require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DNS_SERVERS = (process.env.MONGO_DNS_SERVERS || "8.8.8.8,1.1.1.1")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_IMAGE_DIMENSION = Number.parseInt(
  process.env.MAX_IMAGE_DIMENSION || "1600",
  10
);
const MAX_IMAGE_BYTES = Number.parseInt(
  process.env.MAX_IMAGE_BYTES || `${1024 * 1024}`,
  10
);

module.exports = {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  MONGO_URI,
  MONGO_DNS_SERVERS,
  PORT,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
};
