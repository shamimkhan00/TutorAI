const JPEG_QUALITIES = [0.82, 0.72, 0.62, 0.52, 0.42];

const DEFAULT_IMAGE_PROMPT = [
  "Analyze this image from a document. Extract all meaningful information.",
  "Describe diagrams, charts, labels, and concepts clearly.",
  "Convert the content into structured bullet points for learning.",
  'Respond in JSON with keys "description" and "key_points".',
  '"description" must be a string and "key_points" must be an array of strings.',
].join(" ");

module.exports = {
  JPEG_QUALITIES,
  DEFAULT_IMAGE_PROMPT,
};
