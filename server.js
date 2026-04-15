require("dotenv").config();

const express = require("express");
const fs = require("fs");
const multer = require("multer");

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { PDFParse } = require("pdf-parse");

const app = express();
const upload = multer({ dest: "uploads/" });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const MAX_IMAGE_DIMENSION = Number.parseInt(
  process.env.MAX_IMAGE_DIMENSION || "1600",
  10
);
const MAX_IMAGE_BYTES = Number.parseInt(
  process.env.MAX_IMAGE_BYTES || `${1024 * 1024}`,
  10
);
const JPEG_QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.42];
const DEFAULT_IMAGE_PROMPT = [
  "Analyze this image from a document. Extract all meaningful information.",
  "Describe diagrams, charts, labels, and concepts clearly.",
  "Convert the content into structured bullet points for learning.",
  'Respond in JSON with keys "description" and "key_points".',
  '"description" must be a string and "key_points" must be an array of strings.',
].join(" ");

function validateGeminiConfiguration() {
  if (!GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is not configured");
    error.code = "GEMINI_CONFIG_MISSING";
    throw error;
  }
}

// Keep the original text extraction path, but normalize it into page-first output.
async function extractTextFromPDF(parser) {
  const result = await parser.getText();

  return result.pages
    .map((page) => ({
      pageNumber: page.num,
      text: page.text.trim(),
    }))
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

async function extractImagesFromPDF(parser) {
  try {
    const result = await parser.getImage({
      imageBuffer: true,
      imageDataUrl: false,
      imageThreshold: 24,
    });

    return result.pages
      .map((page) => ({
        pageNumber: page.pageNumber,
        images: page.images.map((image, index) => ({
          id: `${page.pageNumber}-${index + 1}`,
          name: image.name || `page-${page.pageNumber}-image-${index + 1}`,
          width: image.width,
          height: image.height,
          kind: image.kind,
          mimeType: "image/png",
          buffer: Buffer.from(image.data),
        })),
      }))
      .sort((left, right) => left.pageNumber - right.pageNumber);
  } catch (error) {
    if (error?.name !== "DataCloneError") {
      throw error;
    }

    console.warn(
      "Embedded image extraction hit a worker cloning issue. Falling back to page screenshots.",
      error.message
    );

    const screenshots = await parser.getScreenshot({
      imageBuffer: true,
      imageDataUrl: false,
      desiredWidth: MAX_IMAGE_DIMENSION,
    });

    return screenshots.pages
      .map((page) => ({
        pageNumber: page.pageNumber,
        images: page.data?.length
          ? [
              {
                id: `${page.pageNumber}-render-1`,
                name: `page-${page.pageNumber}-render`,
                width: page.width,
                height: page.height,
                kind: "page-render",
                mimeType: "image/png",
                buffer: Buffer.from(page.data),
              },
            ]
          : [],
      }))
      .sort((left, right) => left.pageNumber - right.pageNumber);
  }
}

async function compressImageForGemini(imageBuffer) {
  if (imageBuffer.length <= MAX_IMAGE_BYTES) {
    return {
      mimeType: "image/png",
      base64: imageBuffer.toString("base64"),
    };
  }

  const sourceImage = await loadImage(imageBuffer);
  const sourceWidth = sourceImage.width || MAX_IMAGE_DIMENSION;
  const sourceHeight = sourceImage.height || MAX_IMAGE_DIMENSION;
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight)
  );
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext("2d");

  context.drawImage(sourceImage, 0, 0, targetWidth, targetHeight);

  for (const quality of JPEG_QUALITIES) {
    const compressedBuffer = canvas.toBuffer("image/jpeg", quality);

    if (compressedBuffer.length <= MAX_IMAGE_BYTES) {
      return {
        mimeType: "image/jpeg",
        base64: compressedBuffer.toString("base64"),
      };
    }
  }

  const fallbackBuffer = canvas.toBuffer("image/jpeg", 0.35);

  return {
    mimeType: "image/jpeg",
    base64: fallbackBuffer.toString("base64"),
  };
}

function extractGeminiText(payload) {
  const parts =
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean) || [];

  return parts.join("\n").trim();
}

function normalizeGeminiResponse(rawText) {
  if (!rawText) {
    return {
      description: "No meaningful information could be extracted from this image.",
      key_points: [],
    };
  }

  try {
    const normalizedJson = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(normalizedJson);

    return {
      description: String(parsed.description || "").trim(),
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points
            .map((point) => String(point).trim())
            .filter(Boolean)
        : [],
    };
  } catch (error) {
    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\s]+/, "").trim())
      .filter(Boolean);

    return {
      description: lines[0] || rawText.trim(),
      key_points: lines.slice(1),
    };
  }
}

async function analyzeImageWithGemini(image) {
  validateGeminiConfiguration();

  // Resize and recompress large PDF images before sending them to Gemini.
  const optimizedImage = await compressImageForGemini(image.buffer);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: DEFAULT_IMAGE_PROMPT },
              {
                inlineData: {
                  mimeType: optimizedImage.mimeType,
                  data: optimizedImage.base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              description: { type: "STRING" },
              key_points: {
                type: "ARRAY",
                items: { type: "STRING" },
              },
            },
            required: ["description", "key_points"],
          },
          temperature: 0.2,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const rawText = extractGeminiText(payload);

  return normalizeGeminiResponse(rawText);
}

function buildStructuredOutput(textPages, imagePages) {
  const pageMap = new Map();

  for (const page of textPages) {
    pageMap.set(page.pageNumber, {
      pageNumber: page.pageNumber,
      text: page.text,
      images: [],
    });
  }

  for (const page of imagePages) {
    if (!pageMap.has(page.pageNumber)) {
      pageMap.set(page.pageNumber, {
        pageNumber: page.pageNumber,
        text: "",
        images: [],
      });
    }

    pageMap.get(page.pageNumber).images = page.images;
  }

  return {
    pages: Array.from(pageMap.values()).sort(
      (left, right) => left.pageNumber - right.pageNumber
    ),
  };
}

app.post(
  "/upload",
  upload.fields([
    { name: "pdf", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]),
  async (req, res) => {
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
      textParser = new PDFParse({ data: dataBuffer });
      imageParser = new PDFParse({ data: dataBuffer });

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

      return res.json(structuredOutput);
    } catch (error) {
      console.error("FULL ERROR:", error);

      if (error?.code === "GEMINI_CONFIG_MISSING") {
        return res.status(500).json({
          error: "Image analysis is unavailable because GEMINI_API_KEY is not configured.",
        });
      }

      return res
        .status(500)
        .json({ error: error.message || "Failed to process PDF" });
    } finally {
      if (textParser) {
        await textParser.destroy().catch(() => {});
      }

      if (imageParser) {
        await imageParser.destroy().catch(() => {});
      }

      if (filePath) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }
  }
);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
