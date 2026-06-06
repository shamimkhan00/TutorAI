const { ObjectId } = require("mongodb");

const { connectDB } = require("../config/db");
const { GEMINI_API_KEY, GEMINI_MODEL } = require("../config/env");

const CHUNKS_COLLECTION = "document_chunks";
const DOCUMENTS_COLLECTION = "documents";

async function callGemini(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const rawText =
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim() ?? "";

  return rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildTopicPrompt(docTitle, chunkTexts) {
  const combined = chunkTexts
    .map((text, index) => `[Chunk ${index + 1}]\n${text}`)
    .join("\n\n");

  return `You are an expert educator. Analyze the following content from a document titled "${docTitle}" and extract a structured course outline of topics a student should learn.

Return ONLY a JSON object with this exact shape, with no extra text:
{
  "courseTitle": "string - clean title derived from the document",
  "description": "string - 1-2 sentence overview of what the document covers",
  "topics": [
    {
      "id": "string - short kebab-case id, e.g. 'intro-to-neural-nets'",
      "order": number,
      "title": "string - clear topic name",
      "summary": "string - 2-3 sentences describing what this topic covers",
      "subtopics": ["string", "string"],
      "difficulty": "beginner" | "intermediate" | "advanced",
      "estimatedMinutes": number
    }
  ]
}

Rules:
- Extract 4-12 meaningful topics based on the actual content.
- Order topics logically so a student can progress from foundational to advanced.
- subtopics should be 2-5 key concepts within that topic.
- estimatedMinutes is how long a student would need to understand this topic (10-60 min range).
- Do not invent content that is not in the chunks.

Document content:
${combined}`;
}

function batchChunks(chunks, maxCharsPerBatch = 60000) {
  const batches = [];
  let current = [];
  let charCount = 0;

  for (const chunk of chunks) {
    const len = chunk.content.length;

    if (charCount + len > maxCharsPerBatch && current.length > 0) {
      batches.push(current);
      current = [];
      charCount = 0;
    }

    current.push(chunk);
    charCount += len;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function mergeTopicBatches(results) {
  if (results.length === 1) {
    return results[0];
  }

  const merged = { ...results[0] };
  const allTopics = results.flatMap((result) => result.topics ?? []);
  const seen = new Set();

  merged.topics = allTopics
    .filter((topic) => {
      const key = String(topic.title ?? "").toLowerCase().trim();

      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .map((topic, index) => ({ ...topic, order: index + 1 }));

  return merged;
}

function toDocumentObjectId(documentId) {
  if (documentId instanceof ObjectId) {
    return documentId;
  }

  if (typeof documentId === "string" && ObjectId.isValid(documentId)) {
    return new ObjectId(documentId);
  }

  const error = new Error("Invalid documentId.");
  error.code = "INVALID_DOCUMENT_ID";
  throw error;
}

async function generateTopicsForDocument(documentId, userId) {
  if (!documentId || !userId) {
    throw new Error("generateTopicsForDocument requires documentId and userId.");
  }

  if (!GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is not configured.");
    error.code = "GEMINI_CONFIG_MISSING";
    throw error;
  }

  const db = await connectDB();
  const docObjectId = toDocumentObjectId(documentId);

  const document = await db.collection(DOCUMENTS_COLLECTION).findOne({
    _id: docObjectId,
    userId,
  });

  if (!document) {
    const error = new Error("Document not found or access denied.");
    error.code = "NOT_FOUND";
    throw error;
  }

  if (
    Array.isArray(document.topics) &&
    document.topics.length > 0 &&
    document.topicsGeneratedAt
  ) {
    return {
      courseTitle: document.courseTitle ?? document.title,
      description: document.courseDescription ?? "",
      topics: document.topics,
      fromCache: true,
    };
  }

  const chunks = await db
    .collection(CHUNKS_COLLECTION)
    .find(
      { documentId: docObjectId, userId},
      { projection: { content: 1, page: 1, chunkId: 1, _id: 0 } }
    )
    .sort({ page: 1, chunkId: 1 })
    .toArray();

  if (chunks.length === 0) {
    const error = new Error("No text chunks found for this document.");
    error.code = "NO_CHUNKS";
    throw error;
  }

  const batches = batchChunks(chunks);
  const docTitle = document.title ?? "Untitled";

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const prompt = buildTopicPrompt(
        docTitle,
        batch.map((chunk) => chunk.content)
      );
      const raw = await callGemini(prompt);

      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(
          `Gemini returned invalid JSON for topic extraction: ${raw.slice(0, 200)}`
        );
      }
    })
  );

  const result = mergeTopicBatches(batchResults);

  if (!Array.isArray(result.topics) || result.topics.length === 0) {
    throw new Error("Gemini did not return any topics for this document.");
  }

  const topics = result.topics.map((topic, index) => ({
    id: topic.id ?? `topic-${index + 1}`,
    order: topic.order ?? index + 1,
    title: topic.title ?? `Topic ${index + 1}`,
    summary: topic.summary ?? "",
    subtopics: Array.isArray(topic.subtopics) ? topic.subtopics : [],
    difficulty: ["beginner", "intermediate", "advanced"].includes(
      topic.difficulty
    )
      ? topic.difficulty
      : "beginner",
    estimatedMinutes:
      typeof topic.estimatedMinutes === "number"
        ? topic.estimatedMinutes
        : 15,
  }));

  await db.collection(DOCUMENTS_COLLECTION).updateOne(
    { _id: docObjectId, userId },
    {
      $set: {
        topics,
        courseTitle: result.courseTitle ?? docTitle,
        courseDescription: result.description ?? "",
        topicsGeneratedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  return {
    courseTitle: result.courseTitle ?? docTitle,
    description: result.description ?? "",
    topics,
    fromCache: false,
  };
}

module.exports = { generateTopicsForDocument };
