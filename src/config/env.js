require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "ai_tutor";
const MONGO_DNS_SERVERS = (process.env.MONGO_DNS_SERVERS || "8.8.8.8,1.1.1.1")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MAX_IMAGE_DIMENSION = Number.parseInt(
  process.env.MAX_IMAGE_DIMENSION || "1600",
  10
);
const MAX_IMAGE_BYTES = Number.parseInt(
  process.env.MAX_IMAGE_BYTES || `${1024 * 1024}`,
  10
);

// ── Cashfree (NEW) ───────────────────────────────────────────────────────────
const CASHFREE_CLIENT_ID     = process.env.CASHFREE_CLIENT_ID;
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
const CASHFREE_ENV           = process.env.CASHFREE_ENV || "PRODUCTION"; // "SANDBOX" | "PRODUCTION"
const CASHFREE_API_VERSION   = process.env.CASHFREE_API_VERSION || "2023-08-01";
const FRONTEND_URL           = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL            = process.env.BACKEND_URL || "http://localhost:3000";

module.exports = {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  MONGO_URI,
  MONGO_DB_NAME,
  MONGO_DNS_SERVERS,
  PORT,
  CORS_ORIGINS,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
  CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV,
  CASHFREE_API_VERSION,
  FRONTEND_URL,
  BACKEND_URL,
};