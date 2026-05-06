function cleanText(content) {
  if (typeof content !== "string") {
    return "";
  }

  return content
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

function normalizeLine(line) {
  return cleanText(line).replace(
    /^(\u2022|\u00e2\u20ac\u00a2)\s*/,
    "\u2022 "
  );
}

function isBulletLine(line) {
  return /^(\u2022|\u00e2\u20ac\u00a2)\s+/.test(line);
}

function isQuoteLine(line) {
  return line.startsWith('"');
}

function endsSentence(text) {
  return /[.!?]["')\]]*$/.test(text.trim());
}

function wordCount(text) {
  const words = cleanText(text).match(/\S+/g);
  return words ? words.length : 0;
}

function hasClosingQuote(text) {
  const matches = text.match(/"/g);
  return matches && matches.length >= 2;
}

function joinLines(lines) {
  return cleanText(lines.join(" ").replace(/-\s+/g, ""));
}

function processBullets(lines, startIndex) {
  const bulletLines = [normalizeLine(lines[startIndex])];
  let index = startIndex + 1;

  // Wrapped bullet text usually continues on following non-bullet lines.
  while (index < lines.length) {
    const line = normalizeLine(lines[index]);

    if (!line || isBulletLine(line) || isQuoteLine(line)) {
      break;
    }

    bulletLines.push(line);
    index += 1;
  }

  return {
    chunk: {
      type: "list",
      content: joinLines(bulletLines),
    },
    nextIndex: index,
  };
}

function processQuotes(lines, startIndex) {
  const quoteLines = [normalizeLine(lines[startIndex])];
  let index = startIndex + 1;

  // A quote is one semantic unit, even when the PDF split it across lines.
  while (index < lines.length && !hasClosingQuote(joinLines(quoteLines))) {
    const line = normalizeLine(lines[index]);

    if (!line) {
      break;
    }

    quoteLines.push(line);
    index += 1;
  }

  return {
    chunk: {
      type: "quote",
      content: joinLines(quoteLines),
    },
    nextIndex: index,
  };
}

function mergeLines(lines, startIndex, maxWords) {
  const paragraphLines = [];
  let index = startIndex;

  // Regular prose is merged until a sentence completes or the chunk is full.
  while (index < lines.length) {
    const line = normalizeLine(lines[index]);

    if (!line || isBulletLine(line) || isQuoteLine(line)) {
      break;
    }

    paragraphLines.push(line);
    index += 1;

    const content = joinLines(paragraphLines);
    if (endsSentence(content) || wordCount(content) >= maxWords) {
      break;
    }
  }

  return {
    chunk: {
      type: "text",
      content: joinLines(paragraphLines),
    },
    nextIndex: index,
  };
}

function appendTextUnit(units, unit, minCharacters) {
  const content = cleanText(unit && unit.content);

  if (!content) {
    return;
  }

  // Fold tiny prose fragments into previous prose without merging bullets.
  if (
    unit.type === "text" &&
    content.length < minCharacters &&
    units.length > 0 &&
    units[units.length - 1].type === unit.type
  ) {
    units[units.length - 1].content = joinLines([
      units[units.length - 1].content,
      content,
    ]);
    return;
  }

  units.push({
    type: unit.type,
    content,
  });
}

function createChunk(documentId, page, type, index, content) {
  const cleanedContent = cleanText(content);

  if (!cleanedContent) {
    return null;
  }

  return {
    documentId,
    page,
    chunkId: `${page}-${type}-${index}`,
    type,
    content: cleanedContent,
    metadata: {
      source: "pdf",
    },
  };
}

function chunkPageText(page, documentId) {
  const lines =
    typeof page.text === "string" ? page.text.replace(/\r/g, "\n").split("\n") : [];
  const units = [];
  const chunks = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = normalizeLine(lines[lineIndex]);

    if (!line) {
      lineIndex += 1;
      continue;
    }

    let result;

    if (isBulletLine(line)) {
      result = processBullets(lines, lineIndex);
    } else if (isQuoteLine(line)) {
      result = processQuotes(lines, lineIndex);
    } else {
      result = mergeLines(lines, lineIndex, 200);
    }

    appendTextUnit(units, result.chunk, 40);
    lineIndex = result.nextIndex > lineIndex ? result.nextIndex : lineIndex + 1;
  }

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const chunk = createChunk(
      documentId,
      page.pageNumber,
      unit.type,
      index,
      unit.content
    );

    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function chunkPageImages(page, documentId) {
  const images = Array.isArray(page.images) ? page.images : [];
  const chunks = [];
  let index = 0;

  for (const image of images) {
    const descriptionChunk = createChunk(
      documentId,
      page.pageNumber,
      "image_description",
      index,
      image && image.description
    );

    if (descriptionChunk) {
      chunks.push(descriptionChunk);
      index += 1;
    }

    const keyPoints = Array.isArray(image && image.key_points)
      ? image.key_points
      : [];

    for (const keyPoint of keyPoints) {
      const conceptChunk = createChunk(
        documentId,
        page.pageNumber,
        "concept",
        index,
        keyPoint
      );

      if (conceptChunk) {
        chunks.push(conceptChunk);
        index += 1;
      }
    }
  }

  return chunks;
}

function chunkStructuredPDF(pages, documentId) {
  const safePages = Array.isArray(pages) ? pages : [];
  const chunks = [];

  for (const page of safePages) {
    if (!page || typeof page.pageNumber !== "number") {
      continue;
    }

    chunks.push(...chunkPageText(page, documentId));
    chunks.push(...chunkPageImages(page, documentId));
  }

  return chunks;
}

module.exports = {
  chunkStructuredPDF,
};
