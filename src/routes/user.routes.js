// routes/user.routes.js
"use strict";

const express = require("express");
const { verifyFirebaseToken } = require("../middleware/auth.middleware");
const { getPhoneHandler, savePhoneHandler } = require("../controllers/user.controller");

const router = express.Router();

// GET  /api/users/phone — fetch saved phone (null if not set yet)
router.get("/api/users/phone", verifyFirebaseToken, getPhoneHandler);

// POST /api/users/phone — save/update phone number { phone: "9876543210" }
router.post("/api/users/phone", verifyFirebaseToken, savePhoneHandler);

module.exports = router;