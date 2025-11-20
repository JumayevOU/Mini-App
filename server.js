const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL; 

if (!MISTRAL_API_KEY) console.error("❌ MISTRAL_API_KEY topilmadi!");
if (!DATABASE_URL) console.error("❌ DATABASE_URL topilmadi!");

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } 
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CONCISE_INSTRUCTION = 
    "Siz professional AI yordamchisiz. Javoblaringiz aniq, lo'nda va foydali bo'lsin. " +
    "Ortiqcha mulozamat (salomlashish, xayrlashish) shart emas, to'g'ridan-to'g'ri javob bering. " +
    "Kod so'ralsa, faqat kod va qisqa izoh bering.";

// --- HELPERS ---

function cleanResponse(text) {
    if (!text) return "";
    return text.replace(/^###\s*/gm, '').replace(/^\*\*.*?\*\*/g, '').trim();
}

function cleanTitle(text) {
    if (!text) return "Suhbat";
    let cleaned = text.replace(/['"_`*#\[\]\(\)<>:.!?]/g, '').trim();
    if (cleaned.length > 35) cleaned = cleaned.substring(0, 35) + "...";
    return cleaned;
}

async function getMistralReply(messages, systemPrompt = CONCISE_INSTRUCTION) {
    if (!MISTRAL_API_KEY) return "AI xizmati sozlanmagan.";
    try {
        const apiMessages = [
            { role: "system", content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content }))
        ];

        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MISTRAL_API_KEY}` },
            body: JSON.stringify({ model: "mistral-large-latest", messages: apiMessages, temperature: 0.7 })
        });
        
        const data = await response.json();
        if (data.choices && data.choices.length > 0) return cleanResponse(data.choices[0].message.content);
        return "AI javob bermadi.";
    } catch (error) { 
        console.error(error);
        return "AI xatosi."; 
    }
}

async function generateTitle(text) {
    try {
        const shortText = text.length > 500 ? text.substring(0, 500) : text;
        const prompt = `Quyidagi matnga 2-3 so'zli qisqa nom ber. Faqat nomni yoz. Matn: "${shortText}"`;
        const rawTitle = await getMistralReply([{ role: 'user', content: prompt }], "Siz sarlavha generatorisiz.");
        return cleanTitle(rawTitle);
    } catch (e) {
        return "Yangi suhbat";
    }
}

// --- OCR FUNKSIYASI (Tuzatilgan) ---
async function extractTextFromImage(buffer) {
    if (!OCR_API_KEY) {
        console.warn("OCR API Key yo'q");
        return null;
    }
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        formData.append('apikey', OCR_API_KEY);
        formData.append('language', 'eng');
        formData.append('isOverlayRequired', 'false');

        // Node 18+ fetch bilan ishlash uchun maxsus sozlamalar
        const response = await fetch("https://api.ocr.space/parse/image", { 
            method: "POST", 
            body: formData,
            headers: formData.getHeaders(),
            duplex: 'half' // Node.js fetch uchun muhim!
        });

        const data = await response.json();
        if (data.IsErroredOnProcessing) {
            console.error("OCR Error:", data.ErrorMessage);
            return "Rasmda matn aniqlanmadi.";
        }
        return data.ParsedResults?.[0]?.ParsedText?.trim() || "Rasmda matn topilmadi.";
    } catch (e) { 
        console.error("OCR Fetch Xatosi:", e);
        return "Rasm serverga yetib bormadi."; 
    }
}

// --- API ROUTES ---

app.get('/api/sessions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query("SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC", [userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.get('/api/messages/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await pool.query("SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC", [sessionId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.delete('/api/session/:sessionId', async (req, res) => {
    try { await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.post('/api/session', async (req, res) => {
    try {
        const { userId } = req.body;
        const result = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING *", [userId]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: "DB error" }); }
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
    try {
        const { userId, type, message } = req.body;
        let { sessionId } = req.body;
        let replyText = "";
        let sessionTitle = null;

        if (!sessionId || sessionId === 'null') {
            try {
                const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
                sessionId = newSession.rows[0].id;
            } catch (dbErr) { return res.json({ success: false, response: "Sessiya xatosi." }); }
        }

        let userContent = message || "";
        
        // Rasm logikasi
        if (type === 'image' && req.file) {
            const ocrText = await extractTextFromImage(req.file.buffer);
            // Agar OCR matn topsa uni qo'shamiz, bo'lmasa shunchaki rasm deb belgilaymiz
            if (ocrText && ocrText.length > 2 && !ocrText.includes("xato")) {
                userContent = `[Rasm ichidagi matn]: ${ocrText}\n\n(Iltimos, ushbu ma'lumotga asoslanib javob bering)`;
            } else {
                userContent = "[Rasm yuborildi, lekin matn aniqlanmadi. Umumiy javob bering.]";
            }
        }

        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type]);

        const history = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);
        replyText = await getMistralReply(history.rows, CONCISE_INSTRUCTION);

        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, replyText]);

        const sessionCheck = await pool.query("SELECT title FROM chat_sessions WHERE id = $1", [sessionId]);
        if (sessionCheck.rows[0].title === 'Yangi suhbat') {
            sessionTitle = await generateTitle(userContent);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [sessionTitle, sessionId]);
        }

        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);

        res.json({ success: true, response: replyText, sessionId: sessionId, newTitle: sessionTitle });
    } catch (error) { 
        console.error(error);
        res.json({ success: false, response: "Server xatosi." }); 
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
