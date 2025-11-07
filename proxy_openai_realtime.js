import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

// ====== YANDEX API CONFIG ======
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) {
  throw new Error("❌ YANDEX_API_KEY environment variable is not set");
}

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// ==========================
// 📥 Обработка потока от ESP32
// ==========================
app.post("/stream", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).send("No audio file uploaded");
  }

  const pcmPath = req.file.path;
  const oggPath = pcmPath + ".ogg";

  console.log("🎙️ Incoming audio stream:", pcmPath);

  try {
    // 🎛 Конвертируем PCM → OGG (Opus)
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -f s16le -ar 16000 -ac 1 -i ${pcmPath} -c:a libopus ${oggPath}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error("❌ ffmpeg error:", stderr);
            reject(err);
          } else resolve();
        }
      );
    });

    console.log("✅ Converted to OGG:", oggPath);

    // 📤 Отправляем в Яндекс STT
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
    console.log("🗣️ Yandex response:", text);

    res.send(text);
  } catch (err) {
    console.error("🔥 Error:", err);
    res.status(500).send("Internal Server Error");
  } finally {
    try {
      fs.unlinkSync(pcmPath);
      fs.unlinkSync(oggPath);
    } catch (e) {
      console.warn("⚠️ Cleanup error:", e.message);
    }
  }
});

// ==========================
// 🧪 Тестовое подключение к Яндекс STT
// ==========================
app.get("/test", async (req, res) => {
  try {
    console.log("🧪 Testing connection to Yandex STT...");
    const response = await fetch("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize", {
      method: "POST",
      headers: {
        "Authorization": AUTH_HEADER,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.alloc(100), // пустой 100 байт файл
    });

    const text = await response.text();
    console.log("🧩 Test response:", text);
    res.send(text);
  } catch (err) {
    console.error("❌ Test failed:", err);
    res.status(500).send(err.message);
  }
});

// ==========================
// 🌍 Запуск сервера
// ==========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
