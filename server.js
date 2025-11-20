const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- KONFIGURATSIYA ---
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "sk-sz5a9Z7q3am9Rkzb0N2cngTRmOZR_TroVHc0xQrjwoHXLXdMf2nUkXjDuuYGe5Vmlwu3gODZOdOtGqIzAVISeg";
const OCR_API_KEY = process.env.OCR_API_KEY || "K86767579488957"; 

// Ma'lumotlar bazasiga ulanish
const DATABASE_URL = process.env.DATABASE_URL; 
if (!DATABASE_URL) {
    console.error("❌ XATOLIK: DATABASE_URL topilmadi! Railway Variables bo'limini tekshiring.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } 
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- YORDAMCHI FUNKSIYALAR (Sizning Python kodingizdan olingan) ---

/**
 * Javobni tozalash (Python clean_response funksiyasi analogi)
 * Keraksiz ### belgilarini va bo'shliqlarni olib tashlaydi.
 */
function cleanResponse(text) {
    if (!text) return "";
    // Regex: Satr boshidagi ### va bo'shliqlarni olib tashlash
    return text.replace(/^###\s*/gm, '').trim();
}

/**
 * Mistral AI dan javob olish
 */
async function getMistralReply(messages, systemPrompt) {
    try {
        // API uchun xabarlar formatini tayyorlash
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
                // Python kodingizda 'mistral-large-latest' edi, lekin barqarorlik uchun 'mistral-tiny' ishlatamiz.
                // Agar kalitingizda ruxsat bo'lsa 'mistral-large-latest' ga o'zgartirishingiz mumkin.
                model: "mistral-tiny", 
                messages: apiMessages,
                temperature: 0.7
            })
        });
        
        const data = await response.json();
        
        if (data.choices && data.choices.length > 0) {
            const rawContent = data.choices[0].message.content;
            // Javobni tozalab qaytaramiz
            return cleanResponse(rawContent);
        } else {
            console.error("Mistral Response Error:", data);
            return "AI javob bermadi (Limit yoki xatolik).";
        }
    } catch (error) {
        console.error("Mistral Fetch Error:", error);
        return "AI serverida aloqa xatoligi.";
    }
}

/**
 * Sarlavha generatsiya qilish (Qisqa va aniq)
 */
async function generateTitle(text) {
    try {
        const prompt = `Matnga 2-4 so'zli qisqa sarlavha qo'y. Faqat sarlavhani yoz. Matn: "${text}"`;
        const title = await getMistralReply([{ role: 'user', content: prompt }], "Siz sarlavha generatorisiz.");
        return title.replace(/["\.]/g, '').trim();
    } catch (e) {
        return "Yangi suhbat";
    }
}

/**
 * Rasmdan matn ajratib olish (OCR)
 */
async function extractTextFromImage(buffer) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        formData.append('apikey', OCR_API_KEY);
        formData.append('language', 'eng'); // Yoki 'uz' agar mavjud bo'lsa
        formData.append('isOverlayRequired', 'false');

        const response = await fetch("https://api.ocr.space/parse/image", {
            method: "POST",
            body: formData,
            // FormData o'zi kerakli headerlarni (boundary) qo'yadi
        });

        const data = await response.json();
        
        if (data.IsErroredOnProcessing) {
            console.error("OCR Error:", data.ErrorMessage);
            return null;
        }
        
        const parsedText = data.ParsedResults?.[0]?.ParsedText?.trim();
        return parsedText || null;
    } catch (e) {
        console.error("OCR Exception:", e);
        return null;
    }
}

// --- API ROUTELAR ---

// 1. Chatlar ro'yxati (Sidebar)
app.get('/api/sessions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            "SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Bazaga ulanish xatosi" });
    }
});

// 2. Xabarlar tarixi (Chatni yuklash)
app.get('/api/messages/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await pool.query(
            "SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
            [sessionId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Xabarlarni yuklash xatosi" });
    }
});

// 3. Chatni o'chirish
app.delete('/api/session/:sessionId', async (req, res) => {
    try {
        await pool.query("DELETE FROM chat_sessions WHERE id = $1", [req.params.sessionId]);
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: "O'chirishda xatolik" }); 
    }
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
    } catch (err) { 
        res.status(500).json({ error: "Yaratishda xatolik" }); 
    }
});

// 5. XABAR YUBORISH (Asosiy logika)
app.post('/api/chat', upload.single('file'), async (req, res) => {
    try {
        const { userId, type, message } = req.body;
        let { sessionId } = req.body;
        let replyText = "";
        let sessionTitle = null;

        // A) Sessiyani tekshirish yoki yaratish
        if (!sessionId || sessionId === 'null') {
            try {
                const newSession = await pool.query(
                    "INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id",
                    [userId]
                );
                sessionId = newSession.rows[0].id;
            } catch (dbErr) {
                return res.json({ success: false, response: "Sessiya yaratishda xatolik." });
            }
        }

        // B) User xabarini qayta ishlash
        let userContent = message || "";
        
        // Agar rasm bo'lsa
        if (type === 'image' && req.file) {
            const ocrText = await extractTextFromImage(req.file.buffer);
            if (ocrText) {
                userContent = `[Rasm Tahlili]: ${ocrText}\n\n(Foydalanuvchi rasmdagi matn haqida so'rayapti)`;
            } else {
                userContent = "[Rasm yuborildi, lekin matn aniqlanmadi. Umumiy tahlil qiling.]";
            }
        }

        // C) User xabarini bazaga yozish
        await pool.query(
            "INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)",
            [sessionId, userContent, type]
        );

        // D) Tarixni olish (Context Window)
        // Python kodingizda 9 ta xabar edi, biz bu yerda oxirgi 10 tasini olamiz
        const history = await pool.query(
            "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10",
            [sessionId]
        );
        
        // E) System Prompt (Siz so'ragan "aniq va ortiqcha narsalarsiz" buyrug'i)
        const systemPrompt = "Siz foydali yordamchisiz. Javobingiz aniq, lo'nda va ortiqcha gaplarsiz bo'lsin. Agar kod so'ralsa, faqat kodni va qisqa izohni bering.";
        
        // F) AI Javobini olish
        replyText = await getMistralReply(history.rows, systemPrompt);

        // G) AI javobini bazaga yozish
        await pool.query(
            "INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')",
            [sessionId, replyText]
        );

        // H) Avto-Sarlavha (Birinchi xabar bo'lsa)
        const sessionCheck = await pool.query("SELECT title FROM chat_sessions WHERE id = $1", [sessionId]);
        if (sessionCheck.rows[0].title === 'Yangi suhbat') {
            sessionTitle = await generateTitle(userContent);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [sessionTitle, sessionId]);
        }

        // I) Vaqtni yangilash
        await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);

        res.json({
            success: true,
            response: replyText,
            sessionId: sessionId,
            newTitle: sessionTitle
        });

    } catch (error) {
        console.error("Global Server Error:", error);
        res.json({ success: false, response: "Serverda jiddiy xatolik yuz berdi." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
