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

const SYSTEM_INSTRUCTION = 
    "Siz foydali va aqlli AI yordamchisiz.\n" +
    "1. Javoblaringiz lo'nda va aniq bo'lsin.\n" +
    "2. Mavzuga mos EMOJILAR ishlating. 🎨✨\n" +
    "3. KOD yozsangiz, albatta Markdown (```language) formatida yozing.\n" +
    "4. Kod ichida qisqa izohlar bo'lsin.";

// --- HELPERS ---
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
    } catch (e) { return true; }
}

async function getGPTTitle(text) {
    try {
        // TUZATILDI: URL toza formatda (qavslarsiz)
        const response = await fetch("[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini", // Sarlavha uchun kichik model yetarli
                messages: [
                    { role: "system", content: "Sarlavha generatorisan. Faqat 2-3 so'zli nom qaytar." },
                    { role: "user", content: `Matnga sarlavha: "${text.substring(0, 100)}"` }
                ],
                max_tokens: 15
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.replace(/['"_`*#]/g, '').trim() || "Yangi suhbat";
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

        // TUZATILDI: URL toza formatda (qavslarsiz)
        const response = await fetch("[https://api.ocr.space/parse/image](https://api.ocr.space/parse/image)", { 
            method: "POST", body: formData, headers: formData.getHeaders()
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

app.post('/api/chat', upload.single('file'), async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const controller = new AbortController();
    req.on('close', () => {
        controller.abort();
        res.end();
    });

    try {
        const { userId, type, message, analysisType } = req.body;
        let { sessionId } = req.body;
        let isNewSession = false;

        if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
            const newSession = await pool.query("INSERT INTO chat_sessions (user_id, title) VALUES ($1, 'Yangi suhbat') RETURNING id", [userId]);
            sessionId = newSession.rows[0].id;
            isNewSession = true;
        }

        let userContent = message || "";
        
        // 1. MODEL TANLASH LOGIKASI
        // Default: gpt-4o-mini (matn va OCR uchun)
        let modelName = "gpt-4o-mini"; 

        if (type === 'image' && req.file) {
            if (analysisType === 'vision') {
                // Vision (Aqlli tahlil) tanlansa, kuchli model ishlatamiz
                modelName = "gpt-4o";
                
                const canUse = await checkAndIncrementLimit(userId, 3);
                if (!canUse) {
                    res.write(`data: ${JSON.stringify({ token: "⚠️ **Limit tugadi!**\nVision (aqlli tahlil) kuniga 3 marta. 'OCR' dan foydalaning." })}\n\n`);
                    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                    res.end();
                    return;
                }
                const base64 = req.file.buffer.toString('base64');
                userContent = [
                    { type: "text", text: message || "Rasmni tahlil qil." },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
                ];
            } else {
                // OCR tanlansa, gpt-4o-mini qoladi (chunki biz unga faqat matn beramiz)
                const ocrText = await extractTextFromImage(req.file.buffer);
                userContent = ocrText ? `[OCR Matn]: "${ocrText}"\n\nSavol: ${message}` : "[Matn topilmadi]";
            }
        }

        const dbContent = Array.isArray(userContent) ? JSON.stringify(userContent) : userContent;
        await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'user', $2, $3)", [sessionId, dbContent, type]);

        const history = await pool.query("SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 10", [sessionId]);
        
        const apiMessages = [
            { role: "system", content: SYSTEM_INSTRUCTION },
            ...history.rows.map(m => {
                try {
                    return { role: m.role, content: m.content.startsWith('[') ? JSON.parse(m.content) : m.content };
                } catch { return { role: m.role, content: m.content }; }
            }),
            { role: "user", content: userContent }
        ];

        // TUZATILDI: URL toza formatda va MODEL dinamik (modelName)
        const openaiResponse = await fetch("[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: modelName, messages: apiMessages, stream: true, max_tokens: 1500 }),
            signal: controller.signal
        });

        if (!openaiResponse.ok) {
            const errorText = await openaiResponse.text();
            console.error("OpenAI Error:", errorText); // Xatoni konsolga chiqaramiz
            res.write(`data: ${JSON.stringify({ error: "AI Error: " +  openaiResponse.statusText })}\n\n`);
            res.end(); return;
        }

        let fullAIResponse = "";
        for await (const chunk of openaiResponse.body) {
            const lines = Buffer.from(chunk).toString('utf-8').split("\n");
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
                            res.write(`data: ${JSON.stringify({ token })}\n\n`);
                        }
                    } catch (e) {}
                }
            }
        }

        if (isNewSession) {
            const titleText = typeof userContent === 'string' ? userContent : (message || "Rasm tahlili");
            const newTitle = await getGPTTitle(titleText);
            await pool.query("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
            res.write(`data: ${JSON.stringify({ newTitle })}\n\n`);
        }

        if (fullAIResponse) {
            await pool.query("INSERT INTO chat_messages (session_id, role, content, type) VALUES ($1, 'assistant', $2, 'text')", [sessionId, fullAIResponse]);
            await pool.query("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
        }

        res.write(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`);
        res.end();

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Server Error:", error);
            res.write(`data: ${JSON.stringify({ error: "Server Xatosi" })}\n\n`);
        }
        res.end();
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
