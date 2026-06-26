// routes/wallet-dev.routes.js
"use strict";

/**
 * TEMPORARY dev-only routes to manually test wallet/credit logic
 * before Cashfree (Batch 2) exists. Delete this file once Batch 2
 * payment webhooks are wired up and tested end-to-end.
 *
 * All routes require Firebase auth (same as your other protected routes).
 */

const express = require("express");
const { verifyFirebaseToken } = require("../middleware/auth.middleware");
const { requireCredits } = require("../middleware/credit.middleware");
const { rateLimiter } = require("../middleware/rateLimiter.middleware");
const {
  getOrCreateWallet,
  deductCredits,
  refundCredits,
  grantMonthlyPlanCredits,
  grantTopUpCredits,
} = require("../services/wallet.service");
const { logUsage, getUsageSummary } = require("../services/usage.service");

const router = express.Router();

// GET /api/dev/wallet — view your own wallet
router.get("/api/dev/wallet", verifyFirebaseToken, async (req, res) => {
  const wallet = await getOrCreateWallet(req.userId);
  res.json({ success: true, wallet });
});

// POST /api/dev/wallet/use — simulate spending 1 credit (gated by requireCredits)
router.post(
  "/api/dev/wallet/use",
  verifyFirebaseToken,
  rateLimiter({ windowMs: 60_000, max: 30 }),
  requireCredits,
  async (req, res) => {
    const result = await deductCredits(req.userId, 1, { source: "dev_test" });

    // Simulate logging AI usage alongside the deduction
    await logUsage({
      userId:       req.userId,
      model:        "gemini-2.0-flash",
      route:        "dev.test",
      inputTokens:  120,
      outputTokens: 340,
    });

    res.json({ success: true, ...result });
  }
);

// POST /api/dev/wallet/refund — give back 1 credit
router.post("/api/dev/wallet/refund", verifyFirebaseToken, async (req, res) => {
  const wallet = await refundCredits(req.userId, 1, { source: "dev_test_refund" });
  res.json({ success: true, wallet });
});

// POST /api/dev/wallet/simulate-renewal/:planId — simulate a successful monthly payment
router.post("/api/dev/wallet/simulate-renewal/:planId", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await grantMonthlyPlanCredits(req.userId, req.params.planId, {
      idempotencyKey: `dev_${req.userId}_${Date.now()}`, // unique each time for testing
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/dev/wallet/simulate-topup/:packId — simulate a successful credit top-up
router.post("/api/dev/wallet/simulate-topup/:packId", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await grantTopUpCredits(req.userId, req.params.packId, {
      idempotencyKey: `dev_${req.userId}_${Date.now()}`,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/dev/wallet/usage — view aggregated usage stats
router.get("/api/dev/wallet/usage", verifyFirebaseToken, async (req, res) => {
  const summary = await getUsageSummary(req.userId);
  res.json({ success: true, summary });
});

module.exports = router;