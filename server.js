// server.legacy.fixed.js  (eski kod, optimallashtirilgan — VISION YO'Q)
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!OPENAI_API_KEY) console.error("❌ XATOLIK: OPENAI_API_KEY topilmadi!");
if (!DATABASE_URL) console.error("❌ XATOLIK: DATABASE_URL topilmadi!");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CONCISE_INSTRUCTION =
  "Siz foydali AI yordamchisiz. Javoblaringiz juda QISQA, LO'NDA va ANIQ bo'lsin. Eng muhimi: Javobingizni har doim mavzuga mos EMOJILAR bilan bezang. 🎨✨";

// --- HELPERS ---
async function getGPTTitle(text) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Siz sarlavha generatorisiz. Faqat sarlavhani qaytar." },
          { role: "user", content: `Matnga mos 2-3 so'zli qisqa nom ber: "${(text||'').substring(0, 300)}"` }
        ],
        max_tokens: 15
      })
    });
    const data = await response.json();
    let title = data.choices?.[0]?.message?.content || "Yangi suhbat";
    return title.replace(/['"_`*#]/g, '').trim();
  } catch (e) {
    console.error("getGPTTitle error:", e);
    return "Suhbat";
  }
}

async function extractTextFromImage(buffer) {
  if (!OCR_API_KEY) return null;
  try {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    formData.append('apikey', OCR_API_KEY);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');

    // duplex removed - keep simple
    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: formData,
      headers: formData.getHeaders ? formData.getHeaders() : {}
    });

    const data = await response.json();
    if (data.IsErroredOnProcessing) return null;
    return data.ParsedResults?.[0]?.ParsedText?.trim() || null;
  } catch (e) {
    console.error("extractTextFromImage error:", e);
    return null;
  }
}

// --- API ROUTES ---
app.get('/api/sessions/:userId', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC", [req.params.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC", [req.params.sessionId]);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/session error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// --- STREAMING CHAT ENDPOINT (REAL VAQT) ---
app.post('/api/chat', upload.single('file'), async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  try {
    // DIAGNOSTIC LOG (foydali)
    console.log("=== /api/chat called ===", {
      headersContentType: req.headers['content-type'],
      bodyKeys: Object.keys(req.body || {}),
      hasFile: !!req.file,
      OPENAI_KEY: !!OPENAI_API_KEY
    });

    if (!OPENAI_API_KEY) {
      res.write(`data: ${JSON.stringify({ error: "Server misconfiguration: missing OPENAI_API_KEY" })}\n\n`);
      return res.end();
    }

    const { userId, type, message } = req.body;
    let { sessionId } = req.body;
    let isNewSession = false;

    if (!sessionId || sessionId === 'null') {
      const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
      sessionId = newSession.rows[0].id;
      isNewSession = true;
    }

    // Prepare user content
    let userContent = message || "";
    if (type === 'image' && req.file) {
      const ocrText = await extractTextFromImage(req.file.buffer);
      if (ocrText) userContent = `[Rasm]: ${ocrText}\n\n(Rasm mazmuni bo'yicha javob bering)`;
      else userContent = "[Rasm yuborildi, lekin matn aniqlanmadi]";
    }

    // Save user message to DB (await so that errors are visible)
    try {
      await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type]);
    } catch (dbErr) {
      console.error("DB insert user message error:", dbErr);
    }

    // Get history
    const history = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);

    const apiMessages = [
      { role: "system", content: CONCISE_INSTRUCTION },
      ...history.rows.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent }
    ];

    // Call OpenAI (stream)
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: apiMessages,
        stream: true,
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!openaiResponse.ok) {
      const errBody = await openaiResponse.text();
      console.error("OpenAI Error:", openaiResponse.status, errBody);
      res.write(`data: ${JSON.stringify({ error: "AI Error", detail: errBody })}\n\n`);
      return res.end();
    }

    // Read stream robustly: support getReader() or Node async iterable
    let fullAIResponse = "";
    let buffer = "";

    async function handleChunkText(chunkText) {
      buffer += chunkText;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.replace(/^data:\s*/, "");
        if (dataStr === "[DONE]") continue;
        try {
          const json = JSON.parse(dataStr);
          const token = json.choices?.[0]?.delta?.content || "";
          if (token) {
            fullAIResponse += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        } catch (e) {
          // ignore partial json parse
        }
      }
    }

    if (openaiResponse.body?.getReader) {
      const reader = openaiResponse.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handleChunkText(decoder.decode(value, { stream: true }));
      }
      await handleChunkText("");
    } else {
      for await (const chunk of openaiResponse.body) {
        await handleChunkText(chunk.toString('utf8'));
      }
    }

    // Save assistant response
    if (fullAIResponse && fullAIResponse.trim().length > 0) {
      try {
        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAIResponse]);
        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
      } catch (dbErr) {
        console.error("DB insert assistant message error:", dbErr);
      }
    }

    // New title
    let newTitle = null;
    if (isNewSession) {
      try {
        newTitle = await getGPTTitle(userContent);
        await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
      } catch (e) {
        console.error("set title error:", e);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, sessionId, newTitle })}\n\n`);
    return res.end();

  } catch (error) {
    console.error("Stream Error:", error);
    try { res.write(`data: ${JSON.stringify({ error: "Server Error" })}\n\n`); } catch(e) {}
    return res.end();
  }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
