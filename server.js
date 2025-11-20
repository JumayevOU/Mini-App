const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg'); // PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;

// API KEYS
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "sk-sz5a9Z7q3am9Rkzb0N2cngTRmOZR_TroVHc0xQrjwoHXLXdMf2nUkXjDuuYGe5Vmlwu3gODZOdOtGqIzAVISeg";
const OCR_API_KEY = process.env.OCR_API_KEY || "K86767579488957"; 
// DATABASE URL (Railway avtomatik beradi, yoki .env ga yozing)
const DATABASE_URL = process.env.DATABASE_URL; 

// DB Pool
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Railway uchun shart
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- AI FUNCTIONS ---

async function getMistralReply(messages, systemPrompt = "Siz foydali yordamchisiz.") {
    try {
        // Chat tarixini Mistral formatiga o'tkazish
        const apiMessages = [
            { role: "system", content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content }))
        ];

        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${MISTRAL_API_KEY}`
            },
            body: JSON.stringify({
                model: "mistral-tiny",
                messages: apiMessages
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "AI javob bermadi.";
    } catch (error) {
        console.error("Mistral Error:", error);
        return "AI serverida xatolik.";
    }
}

// Sarlavha generatsiya qilish (qisqa nom)
async function generateTitle(text) {
    const prompt = `Ushbu xabarga 2-4 so'zdan iborat qisqa sarlavha (mavzu) qo'y. Faqat sarlavhani yoz, hech qanday belgi va izohsiz. Matn: "${text}"`;
    const title = await getMistralReply([{ role: 'user', content: prompt }], "Siz sarlavha generatorisiz.");
    return title.replace(/"/g, '').trim();
}

async function extractTextFromImage(buffer) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        formData.append('apikey', OCR_API_KEY);
        formData.append('language', 'eng');
        formData.append('isOverlayRequired', 'false');

        const response = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: formData });
        const data = await response.json();
        return data.ParsedResults?.[0]?.ParsedText?.trim() || "";
    } catch (e) { return ""; }
}

// --- API ROUTES ---

// 1. Chatlar ro'yxatini olish (Sidebar uchun)
app.get('/api/sessions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            "SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Bitta chat tarixini yuklash
app.get('/api/messages/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await pool.query(
            "SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
            [sessionId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Chatni o'chirish
app.delete('/api/session/:sessionId', async (req, res) => {
    try {
        await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Yangi chat yaratish
app.post('/api/session', async (req, res) => {
    try {
        const { userId } = req.body;
        const result = await pool.query(
            "INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING *",
            [userId]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Xabar yuborish (ASOSIY LOGIKA)
app.post('/api/chat', upload.single('file'), async (req, res) => {
    try {
        const { userId, type, message } = req.body;
        let { sessionId } = req.body;
        let replyText = "";
        let sessionTitle = null;

        // 1. Agar sessionId bo'lmasa (yangi chat), yaratamiz
        if (!sessionId || sessionId === 'null') {
            const newSession = await pool.query(
                "INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id",
                [userId]
            );
            sessionId = newSession.rows[0].id;
        }

        // 2. User xabarini saqlash
        let userContent = message;
        if (type === 'image' && req.file) {
            // Rasmdan matn oldik deb faraz qilamiz (real loyihada rasm URL saqlanadi)
            const ocrText = await extractTextFromImage(req.file.buffer);
            userContent = ocrText ? `[Rasm tahlili]: ${ocrText}` : "[Rasm tushunarsiz]";
        }

        await pool.query(
            "INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)",
            [sessionId, userContent, type]
        );

        // 3. AI Javobini olish (Kontekst bilan)
        // Oxirgi 6 ta xabarni olamiz (kontekstni ushlab turish uchun)
        const history = await pool.query(
            "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 6",
            [sessionId]
        );
        
        // System prompt
        const systemPrompt = "Siz qisqa, lo'nda va o'zbek tilida javob beradigan yordamchisiz.";
        replyText = await getMistralReply(history.rows, systemPrompt);

        // 4. AI javobini saqlash
        await pool.query(
            "INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')",
            [sessionId, replyText]
        );

        // 5. Avto-Sarlavha (Agar bu birinchi xabar bo'lsa va title "Yangi suhbat" bo'lsa)
        const sessionCheck = await pool.query("SELECT title FROM chat_sessions WHERE id = $1", [sessionId]);
        if (sessionCheck.rows[0].title === 'Yangi suhbat') {
            sessionTitle = await generateTitle(userContent);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [sessionTitle, sessionId]);
        }

        // 6. Session vaqtini yangilash
        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);

        res.json({
            success: true,
            response: replyText,
            sessionId: sessionId,
            newTitle: sessionTitle
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.json({ success: false, response: "Serverda xatolik." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
