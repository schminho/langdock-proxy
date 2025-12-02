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

// --- OpenAI-compatible Chat Completion endpoint (supports vision/images) ---
app.post("/chat/completions", async (req, res) => {
  try {
    const body = { ...req.body, stream: req.body.stream ?? true };
    const region = req.query.region || "eu"; // default to EU region

    // --- debug summary ---
    try {
      const msgSummary = Array.isArray(body.messages)
        ? body.messages.map((m) => {
            const hasImages =
              Array.isArray(m.content) &&
              m.content.some((c) => c.type === "image_url");
            return {
              role: m.role,
              hasImages,
              contentType: typeof m.content === "string" ? "text" : "array",
              contentPreview:
                typeof m.content === "string"
                  ? m.content.slice(0, 60)
                  : `[${m.content?.length || 0} items]`,
            };
          })
        : [];
      console.log(
        "[/chat/completions] model:",
        body.model,
        "region:",
        region,
        "stream:",
        body.stream,
        "messages:",
        msgSummary.length,
        msgSummary
      );
    } catch (e) {
      console.log("[/chat/completions] summary failed", e?.message);
    }

    const ldRes = await fetch(
      `https://api.langdock.com/openai/${region}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LANGDOCK_API_KEY}`,
          "Content-Type": "application/json",
          Accept: body.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    // If upstream isn't OK, forward its body
    if (!ldRes.ok) {
      const errText = await ldRes.text().catch(() => "");
      return res.status(ldRes.status).type("application/json").send(errText);
    }

    const ct = ldRes.headers.get("content-type") || "";
    console.log("[/chat/completions] upstream content-type:", ct);

    // If not streaming, just return the JSON response
    if (!body.stream) {
      const text = await ldRes.text();
      return res.status(200).type(ct).send(text);
    }

    // --- SSE: unbuffered headers + anti-buffer padding + robust teardown ---
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Vary", "Accept-Encoding");
    res.removeHeader?.("Content-Length");
    res.flushHeaders?.();

    // Anti-buffer padding
    res.write(`:${" ".repeat(2048)}\n`);
    res.write("retry: 1000\n");
    res.write(":ok\n\n");
    res.flush?.();

    // Heartbeat every 1s
    const hb = setInterval(() => {
      try {
        res.write(":hb\n\n");
        res.flush?.();
      } catch {}
    }, 1000);

    const close = () => {
      try {
        clearInterval(hb);
      } catch {}
      try {
        ldRes.body?.destroy?.();
      } catch {}
      try {
        res.end();
      } catch {}
    };
    req.on("close", close);
    req.on("aborted", close);

    // Forward chunks as they arrive
    ldRes.body.on("data", (chunk) => {
      res.write(chunk);
      res.flush?.();
    });

    ldRes.body.on("end", () => {
      try {
        clearInterval(hb);
      } catch {}
      res.write(":done\n\n");
      res.end();
    });

    ldRes.body.on("error", (err) => {
      console.error("[/chat/completions] Stream error:", err);
      try {
        clearInterval(hb);
      } catch {}
      res.write(`:error ${err?.message || ""}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error("[/chat/completions] Proxy error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "Chat completion proxy failed", detail: err.message });
    } else {
      try {
        res.end();
      } catch (_) {}
    }
  }
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
            attachmentIds: m.attachmentIds || [],
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

      // Log full request body for debugging (truncate content for readability)
      const debugBody = {
        ...body,
        messages: body.messages?.map((m) => ({
          ...m,
          content:
            m.content?.slice(0, 100) + (m.content?.length > 100 ? "..." : ""),
        })),
      };
      console.log(
        "[/assistant] Full request body:",
        JSON.stringify(debugBody, null, 2)
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
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      }
    );

    // If upstream isn't OK, forward its body
    if (!ldRes.ok) {
      const errText = await ldRes.text().catch(() => "");
      return res.status(ldRes.status).type("application/json").send(errText);
    }

    // NOTE: Upstream may be text/plain with custom framing (e.g., "0:", "2:", ...).
    // Do NOT switch to .text(); it would buffer the entire body.
    // We will just stream whatever bytes arrive and let the client parse per-line.
    const ct = ldRes.headers.get("content-type") || "";
    console.log("[/assistant] upstream content-type:", ct);

    // --- SSE: unbuffered headers + anti-buffer padding + robust teardown ---
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // strongly hint to proxies not to buffer or transform
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Vary", "Accept-Encoding");
    res.removeHeader?.("Content-Length"); // ensure no fixed length
    res.flushHeaders?.();

    // Anti-buffer padding: some edges/CDNs won't flush small responses
    // Sends ~2KB comment, then a retry hint and a heartbeat
    res.write(`:${" ".repeat(2048)}\n`);
    res.write("retry: 1000\n");
    res.write(":ok\n\n");
    res.flush?.();

    // Heartbeat every 1s to keep intermediaries flushing
    const hb = setInterval(() => {
      try {
        res.write(":hb\n\n");
        res.flush?.();
      } catch {}
    }, 1000);

    // If the client disconnects, stop reading from upstream and end our response
    const close = () => {
      try {
        clearInterval(hb);
      } catch {}
      try {
        ldRes.body?.destroy?.();
      } catch {}
      try {
        res.end();
      } catch {}
    };
    req.on("close", close);
    req.on("aborted", close);

    // Manual streaming—forward chunks as they arrive
    let responseBuffer = "";
    ldRes.body.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      responseBuffer += chunkStr;

      // Log first 500 chars of response to see what model says
      if (responseBuffer.length <= 500) {
        console.log("[/assistant] Response chunk:", chunkStr.slice(0, 200));
      }

      res.write(chunk);
      res.flush?.();
    });

    // Upstream finished
    ldRes.body.on("end", () => {
      try {
        clearInterval(hb);
      } catch {}
      res.write(":done\n\n");
      res.end();
    });

    ldRes.body.on("error", (err) => {
      console.error("Stream error:", err);
      try {
        clearInterval(hb);
      } catch {}
      res.write(`:error ${err?.message || ""}\n\n`);
      res.end();
    });
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

// --- GET-based SSE endpoint: /assistant-stream?q=<urlencoded JSON> ---
// Streams even if upstream isn't SSE by re-framing lines into SSE "data:" frames.
app.get("/assistant-stream", async (req, res) => {
  let body = {};
  try {
    body = JSON.parse(req.query.q || "{}");
  } catch {}
  body.stream = true;

  // (Optional) validate assistantId early
  const UUID_RE =
    /^(?:urn:uuid:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  if (!body.assistantId || !UUID_RE.test(body.assistantId)) {
    return res.status(400).json({ error: "Invalid assistantId: must be UUID" });
  }

  // SSE response headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Vary", "Accept-Encoding");
  res.removeHeader?.("Content-Length");
  res.flushHeaders?.();

  // Anti-buffer padding + heartbeat
  res.write(`:${" ".repeat(2048)}\n`);
  res.write("retry: 1000\n");
  res.write(":ok\n\n");
  res.flush?.();

  const hb = setInterval(() => {
    try {
      res.write(":hb\n\n");
      res.flush?.();
    } catch {}
  }, 1000);

  // Call upstream (requesting "stream")
  const up = await fetch(
    "https://api.langdock.com/assistant/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LANGDOCK_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream", // ask for SSE if supported
      },
      body: JSON.stringify(body),
    }
  );

  const ct = up.headers.get("content-type") || "";
  console.log("[/assistant-stream] upstream content-type:", ct);

  if (!up.ok) {
    const errText = await up.text().catch(() => "");
    res.write(
      `event: error\ndata: ${JSON.stringify({
        status: up.status,
        body: errText.slice(0, 300),
      })}\n\n`
    );
    return res.end();
  }

  const close = () => {
    try {
      clearInterval(hb);
    } catch {}
    try {
      up.body?.destroy?.();
    } catch {}
    try {
      res.end();
    } catch {}
  };
  req.on("close", close);
  req.on("aborted", close);

  // If upstream is real SSE, pass-through
  if (ct.includes("text/event-stream")) {
    up.body.on("data", (chunk) => {
      res.write(chunk);
      res.flush?.();
    });
    up.body.on("end", () => {
      try {
        clearInterval(hb);
      } catch {}
      res.write(":done\n\n");
      res.end();
    });
    up.body.on("error", (err) => {
      try {
        clearInterval(hb);
      } catch {}
      res.write(`:error ${err?.message || ""}\n\n`);
      res.end();
    });
    return;
  }

  // Otherwise: re-frame upstream text/plain stream into SSE frames.
  let carry = "";
  up.body.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    const parts = (carry + text).split(/\r?\n/);
    carry = parts.pop() ?? "";
    for (const lineRaw of parts) {
      const line = lineRaw.trim();
      if (!line) continue;
      // Wrap each upstream line as an SSE data frame.
      // Client-side EventSource sees it as e.data = original line.
      res.write(`data: ${line}\n\n`);
    }
    res.flush?.();
  });

  up.body.on("end", () => {
    try {
      clearInterval(hb);
    } catch {}
    if (carry.trim()) res.write(`data: ${carry.trim()}\n\n`);
    res.write(":done\n\n");
    res.end();
  });

  up.body.on("error", (err) => {
    try {
      clearInterval(hb);
    } catch {}
    res.write(`:error ${err?.message || ""}\n\n`);
    res.end();
  });
});

// --- Minimal debug SSE to verify host-level streaming ---
app.get("/debug-sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Vary", "Accept-Encoding");
  res.removeHeader?.("Content-Length");
  res.flushHeaders?.();

  res.write(`:${" ".repeat(2048)}\n`);
  res.write(":hello\n\n");
  res.flush?.();

  let i = 0;
  const start = Date.now();
  const tick = () => {
    const line = `data: ${++i} @ ${Date.now() - start}ms\n\n`;
    const ok = res.write(line);
    res.flush?.();
    if (i >= 10) return res.end();
    if (!ok) res.once("drain", () => setTimeout(tick, 500));
    else setTimeout(tick, 500);
  };
  tick();

  const close = () => {
    try {
      res.end();
    } catch {}
  };
  req.on("close", close);
  req.on("aborted", close);
});

// Helper endpoint to get assistant details
app.get("/assistant/:assistantId", async (req, res) => {
  try {
    const { assistantId } = req.params;
    const ldRes = await fetch(
      `https://api.langdock.com/assistant/v1/assistants/${assistantId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${LANGDOCK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const text = await ldRes.text();
    const ct = ldRes.headers.get("content-type") || "application/json";

    console.log(
      "[/assistant/:id] status:",
      ldRes.status,
      "body:",
      text.slice(0, 500)
    );

    res.status(ldRes.status).type(ct).send(text);
  } catch (err) {
    console.error("Get assistant error:", err);
    res
      .status(500)
      .json({ error: "Failed to get assistant", detail: err.message });
  }
});

// Upload attachment -> Langdock (multipart passthrough)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    // Log detailed file info for debugging
    console.log("[/upload] Received file:", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      encoding: req.file.encoding,
    });

    // Ensure filename has proper extension
    let filename = req.file.originalname;
    if (!filename || filename === "blob") {
      // If no filename or generic "blob", try to add proper extension based on mimetype
      const ext = req.file.mimetype.split("/")[1] || "bin";
      filename = `file.${ext}`;
      console.log(
        `[/upload] Fixed filename from "${req.file.originalname}" to "${filename}"`
      );
    }

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: filename,
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
      "[/upload] Response - status:",
      ld.status,
      "ct:",
      ct,
      "body:",
      text.slice(0, 500)
    );

    if (!ld.ok) {
      console.error("[/upload] Upload failed:", {
        status: ld.status,
        filename: filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        response: text.slice(0, 500),
      });
      return res.status(ld.status).type(ct).send(text);
    }

    // Normalize to always return { attachmentId, file }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error("[/upload] JSON parse error:", parseError.message);
      console.error("[/upload] Raw response:", text);
      return res.status(500).json({
        message: "Failed to parse upload response",
        detail: parseError.message,
        rawResponse: text.slice(0, 200),
      });
    }

    const attachmentId =
      data.attachmentId ||
      data.id ||
      data?.attachment?.id ||
      data?.result?.attachmentId ||
      null;

    if (!attachmentId) {
      console.error("[/upload] No attachmentId found in response:", data);
      return res.status(500).json({
        message: "No attachmentId in upload response",
        rawResponse: data,
      });
    }

    console.log("[/upload] Success:", {
      attachmentId,
      filename: filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      rawResponse: data,
    }); // Return response matching Langdock documentation format
    return res.status(200).json({
      attachmentId,
      file: {
        name: filename,
        mimeType: req.file.mimetype,
        sizeInBytes: req.file.size,
      },
    });
  } catch (e) {
    console.error("Upload proxy error:", e);
    res.status(500).json({ message: "Upload failed", detail: e.message });
  }
});

// Upload image to Azure Blob Storage (for vision API)
app.post("/upload-image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }

    // Validate it's an image
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        message: "Only image files are supported",
        receivedType: req.file.mimetype,
      });
    }

    console.log("[/upload-image] Received file:", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });

    if (!AZURE_CONN) {
      return res.status(500).json({
        message: "Azure Storage not configured",
        detail: "AZURE_STORAGE_CONNECTION_STRING is missing",
      });
    }

    const blobService = BlobServiceClient.fromConnectionString(AZURE_CONN);
    const container = blobService.getContainerClient("images");

    // Create container if it doesn't exist (private container)
    await container.createIfNotExists();

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 15);
    const ext = req.file.mimetype.split("/")[1] || "jpg";
    const blobName = `${timestamp}-${randomStr}.${ext}`;

    const blockBlobClient = container.getBlockBlobClient(blobName);

    // Upload the image
    await blockBlobClient.upload(req.file.buffer, req.file.size, {
      blobHTTPHeaders: {
        blobContentType: req.file.mimetype,
      },
    });

    // Generate SAS token URL (valid for 24 hours)
    const { BlobSASPermissions, generateBlobSASQueryParameters } = require("@azure/storage-blob");
    const sasToken = generateBlobSASQueryParameters({
      containerName: "images",
      blobName: blobName,
      permissions: BlobSASPermissions.parse("r"), // read-only
      startsOn: new Date(),
      expiresOn: new Date(new Date().valueOf() + 24 * 60 * 60 * 1000), // 24 hours
    }, blobService.credential).toString();

    const imageUrl = `${blockBlobClient.url}?${sasToken}`;

    console.log("[/upload-image] Success:", {
      blobName,
      url: imageUrl,
      size: req.file.size,
    });

    return res.status(200).json({
      url: imageUrl,
      imageUrl: imageUrl,
      blobName,
      mimeType: req.file.mimetype,
      sizeInBytes: req.file.size,
    });
  } catch (e) {
    console.error("[/upload-image] Error:", e);
    res.status(500).json({
      message: "Image upload failed",
      detail: e.message,
    });
  }
});

// --- Azure Blob Logging (CommonJS) ---
const { BlobServiceClient } = require("@azure/storage-blob");

const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "logs";

function safePart(s) {
  // keep it URL-safe & short for blob names
  return String(s || "anon")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64);
}

async function appendToAzureBlob(entry) {
  if (!AZURE_CONN) throw new Error("Missing AZURE_STORAGE_CONNECTION_STRING");
  const blobService = BlobServiceClient.fromConnectionString(AZURE_CONN);
  const container = blobService.getContainerClient(CONTAINER_NAME);
  await container.createIfNotExists();

  // pick date from entry.at if provided, else now
  const iso = (entry && entry.at) || new Date().toISOString();
  const day = iso.slice(0, 10); // YYYY-MM-DD

  // use sessionId if present, else fall back to userEmail, else "anon"
  const sessionPart = safePart(entry?.sessionId || entry?.userEmail || "anon");

  // folder-like naming inside the "logs" container:
  // e.g. logs/2025-10-08/37174234-44a7-4751-...jsonl
  const blobName = `${day}/${sessionPart}.jsonl`;

  const blobClient = container.getAppendBlobClient(blobName);
  if (!(await blobClient.exists())) {
    await blobClient.create();
  }

  // always ensure we stamp 'at' on the line
  const line = JSON.stringify({ ...entry, at: iso }) + "\n";
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
