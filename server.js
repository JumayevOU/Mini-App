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
    "Siz foydali AI yordamchisiz. Javoblaringiz juda QISQA, LO'NDA va ANIQ bo'lsin. " +
    "Eng muhimi: Javobingizni har doim mavzuga mos EMOJILAR bilan bezang. 🎨✨";

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
                    { role: "user", content: `Matnga mos 2-3 so'zli qisqa nom ber: "${text.substring(0, 300)}"` }
                ],
                max_tokens: 15
            })
        });
        const data = await response.json();
        let title = data.choices?.[0]?.message?.content || "Yangi suhbat";
        return title.replace(/['"_`*#]/g, '').trim();
    } catch (e) { return "Suhbat"; }
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
            headers: formData.getHeaders(),
            duplex: 'half'
        });

        const data = await response.json();
        if (data.IsErroredOnProcessing) return null;
        return data.ParsedResults?.[0]?.ParsedText?.trim() || null;
    } catch (e) { return null; }
}

// --- API ROUTES ---

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

// --- STREAMING CHAT ENDPOINT (REAL VAQT) ---
app.post('/api/chat', upload.single('file'), async (req, res) => {
    // 1. Javobni Stream (SSE) formatida tayyorlaymiz
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const { userId, type, message } = req.body;
        let { sessionId } = req.body;
        let isNewSession = false;

        // 2. Sessiya tekshiruvi
        if (!sessionId || sessionId === 'null') {
            const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
            sessionId = newSession.rows[0].id;
            isNewSession = true;
        }

        // 3. User xabarini tayyorlash
        let userContent = message || "";
        if (type === 'image' && req.file) {
            const ocrText = await extractTextFromImage(req.file.buffer);
            if (ocrText) userContent = `[Rasm]: ${ocrText}\n\n(Rasm mazmuni bo'yicha javob bering)`;
            else userContent = "[Rasm yuborildi, lekin matn aniqlanmadi]";
        }

        // 4. User xabarini bazaga saqlash (background)
        pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type]);

        // 5. Tarixni olish (Context)
        const history = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);
        
        const apiMessages = [
            { role: "system", content: CONCISE_INSTRUCTION },
            ...history.rows.map(m => ({ role: m.role, content: m.content })),
            { role: "user", content: userContent }
        ];

        // 6. OpenAI Stream so'rovi
        const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini", // 4.1 mini deb so'ralgan model shu
                messages: apiMessages,
                stream: true, // Streamni yoqamiz
                temperature: 0.7,
                max_tokens: 1000
            })
        });

        if (!openaiResponse.ok) {
            res.write(`data: ${JSON.stringify({ error: "AI Error" })}\n\n`);
            res.end();
            return;
        }

        // 7. Streamni o'qish va Clientga uzatish
        const reader = openaiResponse.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullAIResponse = "";
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            // Stream chunklarini yig'ish va qatorlarga bo'lish
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // Oxirgi tugallanmagan qatorni saqlab qolamiz

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data: ")) {
                    const dataStr = trimmed.replace("data: ", "").trim();
                    if (dataStr === "[DONE]") continue;
                    
                    try {
                        const json = JSON.parse(dataStr);
                        const token = json.choices[0]?.delta?.content || "";
                        if (token) {
                            fullAIResponse += token;
                            // Har bir token (so'z/harf) ni darhol frontendga yuboramiz
                            res.write(`data: ${JSON.stringify({ token })}\n\n`);
                        }
                    } catch (e) { }
                }
            }
        }

        // 8. Yakuniy saqlashlar
        let newTitle = null;
        if (isNewSession) {
            newTitle = await getGPTTitle(userContent);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
        }

        if (fullAIResponse) {
            await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAIResponse]);
            await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
        }

        // Tugaganligi haqida signal
        res.write(`data: ${JSON.stringify({ done: true, sessionId, newTitle })}\n\n`);
        res.end();

    } catch (error) {
        console.error("Stream Error:", error);
        res.write(`data: ${JSON.stringify({ error: "Server Error" })}\n\n`);
        res.end();
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
