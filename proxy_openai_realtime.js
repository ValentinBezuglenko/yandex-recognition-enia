import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

// ==========================
// 🔑 Настройки
// ==========================
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) {
  throw new Error("❌ YANDEX_API_KEY environment variable is not set");
}

const AUTH_HEADER = API_KEY.startsWith("Api-Key")
  ? API_KEY
  : `Api-Key ${API_KEY}`;

const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// ==========================
// 🎧 Приём обычного файла (multipart/form-data)
// ==========================
app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).send("No audio file uploaded");
  }

  const pcmPath = req.file.path;
  const oggPath = pcmPath + ".ogg";

  console.log("🎧 Received audio:", pcmPath);

  try {
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
// 📡 Потоковый приём PCM от ESP32
// ==========================
app.post("/stream", async (req, res) => {
  const timestamp = Date.now();
  const pcmPath = `stream_${timestamp}.pcm`;
  const oggPath = `stream_${timestamp}.ogg`;

  console.log("🎙️ Incoming audio stream...");

  const fileStream = fs.createWriteStream(pcmPath);
  req.pipe(fileStream);

  req.on("end", async () => {
    console.log("✅ Audio saved:", pcmPath);
    try {
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
      console.error("🔥 STT error:", err);
      res.status(500).send(err.message);
    } finally {
      try {
        fs.unlinkSync(pcmPath);
        fs.unlinkSync(oggPath);
      } catch (e) {
        console.warn("⚠️ Cleanup error:", e.message);
      }
    }
  });
});

// ==========================
// 🧪 Тестовый маршрут
// ==========================
app.get("/test", async (req, res) => {
  try {
    const response = await fetch(STT_URL, {
      method: "POST",
      headers: {
        "Authorization": AUTH_HEADER,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.alloc(100),
    });
    res.send(await response.text());
  } catch (err) {
    console.error("Test failed:", err);
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
