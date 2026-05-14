// routes/upload.routes.js
const express = require("express");
const { pdfUpload } = require("../middleware/upload.middleware");
const { uploadPdf } = require("../controllers/upload.controller");
const { verifyFirebaseToken } = require("../middleware/auth.middleware"); // ADD

const router = express.Router();

router.post("/upload", verifyFirebaseToken, pdfUpload, uploadPdf); // ADD middleware

module.exports = router;
