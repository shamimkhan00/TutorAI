// controllers/documents.controller.js
"use strict";

const { ObjectId } = require("mongodb");
const { connectDB } = require("../config/db");

const DOCUMENTS_COLLECTION = "documents";
const CHUNKS_COLLECTION    = "document_chunks";

// ── GET /api/documents ────────────────────────────────────────────────────────
// Returns all documents for the authenticated user, newest first.

async function listDocuments(req, res) {
  const userId = req.user?.uid || req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized." });

  try {
    const db   = await connectDB();
    const docs = await db
      .collection(DOCUMENTS_COLLECTION)
      .find(
        { userId },
        {
          projection: {
            _id:              1,
            title:            1,
            originalFileName: 1,
            fileType:         1,
            pageCount:        1,
            chunkCount:       1,
            processingStatus: 1,
            summary:          1,
            topics:           1,
            courseTitle:      1,
            courseDescription:1,
            topicsGeneratedAt:1,
            createdAt:        1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, documents: docs });
  } catch (err) {
    console.error("[documents.controller] listDocuments:", err);
    return res.status(500).json({ error: "Failed to fetch documents." });
  }
}

// ── DELETE /api/documents/:documentId ─────────────────────────────────────────
// Deletes the document record AND all its chunks from MongoDB.

async function deleteDocument(req, res) {
  const userId     = req.user?.uid || req.userId;
  const { documentId } = req.params;

  if (!userId)     return res.status(401).json({ error: "Unauthorized." });
  if (!documentId) return res.status(400).json({ error: "documentId is required." });

  let docObjectId;
  try {
    docObjectId = new ObjectId(documentId);
  } catch {
    return res.status(400).json({ error: "Invalid documentId format." });
  }

  try {
    const db = await connectDB();

    // Verify ownership before deleting
    const doc = await db
      .collection(DOCUMENTS_COLLECTION)
      .findOne({ _id: docObjectId, userId });

    if (!doc) {
      return res.status(404).json({ error: "Document not found or access denied." });
    }

    // Delete document + all chunks in parallel
    await Promise.all([
      db.collection(DOCUMENTS_COLLECTION).deleteOne({ _id: docObjectId }),
      db.collection(CHUNKS_COLLECTION).deleteMany({ documentId: docObjectId }),
    ]);

    return res.json({ success: true, documentId });
  } catch (err) {
    console.error("[documents.controller] deleteDocument:", err);
    return res.status(500).json({ error: "Failed to delete document." });
  }
}

module.exports = { listDocuments, deleteDocument };