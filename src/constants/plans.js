// constants/plans.js
"use strict";

/**
 * Single source of truth for all plans and credit packs.
 * Prices in INR (paise NOT used — Cashfree takes rupees as decimal).
 *
 * type:
 *   "daily_reset" — free tier, credits reset to `credits` every day at midnight
 *   "monthly"     — paid recurring plan, credits granted each renewal period
 *   "topup"       — one-time credit purchase, stacks on top of current balance
 */

const PLANS = {
  free: {
    id:      "free",
    label:   "Free",
    price:   0,
    credits: 20,
    type:    "daily_reset",
  },
  student: {
    id:      "student",
    label:   "Student Pro",
    price:   199,
    credits: 500,
    type:    "monthly",
    periodDays: 30,
  },
  premium: {
    id:      "premium",
    label:   "Premium",
    price:   499,
    credits: 2000,
    type:    "monthly",
    periodDays: 30,
  },
};

const CREDIT_PACKS = {
  extra_500: {
    id:      "extra_500",
    label:   "Extra Credits",
    price:   99,
    credits: 500,
    type:    "topup",
  },
};

function getPlan(planId) {
  return PLANS[planId] ?? null;
}

function getCreditPack(packId) {
  return CREDIT_PACKS[packId] ?? null;
}

function isMonthlyPlan(planId) {
  return getPlan(planId)?.type === "monthly";
}

module.exports = { PLANS, CREDIT_PACKS, getPlan, getCreditPack, isMonthlyPlan };