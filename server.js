const express = require("express");
const fetch = require("node-fetch"); // ✅ v2 — supports .pipe()
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment variables.");
  process.exit(1);
}

// ✅ Special handling for streaming run creation
app.post("/v1/threads/:thread_id/runs", async (req, res) => {
  const { thread_id } = req.params;
  const targetUrl = `https://api.openai.com/v1/threads/${thread_id}/runs`;

  console.log("➡️ Streaming run to:", targetUrl);

  try {
    const openaiRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({
        ...req.body,
        stream: true,
      }),
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    openaiRes.body.pipe(res); // ✅ now works
  } catch (err) {
    console.error("Streaming run error:", err);
    res.status(500).json({ error: "Stream proxy failed", detail: err.message });
  }
});

// ✅ All other requests go through regular proxy
app.all("/v1/*", async (req, res) => {
  const path = req.path.replace(/^\/v1\//, "");
  const targetUrl = `https://api.openai.com/v1/${path}`;

  console.log("➡️ Proxying to:", targetUrl);
  if (req.body && Object.keys(req.body).length) {
    console.log("📦 Request body:", req.body);
  }

  try {
    const openaiRes = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
    });

    const data = await openaiRes.json();
    res.status(openaiRes.status).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Streaming proxy server running on port ${PORT}`);
});
