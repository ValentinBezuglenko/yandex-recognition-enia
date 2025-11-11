import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();

const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// ==========================
// Текущий поток
// ==========================
let currentFileStream = null;
let currentFileName = "";
let totalBytes = 0;

// Ограничение размера чанка для express.raw
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));

// ==========================
// Получение чанка
// ==========================
app.post("/chunk", (req, res) => {
  if (!currentFileStream) {
    const timestamp = Date.now();
    currentFileName = `stream_${timestamp}.pcm`;
    currentFileStream = fs.createWriteStream(currentFileName);
    totalBytes = 0;
    console.log("🎙️ New stream started:", currentFileName);
  }

  const chunk = req.body;
  currentFileStream.write(chunk);
  totalBytes += chunk.length;

  // Лог каждые 8 KB
  if (totalBytes % 8192 < chunk.length) {
    console.log(`⬇️ Chunk received: ${chunk.length} bytes (total: ${totalBytes})`);
  }

  res.sendStatus(200);
});

// ==========================
// Сигнал конца потока
// ==========================
app.post("/end", async (req, res) => {
  if (!currentFileStream) {
    return res.status(400).send("❌ No stream in progress");
  }

  currentFileStream.end();
  console.log(`⏹ Stream ended. Total bytes: ${totalBytes}`);

  const pcmPath = currentFileName;
  const oggPath = currentFileName.replace(".pcm", ".ogg");

  try {
    // Конвертация PCM → OGG
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -f s16le -ar 16000 -ac 1 -i ${pcmPath} -af "volume=3" -c:a libopus ${oggPath}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error("❌ ffmpeg error:", stderr);
            reject(err);
          } else {
            console.log("✅ Converted to OGG:", oggPath);
            resolve();
          }
        }
      );
    });

    // Отправка в Yandex STT
    const oggData = fs.readFileSync(oggPath);
    console.log(`📤 Sending ${oggData.length} bytes to Yandex...`);

    const response = await fetch(STT_URL, {
      method: "POST",
      headers: {
        "Authorization": AUTH_HEADER,
        "Content-Type": "audio/ogg; codecs=opus",
      },
      body: oggData,
    });

    const text = await response.text();
    console.log("🗣️ Yandex response:", text);

    // Сброс потока
    currentFileStream = null;
    currentFileName = "";
    totalBytes = 0;

    res.send(text);
  } catch (err) {
    console.error("🔥 STT error:", err);
    res.status(500).send(err.message);
  }
});

// ==========================
// Список файлов
// ==========================
app.get("/list", (req, res) => {
  const files = fs.readdirSync("./").filter(f => f.startsWith("stream_"));
  res.json(files);
});

app.get("/files/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!fs.existsSync(filename)) return res.status(404).send("File not found");
  res.download(filename);
});

// ==========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
