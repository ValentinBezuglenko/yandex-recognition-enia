import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import http from "http";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OGG_DIR = path.join(__dirname, "public/ogg");
if (!fs.existsSync(OGG_DIR)) fs.mkdirSync(OGG_DIR, { recursive: true });

// 🌐 Настройки
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 🧠 Распознавание речи через Yandex STT
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

// 📡 WebSocket приём аудио
wss.on("connection", ws => {
  console.log("🎙 Client connected");

  let file = null;
  let pcmPath = "";
  let oggPath = "";
  let totalBytes = 0;

  ws.on("message", async data => {
    if (data.toString() === "/end") {
      if (file) {
        file.end();
        console.log(`⏹ Stream ended: ${path.basename(pcmPath)} (total: ${totalBytes})`);

        // 🔄 Конвертация PCM → OGG
        exec(
          `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${pcmPath}" -af "volume=3" -c:a libopus "${oggPath}"`,
          async err => {
            if (err) {
              console.error("❌ ffmpeg error:", err);
              return;
            }
            if (!fs.existsSync(oggPath)) {
              console.error("❌ No OGG created");
              return;
            }

            console.log(`✅ Converted to OGG: ${path.basename(oggPath)}`);
            console.log(`🌐 Player: https://${process.env.RENDER_EXTERNAL_HOSTNAME || "localhost"}/player/${path.basename(oggPath)}`);

            const text = await recognizeOgg(oggPath);
            ws.send(JSON.stringify({ type: "stt_result", text }));
          }
        );

        // Сброс для следующего стрима
        file = null;
        pcmPath = "";
        oggPath = "";
        totalBytes = 0;
      }
      return;
    }

    if (data instanceof Buffer) {
      // Создаём новый файл при начале каждого стрима
      if (!file) {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000); // чтобы точно уникально
        const pcmFilename = `stream_${timestamp}_${random}.pcm`;
        const oggFilename = `stream_${timestamp}_${random}.ogg`;
        pcmPath = path.join(OGG_DIR, pcmFilename);
        oggPath = path.join(OGG_DIR, oggFilename);
        file = fs.createWriteStream(pcmPath);
        totalBytes = 0;
      }

      file.write(data);
      totalBytes += data.length;
    }
  });

  ws.on("close", () => {
    if (file) file.end();
  });
});

// 🎧 HTML-плеер
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

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
