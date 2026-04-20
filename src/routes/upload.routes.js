const express = require("express");

const { pdfUpload } = require("../middleware/upload.middleware");
const { uploadPdf } = require("../controllers/upload.controller");

const router = express.Router();

router.post("/upload", pdfUpload, uploadPdf);

module.exports = router;
