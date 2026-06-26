// controllers/user.controller.js
"use strict";

const { getUserPhone, saveUserPhone } = require("../services/user.service");

async function getPhoneHandler(req, res) {
  const userId = req.user?.uid || req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized." });

  try {
    const phone = await getUserPhone(userId);
    res.json({ success: true, phone });
  } catch (err) {
    console.error("[user.controller] getPhoneHandler:", err);
    res.status(500).json({ error: "Failed to fetch phone number." });
  }
}

async function savePhoneHandler(req, res) {
  const userId = req.user?.uid || req.userId;
  const { phone } = req.body;

  if (!userId) return res.status(401).json({ error: "Unauthorized." });
  if (!phone)  return res.status(400).json({ error: "phone is required." });

  try {
    const saved = await saveUserPhone(userId, phone);
    res.json({ success: true, phone: saved });
  } catch (err) {
    res.status(400).json({ error: err.message || "Invalid phone number." });
  }
}

module.exports = { getPhoneHandler, savePhoneHandler };