const { createCanvas, loadImage } = require("@napi-rs/canvas");

const {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
} = require("../config/env");
const { JPEG_QUALITIES, DEFAULT_IMAGE_PROMPT } = require("../constants/gemini");

function createGeminiConfigError() {
  const error = new Error("GEMINI_API_KEY is not configured");
  error.code = "GEMINI_CONFIG_MISSING";
  return error;
}

function validateGeminiConfiguration() {
  if (!GEMINI_API_KEY) {
    throw createGeminiConfigError();
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

module.exports = {
  analyzeImageWithGemini,
  validateGeminiConfiguration,
};
