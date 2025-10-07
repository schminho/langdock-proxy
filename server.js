// server.js
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
const FormData = require("form-data");
const upload = multer(); // memory storage

const app = express();
const PORT = process.env.PORT || 3000;
const LANGDOCK_API_KEY = process.env.LANGDOCK_API_KEY;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

if (!LANGDOCK_API_KEY) {
  console.error("❌ Missing LANGDOCK_API_KEY");
  process.exit(1);
}

app.use(cors({ origin: ALLOW_ORIGIN, credentials: false }));
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/health", (_req, res) => res.status(200).send("ok"));

// CORS preflight (if needed)
app.options("*", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.sendStatus(204);
});

// --- Main streaming endpoint: forwards to Langdock Assistant API ---
app.post("/assistant", async (req, res) => {
  try {
    // Expect: { assistantId, messages: [{role, content, attachmentIds?}, ...], stream: true }
    const body = {
      ...req.body,
      stream: true, // enforce streaming from server side
    };

    const ldRes = await fetch(
      "https://api.langdock.com/assistant/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LANGDOCK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    // Pass through status if non-200
    if (!ldRes.ok && ldRes.status !== 200) {
      const errText = await ldRes.text().catch(() => "");
      return res.status(ldRes.status).type("application/json").send(errText);
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Stream pipe
    ldRes.body.pipe(res);

    // If you prefer manual read to transform lines, use a reader:
    // const reader = ldRes.body.getReader();
    // const encoder = new TextEncoder();
    // for (;;) {
    //   const { done, value } = await reader.read();
    //   if (done) break;
    //   res.write(value);
    // }
    // res.end();
  } catch (err) {
    console.error("Proxy stream error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "Stream proxy failed", detail: err.message });
    } else {
      try {
        res.end();
      } catch (_) {}
    }
  }
});

// (Optional) non-streaming helper endpoint for server-to-server use
app.post("/assistant-json", async (req, res) => {
  try {
    const body = { ...req.body, stream: false };
    const ldRes = await fetch(
      "https://api.langdock.com/assistant/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LANGDOCK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    const text = await ldRes.text();
    res
      .status(ldRes.status)
      .type(ldRes.headers.get("content-type") || "application/json")
      .send(text);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

// Upload attachment -> Langdock (multipart passthrough)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      knownLength: req.file.size,
    });

    const ld = await fetch("https://api.langdock.com/attachment/v1/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LANGDOCK_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const text = await ld.text();
    res
      .status(ld.status)
      .type(ld.headers.get("content-type") || "application/json")
      .send(text);
  } catch (e) {
    console.error("Upload proxy error:", e);
    res.status(500).json({ message: "Upload failed", detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Langdock streaming proxy listening on ${PORT}`);
});
