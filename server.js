// server.js — streaming uchun optimallashtirilgan
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const fetch = global.fetch || require('node-fetch'); // Node 18+ da global.fetch bor, lekin fallback
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
    "Siz foydali AI yordamchisiz. Javoblaringiz juda QISQA, LO'NDA va ANIQ bo'lsin. " +
    "Eng muhimi: Javobingizni har doim mavzuga mos EMOJILAR bilan bezang. 🎨✨";

// --- HELPERS ---
function cleanResponse(text) {
    if (!text) return "";
    return text.trim();
}

async function getGPTTitle(text) {
    try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Siz sarlavha generatorisiz." },
                    { role: "user", content: `Matnga mos 2-3 so'zli nom ber. Faqat nomni yoz: "${(text||'').substring(0, 500)}"` }
                ],
                max_tokens: 20
            })
        });
        const data = await resp.json();
        let title = data.choices?.[0]?.message?.content || "Yangi suhbat";
        return title.replace(/['"_`*#]/g, '').trim();
    } catch (e) {
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

        const response = await fetch("https://api.ocr.space/parse/image", {
            method: "POST",
            body: formData,
            headers: formData.getHeaders ? formData.getHeaders() : {}
        });

        const data = await response.json();
        if (data.IsErroredOnProcessing) return null;
        return data.ParsedResults?.[0]?.ParsedText?.trim() || null;
    } catch (e) { return null; }
}

// --- ROUTES (unchanged qismlar) ---
app.get('/api/sessions/:userId', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC", [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.get('/api/messages/:sessionId', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC", [req.params.sessionId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.delete('/api/session/:sessionId', async (req, res) => {
    try { await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: "DB error" }); }
});

// --- STREAMING CHAT ENDPOINT ---
app.post('/api/chat', upload.single('file'), async (req, res) => {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Some PaaS (heroku) benefit: disable response compression middleware if present
    if (res.flushHeaders) res.flushHeaders();

    // send a comment to establish the stream quickly
    res.write(`: connected\n\n`);

    // heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch (e) {}
    }, 20000);

    // AbortController to cancel OpenAI fetch if client disconnects
    const controller = new AbortController();

    req.on('close', () => {
        clearInterval(heartbeat);
        controller.abort();
    });

    try {
        const { userId, type, message } = req.body;
        let { sessionId } = req.body;
        let isNewSession = false;

        // 1. Sessiyani aniqlash
        if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
            const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
            sessionId = newSession.rows[0].id;
            isNewSession = true;
        }

        // 2. User xabarini tayyorlash
        let userContent = (message || "").toString();
        if (type === 'image' && req.file) {
            const ocrText = await extractTextFromImage(req.file.buffer);
            if (ocrText) userContent = `[Rasm]: ${ocrText}\n\n(Rasm mazmuni bo'yicha javob bering)`;
            else userContent = "[Rasm yuborildi, lekin matn aniqlanmadi. Umumiy javob bering]";
        }

        // 3. User xabarini bazaga saqlash (Async, kutib o'tirmaymiz)
        pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type])
            .catch(e => console.error("DB insert user message failed:", e));

        // 4. Tarixni olish (oxirgi 10 ta)
        const historyRes = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);

        const apiMessages = [
            { role: "system", content: CONCISE_INSTRUCTION },
            ...historyRes.rows.map(m => ({ role: m.role, content: m.content })),
            { role: "user", content: userContent }
        ];

        // 5. OpenAI Stream so'rovi
        const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: apiMessages,
                stream: true,
                temperature: 0.7,
                max_tokens: 1200
            })
        });

        if (!openaiResp.ok) {
            const text = await openaiResp.text();
            res.write(`data: ${JSON.stringify({ type: "error", message: "AI Error", detail: text })}\n\n`);
            res.end();
            clearInterval(heartbeat);
            return;
        }

        // 6. Streamni o'qish va Clientga uzatish robust yo'l bilan
        const reader = openaiResp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let fullAIResponse = "";

        // helper to push SSE
        const push = (obj) => {
            try {
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch (e) {
                console.error("SSE write error:", e);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // process complete SSE messages (they are separated by \n\n)
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const rawEvent = buffer.slice(0, boundary).trim();
                buffer = buffer.slice(boundary + 2);

                // Each event may have multiple lines; we care about lines starting with "data: "
                const lines = rawEvent.split(/\r?\n/);
                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const dataStr = line.replace(/^data:\s*/, '').trim();
                    if (dataStr === "[DONE]") {
                        // stream finished
                        break;
                    }
                    try {
                        const json = JSON.parse(dataStr);
                        const token = json.choices?.[0]?.delta?.content || "";
                        if (token) {
                            fullAIResponse += token;
                            push({ type: "token", token }); // mijozga yuborish
                        }
                    } catch (e) {
                        // ba'zan JSON parsingida xatolik bo'lishi mumkin, shunchaki o'tamiz
                    }
                }
            }
        }

        // 7. Yakuniy ishlar (Sarlavha va Baza)
        let newTitle = null;
        if (isNewSession) {
            try {
                newTitle = await getGPTTitle(userContent);
                await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
            } catch (e) { console.error("Title save error:", e); }
        }

        // AI javobini bazaga saqlash
        try {
            await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAIResponse]);
            await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
        } catch (e) { console.error("DB save assistant message failed:", e); }

        // Yakuniy signal yuborish (Session ID va Title bilan)
        push({ type: "done", sessionId, newTitle });
        res.end();
        clearInterval(heartbeat);

    } catch (error) {
        console.error("Stream Error:", error);
        try { res.write(`data: ${JSON.stringify({ type: "error", message: "Server Error" })}\n\n`); res.end(); } catch (e) {}
        clearInterval(heartbeat);
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));