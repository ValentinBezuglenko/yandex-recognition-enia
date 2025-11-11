import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// Папка для сохранения потоков
const STREAM_DIR = path.join(process.cwd(), "streams");
if (!fs.existsSync(STREAM_DIR)) fs.mkdirSync(STREAM_DIR);

// -------------------------
// Потоковый приём PCM
// -------------------------
app.post("/stream", (req, res) => {
  const timestamp = Date.now();
  const pcmPath = path.join(STREAM_DIR, `stream_${timestamp}.pcm`);
  const oggPath = path.join(STREAM_DIR, `stream_${timestamp}.ogg`);

  console.log("🎙️ Incoming audio stream...");

  const fileStream = fs.createWriteStream(pcmPath);
  let totalBytes = 0;

  req.on("data", chunk => {
    fileStream.write(chunk);
    totalBytes += chunk.length;
    console.log(`⬇️ Chunk received: ${chunk.length} bytes (total: ${totalBytes})`);
  });

  req.on("end", async () => {
    fileStream.end();
    console.log(`⏹ Stream ended: ${pcmPath} (${totalBytes} bytes)`);

    try {
      // Конвертация PCM → OGG
      await new Promise((resolve, reject) => {
        exec(
          `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${pcmPath}" -af "volume=3" -c:a libopus "${oggPath}"`,
          (err, stdout, stderr) => {
            if (err) {
              console.error("❌ ffmpeg error:", stderr);
              reject(err);
            } else {
              console.log(`✅ Converted to OGG: ${oggPath}`);
              resolve();
            }
          }
        );
      });

      res.json({
        message: "Stream processed",
        pcm: `/download/${path.basename(pcmPath)}`,
        ogg: `/download/${path.basename(oggPath)}`
      });

    } catch (err) {
      console.error("🔥 Error processing stream:", err);
      res.status(500).send(err.message);
    }
  });

  req.on("error", err => {
    console.error("❌ Stream error:", err);
    fileStream.destroy(err);
  });
});

// -------------------------
// Скачать файл
// -------------------------
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(STREAM_DIR, filename);

  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
  res.download(filePath);
});

// -------------------------
// Список всех файлов
// -------------------------
app.get("/list", (req, res) => {
  const files = fs.readdirSync(STREAM_DIR);
  res.json(files);
});

// -------------------------
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`✅ Streams available at: /download/<filename>`);
});
