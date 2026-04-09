const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const upload = multer({ dest: "uploads/" });

/* ---------------- CLEAN + STRUCTURE ---------------- */

function normalizeInlineSpacing(text) {
  return String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function isDividerLine(line) {
  return /^\s*(?:[-_=*]\s*){3,}$/.test(String(line || ""));
}

function getHeadingLevel(line) {
  const text = normalizeInlineSpacing(line);
  if (!text || text.length > 120) return null;
  if (/[.!?]$/.test(text) && !/:$/.test(text)) return null;

  const numberedHeadingRegex = /^(\d+(?:\.\d+)*)[.)]?\s+(.+)$/;
  if (numberedHeadingRegex.test(text)) return 2;

  if (/^(output|example|summary|note|warning)[:]?$/i.test(text)) return 3;
  if (/^[A-Z][A-Z\s/&()-]{2,}$/.test(text) && /[A-Z]/.test(text)) return 3;
  if (/^[A-Z][A-Za-z0-9/&(),:'"-]+(?:\s+[A-Z][A-Za-z0-9/&(),:'"-]+){0,7}$/.test(text)) {
    return 3;
  }

  return null;
}

function isCodeLikeLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (/^\s*(```|~~~)/.test(text)) return true;

  if (/^(db\.[\w$]+|use\s+\w+|show\s+\w+|mongo(?:sh|export|import)\b)/i.test(text)) {
    return true;
  }

  if (
    /\/\/|=>|\bnew Date\(|\$\w+|insertMany\(|insertOne\(|updateOne\(|updateMany\(|deleteOne\(|deleteMany\(|aggregate\(|createIndex\(|find\(|sort\(|limit\(/.test(
      text
    )
  ) {
    return true;
  }

  const codeTokenCount = (
    text.match(/[{}[\]();]|(?:^|\s)(?:\$[A-Za-z_]\w*|_id|createdAt|price|quantity|category|status)(?:\s|:|$)/g) ||
    []
  ).length;
  const wordCount = (text.match(/[A-Za-z]+/g) || []).length;

  if (codeTokenCount >= 3 && wordCount <= 12) return true;
  if (/^[\]}),]+$/.test(text)) return true;

  return false;
}

function isCodeContinuationLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (/^[\]}),]+$/.test(text)) return true;
  if (/^[{[]/.test(text)) return true;
  if (/:\s/.test(text) && /[{},[\]]/.test(text)) return true;
  if (/^(from|localField|foreignField|as|totalSales|totalFruitSales|_id)\s*:/.test(text)) {
    return true;
  }
  return false;
}

function normalizeParagraphBreaks(lines) {
  const merged = [];
  let paragraph = [];
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;

    const text = paragraph
      .map((line) => normalizeInlineSpacing(line))
      .filter(Boolean)
      .join(" ")
      .replace(/-\s+([a-z])/g, "$1")
      .replace(/\s+([)}\]])/g, "$1")
      .replace(/([({\[])\s+/g, "$1");

    if (text) merged.push(text);
    paragraph = [];
  };

  const flushCode = () => {
    if (!codeLines.length) return;
    merged.push("```javascript");
    merged.push(...codeLines.map((line) => line.trimEnd()));
    merged.push("```");
    codeLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushCode();
      flushParagraph();
      merged.push("");
      continue;
    }

    if (isDividerLine(trimmed)) {
      flushCode();
      flushParagraph();
      continue;
    }

    if (isCodeLikeLine(trimmed) || (codeLines.length && isCodeContinuationLine(trimmed))) {
      flushParagraph();
      codeLines.push(trimmed);
      continue;
    }

    if (
      /^#{1,6}\s+/.test(trimmed) ||
      /^-\s+/.test(trimmed) ||
      /^\d+[.)]\s+/.test(trimmed) ||
      /^\s*(```|~~~)/.test(trimmed)
    ) {
      flushCode();
      flushParagraph();
      merged.push(trimmed);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushCode();
  flushParagraph();
  return merged;
}

function extractStructuredSections(rawText) {
  const pageLineRegex =
    /^\s*(?:[-\u2013\u2014]*\s*)?(?:page\s*)?\d+\s*(?:of|\/)\s*\d+\s*(?:[-\u2013\u2014]*\s*)?$/i;

  const bulletRegex =
    /^\s*[\u2022\u25CF\u25E6\u25AA\u25AB\u2023\u2219\u25C6\u25C7\u2605\u2606\u25BA\u25B6\u25B8\u25B9\u27A4\u27A2\u27A3\u27A5\u27A6\u27A7\u26AB\u26AA]\s*/;

  const headingRegex = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(.+?)\s*$/;
  const junkLineRegex = /^\s*\d+\.\s*$/;
  const footerRegex = /^\s*(confidential|copyright|all rights reserved)\b.*$/i;

  const lines = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  const cleaned = [];
  let inCode = false;

  for (let line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);

    if (isFence) {
      inCode = !inCode;
      cleaned.push(line);
      continue;
    }

    if (!inCode) {
      line = line.replace(/\t/g, " ").replace(/\s+$/g, "");

      if (pageLineRegex.test(line)) continue;
      if (junkLineRegex.test(line)) continue;
      if (footerRegex.test(line)) continue;

      if (bulletRegex.test(line)) {
        line = line.replace(bulletRegex, "- ");
      } else {
        line = normalizeInlineSpacing(line);
      }

      const headingLevel = getHeadingLevel(line);
      if (headingLevel && !/^#/.test(line.trim())) {
        const numberedMatch = line.match(headingRegex);
        if (numberedMatch) {
          line = `## ${numberedMatch[1]}. ${normalizeInlineSpacing(numberedMatch[2])}`;
        } else {
          line = `${"#".repeat(headingLevel)} ${line.trim()}`;
        }
      }
    }

    cleaned.push(line);
  }

  const normalized = [];
  let prevBlank = false;

  for (const line of normalizeParagraphBreaks(cleaned)) {
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    normalized.push(line);
    prevBlank = blank;
  }

  const sections = [];
  let current = { number: null, title: "General", heading: "## General", contentLines: [] };
  inCode = false;

  const pushCurrent = () => {
    const content = current.contentLines.join("\n").trim();
    if (content.length < 30) return;

    sections.push({
      number: current.number,
      title: current.title,
      heading: current.heading,
      content,
      chunks: createAIChunksForSection(current, content),
    });
  };

  for (const line of normalized) {
    const isFence = /^\s*(```|~~~)/.test(line);

    if (isFence) {
      inCode = !inCode;
      current.contentLines.push(line);
      continue;
    }

    const sectionHeadingMatch = !inCode ? line.match(/^##\s+(.+?)\s*$/) : null;
    const match = sectionHeadingMatch ? sectionHeadingMatch[1].match(headingRegex) : null;

    if (sectionHeadingMatch) {
      pushCurrent();

      const plainHeading = sectionHeadingMatch[1].trim();
      current = {
        number: match ? match[1] : null,
        title: match ? match[2].trim() : plainHeading,
        heading: `## ${plainHeading}`,
        contentLines: [],
      };
    } else {
      current.contentLines.push(line);
    }
  }

  pushCurrent();
  if (!sections.length) {
    const fallbackContent = normalized.join("\n").trim();
    if (fallbackContent) {
      const fallback = {
        number: null,
        title: "General",
        heading: "## General",
        content: fallbackContent,
      };

      sections.push({
        ...fallback,
        chunks: createAIChunksForSection(fallback, fallbackContent),
      });
    }
  }

  return sections;
}

/* ---------------- CHUNKING ---------------- */

function splitIntoSemanticBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let inCode = false;
  let codeLines = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    const paragraph = paragraphLines.join("\n").trim();
    if (paragraph) {
      const type = /^###\s+/.test(paragraph) ? "subheading" : "paragraph";
      blocks.push({ type, text: paragraph });
    }
    paragraphLines = [];
  };

  const flushCode = () => {
    const code = codeLines.join("\n").trim();
    if (code) blocks.push({ type: "code", text: code });
    codeLines = [];
  };

  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);

    if (isFence) {
      if (!inCode) {
        flushParagraph();
        inCode = true;
        codeLines.push(line);
      } else {
        codeLines.push(line);
        flushCode();
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraphLines.push(line);
    }
  }

  flushParagraph();
  if (codeLines.length) flushCode();

  return blocks;
}

function splitLongText(text, maxChars = 900) {
  const parts = [];
  let remaining = String(text || "").trim();

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars + 1);
    let cut = slice.lastIndexOf("\n");
    if (cut < 0) cut = slice.lastIndexOf("\n### ");
    if (cut < 0) cut = slice.lastIndexOf(". ");
    if (cut < 0) cut = slice.lastIndexOf(": ");
    if (cut < 0) cut = slice.lastIndexOf(" ");
    if (cut < 0 || cut < Math.floor(maxChars * 0.6)) cut = maxChars;

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function chunkWithOverlap(blocks, maxChars = 900, overlapChars = 120) {
  const chunkTexts = [];
  let current = "";

  const buildOverlap = (text) => {
    const source = String(text || "").trim();
    if (!source) return "";

    const tail = source.slice(Math.max(0, source.length - overlapChars)).trim();
    const sentenceCut = Math.max(tail.lastIndexOf("\n"), tail.lastIndexOf(". "));
    const overlap = sentenceCut >= 0 ? tail.slice(sentenceCut + 1).trim() : tail;
    return overlap.replace(/^[^\w#`({\[]+/, "").trim();
  };

  const pushChunk = () => {
    const text = current.trim();
    if (text) chunkTexts.push(text);
    current = "";
  };

  for (const block of blocks) {
    const blockText = block.text.trim();
    if (!blockText) continue;

    const parts =
      blockText.length > maxChars ? splitLongText(blockText, maxChars) : [blockText];

    for (const part of parts) {
      const separator = current ? "\n\n" : "";
      const candidate = `${current}${separator}${part}`;

      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        const prev = current.trim();
        pushChunk();

        const overlap = prev ? buildOverlap(prev) : "";

        current = overlap ? `${overlap}\n\n${part}` : part;
      }
    }
  }

  pushChunk();
  return chunkTexts;
}

function createAIChunksForSection(section, content) {
  const blocks = splitIntoSemanticBlocks(content);
  const chunkTexts = chunkWithOverlap(blocks, 900, 120);

  return chunkTexts.map((text, index) => ({
    id: `${section.number || "0"}-${index}`,
    index,
    sectionNumber: section.number,
    sectionTitle: section.title,
    heading: section.heading,
    type: /```|~~~/.test(text) ? "mixed" : "text",
    charCount: text.length,
    text: `${section.heading || "## General"}\n\n${text}`,
  }));
}

function buildAIDocumentText(sections) {
  return sections
    .map((section) => {
      const heading = section.heading || "## General";
      const body = String(section.content || "").trim();
      return body ? `${heading}\n\n${body}` : heading;
    })
    .join("\n\n");
}

function buildAIPayload(sections) {
  const allChunks = [];

  for (const section of sections) {
    for (const chunk of section.chunks) {
      allChunks.push(chunk);
    }
  }

  return {
    totalSections: sections.length,
    totalChunks: allChunks.length,
    documentText: buildAIDocumentText(sections),
    sectionTitles: sections.map((section) => section.heading),
    chunks: allChunks,
  };
}

/* ---------------- ROUTE ---------------- */

app.post("/upload", upload.single("file"), async (req, res) => {
  let filePath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    filePath = req.file.path;
    const fileType = req.file.mimetype;

    let text = "";

    // PDF
    if (fileType === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buffer });
      const data = await parser.getText();
      text = data.text;
      await parser.destroy();
    }

    // DOCX
    else if (
      fileType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    }

    else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const sections = extractStructuredSections(text);
    const aiInput = buildAIPayload(sections);

    res.json({
      totalSections: sections.length,
      sections,
      aiInput,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process file" });

  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

/* ---------------- SERVER ---------------- */

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
