// controllers/tutor.controller.js
"use strict";

const { explainTopic, answerQuestion } = require("../services/tutor.service");

// ── Shared SSE helper ─────────────────────────────────────────────────────────

function setupSSE(res) {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  return (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };
}

function closeSSE(res, send, error) {
  if (error) {
    console.error("[tutor.controller]", error);
    if (res.headersSent) {
      send({ error: error.message || "Failed." });
    } else {
      const status =
        error.code === "NOT_FOUND" ? 404 :
        error.code === "NO_CHUNKS" ? 422 : 500;
      res.status(status).json({ error: error.message || "Failed." });
      return;
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── POST /api/tutor/explain ───────────────────────────────────────────────────
// Body: { documentId, topic }

async function explainTopicHandler(req, res) {
  const { documentId, topic } = req.body;
  const userId = req.user?.uid || req.userId;

  if (!documentId || typeof documentId !== "string")
    return res.status(400).json({ error: "documentId is required." });
  if (!userId)
    return res.status(401).json({ error: "Unauthorized." });
  if (topic !== null && topic !== undefined && typeof topic !== "object")
    return res.status(400).json({ error: "topic must be an object or null." });

  const send = setupSSE(res);

  try {
    await explainTopic({ documentId, userId, topic: topic ?? null, onChunk: (d) => send({ delta: d }) });
    closeSSE(res, send);
  } catch (err) {
    closeSSE(res, send, err);
  }
}

// ── POST /api/tutor/chat ──────────────────────────────────────────────────────
// Body: { documentId, question, history }
// history: Array<{ role: "user"|"assistant", content: string }>

async function chatHandler(req, res) {
  const { documentId, question, history = [] } = req.body;
  const userId = req.user?.uid || req.userId;

  if (!documentId || typeof documentId !== "string")
    return res.status(400).json({ error: "documentId is required." });
  if (!question || typeof question !== "string" || !question.trim())
    return res.status(400).json({ error: "question is required." });
  if (!userId)
    return res.status(401).json({ error: "Unauthorized." });
  if (!Array.isArray(history))
    return res.status(400).json({ error: "history must be an array." });

  const send = setupSSE(res);

  try {
    await answerQuestion({
      documentId,
      userId,
      question,
      history,
      onChunk: (d) => send({ delta: d }),
    });
    closeSSE(res, send);
  } catch (err) {
    closeSSE(res, send, err);
  }
}

module.exports = { explainTopicHandler, chatHandler };