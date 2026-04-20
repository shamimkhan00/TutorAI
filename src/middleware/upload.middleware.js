const multer = require("multer");

const upload = multer({ dest: "uploads/" });

const pdfUpload = upload.fields([
  { name: "pdf", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

module.exports = {
  pdfUpload,
};
