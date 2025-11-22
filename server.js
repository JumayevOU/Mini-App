// server.js (optimized, vision+ocr+stream + diagnostics)
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

// If Node <18 and fetch missing, fallback to node-fetch
if (typeof fetch === 'undefined') {
  try {
    global.fetch = require('node-fetch');
  } catch (e) {
    console.warn('Fetch is not available and node-fetch is not installed. Install node-fetch or use Node 18+.');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!OPENAI_API_KEY) console.error("❌ MISSING: OPENAI_API_KEY");
if (!DATABASE_URL) console.error("❌ MISSING: DATABASE_URL");

// Postgres pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Multer memory storage for files
const upload = multer({ storage: multer.memoryStorage() });

// Middlewares
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// System instruction
const SYSTEM_INSTRUCTION =
  "Siz foydali va aqlli AI yordamchisiz.\n" +
  "1. Javoblaringiz lo'nda va aniq bo'lsin.\n" +
  "2. Mavzuga mos EMOJILAR ishlating. 🎨✨\n" +
  "3. Kod yozsangiz, Markdown (```language) formatida yozing.";

// ----------------- HELPERS -----------------

async function checkAndIncrementLimit(userId, limit = 3) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query(
      "SELECT vision_count FROM daily_limits WHERE user_id = $1 AND usage_date = $2",
      [userId, today]
    );
    const current = r.rows[0]?.vision_count || 0;
    if (current >= limit) return false;
    await pool.query(`
      INSERT INTO daily_limits (user_id, usage_date, vision_count)
      VALUES ($1,$2,1)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET vision_count = daily_limits.vision_count + 1
    `, [userId, today]);
    return true;
  } catch (e) {
    console.error("checkAndIncrementLimit error:", e);
    // fail-open: allow if DB broken (adjust to false if you prefer)
    return true;
  }
}

function flattenContentToString(content) {
  if (typeof content === 'string') {
    const t = content.trim();
    // try parse json string if it was stored as JSON
    if ((t.startsWith('[') || t.startsWith('{'))) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed.map(item => {
            if (typeof item === 'string') return item;
            if (item?.type === 'text') return item.text || '';
            if (item?.type === 'input_image') return "[IMAGE]";
            return JSON.stringify(item);
          }).join('\n\n');
        } else if (typeof parsed === 'object') {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        // ignore parse
      }
    }
    return content;
  } else if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item?.type === 'text') return item.text || '';
      return JSON.stringify(item);
    }).join('\n\n');
  } else if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return String(content);
}

async function getGPTTitle(text) {
  try {
    const prompt = (typeof text === 'string' ? text : flattenContentToString(text)).substring(0, 240);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sarlavha generatori. Faqat 2-3 so'zli sarlavha qaytar." },
          { role: "user", content: `Matnga sarlavha: "${prompt}"` }
        ],
        max_tokens: 16
      })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("getGPTTitle OpenAI error:", r.status, t);
      return "Yangi suhbat";
    }
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.replace(/['"_`*#]/g, '').trim() || "Yangi suhbat";
  } catch (e) {
    console.error("getGPTTitle exception:", e);
    return "Suhbat";
  }
}

// OCR via ocr.space (optional)
async function extractTextFromImage(buffer) {
  if (!OCR_API_KEY) return null;
  try {
    const form = new FormData();
    form.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    form.append('apikey', OCR_API_KEY);
    form.append('language', 'eng');
    form.append('isOverlayRequired', 'false');

    const headers = form.getHeaders ? form.getHeaders() : {};
    const resp = await fetch("https://api.ocr.space/parse/image", { method: "POST", headers, body: form });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error("OCR API error:", resp.status, txt);
      return null;
    }
    const data = await resp.json();
    if (data.IsErroredOnProcessing) return null;
    return data.ParsedResults?.[0]?.ParsedText?.trim() || null;
  } catch (e) {
    console.error("extractTextFromImage error:", e);
    return null;
  }
}

// ----------------- DIAGNOSTIC ENDPOINT -----------------

app.get('/api/test-openai', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "NO_OPENAI_KEY" });
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "You are a simple test assistant." }, { role: "user", content: "Say hi in Uzbek." }],
        max_tokens: 30
      })
    });
    const text = await resp.text();
    return res.status(resp.ok ? 200 : 500).send({ status: resp.status, body: text });
  } catch (e) {
    console.error("test-openai error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----------------- SESSIONS & MESSAGES -----------------

app.get('/api/sessions/:userId', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC", [req.params.userId]);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /api/sessions error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC", [req.params.sessionId]);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /api/messages error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/session error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

// ----------------- CHAT (STREAMING) -----------------

app.post('/api/chat', upload.single('file'), async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Diagnostic log for each request
  console.log('=== /api/chat called ===', {
    contentType: req.headers['content-type'],
    bodyKeys: Object.keys(req.body || {}),
    hasFile: !!req.file,
    fileInfo: req.file ? { originalname: req.file.originalname, size: req.file.size } : null,
    OPENAI_KEY: !!OPENAI_API_KEY
  });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const userId = req.body.userId || req.body.user_id || 'guest';
    const type = req.body.type || 'text'; // 'text' or 'image'
    const message = req.body.message || '';
    const analysisType = req.body.analysisType || req.body.analysis_type || 'ocr'; // 'vision' | 'ocr'
    let sessionId = req.body.sessionId || req.body.session_id || null;
    let isNewSession = false;

    // create session if missing
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
      const created = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
      sessionId = created.rows[0].id;
      isNewSession = true;
    }

    // Prepare user content
    let modelName = "gpt-4o-mini";
    let userContent = message || "";

    if (type === 'image' && req.file) {
      // If analysis type is vision -> structured content with input_image
      if (analysisType === 'vision') {
        modelName = "gpt-4o";
        const canUse = await checkAndIncrementLimit(userId, 3);
        if (!canUse) {
          res.write(`data: ${JSON.stringify({ token: "⚠️ Kunlik vision limiti tugadi (3 marta)." })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          return res.end();
        }
        const base64 = req.file.buffer.toString('base64');
        // structured content: text + input_image (base64 without data: prefix)
        userContent = [
          { type: "text", text: message || "Rasmni tahlil qil." },
          { type: "input_image", image: base64 }
        ];
      } else {
        // OCR mode: extract text and send plain text prompt
        const ocrText = await extractTextFromImage(req.file.buffer);
        userContent = ocrText ? `[OCR Matn]: ${ocrText}\n\nSavol: ${message || ''}` : "[OCR matn topilmadi]";
      }
    }

    // Save user message
    try {
      const dbContent = Array.isArray(userContent) ? JSON.stringify(userContent) : userContent;
      await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, dbContent, type]);
    } catch (e) {
      console.error("DB save user message error:", e);
    }

    // Load history (flattened for text)
    const historyRes = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 20", [sessionId]);
    const apiMessages = [
      { role: "system", content: SYSTEM_INSTRUCTION },
      ...historyRes.rows.map(m => ({ role: m.role, content: flattenContentToString(m.content) })),
      // For the new user content: send structured array if it's array (vision), otherwise string
      ...(Array.isArray(userContent) ? [{ role: "user", content: userContent }] : [{ role: "user", content: String(userContent) }])
    ];

    // Call OpenAI (stream)
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, messages: apiMessages, stream: true, max_tokens: 1500 }),
      signal: controller.signal
    });

    if (!openaiResp.ok) {
      const errTxt = await openaiResp.text();
      console.error("OpenAI Error:", openaiResp.status, errTxt);
      res.write(`data: ${JSON.stringify({ error: "AI Error", detail: errTxt })}\n\n`);
      return res.end();
    }

    // Stream parsing: supports web getReader() and Node async iterable
    let fullAI = "";
    let buffer = "";

    async function handleChunkText(chunkText) {
      buffer += chunkText;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.replace(/^data:\s*/, "");
        if (dataStr === "[DONE]") continue;
        try {
          const json = JSON.parse(dataStr);
          const token = json.choices?.[0]?.delta?.content || "";
          if (token) {
            fullAI += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        } catch (e) {
          // ignore partial JSON
        }
      }
    }

    if (openaiResp.body?.getReader) {
      const reader = openaiResp.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handleChunkText(decoder.decode(value, { stream: true }));
      }
      await handleChunkText("");
    } else {
      for await (const chunk of openaiResp.body) {
        await handleChunkText(chunk.toString('utf8'));
      }
    }

    // Save assistant output
    try {
      if (fullAI && fullAI.trim().length > 0) {
        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAI]);
        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
      }
    } catch (e) {
      console.error("DB save assistant message error:", e);
    }

    // Set session title if new session
    if (isNewSession) {
      try {
        const titleText = flattenContentToString(userContent).slice(0, 200);
        const newTitle = await getGPTTitle(titleText);
        await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
        res.write(`data: ${JSON.stringify({ newTitle })}\n\n`);
      } catch (e) {
        console.error("set title error:", e);
      }
    }

    // finish
    res.write(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`);
    return res.end();

  } catch (err) {
    if (err?.name === 'AbortError') {
      console.log('Request aborted by client');
    } else {
      console.error("Server /api/chat error:", err);
      try { res.write(`data: ${JSON.stringify({ error: "Server Error" })}\n\n`); } catch(e){}
    }
    try { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); } catch(e){}
    return res.end();
  }
});

// Fallback SPA route
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
