const { GoogleGenAI } = require("@google/genai");

// Reuse a single Gemini client for all embedding requests.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Creates a Gemini embedding vector for the provided text.
 *
 * @param {string} text - Non-empty text to embed.
 * @returns {Promise<number[]>} Embedding vector values.
 */
async function createEmbedding(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("createEmbedding requires a non-empty string.");
  }

  try {
    const response = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
    });

    return response.embeddings[0].values;
  } catch (error) {
    console.error("Failed to create Gemini embedding:", error.message);
    throw error;
  }
}

module.exports = {
  createEmbedding,
};
