import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

const PORT = process.env.PORT || 8080;       // WebSocket
const HTTP_PORT = process.env.HTTP_PORT || 8081; // Express
const app = express();

// ==========================
// 📡 WebSocket сервер для аудио
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

      // Конвертация в OGG
      exec(
        `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${pcmPath} -c:a libopus ${oggPath}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error("❌ ffmpeg error:", stderr);
          } else {
            // Проверяем размер файла
            if (fs.existsSync(oggPath)) {
              const stats = fs.statSync(oggPath);
              if (stats.size > 0) {
                console.log(`✅ Converted to OGG: ${oggFilename}`);
                console.log(`🔗 OGG available at: http://localhost:${HTTP_PORT}/download/${oggFilename}`);
              } else {
                console.error(`❌ OGG file is empty: ${oggFilename}`);
              }
            } else {
              console.error(`❌ OGG file not found: ${oggFilename}`);
            }
          }
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
// 📥 Express для скачивания файлов
// ==========================
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(process.cwd(), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const stats = fs.statSync(filePath);
  console.log(`📦 Sending file ${filename}, size: ${stats.size} bytes`);

  if (stats.size === 0) {
    return res.status(500).send("File is empty, conversion might have failed");
  }

  res.download(filePath, err => {
    if (err) console.error("❌ Download error:", err);
    else console.log(`✅ File sent: ${filename}`);
  });
});

app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP server running on port ${HTTP_PORT} — files available at /download/:filename`);
});
