// controllers/upload.controller.js
const fs = require("fs");

const {
  createPdfParsers,
  extractTextFromPDF,
  extractImagesFromPDF,
  destroyParser,
} = require("../services/pdf.service");
const {
  analyzeImageWithGemini,
  validateGeminiConfiguration,
} = require("../services/gemini.service");
const { buildStructuredOutput } = require("../utils/structured-output");
const { chunkStructuredPDF } = require("../utils/chunk-structured-pdf");
const { embedChunks } = require("../utils/embed-chunks");
const { saveProcessedDocument } = require("../services/document-storage.service");

async function uploadPdf(req, res) {
  let filePath;
  let textParser;
  let imageParser;

  try {
    const file = req.files?.pdf?.[0] || req.files?.file?.[0];

    if (!file) return res.status(400).json({ error: "No file uploaded" });
    if (file.mimetype !== "application/pdf")
      return res.status(400).json({ error: "Only PDF allowed" });

    validateGeminiConfiguration();

    filePath = file.path;
    const dataBuffer = await fs.promises.readFile(filePath);
    const parsers = createPdfParsers(dataBuffer);
    textParser = parsers.textParser;
    imageParser = parsers.imageParser;

    const textPages = await extractTextFromPDF(textParser);
    const imagePages = await extractImagesFromPDF(imageParser);

    const analyzedImagePages = await Promise.all(
      imagePages.map(async (page) => ({
        pageNumber: page.pageNumber,
        images: await Promise.all(
          page.images.map(async (image) => {
            try {
              return await analyzeImageWithGemini(image);
            } catch (error) {
              return { description: "Image analysis failed.", key_points: [] };
            }
          })
        ),
      }))
    );

    const structuredOutput = buildStructuredOutput(textPages, analyzedImagePages);
    const documentId = req.body.documentId || file.filename;
    const chunkStructured = chunkStructuredPDF(structuredOutput.pages, documentId);
    const chunks = await embedChunks(chunkStructured);

    const userId = req.user?.uid || req.userId;
    const savedDocument = await saveProcessedDocument({
      userId,
      fileName: file.originalname,
      fileType: file.mimetype,
      structuredOutput,
      chunks,
    });

    return res.json({
      success: true,
      documentId: savedDocument.document._id,
      filename: file.originalname,
      pageCount: structuredOutput.pages.length,
      chunkCount: savedDocument.document.chunkCount,
      structuredOutput,
      chunks,
    });

  } catch (error) {
    console.error("FULL ERROR:", error);
    if (error?.code === "GEMINI_CONFIG_MISSING") {
      return res.status(500).json({ error: "GEMINI_API_KEY not configured." });
    }
    return res.status(500).json({ error: error.message || "Failed to process PDF" });
  } finally {
    await destroyParser(textParser);
    await destroyParser(imageParser);
    if (filePath) await fs.promises.unlink(filePath).catch(() => {});
  }
}

module.exports = { uploadPdf };
