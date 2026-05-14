const { ObjectId } = require("mongodb");

const { connectDB } = require("../config/db");

const DOCUMENTS_COLLECTION = "documents";
const CHUNKS_COLLECTION = "document_chunks";
const VECTOR_INDEX_NAME = "document_chunks_embedding_vector_index";

function getPageCount(structuredOutput) {
  return Array.isArray(structuredOutput && structuredOutput.pages)
    ? structuredOutput.pages.length
    : 0;
}

function getTitle(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) {
    return "Untitled document";
  }

  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) {
    return null;
  }

  const normalized = embedding
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return normalized.length === embedding.length ? normalized : null;
}

function normalizeKeyPoints(keyPoints) {
  return Array.isArray(keyPoints)
    ? keyPoints.filter((point) => typeof point === "string" && point.trim())
    : [];
}

function buildImageContent(chunk) {
  const description =
    typeof chunk.imageDescription === "string"
      ? chunk.imageDescription.trim()
      : typeof chunk.description === "string"
        ? chunk.description.trim()
        : typeof chunk.content === "string"
          ? chunk.content.trim()
          : "";
  const keyPoints = normalizeKeyPoints(chunk.keyPoints || chunk.key_points);
  const keyPointsContent =
    keyPoints.length > 0 ? `\n\nKey Points:\n- ${keyPoints.join("\n- ")}` : "";

  return {
    content: `${description}${keyPointsContent}`.trim(),
    imageDescription: description,
    keyPoints,
  };
}

function normalizeChunk(chunk, documentId, userId, createdAt) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }

  const isImage =
    chunk.type === "image" ||
    chunk.type === "image_description" ||
    chunk.type === "concept";
  const embedding = normalizeEmbedding(chunk.embedding);
  const imageFields = isImage ? buildImageContent(chunk) : null;
  const content = isImage
    ? imageFields.content
    : typeof chunk.content === "string"
      ? chunk.content.trim()
      : "";

  if (!content || !embedding) {
    return null;
  }

  return {
    documentId,
    userId,
    page: chunk.page,
    chunkId: chunk.chunkId,
    type: isImage ? "image" : "text",
    content,
    metadata: {
      ...(chunk.metadata || {}),
      originalType: chunk.type,
    },
    embedding,
    ...(isImage
      ? {
          imageDescription: imageFields.imageDescription,
          keyPoints: imageFields.keyPoints,
        }
      : {}),
    createdAt,
  };
}

async function ensureDocumentIndexes(db) {
  await Promise.all([
    db.collection(DOCUMENTS_COLLECTION).createIndex({ userId: 1, createdAt: -1 }),
    db.collection(DOCUMENTS_COLLECTION).createIndex({
      userId: 1,
      processingStatus: 1,
    }),
    db.collection(CHUNKS_COLLECTION).createIndex({ userId: 1, documentId: 1 }),
    db.collection(CHUNKS_COLLECTION).createIndex({
      userId: 1,
      documentId: 1,
      page: 1,
    }),
    db.collection(CHUNKS_COLLECTION).createIndex(
      { documentId: 1, chunkId: 1 },
      { unique: true }
    ),
  ]);
}

async function ensureVectorSearchIndex(db, dimensions) {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return;
  }

  const collection = db.collection(CHUNKS_COLLECTION);

  if (typeof collection.createSearchIndex !== "function") {
    return;
  }

  try {
    const existingIndexes =
      typeof collection.listSearchIndexes === "function"
        ? await collection.listSearchIndexes(VECTOR_INDEX_NAME).toArray()
        : [];

    if (existingIndexes.length > 0) {
      return;
    }

    await collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: dimensions,
            similarity: "cosine",
          },
          {
            type: "filter",
            path: "userId",
          },
          {
            type: "filter",
            path: "documentId",
          },
        ],
      },
    });
  } catch (error) {
    console.warn(
      `Vector search index was not created automatically: ${error.message}`
    );
  }
}

async function saveProcessedDocument({
  userId,
  fileName,
  fileType,
  structuredOutput,
  chunks,
}) {
  if (!userId) {
    throw new Error("saveProcessedDocument requires a userId.");
  }

  if (!Array.isArray(chunks)) {
    throw new Error("saveProcessedDocument requires a chunks array.");
  }

  const db = await connectDB();
  const now = new Date();
  const documentId = new ObjectId();
  const normalizedChunks = chunks
    .map((chunk) => normalizeChunk(chunk, documentId, userId, now))
    .filter(Boolean);
  const firstEmbedding = normalizedChunks.find((chunk) =>
    Array.isArray(chunk.embedding)
  )?.embedding;

  await ensureDocumentIndexes(db);
  await ensureVectorSearchIndex(db, firstEmbedding && firstEmbedding.length);

  const document = {
    _id: documentId,
    userId,
    title: getTitle(fileName),
    originalFileName: fileName,
    fileType,
    pageCount: getPageCount(structuredOutput),
    chunkCount: normalizedChunks.length,
    createdAt: now,
    updatedAt: now,
    processingStatus: "completed",
  };

  if (
    typeof structuredOutput?.summary === "string" &&
    structuredOutput.summary.trim()
  ) {
    document.summary = structuredOutput.summary.trim();
  }

  await db.collection(DOCUMENTS_COLLECTION).insertOne(document);

  if (normalizedChunks.length > 0) {
    await db.collection(CHUNKS_COLLECTION).insertMany(normalizedChunks);
  }

  return {
    document,
    chunks: normalizedChunks,
  };
}

module.exports = {
  saveProcessedDocument,
};
