// config/cashfree.js
"use strict";

const {
  CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV,
  CASHFREE_API_VERSION,
} = require("./env");

if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) {
  console.warn(
    "[cashfree] CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET not set. " +
    "Payment routes will fail until these are configured in .env"
  );
}

const CASHFREE_BASE_URL =
  CASHFREE_ENV === "SANDBOX"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";

function cashfreeHeaders() {
  return {
    "Content-Type":  "application/json",
    "x-client-id":     CASHFREE_CLIENT_ID,
    "x-client-secret": CASHFREE_CLIENT_SECRET,
    "x-api-version":   CASHFREE_API_VERSION,
  };
}

module.exports = { CASHFREE_BASE_URL, cashfreeHeaders, CASHFREE_CLIENT_SECRET };