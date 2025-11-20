const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const app = express();
const PORT = process.env.PORT || 3000;
const MISTRAL_API_KEY = "aWo4o2nHc5ZoY62aHs0OndgsM4jDO14f";
const OCR_API_KEY = "K86767579488957"; 
const CONCISE_INSTRUCTION = 
    "Siz faqat QISQA VA TEZ javob bering. " +
    "Javob 1-3 ta jumla bo'lsin; ortiqcha tushuntirishlardan voz keching. " +
    "Kerak bo'lsa, maksimal 2 ta punkt bilan cheklangan ro'yxat bering.";

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
async function getMistralReply(userMessage, systemPrompt = CONCISE_INSTRUCTION) {
    try {
        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${MISTRAL_API_KEY}`
            },
            body: JSON.stringify({
                model: "mistral-tiny",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessage }
                ]
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "AI javob bermadi.";
    } catch (error) {
        console.error("Mistral Error:", error);
        return "AI serverida xatolik.";
    }
}

async function extractTextFromImage(buffer) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        formData.append('apikey', OCR_API_KEY);
        formData.append('language', 'eng');
        formData.append('isOverlayRequired', 'false');

        const response = await fetch("https://api.ocr.space/parse/image", {
            method: "POST",
            body: formData,
            // native fetch da FormData boundary headerini o'zi qo'yadi, shuning uchun headers shart emas
        });

        const data = await response.json();
        if (data.IsErroredOnProcessing) return "";
        return data.ParsedResults?.[0]?.ParsedText?.trim() || "";
    } catch (error) {
        console.error("OCR Error:", error);
        return "";
    }
}

app.post('/api/chat', upload.single('file'), async (req, res) => {
    try {
        const message = req.body.message || "";
        const type = req.body.type || "text";
        let replyText = "";
        if (type === 'text') {
            replyText = await getMistralReply(message);
        } 
        else if (type === 'image' && req.file) {
            const extractedText = await extractTextFromImage(req.file.buffer);
            
            if (!extractedText || extractedText.length < 3) {
                replyText = "Rasmda matn topilmadi. Iltimos aniqroq rasm yuboring.";
            } else {
                const aiPrompt = `Quyidagi matn rasmdan olindi. Uni tahlil qilib ber:\n\n"${extractedText}"`;
                replyText = await getMistralReply(aiPrompt);
            }
        }

        else if (type === 'voice') {
            replyText = "Ovozli xabar qabul qilindi (Beta).";
        }

        res.json({ success: true, response: replyText, type: 'text' });

    } catch (error) {
        console.error("Server Error:", error);
        res.json({ success: false, response: "Serverda xatolik yuz berdi." });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server ${PORT}-portda ishga tushdi.`);
});
