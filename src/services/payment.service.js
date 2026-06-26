// services/payment.service.js
"use strict";

const crypto = require("crypto");
const { connectDB } = require("../config/db");
const { CASHFREE_BASE_URL, cashfreeHeaders } = require("../config/cashfree");
const { FRONTEND_URL } = require("../config/env");
const { getPlan, getCreditPack } = require("../constants/plans");

const PAYMENTS_COLLECTION      = "payments";
const SUBSCRIPTIONS_COLLECTION = "subscriptions";
const WEBHOOK_LOGS_COLLECTION  = "payment_webhook_logs";

// ─── Indexes ──────────────────────────────────────────────────────────────────

async function ensurePaymentIndexes(db) {
  await Promise.all([
    db.collection(PAYMENTS_COLLECTION).createIndex({ orderId: 1 }, { unique: true }),
    db.collection(PAYMENTS_COLLECTION).createIndex({ userId: 1, createdAt: -1 }),
    db.collection(SUBSCRIPTIONS_COLLECTION).createIndex({ userId: 1 }),
    db.collection(WEBHOOK_LOGS_COLLECTION).createIndex({ eventId: 1 }, { unique: true, sparse: true }),
    db.collection(WEBHOOK_LOGS_COLLECTION).createIndex({ orderId: 1 }),
  ]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateOrderId(prefix) {
  // Cashfree requires alphanumeric + underscore, max 50 chars
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Resolves what's being purchased (plan or credit pack) and its price.
 * `purpose` is either "subscription" or "credits".
 */
function resolvePurchase({ purpose, planId, packId }) {
  if (purpose === "subscription") {
    const plan = getPlan(planId);
    if (!plan || plan.price <= 0) throw new Error(`Invalid or free planId "${planId}" for subscription purchase.`);
    return { amount: plan.price, label: plan.label, refId: planId };
  }

  if (purpose === "credits") {
    const pack = getCreditPack(packId);
    if (!pack) throw new Error(`Invalid credit packId "${packId}".`);
    return { amount: pack.price, label: pack.label, refId: packId };
  }

  throw new Error(`Unknown purchase purpose "${purpose}". Expected "subscription" or "credits".`);
}

// ─── Create order ─────────────────────────────────────────────────────────────

/**
 * Creates a Cashfree order and a matching `payments` record (status: "pending").
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.purpose      - "subscription" | "credits"
 * @param {string} [opts.planId]    - required if purpose === "subscription"
 * @param {string} [opts.packId]    - required if purpose === "credits"
 * @param {object} opts.customer    - { email, phone, name }
 */
async function createOrder({ userId, purpose, planId, packId, customer }) {
  if (!userId) throw new Error("createOrder requires userId.");
  if (!customer?.email || !customer?.phone) {
    throw new Error("createOrder requires customer.email and customer.phone (Cashfree mandatory fields).");
  }

  const { amount, label, refId } = resolvePurchase({ purpose, planId, packId });

  const db = await connectDB();
  await ensurePaymentIndexes(db);

  const orderId = generateOrderId(purpose === "subscription" ? "sub" : "topup");
  const now = new Date();

  // Build the Cashfree order payload
  const orderPayload = {
    order_amount:   amount,
    order_currency: "INR",
    order_id:       orderId,
    customer_details: {
      customer_id:    userId,
      customer_email: customer.email,
      customer_phone: customer.phone,
      ...(customer.name ? { customer_name: customer.name } : {}),
    },
    order_meta: {
      return_url: `${FRONTEND_URL}/pricing/result?order_id={order_id}`,
      // notify_url is also configurable here, but we set it once at the
      // Cashfree dashboard level for all orders — see Batch 2 notes.
    },
    order_note: `${label} — ${purpose}`,
    order_tags: { purpose, refId, userId },
  };

  const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
    method:  "POST",
    headers: cashfreeHeaders(),
    body:    JSON.stringify(orderPayload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Cashfree order creation failed: ${data.message || response.status}`);
  }

  // Persist the pending payment record — this is OUR source of truth
  // for "what was this order for", since Cashfree's order_tags are
  // metadata only and not guaranteed to be queryable later.
  const paymentRecord = {
    orderId,
    cfOrderId:  data.cf_order_id ?? null,
    userId,
    purpose,                 // "subscription" | "credits"
    refId,                   // planId or packId
    amount,
    currency:   "INR",
    status:     "pending",   // pending -> paid | failed | expired
    paymentSessionId: data.payment_session_id ?? null,
    gatewayResponse: data,   // full raw response for audit/debug
    createdAt:  now,
    updatedAt:  now,
  };

  await db.collection(PAYMENTS_COLLECTION).insertOne(paymentRecord);

  return {
    orderId,
    paymentSessionId: data.payment_session_id,
    amount,
    purpose,
    refId,
  };
}

// ─── Fetch order status directly from Cashfree (for polling / reconciliation) ─

async function fetchOrderStatusFromCashfree(orderId) {
  const response = await fetch(`${CASHFREE_BASE_URL}/orders/${encodeURIComponent(orderId)}`, {
    method:  "GET",
    headers: cashfreeHeaders(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to fetch order status: ${data.message || response.status}`);
  }
  return data; // includes order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED"
}

// ─── Local payment record helpers ─────────────────────────────────────────────

async function getPaymentByOrderId(orderId) {
  const db = await connectDB();
  return db.collection(PAYMENTS_COLLECTION).findOne({ orderId });
}

async function getPaymentsForUser(userId, limit = 50) {
  const db = await connectDB();
  return db
    .collection(PAYMENTS_COLLECTION)
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Updates a payment record's status. Used by both the webhook handler
 * and the manual status-check endpoint (for polling fallback).
 */
async function updatePaymentStatus(orderId, status, extra = {}) {
  const db  = await connectDB();
  const now = new Date();

  const result = await db.collection(PAYMENTS_COLLECTION).findOneAndUpdate(
    { orderId },
    { $set: { status, updatedAt: now, ...extra } },
    { returnDocument: "after" }
  );

  return result.value ?? result;
}

// ─── Subscription record helpers ──────────────────────────────────────────────

async function upsertSubscription({ userId, planId, orderId, periodEnd }) {
  const db  = await connectDB();
  const now = new Date();

  const result = await db.collection(SUBSCRIPTIONS_COLLECTION).findOneAndUpdate(
    { userId },
    {
      $set: {
        userId, planId, status: "active",
        lastOrderId: orderId, currentPeriodEnd: periodEnd, updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
      $push: {
        history: {
          $each: [{ planId, orderId, periodEnd, renewedAt: now }],
          $slice: -24, // keep last 24 renewals
        },
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  return result.value ?? result;
}

async function getSubscription(userId) {
  const db = await connectDB();
  return db.collection(SUBSCRIPTIONS_COLLECTION).findOne({ userId });
}

// ─── Webhook log helpers (idempotency + audit trail) ──────────────────────────

/**
 * Records that a webhook event was received. Returns false if this exact
 * event was already processed (duplicate webhook delivery — Cashfree retries
 * on non-200 responses, so duplicates are expected and must be handled).
 */
async function recordWebhookEvent({ eventId, orderId, type, payload, signatureValid }) {
  const db  = await connectDB();
  const now = new Date();

  try {
    await db.collection(WEBHOOK_LOGS_COLLECTION).insertOne({
      eventId: eventId ?? null,
      orderId,
      type,
      payload,
      signatureValid,
      processedAt: now,
    });
    return true; // first time seeing this event
  } catch (err) {
    if (err.code === 11000) return false; // duplicate — already processed
    throw err;
  }
}

module.exports = {
  createOrder,
  fetchOrderStatusFromCashfree,
  getPaymentByOrderId,
  getPaymentsForUser,
  updatePaymentStatus,
  upsertSubscription,
  getSubscription,
  recordWebhookEvent,
};