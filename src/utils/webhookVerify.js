// utils/webhookVerify.js
"use strict";

const crypto = require("crypto");
const { CASHFREE_CLIENT_SECRET } = require("../config/cashfree");

/**
 * Verifies a Cashfree webhook signature.
 *
 * Cashfree's algorithm (per their official docs):
 *   signedPayload = timestamp + rawBody
 *   expectedSignature = base64(HMAC_SHA256(signedPayload, clientSecret))
 *
 * CRITICAL: this must run against the RAW request body string,
 * not the parsed JSON object — re-serializing JSON can change key
 * order/whitespace and break the signature even with correct data.
 *
 * @param {string} signature  - value of the "x-webhook-signature" header
 * @param {string} timestamp  - value of the "x-webhook-timestamp" header
 * @param {string} rawBody    - the raw request body as a string
 * @returns {boolean}
 */
function verifyCashfreeWebhookSignature(signature, timestamp, rawBody) {
  if (!signature || !timestamp || !rawBody) return false;
  if (!CASHFREE_CLIENT_SECRET) {
    console.error("[webhookVerify] CASHFREE_CLIENT_SECRET is not configured.");
    return false;
  }

  const signedPayload = `${timestamp}${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", CASHFREE_CLIENT_SECRET)
    .update(signedPayload)
    .digest("base64");

  // Constant-time comparison to avoid timing attacks
  const a = Buffer.from(expectedSignature);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/**
 * Replay-attack guard: rejects webhooks with a timestamp older than
 * `maxAgeMs` (default 5 minutes), per standard webhook security practice.
 */
function isTimestampFresh(timestamp, maxAgeMs = 5 * 60 * 1000) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() - ts) <= maxAgeMs;
}

module.exports = { verifyCashfreeWebhookSignature, isTimestampFresh };