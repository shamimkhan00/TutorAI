// services/tutor.service.js
"use strict";

const { ObjectId } = require("mongodb");
const { connectDB } = require("../config/db");
const { createEmbedding } = require("./embedding.service");
const { GEMINI_API_KEY, GEMINI_MODEL } = require("../config/env");

const CHUNKS_COLLECTION    = "document_chunks";
const DOCUMENTS_COLLECTION = "documents";
const VECTOR_INDEX_NAME    = "document_chunks_embedding_vector_index";

// How many chunks to pull for context (tune up/down based on token budget)
const TOP_K_CHUNKS = 12;

// ─── 1. Vector search ─────────────────────────────────────────────────────────

/**
 * Embed the query and pull the top-K most relevant chunks for this document.
 */
async function findRelevantChunks(db, documentId, userId, queryText) {
  const queryEmbedding = await createEmbedding(queryText);

  const docObjectId =
    typeof documentId === "string" ? new ObjectId(documentId) : documentId;

  // Try Atlas vector search first; fall back to a plain text fetch if the
  // index doesn't exist yet (e.g. local dev without Atlas Search).
  try {
    const results = await db
      .collection(CHUNKS_COLLECTION)
      .aggregate([
        {
          $vectorSearch: {
            index:       VECTOR_INDEX_NAME,
            path:        "embedding",
            queryVector: queryEmbedding,
            numCandidates: TOP_K_CHUNKS * 10,
            limit:         TOP_K_CHUNKS,
            filter: {
              documentId: docObjectId,
              userId,
            },
          },
        },
        {
          $project: {
            _id:     0,
            content: 1,
            page:    1,
            type:    1,
            score:   { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();

    if (results.length > 0) return results;
  } catch (_vectorErr) {
    // Atlas vector search unavailable — fall through to plain fetch
    console.warn("[tutor.service] Vector search unavailable, falling back to plain fetch.");
  }

  // Fallback: just grab the first TOP_K_CHUNKS text chunks in page order
  return db
    .collection(CHUNKS_COLLECTION)
    .find(
      { documentId: docObjectId, userId, type: "text" },
      { projection: { _id: 0, content: 1, page: 1, type: 1 } }
    )
    .sort({ page: 1 })
    .limit(TOP_K_CHUNKS)
    .toArray();
}

// ─── 2. Build the teaching prompt ─────────────────────────────────────────────

function buildTutorPrompt({ docTitle, topic, subtopics, difficulty, chunks, startFromBeginning }) {
  const contextBlock = chunks
    .map((c, i) => `[Source ${i + 1}${c.page != null ? `, page ${c.page}` : ""}]\n${c.content}`)
    .join("\n\n");

  const topicLine = startFromBeginning
    ? `Teach the entire document "${docTitle}" from the very beginning, starting with the first and most foundational concepts.`
    : `Teach the topic: "${topic}" from the document "${docTitle}".`;

  const subtopicLine =
    !startFromBeginning && subtopics && subtopics.length > 0
      ? `This topic covers: ${subtopics.join(", ")}.`
      : "";

  const difficultyLine = difficulty
    ? `Calibrate your explanation for a ${difficulty}-level student.`
    : "";

  return `You are an expert tutor. ${topicLine} ${subtopicLine} ${difficultyLine}

Use ONLY the source excerpts below as your knowledge base — do not invent anything not present in them.

Your explanation must follow this exact structure:

## Overview
A 2–3 sentence plain-language intro to what this topic is and why it matters.

## Core Concepts
Explain each key concept clearly. Use sub-headings (###) for each one. For each concept:
- What it is
- How it works
- Why it matters

## Worked Example
A concrete, step-by-step example that illustrates the most important concept. Make it relatable.

## Common Misconceptions
1–3 things students often get wrong about this topic, and the correct understanding.

## Quick Summary
3–5 bullet points the student should remember after reading this.

---
Source excerpts:
${contextBlock}`;
}

// ─── 3. Stream from Gemini ────────────────────────────────────────────────────

/**
 * Calls the Gemini streaming endpoint and pipes chunks to the SSE writer.
 *
 * @param {string}   prompt
 * @param {Function} onChunk  - called with each text delta string
 */
async function streamGeminiExplanation(prompt, onChunk) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.4,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini streaming failed: ${res.status} ${errText}`);
  }

  // Parse the SSE stream line-by-line
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the incomplete last line

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const payload = JSON.parse(jsonStr);
        const delta   =
          payload?.candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? "")
            .join("") ?? "";

        if (delta) onChunk(delta);
      } catch {
        // malformed SSE frame — skip
      }
    }
  }
}

// ─── 4. Public entry point ────────────────────────────────────────────────────

/**
 * Streams a structured topic explanation to the caller via the onChunk callback.
 *
 * @param {object}   opts
 * @param {string}   opts.documentId
 * @param {string}   opts.userId
 * @param {object|null} opts.topic          - Topic object from the course outline, or null for "start from beginning"
 * @param {Function} opts.onChunk           - Receives each text delta (string)
 */
async function explainTopic({ documentId, userId, topic, onChunk }) {
  if (!documentId || !userId) {
    throw new Error("explainTopic requires documentId and userId.");
  }
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  if (typeof onChunk !== "function") {
    throw new Error("explainTopic requires an onChunk callback.");
  }

  const db          = await connectDB();
  const docObjectId = typeof documentId === "string" ? new ObjectId(documentId) : documentId;

  // ── Verify document ownership ──────────────────────────────────────
  const document = await db
    .collection(DOCUMENTS_COLLECTION)
    .findOne({ _id: docObjectId, userId });

  if (!document) {
    const err = new Error("Document not found or access denied.");
    err.code  = "NOT_FOUND";
    throw err;
  }

  const startFromBeginning = !topic;

  // ── Build search query ─────────────────────────────────────────────
  // For "start from beginning" we search for the document's overall intro.
  const searchQuery = startFromBeginning
    ? `introduction overview ${document.title}`
    : `${topic.title} ${(topic.subtopics ?? []).join(" ")}`;

  // ── Retrieve relevant chunks via vector search ─────────────────────
  const chunks = await findRelevantChunks(db, documentId, userId, searchQuery);

  if (chunks.length === 0) {
    throw new Error("No content found for this topic in the document.");
  }

  // ── Build prompt and stream ────────────────────────────────────────
  const prompt = buildTutorPrompt({
    docTitle:          document.title,
    topic:             topic?.title    ?? null,
    subtopics:         topic?.subtopics ?? [],
    difficulty:        topic?.difficulty ?? "beginner",
    chunks,
    startFromBeginning,
  });

  await streamGeminiExplanation(prompt, onChunk);
}

// ─── 5. Chat prompt builder ───────────────────────────────────────────────────

/**
 * Builds the prompt for a follow-up chat question.
 * Includes the last few messages as conversational context so Gemini
 * can understand "explain this more simply" or "I still don't get it".
 */
function buildChatPrompt({ docTitle, question, chunks, history }) {
  const contextBlock = chunks
    .map((c, i) => `[Source ${i + 1}${c.page != null ? `, page ${c.page}` : ""}]\n${c.content}`)
    .join("\n\n");

  // Last 6 messages max to stay within token budget
  const recentHistory = history.slice(-6);
  const historyBlock = recentHistory.length > 0
    ? recentHistory
        .map(m => `${m.role === "user" ? "Student" : "Tutor"}: ${m.content}`)
        .join("\n\n")
    : "";

  return `You are an expert tutor helping a student understand the document: "${docTitle}".

Use ONLY the source excerpts below as your knowledge base. Do not invent anything.

Your job is to directly answer the student's question in a helpful, clear, and conversational way.
- If they say they don't understand something, explain it more simply with a different analogy or example.
- If they ask a follow-up, build on what was already explained.
- If they ask something outside the document, say so politely.
- Keep the response focused — no need for rigid headings unless the answer is complex.
- Use **bold** for key terms, bullet points for lists, and code blocks where relevant.

${historyBlock ? `Conversation so far:\n${historyBlock}\n\n` : ""}Student's question: ${question}

---
Source excerpts from "${docTitle}":
${contextBlock}`;
}

// ─── 6. Answer a follow-up chat question ─────────────────────────────────────

/**
 * Answers a student's free-text question using vector search + Gemini streaming.
 *
 * @param {object}   opts
 * @param {string}   opts.documentId
 * @param {string}   opts.userId
 * @param {string}   opts.question       - The student's message
 * @param {Array}    opts.history        - Previous {role, content} messages for context
 * @param {Function} opts.onChunk        - Called with each streamed text delta
 */
async function answerQuestion({ documentId, userId, question, history = [], onChunk }) {
  if (!documentId || !userId)  throw new Error("answerQuestion requires documentId and userId.");
  if (!question?.trim())        throw new Error("answerQuestion requires a non-empty question.");
  if (!GEMINI_API_KEY)          throw new Error("GEMINI_API_KEY is not configured.");
  if (typeof onChunk !== "function") throw new Error("answerQuestion requires an onChunk callback.");

  const db          = await connectDB();
  const docObjectId = typeof documentId === "string" ? new ObjectId(documentId) : documentId;

  // ── Verify ownership ───────────────────────────────────────────────
  const document = await db
    .collection(DOCUMENTS_COLLECTION)
    .findOne({ _id: docObjectId, userId });

  if (!document) {
    const err = new Error("Document not found or access denied.");
    err.code  = "NOT_FOUND";
    throw err;
  }

  // ── Vector search using the student's question as the query ───────
  // Also blend in the last assistant reply so follow-ups like
  // "explain that more" retrieve the right chunks.
  const lastAssistantMsg = [...history].reverse().find(m => m.role === "assistant");
  const enrichedQuery = lastAssistantMsg
    ? `${question} ${lastAssistantMsg.content.slice(0, 300)}`
    : question;

  const chunks = await findRelevantChunks(db, documentId, userId, enrichedQuery);

  if (chunks.length === 0) {
    throw new Error("No relevant content found in the document for this question.");
  }

  // ── Build prompt and stream ────────────────────────────────────────
  const prompt = buildChatPrompt({
    docTitle: document.title,
    question: question.trim(),
    chunks,
    history,
  });

  await streamGeminiExplanation(prompt, onChunk);
}

module.exports = { explainTopic, answerQuestion };