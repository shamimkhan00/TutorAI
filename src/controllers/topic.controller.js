// controllers/topic.controller.js
const { generateTopicsForDocument } = require("../services/topic.service");

async function getTopics(req, res) {
  try {
    const { documentId } = req.params;
    const userId = req.user?.uid || req.userId;

    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const result = await generateTopicsForDocument(documentId, userId);

    return res.json({
      success: true,
      documentId,
      ...result,
    });
  } catch (error) {
    console.error("[topic.controller] getTopics error:", error);

    if (error.code === "NOT_FOUND") {
      return res.status(404).json({ error: error.message });
    }

    if (error.code === "NO_CHUNKS") {
      return res.status(422).json({ error: error.message });
    }

    if (error.code === "INVALID_DOCUMENT_ID") {
      return res.status(400).json({ error: error.message });
    }

    if (error.code === "GEMINI_CONFIG_MISSING") {
      return res.status(500).json({ error: "GEMINI_API_KEY not configured." });
    }

    return res.status(500).json({
      error: error.message || "Failed to generate topics.",
    });
  }
}

module.exports = { getTopics };
