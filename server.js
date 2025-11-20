const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const OCR_API_KEY = process.env.OCR_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL; 

if (!MISTRAL_API_KEY) console.error("❌ XATOLIK: MISTRAL_API_KEY topilmadi!");
if (!DATABASE_URL) console.error("❌ XATOLIK: DATABASE_URL topilmadi!");

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } 
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- SYSTEM PROMPT ---
const CONCISE_INSTRUCTION = 
    "Siz foydali yordamchisiz. Javoblaringiz qisqa, lo'nda va aniq bo'lsin. Ortiqcha kirish so'zlarisiz to'g'ridan-to'g'ri javob bering.";

// --- YORDAMCHI FUNKSIYALAR ---

function cleanResponse(text) {
    if (!text) return "";
    return text.replace(/^###\s*/gm, '').trim();
}

/**
 * Sarlavhani tozalash
 * Qo'shtirnoq va ortiqcha belgilarni olib tashlaydi
 */
function cleanTitle(text) {
    if (!text) return "Suhbat";
    // Faqat xavfsiz belgilarni qoldiramiz
    let cleaned = text.replace(/['"_`*#\[\]\(\)<>]/g, '').trim();
    // Agar sarlavha juda uzun bo'lsa, uni qisqartiramiz
    if (cleaned.length > 40) cleaned = cleaned.substring(0, 40) + "...";
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
    } catch (error) { return "AI xatosi."; }
}

/**
 * MUHIM: Aqlli Sarlavha Generatori
 */
async function generateTitle(text) {
    // 1. Fallback sarlavha (User yozgan matnning boshlanishi)
    // Agar AI ishlamasa yoki sekin bo'lsa, shuni ishlatamiz.
    let fallbackTitle = text.substring(0, 30).trim();
    if (text.length > 30) fallbackTitle += "...";
    
    try {
        // 2. AI ga so'rov
        const prompt = `Quyidagi xabar mazmuniga mos keladigan juda qisqa (maksimum 3-4 so'z) sarlavha yoz. 
        Sarlavha o'zbek tilida bo'lsin. Hech qanday qo'shtirnoq, nuqta yoki izoh yozma. Faqat sarlavha.
        
        Xabar: "${text}"`;
        
        const rawTitle = await getMistralReply([{ role: 'user', content: prompt }], "Siz sarlavha generatorisiz.");
        
        // Agar AI bo'sh yoki xato qaytarsa, fallback ishlatamiz
        if (!rawTitle || rawTitle.includes("AI xatosi") || rawTitle.length < 2) {
            return cleanTitle(fallbackTitle);
        }

        return cleanTitle(rawTitle);

    } catch (e) {
        // Xatolik bo'lsa ham, "Yangi suhbat" demaymiz, user matnini qo'yamiz
        return cleanTitle(fallbackTitle);
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
        const response = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: formData });
        const data = await response.json();
        if (data.IsErroredOnProcessing) return "❌ OCR xatosi";
        return data.ParsedResults?.[0]?.ParsedText?.trim() || "Matn topilmadi";
    } catch (e) { return "❌ OCR xatosi"; }
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

        // 1. Sessiya yaratish
        if (!sessionId || sessionId === 'null') {
            try {
                const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
                sessionId = newSession.rows[0].id;
            } catch (dbErr) { return res.json({ success: false, response: "Sessiya xatosi." }); }
        }

        // 2. User xabarini yozish
        let userContent = message || "";
        if (type === 'image' && req.file) {
            const ocrText = await extractTextFromImage(req.file.buffer);
            userContent = `[Rasm]: ${ocrText}`;
        }

        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, userContent, type]);

        // 3. AI Javobi
        const history = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);
        replyText = await getMistralReply(history.rows, CONCISE_INSTRUCTION);

        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, replyText]);

        // 4. AVTO-SARLAVHA (Optimallashtirilgan)
        // Har safar birinchi xabar yozilganda yoki sarlavha "Yangi suhbat" bo'lsa, uni yangilaymiz
        const sessionCheck = await pool.query("SELECT title FROM chat_sessions WHERE id = $1", [sessionId]);
        
        // Agar bu birinchi xabar bo'lsa yoki sarlavha hali ham default bo'lsa
        if (sessionCheck.rows[0].title === 'Yangi suhbat') {
            // Sarlavha generatsiya qilamiz (AI yoki Fallback)
            sessionTitle = await generateTitle(userContent);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [sessionTitle, sessionId]);
        }

        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);

        res.json({ success: true, response: replyText, sessionId: sessionId, newTitle: sessionTitle });
    } catch (error) { res.json({ success: false, response: "Server xatosi." }); }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
