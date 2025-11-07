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
// 📡 Потоковый приём PCM от ESP32 и сохранение файлов
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
      // Конвертация PCM → OGG + усиление громкости x3
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
    }
    // Файлы теперь не удаляем — чтобы можно было прослушать
    // fs.unlinkSync(pcmPath);
    // fs.unlinkSync(oggPath);
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
