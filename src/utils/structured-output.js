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

module.exports = {
  buildStructuredOutput,
};
