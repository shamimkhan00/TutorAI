const express = require("express");
const fs = require("fs");
const multer = require("multer");

// ✅ FIXED import
const { PDFParse } = require("pdf-parse");

const app = express();
const upload = multer({ dest: "uploads/" });

app.post(
  "/upload",
  upload.fields([
    { name: "pdf", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]),
  async (req, res) => {
    let filePath;
    let parser;

    try {
      const file = req.files?.pdf?.[0] || req.files?.file?.[0];
      console.log("File received:", file);

    // ❌ No file
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

    // ❌ Wrong file type
      if (file.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF allowed" });
      }

      filePath = file.path;

    // ✅ Read file
      const dataBuffer = await fs.promises.readFile(filePath);

    // ✅ Parse PDF
      parser = new PDFParse({ data: dataBuffer });
      const data = await parser.getText();

    // ✅ Send response
      res.json({
        pages: data.numpages,
        text: data.text.trim(),
      });

    // 🧹 Delete uploaded file
    } catch (error) {
      console.error("FULL ERROR:", error);
      res.status(500).json({ error: error.message || "Failed to parse PDF" });
    } finally {
      if (parser) {
        await parser.destroy().catch(() => {});
      }

      if (filePath) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }
  }
);

// 🚀 Start server
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
