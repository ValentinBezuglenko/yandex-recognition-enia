import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { io } from "socket.io-client";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// --- HTTP endpoint для Render ---
app.get("/", (req, res) => res.send("✅ Server is alive"));

// --- Создаём сервер HTTP для Express и WS ---
const server = createServer(app);

// --- WebSocketServer на том же сервере ---
const wss = new WebSocketServer({ server });
console.log(`✅ WebSocket proxy запущен на порту ${PORT}`);

// --- Папка для OGG/PCM файлов ---
const OGG_DIR = path.join(__dirname, "public/ogg");
if (!fs.existsSync(OGG_DIR)) fs.mkdirSync(OGG_DIR, { recursive: true });

// --- Настройки Yandex STT ---
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

async function recognizeOgg(oggPath) {
  const oggData = fs.readFileSync(oggPath);
  const response = await fetch(STT_URL, {
    method: "POST",
    headers: {
      "Authorization": AUTH_HEADER,
      "Content-Type": "audio/ogg; codecs=opus",
    },
    body: oggData,
  });

  const text = await response.text();
  console.log("🗣️ Yandex STT response:", text);
  return text;
}

// --- WebSocket приём аудио ---
wss.on("connection", ws => {
  let file = null;
  let pcmPath = null;
  let oggPath = null;
  let totalBytes = 0;

  function startNewStream() {
    const timestamp = Date.now();
    pcmPath = path.join(OGG_DIR, `stream_${timestamp}.pcm`);
    oggPath = path.join(OGG_DIR, `stream_${timestamp}.ogg`);
    totalBytes = 0;
    file = fs.createWriteStream(pcmPath);
    console.log("🎙 New stream started:", pcmPath);
  }

  startNewStream();

  ws.on("message", async data => {
    if (data.toString() === "/end") {
      if (!file) return;
      file.end();
      console.log(`⏹ Stream ended: ${path.basename(pcmPath)} (total: ${totalBytes})`);

      exec(
        `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${pcmPath}" -af "volume=3" -c:a libopus "${oggPath}"`,
        async err => {
          if (err) return console.error("❌ ffmpeg error:", err);
          if (!fs.existsSync(oggPath)) return console.error("❌ No OGG created");

          console.log(`✅ Converted to OGG: ${path.basename(oggPath)}`);

          const text = await recognizeOgg(oggPath);

          // Отправка стримеру
          ws.send(JSON.stringify({ type: "stt_result", text }));

          // Broadcast всем клиентам (один раз)
          if (wss.clients.size > 0) {
            console.log("📢 Broadcast to all clients:", text);
            wss.clients.forEach(client => {
              if (client.readyState === client.OPEN) {
                client.send(JSON.stringify({ type: "stt_broadcast", text }));
              }
            });
          }

          // Начинаем новый поток для следующего аудио
          startNewStream();
        }
      );
      return;
    }

    if (data instanceof Buffer) {
      if (!file) startNewStream();
      file.write(data);
      totalBytes += data.length;
    }
  });

  ws.on("close", () => {
    if (file) file.end();
    console.log("🔌 Client disconnected");
  });
});

// --- Подключение к backend.enia-kids.ru ---
const socket = io("ws://backend.enia-kids.ru:8025", { transports: ["websocket"] });
socket.on("connect", () => console.log("🟢 Подключено к backend.enia-kids.ru"));
socket.on("disconnect", () => console.log("🔴 Отключено от backend.enia-kids.ru"));

// --- Ретрансляция событий от backend ---
socket.on("/child/game-level/action", msg => {
  console.log("📩 Событие:", msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(msg));
  });
});

// --- HTML-плеер для проверки ---
app.get("/player/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(OGG_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.send(`
    <!doctype html>
    <html>
      <head><title>${filename}</title></head>
      <body>
        <h1>${filename}</h1>
        <audio controls autoplay>
          <source src="/file/${filename}" type="audio/ogg">
        </audio>
        <br>
        <a href="/file/${filename}" download>Скачать</a>
      </body>
    </html>
  `);
});

app.use("/file", express.static(OGG_DIR));

// --- Автопинг для Render ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log("💓 Self ping OK"))
    .catch(err => console.log("⚠️ Self ping error:", err.message));
}, 4 * 60 * 1000);

// --- Запуск сервера ---
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
