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

// Support comma-separated list of origins
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const allowedOrigins =
  ALLOW_ORIGIN === "*" ? "*" : ALLOW_ORIGIN.split(",").map((o) => o.trim());

if (!LANGDOCK_API_KEY) {
  console.error("❌ Missing LANGDOCK_API_KEY");
  process.exit(1);
}

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all origins if "*" is set
    if (allowedOrigins === "*") return callback(null, true);

    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: false,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/health", (_req, res) => res.status(200).send("ok"));

// CORS preflight (if needed)
app.options("*", (req, res) => {
  const origin = req.headers.origin;

  if (allowedOrigins === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.sendStatus(204);
});

// --- Main streaming endpoint: forwards to Langdock Assistant API ---
app.post("/assistant", async (req, res) => {
  try {
    const body = { ...req.body, stream: true };

    // --- debug summary ---
    try {
      const msgSummary = Array.isArray(body.messages)
        ? body.messages.map((m) => ({
            role: m.role,
            hasAttachments:
              Array.isArray(m.attachmentIds) && m.attachmentIds.length > 0,
            attCount: Array.isArray(m.attachmentIds)
              ? m.attachmentIds.length
              : 0,
            contentPreview: (m.content || "").slice(0, 60),
          }))
        : [];
      console.log(
        "[/assistant] asst:",
        body.assistantId,
        "rootAttIds:",
        Array.isArray(body.attachmentIds) ? body.attachmentIds.length : 0,
        "messages:",
        msgSummary.length,
        msgSummary
      );
    } catch (e) {
      console.log("[/assistant] summary failed", e?.message);
    }

    const ldRes = await fetch(
      "https://api.langdock.com/assistant/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LANGDOCK_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream", // <-- ask for SSE
        },
        body: JSON.stringify(body),
      }
    );

    // If upstream isn't OK, forward its body
    if (!ldRes.ok) {
      const errText = await ldRes.text().catch(() => "");
      return res.status(ldRes.status).type("application/json").send(errText);
    }

    // If upstream didn't return SSE, surface that body for debugging
    const ct = ldRes.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const bodyText = await ldRes.text().catch(() => "");
      return res
        .status(ldRes.status)
        .type(ct || "application/json")
        .send(bodyText);
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
        Authorization: `Bearer ${LANGDOCK_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const ct = ld.headers.get("content-type") || "application/json";
    const text = await ld.text();

    console.log(
      "[/upload] status:",
      ld.status,
      "ct:",
      ct,
      "body:",
      text.slice(0, 300)
    );

    if (!ld.ok) {
      return res.status(ld.status).type(ct).send(text);
    }

    // Normalize to always return { attachmentId }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {}
    const attachmentId =
      data.attachmentId ||
      data.id ||
      data?.attachment?.id ||
      data?.result?.attachmentId ||
      null;

    return res.status(200).json({ attachmentId, raw: data });
  } catch (e) {
    console.error("Upload proxy error:", e);
    res.status(500).json({ message: "Upload failed", detail: e.message });
  }
});

// --- Azure Blob Logging (CommonJS) ---
const { BlobServiceClient } = require("@azure/storage-blob");

const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "logs";

async function appendToAzureBlob(entry) {
  if (!AZURE_CONN) throw new Error("Missing AZURE_STORAGE_CONNECTION_STRING");
  const blobService = BlobServiceClient.fromConnectionString(AZURE_CONN);
  const container = blobService.getContainerClient(CONTAINER_NAME);

  // create container if missing
  await container.createIfNotExists();

  const today = new Date().toISOString().slice(0, 10);
  const blobName = `logs-${today}.jsonl`;
  const blobClient = container.getAppendBlobClient(blobName);

  // create append blob if missing
  if (!(await blobClient.exists())) {
    await blobClient.create();
  }

  const line =
    JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n";
  await blobClient.appendBlock(line, Buffer.byteLength(line));
}

// /log route (frontend -> proxy -> Azure)
app.post("/log", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    await appendToAzureBlob(req.body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Azure log error:", e);
    res.status(500).json({ message: "Azure log failed", error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Langdock streaming proxy listening on ${PORT}`);
});
