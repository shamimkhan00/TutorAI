// routes/documents.routes.js
const express = require("express");
const { verifyFirebaseToken } = require("../middleware/auth.middleware");
const { listDocuments, deleteDocument } = require("../controllers/documents.controller");

const router = express.Router();

// GET    /api/documents                — list all docs for the user
router.get("/api/documents", verifyFirebaseToken, listDocuments);

// DELETE /api/documents/:documentId   — delete doc + all chunks
router.delete("/api/documents/:documentId", verifyFirebaseToken, deleteDocument);

module.exports = router;