// controllers/payment.controller.js
"use strict";

const {
  createOrder,
  fetchOrderStatusFromCashfree,
  getPaymentByOrderId,
  getPaymentsForUser,
  updatePaymentStatus,
  upsertSubscription,
  recordWebhookEvent,
} = require("../services/payment.service");
const { verifyCashfreeWebhookSignature, isTimestampFresh } = require("../utils/webhookVerify");
const { grantMonthlyPlanCredits, grantTopUpCredits } = require("../services/wallet.service");
const { getPlan } = require("../constants/plans");

// ── POST /api/payments/create-order ───────────────────────────────────────────
// Body: { purpose: "subscription"|"credits", planId?, packId?, customer: {email, phone, name?} }

async function createOrderHandler(req, res) {
  const userId = req.user?.uid || req.userId;
  const { purpose, planId, packId, customer } = req.body;

  if (!userId) return res.status(401).json({ error: "Unauthorized." });
  if (!purpose) return res.status(400).json({ error: "purpose is required." });
  if (!customer?.email || !customer?.phone) {
    return res.status(400).json({ error: "customer.email and customer.phone are required." });
  }

  try {
    const result = await createOrder({ userId, purpose, planId, packId, customer });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[payment.controller] createOrderHandler:", err);
    return res.status(400).json({ error: err.message || "Failed to create order." });
  }
}

// ── GET /api/payments/:orderId/status ─────────────────────────────────────────
// Polling fallback for the frontend while waiting on the webhook.
// NEVER trusted as the final word — only the webhook flips status to "paid".

async function getOrderStatusHandler(req, res) {
  const userId = req.user?.uid || req.userId;
  const { orderId } = req.params;

  if (!userId) return res.status(401).json({ error: "Unauthorized." });

  try {
    const payment = await getPaymentByOrderId(orderId);
    if (!payment || payment.userId !== userId) {
      return res.status(404).json({ error: "Order not found." });
    }

    // If still pending locally, double check with Cashfree directly —
    // covers the case where the webhook is delayed or the person closed
    // the checkout and came back to the result page.
    if (payment.status === "pending") {
      try {
        const live = await fetchOrderStatusFromCashfree(orderId);
        if (live.order_status === "PAID" && payment.status !== "paid") {
          // Webhook hasn't arrived yet but Cashfree confirms payment —
          // reconcile now rather than make the user wait.
          await finalizePaidOrder(payment, { source: "status_poll_reconciliation" });
          payment.status = "paid";
        } else if (["EXPIRED", "TERMINATED"].includes(live.order_status)) {
          await updatePaymentStatus(orderId, "failed");
          payment.status = "failed";
        }
      } catch (liveErr) {
        console.warn("[payment.controller] live status check failed:", liveErr.message);
        // fall through and return whatever we have locally
      }
    }

    return res.json({
      success: true,
      orderId: payment.orderId,
      status:  payment.status,
      purpose: payment.purpose,
      amount:  payment.amount,
    });
  } catch (err) {
    console.error("[payment.controller] getOrderStatusHandler:", err);
    return res.status(500).json({ error: "Failed to fetch order status." });
  }
}

// ── GET /api/payments/history ──────────────────────────────────────────────────

async function getPaymentHistoryHandler(req, res) {
  const userId = req.user?.uid || req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized." });

  try {
    const payments = await getPaymentsForUser(userId);
    return res.json({ success: true, payments });
  } catch (err) {
    console.error("[payment.controller] getPaymentHistoryHandler:", err);
    return res.status(500).json({ error: "Failed to fetch payment history." });
  }
}

// ── Shared finalize logic (used by webhook AND status-poll reconciliation) ────

/**
 * Applies the business effect of a successful payment: grants credits or
 * renews a subscription. Idempotent — safe to call multiple times for the
 * same orderId because wallet.service uses orderId as the idempotencyKey.
 */
async function finalizePaidOrder(payment, { source } = {}) {
  const idempotencyKey = `order_${payment.orderId}`;

  if (payment.purpose === "subscription") {
    const plan = getPlan(payment.refId);
    if (!plan) throw new Error(`Unknown plan "${payment.refId}" on payment ${payment.orderId}`);

    const { wallet, alreadyProcessed } = await grantMonthlyPlanCredits(
      payment.userId,
      payment.refId,
      { idempotencyKey }
    );

    if (!alreadyProcessed) {
      await upsertSubscription({
        userId:    payment.userId,
        planId:    payment.refId,
        orderId:   payment.orderId,
        periodEnd: wallet.currentPeriodEnd,
      });
    }
  } else if (payment.purpose === "credits") {
    await grantTopUpCredits(payment.userId, payment.refId, { idempotencyKey });
  }

  await updatePaymentStatus(payment.orderId, "paid", { finalizedVia: source ?? "webhook" });
}

// ── POST /api/payments/webhook ─────────────────────────────────────────────────
// Cashfree sends raw JSON. This route MUST receive the raw body — see the
// express.raw() middleware applied specifically to this route in app.js.

async function webhookHandler(req, res) {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  const rawBody   = req.body; // Buffer, thanks to express.raw() on this route

  const rawBodyString = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);

  // ── 1. Verify signature FIRST, before touching any data ─────────────
  const signatureValid = verifyCashfreeWebhookSignature(signature, timestamp, rawBodyString);

  if (!signatureValid) {
    console.error("[payment.controller] Webhook signature verification FAILED.");
    return res.status(401).json({ error: "Invalid signature." });
  }

  if (!isTimestampFresh(timestamp)) {
    console.error("[payment.controller] Webhook timestamp too old — possible replay.");
    return res.status(401).json({ error: "Stale webhook timestamp." });
  }

  // ── 2. Parse only AFTER signature is confirmed valid ─────────────────
  let event;
  try {
    event = JSON.parse(rawBodyString);
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload." });
  }

  const orderId  = event?.data?.order?.order_id;
  const eventId  = event?.event_time && orderId ? `${orderId}_${event.event_time}_${event.type}` : undefined;
  const type     = event?.type;

  if (!orderId) {
    console.warn("[payment.controller] Webhook missing order_id, ignoring.", type);
    return res.status(200).json({ received: true }); // ack so Cashfree doesn't retry forever
  }

  // ── 3. Idempotency: skip if we've already processed this exact event ──
  let isNewEvent;
  try {
    isNewEvent = await recordWebhookEvent({ eventId, orderId, type, payload: event, signatureValid });
  } catch (err) {
    console.error("[payment.controller] recordWebhookEvent failed:", err);
    return res.status(500).json({ error: "Failed to log webhook." });
  }

  if (!isNewEvent) {
    // Duplicate delivery — Cashfree retries on timeout/non-200, this is expected.
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── 4. Apply business logic based on event type ──────────────────────
  try {
    const payment = await getPaymentByOrderId(orderId);
    if (!payment) {
      console.error(`[payment.controller] Webhook for unknown orderId "${orderId}".`);
      return res.status(200).json({ received: true }); // ack — nothing we can do
    }

    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      if (payment.status !== "paid") {
        await finalizePaidOrder(payment, { source: "webhook" });
      }
    } else if (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      await updatePaymentStatus(orderId, "failed");
    }
    // Other event types (refunds, disputes, etc.) can be added here as needed.

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[payment.controller] Webhook processing failed:", err);
    // Return 500 so Cashfree retries — but the idempotency log above
    // means even if THIS handler partially succeeded, a retry won't
    // double-grant credits because finalizePaidOrder is idempotent.
    return res.status(500).json({ error: "Webhook processing failed." });
  }
}

module.exports = {
  createOrderHandler,
  getOrderStatusHandler,
  getPaymentHistoryHandler,
  webhookHandler,
};