import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🗂 Папка для файлов
const OGG_DIR = path.join(__dirname, "public/ogg");
if (!fs.existsSync(OGG_DIR)) fs.mkdirSync(OGG_DIR, { recursive: true });

// 🌐 Один порт (Render требует один сервер)
const PORT = process.env.PORT || 8080;
const app = express();

// 📡 Вебсокет поверх того же HTTP сервера
import http from "http";
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
  const timestamp = Date.now();
  const pcmFilename = `stream_${timestamp}.pcm`;
  const oggFilename = `stream_${timestamp}.ogg`;
  const pcmPath = path.join(OGG_DIR, pcmFilename);
  const oggPath = path.join(OGG_DIR, oggFilename);

  const file = fs.createWriteStream(pcmPath);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", data => {
    if (data.toString() === "/end") {
      file.end();
      console.log(`⏹ Stream ended: ${pcmFilename} (total: ${totalBytes})`);

      exec(
        `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${pcmPath}" -c:a libopus "${oggPath}"`,
        err => {
          if (err) return console.error("❌ ffmpeg error");
          if (!fs.existsSync(oggPath)) return console.error("❌ No OGG created");

          console.log(`✅ Converted to OGG: ${oggFilename}`);
          console.log(`🌐 Player: https://${process.env.RENDER_EXTERNAL_HOSTNAME}/player/${oggFilename}`);
        }
      );
      return;
    }

    if (data instanceof Buffer) {
      file.write(data);
      totalBytes += data.length;
    }
  });

  ws.on("close", () => file.end());
});

// 🎧 Страница-плеер
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

// 🎵 Отдача файлов
app.use("/file", express.static(OGG_DIR));

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
