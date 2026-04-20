require("dotenv").config();

const express = require("express");

const uploadRoutes = require("./routes/upload.routes");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running...");
});

app.use(uploadRoutes);

module.exports = app;
