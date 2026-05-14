require("dotenv").config();

const express = require("express");

const { CORS_ORIGINS } = require("./config/env");
const uploadRoutes = require("./routes/upload.routes");

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running...");
});

app.use(uploadRoutes);

module.exports = app;
