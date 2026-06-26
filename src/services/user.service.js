// services/user.service.js
"use strict";

const { connectDB } = require("../config/db");

const USERS_COLLECTION = "users";

async function ensureUserIndexes(db) {
  await db.collection(USERS_COLLECTION).createIndex({ userId: 1 }, { unique: true });
}

/**
 * Basic Indian phone number sanity check — 10 digits, optionally with
 * a leading +91 / 91. Not exhaustive validation, just enough to catch
 * obvious typos before sending to Cashfree.
 */
function normalizePhone(rawPhone) {
  const digitsOnly = String(rawPhone).replace(/\D/g, "");
  const last10 = digitsOnly.slice(-10);

  if (last10.length !== 10 || !/^[6-9]/.test(last10)) {
    throw new Error("Please enter a valid 10-digit Indian mobile number.");
  }

  return last10;
}

async function getUserPhone(userId) {
  const db = await connectDB();
  const user = await db.collection(USERS_COLLECTION).findOne({ userId });
  return user?.phone ?? null;
}

async function saveUserPhone(userId, rawPhone) {
  const phone = normalizePhone(rawPhone);

  const db  = await connectDB();
  await ensureUserIndexes(db);
  const now = new Date();

  await db.collection(USERS_COLLECTION).updateOne(
    { userId },
    { $set: { userId, phone, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  return phone;
}

module.exports = { getUserPhone, saveUserPhone, normalizePhone };