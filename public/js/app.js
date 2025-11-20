// ----------------------------------------
// IMPORTS
// ----------------------------------------
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------
// MIDDLEWARE
// ----------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------------------------
// MULTER (FILE UPLOAD)
// ----------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// ----------------------------------------
// POSTGRES
// ----------------------------------------
const db = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'chatdb',
  password: '12345',
  port: 5432,
});

// ----------------------------------------
// SSE CLIENTS
// ----------------------------------------
let clients = [];

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders();

  const client = { id: Date.now(), res };
  clients.push(client);

  console.log('Client connected:', client.id);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
    console.log('Client disconnected:', client.id);
  });
});

// SSE xabar yuborish
function sendToAll(event, data) {
  clients.forEach(c => {
    c.res.write(`event: ${event}\n`);
    c.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// ----------------------------------------
// OPENAI STREAM (REAL-TIME)
// ----------------------------------------
async function streamChat(message, clientId) {
  const response = await axios({
    method: 'post',
    url: 'https://api.openai.com/v1/chat/completions',
    responseType: 'stream',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    data: {
      model: "gpt-4.1-mini",
      stream: true,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: message }
      ]
    }
  });

  let fullText = "";

  response.data.on('data', chunk => {
    const lines = chunk.toString().split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const json = line.replace("data: ", "").trim();

        if (json === "[DONE]") {
          sendToAll("end", { clientId });
          return;
        }

        try {
          const parsed = JSON.parse(json);
          const token = parsed.choices?.[0]?.delta?.content;

          if (token) {
            fullText += token;
            sendToAll("token", { token, clientId });
          }
        } catch (err) {}
      }
    }
  });

  response.data.on('end', () => {
    sendToAll("done", { message: fullText, clientId });
  });
}

// ----------------------------------------
// CHAT ROUTE
// ----------------------------------------
app.post('/chat', async (req, res) => {
  try {
    const { text, clientId } = req.body;

    // DB ga saqlash
    await db.query(
      "INSERT INTO messages (sender, text) VALUES ($1, $2)",
      ['user', text]
    );

    // Chatni streamda yuboramiz
    streamChat(text, clientId);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------------------------
// FILE UPLOAD + AI INSERT
// ----------------------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  res.json({
    status: "ok",
    file: req.file.filename
  });
});

// ----------------------------------------
// OXIRGI 50 XABAR
// ----------------------------------------
app.get('/messages', async (req, res) => {
  const result = await db.query("SELECT * FROM messages ORDER BY id DESC LIMIT 50");
  res.json(result.rows.reverse());
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});