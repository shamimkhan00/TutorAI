// middleware/credit.middleware.js
"use strict";

const { hasCredits, getOrCreateWallet } = require("../services/wallet.service");

/**
 * Blocks the request if the user has no credits left.
 * Must run AFTER verifyFirebaseToken (needs req.user.uid).
 *
 * Does NOT deduct credits — deduction happens after a successful AI
 * response, inside the route handler itself, via wallet.service.deductCredits().
 * This middleware is a pre-flight gate only.
 */
async function requireCredits(req, res, next) {
  const userId = req.user?.uid || req.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const ok = await hasCredits(userId, 1);

    if (!ok) {
      const wallet = await getOrCreateWallet(userId);
      return res.status(402).json({
        error:   "Insufficient credits.",
        code:    "OUT_OF_CREDITS",
        balance: wallet.balance,
        planId:  wallet.planId,
      });
    }

    next();
  } catch (err) {
    console.error("[credit.middleware] requireCredits error:", err);
    return res.status(500).json({ error: "Failed to verify credit balance." });
  }
}

/**
 * Attaches the user's current wallet to req.wallet without blocking.
 * Useful for routes that want to show balance but don't strictly require it.
 */
async function attachWallet(req, res, next) {
  const userId = req.user?.uid || req.userId;
  if (!userId) return next();

  try {
    req.wallet = await getOrCreateWallet(userId);
  } catch (err) {
    console.error("[credit.middleware] attachWallet error:", err);
  }
  next();
}

module.exports = { requireCredits, attachWallet };