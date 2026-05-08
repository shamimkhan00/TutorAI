const { createEmbedding } = require("../../services/embedding.service");

const EMBEDDING_DELAY_MS = 200;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embeds structured PDF chunks sequentially without mutating originals.
 *
 * @param {Array<object>} chunks - Structured PDF chunks.
 * @returns {Promise<Array<object>>} Chunks with embedding vectors attached.
 */
async function embedChunks(chunks) {
  if (!Array.isArray(chunks)) {
    throw new Error("embedChunks requires an array of chunks.");
  }

  for (const chunk of chunks) {
    if (!chunk || typeof chunk.content !== "string") {
      console.warn("Skipping invalid chunk:", chunk && chunk.chunkId);
      continue;
    }

    const content = chunk.content.trim();

    if (!content) {
      chunk.embedding = null;
      console.warn("Skipping empty chunk:", chunk.chunkId);
      continue;
    }

    console.log("Embedding chunk:", chunk.chunkId);

    try {
      chunk.embedding = await createEmbedding(content);

      console.log("Successfully embedded chunk:", chunk.chunkId);
    } catch (error) {
      chunk.embedding = null;
      console.error("Failed to embed chunk:", chunk.chunkId, error.message);
    }

    await delay(EMBEDDING_DELAY_MS);
  }

  return chunks;
}

module.exports = {
  embedChunks,
};
