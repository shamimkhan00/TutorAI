// services/usage.service.js
"use strict";

const { connectDB } = require("../config/db");

const USAGE_COLLECTION = "ai_usage_logs";

/**
 * Rough cost-per-1K-token estimates (USD). Update as needed —
 * this is for internal analytics only, not billing.
 */
const COST_PER_1K_TOKENS = {
  "gemini-2.0-flash":      { input: 0.0001, output: 0.0004 },
  "gemini-embedding-001":  { input: 0.0001, output: 0 },
  default:                 { input: 0.0001, output: 0.0004 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const rates = COST_PER_1K_TOKENS[model] ?? COST_PER_1K_TOKENS.default;
  const inputCost  = (inputTokens  / 1000) * rates.input;
  const outputCost = (outputTokens / 1000) * rates.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

async function ensureUsageIndexes(db) {
  await Promise.all([
    db.collection(USAGE_COLLECTION).createIndex({ userId: 1, createdAt: -1 }),
    db.collection(USAGE_COLLECTION).createIndex({ documentId: 1 }),
    db.collection(USAGE_COLLECTION).createIndex({ model: 1, createdAt: -1 }),
  ]);
}

/**
 * Logs a single AI request/response usage event.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.documentId]
 * @param {string} opts.model            - e.g. "gemini-2.0-flash"
 * @param {string} opts.route            - e.g. "tutor.explain", "tutor.chat", "topics.generate"
 * @param {number} opts.inputTokens
 * @param {number} opts.outputTokens
 */
async function logUsage({ userId, documentId, model, route, inputTokens = 0, outputTokens = 0 }) {
  if (!userId) throw new Error("logUsage requires userId.");
  if (!model)  throw new Error("logUsage requires model.");

  const db = await connectDB();
  await ensureUsageIndexes(db);

  const totalTokens   = inputTokens + outputTokens;
  const estimatedCost = estimateCost(model, inputTokens, outputTokens);
  const now           = new Date();

  const entry = {
    userId,
    documentId: documentId ?? null,
    model,
    route:      route ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    createdAt:  now,
  };

  await db.collection(USAGE_COLLECTION).insertOne(entry);
  return entry;
}

/**
 * Aggregates usage for a user — useful for an account/usage dashboard.
 */
async function getUsageSummary(userId, { sinceDays = 30 } = {}) {
  const db    = await connectDB();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const result = await db.collection(USAGE_COLLECTION).aggregate([
    { $match: { userId, createdAt: { $gte: since } } },
    {
      $group: {
        _id:            null,
        totalRequests:  { $sum: 1 },
        totalInputTokens:  { $sum: "$inputTokens" },
        totalOutputTokens: { $sum: "$outputTokens" },
        totalTokens:    { $sum: "$totalTokens" },
        totalCost:      { $sum: "$estimatedCost" },
      },
    },
  ]).toArray();

  return result[0] ?? {
    totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalTokens: 0, totalCost: 0,
  };
}

module.exports = { logUsage, getUsageSummary, estimateCost };