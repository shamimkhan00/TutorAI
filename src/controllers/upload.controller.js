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

async function uploadPdf(req, res) {
  let filePath;
  let textParser;
  let imageParser;

  try {
    const file = req.files?.pdf?.[0] || req.files?.file?.[0];

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF allowed" });
    }

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
              console.error(
                `Image analysis failed on page ${page.pageNumber} (${image.name}):`,
                error.message
              );

              return {
                description: "Image analysis failed and was skipped.",
                key_points: [],
              };
            }
          })
        ),
      }))
    );

    const structuredOutput = buildStructuredOutput(textPages, analyzedImagePages);

    const documentId = req.body.documentId || file.filename;
    const chunkStructured = chunkStructuredPDF(structuredOutput.pages, documentId);

    // return res.json(structuredOutput);
    return res.json(chunkStructured);
    
  } catch (error) {
    console.error("FULL ERROR:", error);

    if (error?.code === "GEMINI_CONFIG_MISSING") {
      return res.status(500).json({
        error:
          "Image analysis is unavailable because GEMINI_API_KEY is not configured.",
      });
    }

    return res
      .status(500)
      .json({ error: error.message || "Failed to process PDF" });
  } finally {
    await destroyParser(textParser);
    await destroyParser(imageParser);

    if (filePath) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }
}

module.exports = {
  uploadPdf,
};
