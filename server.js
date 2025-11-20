/*
  server.js
  To'liq ishlaydigan va tuzatilgan Node/Express server namunasi.
  - Gemini (Generative Language) uchun gemini-2.5-flash modeliga moslashtirilgan
  - x-goog-api-key header ishlatiladi
  - OCR: ocr.space chaqiruviga mos
  - Postgres Pool faqat DATABASE_URL bo'lsa ishlaydi; yo'q bo'lsa DB yoqilgan emas xabari qaytaradi
  - Node >=18 uchun global fetch bo'lmasa `node-fetch` dinamik import qilinadi
*/

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL || null;

if (!GEMINI_API_KEY) console.error("❌ XATOLIK: GEMINI_API_KEY topilmadi!");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL topilmadi — DB yoqilmagan, sessiyalar saqlanmaydi.");

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  // agar localhost bo'lsa SSLni o'chiramiz
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
}) : null;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- SYSTEM PROMPT ---
const CONCISE_INSTRUCTION =
  "Siz foydali AI yordamchisiz. Javoblaringiz juda QISQA, LO'NDA va ANIQ bo'lsin. " +
  "Ortiqcha kirish so'zlarisiz to'g'ridan-to'g'ri javob bering. " +
  "Eng muhimi: Javobingizni har doim mavzuga mos EMOJILAR bilan bezang. 🎨✨";

// --- HELPERS ---
function cleanResponse(text) {
  if (!text) return "";
  return text.trim();
}

function cleanTitle(text) {
  if (!text) return "Suhbat";
  let cleaned = text.replace(/["'\\`*#\[\]\(\)<>:.!?]/g, '').trim();
  if (cleaned.length > 35) cleaned = cleaned.substring(0, 35) + "...";
  return cleaned;
}

// Ensure fetch is available (Node <18 fallback to node-fetch)
async function ensureFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  // dynamic import
  const mod = await import('node-fetch');
  return mod.default;
}

/**
 * Get reply from Gemini Generative Language API
 * messages: array of { role: 'user'|'assistant', content: '...' }
 */
async function getGeminiReply(messages, systemPrompt = CONCISE_INSTRUCTION) {
  if (!GEMINI_API_KEY) return "⚠️ API kalit sozlanmagan.";

  try {
    const fetchFn = await ensureFetch();

    // Build parts in order: include systemInstruction separately
    // For chat history, Gemini expects contents[].parts ordered as conversation parts
    const parts = [];
    for (const m of messages || []) {
      // prefix role label for clarity (optional)
      const prefix = m.role === 'assistant' ? 'Assistant: ' : 'User: ';
      parts.push({ text: `${prefix}${m.content}` });
    }

    const body = {
      // generation request uses systemInstruction + contents
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [ { parts } ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Gemini API Error:', JSON.stringify(data, null, 2));
      if (data && data.error && data.error.code === 404) {
        return "⚠️ AI modeli topilmadi — model nomini tekshiring.";
      }
      // return a user-friendly short error
      return "⚠️ AI xatoligi.";
    }

    // extract text from first candidate
    const candidate = data?.candidates?.[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      return "⚠️ AI javob bermadi.";
    }

    const text = candidate.content.parts.map(p => p.text || '').join('');
    return cleanResponse(text || "⚠️ AI bo'sh javob berdi.");
  } catch (err) {
    console.error('Fetch Error:', err);
    return "⚠️ Tarmoq yoki server xatosi.";
  }
}

async function generateTitle(text) {
  try {
    const shortText = text ? (text.length > 500 ? text.substring(0, 500) : text) : '';
    const prompt = `Quyidagi matnga mos 2-3 so'zli qisqa nom yoz. Faqat nomni yoz. Matn: "${shortText}"`;
    const rawTitle = await getGeminiReply([{ role: 'user', content: prompt }], "Siz sarlavha generatorisiz.");
    return cleanTitle(rawTitle);
  } catch (e) {
    return "Yangi suhbat";
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

    const fetchFn = await ensureFetch();

    const headers = formData.getHeaders ? formData.getHeaders() : {}; // node form-data headers

    const response = await fetchFn('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers,
      body: formData
    });

    const data = await response.json();
    if (data?.IsErroredOnProcessing) return "⚠️ Rasm o'qilmadi.";
    return data?.ParsedResults?.[0]?.ParsedText?.trim() || "Rasmda matn topilmadi.";
  } catch (e) {
    console.error('OCR Error:', e);
    return "⚠️ Server xatosi (OCR).";
  }
}

// --- API ROUTES ---
app.get('/api/sessions/:userId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    const { userId } = req.params;
    const result = await pool.query('SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/api/messages/:sessionId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    const { sessionId } = req.params;
    const result = await pool.query('SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.delete('/api/session/:sessionId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [req.params.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/session', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    const { userId } = req.body;
    const result = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING *", [userId]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
  try {
    const { userId, type, message } = req.body;
    let { sessionId } = req.body || {};
    let replyText = '';
    let sessionTitle = null;

    if (!sessionId || sessionId === 'null') {
      if (!pool) return res.status(400).json({ success: false, response: 'Sessiya yaratish uchun DB kerak.' });
      try {
        const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
        sessionId = newSession.rows[0].id;
      } catch (dbErr) {
        console.error(dbErr);
        return res.json({ success: false, response: 'Sessiya xatosi.' });
      }
    }

    let userContent = message || '';
    if (type === 'image' && req.file) {
      const ocrText = await extractTextFromImage(req.file.buffer);
      if (ocrText && ocrText.length > 2 && !ocrText.includes('⚠️')) {
        userContent = `[Rasm ichidagi matn]: ${ocrText}\n\n(Iltimos, javobni emojilar bilan bering)`;
      } else {
        userContent = '[Rasm yuborildi, lekin matn aniqlanmadi. Umumiy tavsif bering]';
      }
    }

    // store user message if DB configured
    if (pool) {
      await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type]);
    }

    // fetch recent history (if DB configured) or build minimal history
    let historyRows = [];
    if (pool) {
      const history = await pool.query('SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10', [sessionId]);
      historyRows = history.rows;
    } else {
      historyRows = [{ role: 'user', content: userContent }];
    }

    replyText = await getGeminiReply(historyRows, CONCISE_INSTRUCTION);

    if (pool) {
      await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, replyText]);

      const sessionCheck = await pool.query('SELECT title FROM chat_sessions WHERE id = $1', [sessionId]);
      if (sessionCheck.rows[0] && sessionCheck.rows[0].title === 'Yangi suhbat') {
        sessionTitle = await generateTitle(userContent);
        await pool.query('UPDATE chat_sessions SET title = $1 WHERE id = $2', [sessionTitle, sessionId]);
      }

      await pool.query('UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
    }

    res.json({ success: true, response: replyText, sessionId: sessionId, newTitle: sessionTitle });
  } catch (error) {
    console.error('Global Error:', error);
    res.json({ success: false, response: 'Serverda jiddiy xatolik.' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
