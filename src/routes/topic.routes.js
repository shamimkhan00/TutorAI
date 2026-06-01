// routes/topic.routes.js
const express = require("express");
const { verifyFirebaseToken }               = require("../middleware/auth.middleware");
const { getTopics }                         = require("../controllers/topic.controller");
const { explainTopicHandler, chatHandler }  = require("../controllers/tutor.controller");

const router = express.Router();

// GET  /api/topics/:documentId   — fetch / generate course outline
router.get("/api/topics/:documentId", verifyFirebaseToken, getTopics);

// POST /api/tutor/explain        — stream a structured topic explanation (SSE)
router.post("/api/tutor/explain", verifyFirebaseToken, explainTopicHandler);

// POST /api/tutor/chat           — stream a conversational follow-up answer (SSE)
router.post("/api/tutor/chat", verifyFirebaseToken, chatHandler);

module.exports = router;