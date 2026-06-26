// services/wallet.service.js
"use strict";

const { connectDB } = require("../config/db");
const { getPlan, getCreditPack } = require("../constants/plans");

const WALLETS_COLLECTION      = "credit_wallets";
const TRANSACTIONS_COLLECTION = "credit_transactions";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfNextMidnight(from = new Date()) {
  const d = new Date(from);
  d.setHours(24, 0, 0, 0); // next midnight, local server time
  return d;
}

async function ensureWalletIndexes(db) {
  await Promise.all([
    db.collection(WALLETS_COLLECTION).createIndex({ userId: 1 }, { unique: true }),
    db.collection(TRANSACTIONS_COLLECTION).createIndex({ userId: 1, createdAt: -1 }),
    db.collection(TRANSACTIONS_COLLECTION).createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
  ]);
}

/**
 * Returns the wallet for a user, creating a fresh free-tier wallet if none exists.
 */
async function getOrCreateWallet(userId) {
  if (!userId) throw new Error("getOrCreateWallet requires userId.");

  const db = await connectDB();
  await ensureWalletIndexes(db);

  const existing = await db.collection(WALLETS_COLLECTION).findOne({ userId });
  if (existing) return existing;

  const now = new Date();
  const freePlan = getPlan("free");

  const wallet = {
    userId,
    planId:            "free",
    balance:           freePlan.credits,
    dailyResetAt:      startOfNextMidnight(now),
    currentPeriodEnd:  null,         // only set for monthly plans
    rolloverCap:       0,            // monthly allowance, used to cap carry-over
    lifetimeAllocated: freePlan.credits,
    lifetimePurchased: 0,
    lifetimeUsed:      0,
    createdAt:         now,
    updatedAt:         now,
  };

  try {
    await db.collection(WALLETS_COLLECTION).insertOne(wallet);
  } catch (err) {
    // Race: another request created it first (unique index) — just re-fetch
    if (err.code === 11000) {
      return db.collection(WALLETS_COLLECTION).findOne({ userId });
    }
    throw err;
  }

  return wallet;
}

/**
 * Lazily resets the free-tier daily allowance if the reset time has passed.
 * Called before every credit check/deduction for free-tier users.
 */
async function applyDailyResetIfDue(userId) {
  const db     = await connectDB();
  const wallet = await getOrCreateWallet(userId);

  if (wallet.planId !== "free" || !wallet.dailyResetAt) return wallet;

  const now = new Date();
  if (now < new Date(wallet.dailyResetAt)) return wallet;

  const freePlan  = getPlan("free");
  const nextReset = startOfNextMidnight(now);

  const result = await db.collection(WALLETS_COLLECTION).findOneAndUpdate(
    { userId, planId: "free" },
    {
      $set: {
        balance:      freePlan.credits,
        dailyResetAt: nextReset,
        updatedAt:    now,
      },
    },
    { returnDocument: "after" }
  );

  await db.collection(TRANSACTIONS_COLLECTION).insertOne({
    userId,
    type:         "daily_reset",
    amount:       freePlan.credits,
    balanceAfter: freePlan.credits,
    source:       "free_tier_reset",
    createdAt:    now,
  });

  return result.value ?? result;
}

/**
 * Checks whether the user has at least `amount` credits available.
 * Applies the free-tier daily reset first if relevant.
 */
async function hasCredits(userId, amount = 1) {
  const wallet = await applyDailyResetIfDue(userId);
  return wallet.balance >= amount;
}

/**
 * Deducts credits for a single AI usage event. Atomic — never goes negative.
 * Returns { success, balanceAfter } — success=false means insufficient credits.
 */
async function deductCredits(userId, amount = 1, meta = {}) {
  if (amount <= 0) throw new Error("deductCredits amount must be positive.");

  await applyDailyResetIfDue(userId);

  const db  = await connectDB();
  const now = new Date();

  // Atomic conditional decrement — only succeeds if balance >= amount
  const result = await db.collection(WALLETS_COLLECTION).findOneAndUpdate(
    { userId, balance: { $gte: amount } },
    {
      $inc: { balance: -amount, lifetimeUsed: amount },
      $set: { updatedAt: now },
    },
    { returnDocument: "after" }
  );

  const updated = result.value ?? result;

  if (!updated) {
    return { success: false, balanceAfter: null };
  }

  await db.collection(TRANSACTIONS_COLLECTION).insertOne({
    userId,
    type:         "usage",
    amount:       -amount,
    balanceAfter: updated.balance,
    source:       meta.source ?? "ai_message",
    metadata:     meta,
    createdAt:    now,
  });

  return { success: true, balanceAfter: updated.balance };
}

/**
 * Refunds credits back to a user (e.g. a failed AI generation after deduction).
 */
async function refundCredits(userId, amount, meta = {}) {
  if (amount <= 0) throw new Error("refundCredits amount must be positive.");

  const db  = await connectDB();
  const now = new Date();

  const result = await db.collection(WALLETS_COLLECTION).findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount, lifetimeUsed: -amount },
      $set: { updatedAt: now },
    },
    { returnDocument: "after" }
  );

  const updated = result.value ?? result;

  await db.collection(TRANSACTIONS_COLLECTION).insertOne({
    userId,
    type:         "refund",
    amount,
    balanceAfter: updated?.balance ?? null,
    source:       meta.source ?? "refund",
    metadata:     meta,
    createdAt:    now,
  });

  return updated;
}

/**
 * Grants credits for a monthly plan renewal (or first purchase).
 * Implements the rollover rule: unused credits carry over capped at
 * exactly one extra month's worth, then the new period's allowance is added.
 *
 *   newBalance = min(remainingOldCredits, oneMonthAllowance) + newAllowance
 */
async function grantMonthlyPlanCredits(userId, planId, { idempotencyKey } = {}) {
  const plan = getPlan(planId);
  if (!plan || plan.type !== "monthly") {
    throw new Error(`grantMonthlyPlanCredits requires a monthly planId, got "${planId}".`);
  }

  const db  = await connectDB();
  const now = new Date();

  // Idempotency: if this exact grant was already recorded, skip
  if (idempotencyKey) {
    const dup = await db.collection(TRANSACTIONS_COLLECTION).findOne({ idempotencyKey });
    if (dup) {
      const wallet = await db.collection(WALLETS_COLLECTION).findOne({ userId });
      return { wallet, alreadyProcessed: true };
    }
  }

  const wallet = await getOrCreateWallet(userId);

  const oneMonthAllowance = plan.credits;
  const remainingOld      = Math.max(0, wallet.balance);
  const carriedOver       = Math.min(remainingOld, oneMonthAllowance); // capped rollover
  const newBalance        = carriedOver + oneMonthAllowance;

  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + plan.periodDays);

  const updated = await db.collection(WALLETS_COLLECTION).findOneAndUpdate(
    { userId },
    {
      $set: {
        planId,
        balance:          newBalance,
        currentPeriodEnd: periodEnd,
        rolloverCap:      oneMonthAllowance,
        dailyResetAt:     null, // no longer on free tier
        updatedAt:        now,
      },
      $inc: { lifetimeAllocated: oneMonthAllowance },
    },
    { returnDocument: "after", upsert: false }
  );

  await db.collection(TRANSACTIONS_COLLECTION).insertOne({
    userId,
    type:           "plan_renewal",
    amount:         newBalance - remainingOld,
    balanceAfter:   newBalance,
    source:         planId,
    idempotencyKey: idempotencyKey ?? undefined,
    metadata:       { carriedOver, oneMonthAllowance, periodEnd },
    createdAt:      now,
  });

  return { wallet: updated.value ?? updated, alreadyProcessed: false };
}

/**
 * Grants credits from a one-time top-up purchase. Stacks on current balance,
 * does not affect plan or renewal period.
 */
async function grantTopUpCredits(userId, packId, { idempotencyKey } = {}) {
  const pack = getCreditPack(packId);
  if (!pack) throw new Error(`Unknown credit pack "${packId}".`);

  const db  = await connectDB();
  const now = new Date();

  if (idempotencyKey) {
    const dup = await db.collection(TRANSACTIONS_COLLECTION).findOne({ idempotencyKey });
    if (dup) {
      const wallet = await db.collection(WALLETS_COLLECTION).findOne({ userId });
      return { wallet, alreadyProcessed: true };
    }
  }

  await getOrCreateWallet(userId); // ensure wallet exists

  const updated = await db.collection(WALLETS_COLLECTION).findOneAndUpdate(
    { userId },
    {
      $inc: { balance: pack.credits, lifetimePurchased: pack.credits },
      $set: { updatedAt: now },
    },
    { returnDocument: "after" }
  );

  await db.collection(TRANSACTIONS_COLLECTION).insertOne({
    userId,
    type:           "purchase",
    amount:         pack.credits,
    balanceAfter:   updated.value?.balance ?? updated.balance,
    source:         packId,
    idempotencyKey: idempotencyKey ?? undefined,
    createdAt:      now,
  });

  return { wallet: updated.value ?? updated, alreadyProcessed: false };
}

module.exports = {
  getOrCreateWallet,
  applyDailyResetIfDue,
  hasCredits,
  deductCredits,
  refundCredits,
  grantMonthlyPlanCredits,
  grantTopUpCredits,
};