const { PDFParse } = require("pdf-parse");

const { MAX_IMAGE_DIMENSION } = require("../config/env");

function createPdfParsers(dataBuffer) {
  return {
    textParser: new PDFParse({ data: dataBuffer }),
    imageParser: new PDFParse({ data: dataBuffer }),
  };
}

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

async function destroyParser(parser) {
  if (parser) {
    await parser.destroy().catch(() => {});
  }
}

module.exports = {
  createPdfParsers,
  extractTextFromPDF,
  extractImagesFromPDF,
  destroyParser,
};
