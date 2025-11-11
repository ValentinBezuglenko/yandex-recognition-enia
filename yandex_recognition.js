import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

const PORT = process.env.PORT || 8080;       // WebSocket
const HTTP_PORT = process.env.HTTP_PORT || 8081; // Express
const app = express();

// ==========================
// 📡 WebSocket сервер
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
            console.error(`❌ OGG file not created or пустой: ${oggFilename}`);
            return;
          }

          console.log(`✅ Converted to OGG: ${oggFilename}`);

          // Загрузка на 0x0.st
          const uploadCommand = `curl --upload-file ${oggPath} https://0x0.st/`;
          exec(uploadCommand, (err2, stdout2, stderr2) => {
            if (err2) {
              console.error("❌ Upload error:", stderr2);
            } else {
              const publicUrl = stdout2.trim();
              console.log(`🔗 Uploaded to 0x0.st: ${publicUrl}`);
            }
          });
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
// HTTP сервер (если нужен)
// ==========================
app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP server running on port ${HTTP_PORT}`);
});
