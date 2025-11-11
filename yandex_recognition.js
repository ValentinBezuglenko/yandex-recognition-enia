import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

const PORT = process.env.PORT || 8080;       // WebSocket
const HTTP_PORT = process.env.HTTP_PORT || 8081; // Express
const app = express();

// ==========================
// WebSocket сервер для получения PCM
// ==========================
const wss = new WebSocketServer({ port: PORT });
console.log(`🌐 WebSocket server running on port ${PORT}`);

wss.on("connection", ws => {
  const timestamp = Date.now();
  const pcmFilename = `stream_${timestamp}.pcm`;
  const oggFilename = `stream_${timestamp}.ogg`;
  const pcmPath = path.join(process.cwd(), pcmFilename);
  const oggPath = path.join(process.cwd(), oggFilename);

  const file = fs.createWriteStream(pcmPath);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", data => {
    if (data.toString() === "/end") {
      file.end();
      console.log(`⏹ Stream ended: ${pcmFilename} (total bytes: ${totalBytes})`);

      // Конвертация PCM → OGG
      exec(
        `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${pcmPath} -c:a libopus ${oggPath}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error("❌ ffmpeg error:", stderr);
            return;
          }

          if (!fs.existsSync(oggPath) || fs.statSync(oggPath).size === 0) {
            console.error(`❌ OGG file not created or empty: ${oggFilename}`);
            return;
          }

          console.log(`✅ Converted to OGG: ${oggFilename}`);
          console.log(`🌐 Web player available at: http://localhost:${HTTP_PORT}/player/${oggFilename}`);
        }
      );

      return;
    }

    if (data instanceof Buffer) {
      file.write(data);
      totalBytes += data.length;
      console.log(`⬇️ Chunk received: ${data.length} bytes (total: ${totalBytes})`);
    }
  });

  ws.on("close", () => {
    file.end();
    console.log("❌ Client disconnected");
  });

  ws.on("error", err => console.error("❌ WebSocket error:", err));
});

// ==========================
// Express веб-морда и отдача файлов
// ==========================

// Страница с аудио-плеером
app.get("/player/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(process.cwd(), filename);

  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.send(`
    <!doctype html>
    <html>
      <head><title>Audio Player</title></head>
      <body>
        <h1>Прослушать OGG</h1>
        <audio controls>
          <source src="/file/${filename}" type="audio/ogg">
          Ваш браузер не поддерживает OGG.
        </audio>
        <br>
        <a href="/file/${filename}" download>Скачать OGG</a>
      </body>
    </html>
  `);
});

// Маршрут для отдачи файлов
app.get("/file/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(process.cwd(), filename);

  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.setHeader("Content-Type", "audio/ogg");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);

  readStream.on("error", err => {
    console.error("❌ Read stream error:", err);
    res.status(500).end("Server error while reading file");
  });
});

app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP server running on port ${HTTP_PORT}`);
});
