// routes/payment.routes.js
"use strict";

const express = require("express");
const { verifyFirebaseToken } = require("../middleware/auth.middleware");
const { rateLimiter } = require("../middleware/rateLimiter.middleware");
const {
  createOrderHandler,
  getOrderStatusHandler,
  getPaymentHistoryHandler,
  webhookHandler,
} = require("../controllers/payment.controller");

const router = express.Router();

// ── POST /api/payments/create-order ───────────────────────────────────────────
// Rate limited: 10 order attempts per 10 minutes per user — prevents abuse
// (e.g. spamming order creation to probe the gateway or rack up logs).
router.post(
  "/api/payments/create-order",
  verifyFirebaseToken,
  rateLimiter({ windowMs: 10 * 60_000, max: 10 }),
  createOrderHandler
);

// ── GET /api/payments/:orderId/status ─────────────────────────────────────────
router.get("/api/payments/:orderId/status", verifyFirebaseToken, getOrderStatusHandler);

// ── GET /api/payments/history ──────────────────────────────────────────────────
router.get("/api/payments/history", verifyFirebaseToken, getPaymentHistoryHandler);

// ── POST /api/payments/webhook ─────────────────────────────────────────────────
// NOTE: No verifyFirebaseToken here — Cashfree is calling this, not a logged-in
// user. Authenticity is established by the webhook signature check instead.
// IMPORTANT: this route needs the RAW body, not JSON-parsed. The express.raw()
// middleware for this specific path is registered in app.js, BEFORE
// app.use(express.json()) touches it. No rate limiter here either — Cashfree's
// own retry behavior must not be throttled.
router.post("/api/payments/webhook", webhookHandler);

module.exports = router;