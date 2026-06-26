// app.js
require("dotenv").config();

const express = require("express");
const { CORS_ORIGINS } = require("./config/env");
const uploadRoutes      = require("./routes/upload.routes");
const topicRoutes       = require("./routes/topic.routes");
const documentRoutes    = require("./routes/documents.routes");
const walletDevRoutes   = require("./routes/wallet-dev.routes"); // temporary — remove once Batch 2 is verified end-to-end
const paymentRoutes     = require("./routes/payment.routes");
const userRoutes        = require("./routes/user.routes");       // ← NEW

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-webhook-signature,x-webhook-timestamp");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// CRITICAL: webhook route needs the RAW body for signature verification.
// Must be registered BEFORE express.json(), and ONLY for this exact path.
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" })
);

app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running...");
});

app.use(uploadRoutes);
app.use(topicRoutes);
app.use(documentRoutes);
app.use(walletDevRoutes);
app.use(paymentRoutes);
app.use(userRoutes); // ← NEW

module.exports = app;