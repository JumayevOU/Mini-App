// server.js (Optimallashtirilgan va tuzatilgan)
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!OPENAI_API_KEY) console.error("❌ XATOLIK: OPENAI_API_KEY topilmadi!");
if (!DATABASE_URL) console.error("❌ XATOLIK: DATABASE_URL topilmadi!");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Multer - file in memory (we will convert to base64)
const upload = multer({ storage: multer.memoryStorage() });

// Middlewares
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' })); // helps if any non-file form fields are sent
app.use(express.static(path.join(__dirname, 'public')));

// System instruction
const SYSTEM_INSTRUCTION =
  "Siz foydali va aqlli AI yordamchisiz.\n" +
  "1. Javoblaringiz lo'nda va aniq bo'lsin.\n" +
  "2. Mavzuga mos EMOJILAR ishlating. 🎨✨\n" +
  "3. KOD yozsangiz, albatta Markdown (```language) formatida yozing.\n" +
  "4. Kod ichida qisqa izohlar bo'lsin.";

// --- HELPERS ---

// Limit tekshirish (vision)
async function checkAndIncrementLimit(userId, limit = 3) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await pool.query(
      "SELECT vision_count FROM daily_limits WHERE user_id = $1 AND usage_date = $2",
      [userId, today]
    );
    const currentCount = res.rows[0]?.vision_count || 0;
    if (currentCount >= limit) return false;

    await pool.query(`
      INSERT INTO daily_limits (user_id, usage_date, vision_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET vision_count = daily_limits.vision_count + 1
    `, [userId, today]);

    return true;
  } catch (e) {
    console.error("checkAndIncrementLimit error:", e);
    // Fail-open: agar DB muammosi bo'lsa, ruxsat berish (yoki siz xohlasangiz false qaytarish mumkin)
    return true;
  }
}

// Flatten DB content (har doim string yoki structured array qaytaradi kerakli joylarga)
function flattenContentToString(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    // If stored as JSON array/object string
    if ((trimmed.startsWith('[') || trimmed.startsWith('{'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map(item => {
            if (typeof item === 'string') return item;
            if (item?.type === 'text') return item.text || '';
            if (item?.type === 'input_image') return `[IMAGE] (image omitted in history)`;
            if (item?.type === 'image_url') return `[IMAGE_URL] ${item.image_url?.url || ''}`;
            return JSON.stringify(item);
          }).join('\n\n');
        } else if (typeof parsed === 'object') {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        // ignore parse error
      }
    }
    return content;
  } else if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item?.type === 'text') return item.text || '';
      if (item?.type === 'input_image') return `[IMAGE] (image omitted in history)`;
      return JSON.stringify(item);
    }).join('\n\n');
  } else if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return String(content);
}

// Get title via OpenAI (simple)
async function getGPTTitle(text) {
  try {
    const promptText = (typeof text === 'string' ? text : flattenContentToString(text)).substring(0, 200);
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sarlavha generatorisan. Faqat 2-3 so'zli nom qaytar." },
          { role: "user", content: `Matnga sarlavha: "${promptText}"` }
        ],
        max_tokens: 16
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("getGPTTitle OpenAI error:", resp.status, err);
      return "Yangi suhbat";
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.replace(/['"_`*#]/g, '').trim() || "Yangi suhbat";
  } catch (e) {
    console.error("getGPTTitle exception:", e);
    return "Suhbat";
  }
}

// OCR using ocr.space (if configured)
async function extractTextFromImage(buffer) {
  if (!OCR_API_KEY) return null;
  try {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    formData.append('apikey', OCR_API_KEY);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');

    const headers = formData.getHeaders ? formData.getHeaders() : {};
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers,
      body: formData
    });

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

// --- ROUTES ---

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

// --- CHAT (multer for file) ---
app.post('/api/chat', upload.single('file'), async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  try {
    // Note: multer populates req.body and req.file
    const userId = req.body.userId || req.body.user_id || 'guest';
    const type = req.body.type || 'text'; // 'text' or 'image'
    const message = req.body.message || '';
    const analysisType = req.body.analysisType || req.body.analysis_type || 'ocr'; // 'vision' or 'ocr'
    let sessionId = req.body.sessionId || req.body.session_id || null;
    let isNewSession = false;

    // create session if missing
    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
      const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
      sessionId = newSession.rows[0].id;
      isNewSession = true;
    }

    // Prepare userContent for OpenAI messages
    let modelName = "gpt-4o-mini";
    let userContent = message || "";

    // If image is present
    if (type === 'image' && req.file) {
      const base64 = req.file.buffer.toString('base64');

      if (analysisType === 'vision') {
        modelName = "gpt-4o"; // stronger model for vision
        // check limit
        const canUse = await checkAndIncrementLimit(userId, 3);
        if (!canUse) {
          res.write(`data: ${JSON.stringify({ token: "⚠️ Kunlik vision limiti tugadi (3 marta)." })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          return res.end();
        }
        // IMPORTANT: Build structured content array with 'text' and 'input_image'
        userContent = [
          { type: "text", text: message || "Rasmni tahlil qil." },
          { type: "input_image", image: base64 } // image as base64 (no data: prefix)
        ];
      } else {
        // OCR flow
        const ocrText = await extractTextFromImage(req.file.buffer);
        userContent = ocrText ? `[OCR Matn]: "${ocrText}"\n\nSavol: ${message || ''}` : "[OCR matn topilmadi]";
      }
    }

    // Save user message to DB (store as string or JSON string)
    const dbContent = Array.isArray(userContent) ? JSON.stringify(userContent) : userContent;
    await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, dbContent, type]);

    // Load last messages for context (flattened to strings where needed)
    const historyRes = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 20", [sessionId]);
    const apiMessages = [
      { role: "system", content: SYSTEM_INSTRUCTION },
      ...historyRes.rows.map(m => ({ role: m.role, content: flattenContentToString(m.content) })),
      // For the user message we send structured content if it's an array (vision), otherwise a string
      (Array.isArray(userContent))
        ? { role: "user", content: userContent } // structured content (text + input_image)
        : { role: "user", content: String(userContent) }
    ];

    // Call OpenAI Chat Completions (stream)
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: modelName,
        messages: apiMessages,
        stream: true,
        max_tokens: 1500
      }),
      signal: controller.signal
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      console.error("OpenAI Error:", openaiResp.status, errText);
      res.write(`data: ${JSON.stringify({ error: "AI Error", detail: errText })}\n\n`);
      return res.end();
    }

    // Stream parsing compatible with getReader() or Node streams
    let fullAI = "";
    let buffer = "";

    async function handleChunkText(text) {
      buffer += text;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop(); // keep incomplete chunk

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
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
          // ignore partial/parse errors
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
      await handleChunkText(""); // flush
    } else {
      for await (const chunk of openaiResp.body) {
        await handleChunkText(chunk.toString('utf8'));
      }
    }

    // Save assistant response to DB
    if (fullAI && fullAI.trim().length > 0) {
      await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAI]);
      await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
    }

    // If new session, generate title
    if (isNewSession) {
      const titleText = flattenContentToString(userContent).slice(0, 200);
      const newTitle = await getGPTTitle(titleText);
      await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
      res.write(`data: ${JSON.stringify({ newTitle })}\n\n`);
    }

    // Finish
    res.write(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`);
    return res.end();

  } catch (err) {
    if (err?.name === 'AbortError') {
      console.log("Request aborted by client.");
    } else {
      console.error("Server Error (/api/chat):", err);
      try { res.write(`data: ${JSON.stringify({ error: "Server Xatosi" })}\n\n`); } catch (e) {}
    }
    try { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); } catch (e) {}
    return res.end();
  }
});

// Fallback to SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
