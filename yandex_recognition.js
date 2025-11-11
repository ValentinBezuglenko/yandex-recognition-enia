import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import { exec } from "child_process";
import express from "express";

const PORT_WS = process.env.PORT_WS || 10000;
const PORT_HTTP = process.env.PORT_HTTP || 8080;

const app = express();
const wss = new WebSocketServer({ port: PORT_WS });

console.log(`🌐 WebSocket server running on port ${PORT_WS}`);

// =======================
// 📡 WebSocket — приём аудио
// =======================
wss.on("connection", ws => {
  const timestamp = Date.now();
  const pcmFilename = `stream_${timestamp}.pcm`;
  const oggFilename = `stream_${timestamp}.ogg`;
  const file = fs.createWriteStream(pcmFilename);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", data => {
    if (data.toString() === "/end") {
      file.end();
      console.log(`⏹ Stream ended: ${pcmFilename} (total bytes: ${totalBytes})`);

      // Конвертация PCM → OGG
      exec(
        `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${pcmFilename} -c:a libopus ${oggFilename}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error("❌ ffmpeg error:", stderr);
          } else {
            console.log(`✅ Converted to OGG: ${oggFilename}`);
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

  ws.on("error", err => {
    console.error("❌ WebSocket error:", err);
  });
});

// =======================
// 📥 HTTP — скачать OGG
// =======================
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!fs.existsSync(filename)) return res.status(404).send("File not found");
  res.download(filename);
});

// Список файлов
app.get("/list", (req, res) => {
  const files = fs.readdirSync("./").filter(f => f.endsWith(".ogg"));
  res.json(files);
});

app.listen(PORT_HTTP, () => {
  console.log(`🌐 HTTP server running on port ${PORT_HTTP}`);
});
