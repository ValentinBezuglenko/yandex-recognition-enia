import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) {
  throw new Error("YANDEX_API_KEY environment variable is not set");
}
const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// принимаем POST от ESP32
app.post("/upload", upload.single("audio"), async (req, res) => {
  const pcmPath = req.file.path;
  const oggPath = pcmPath + ".ogg";

  console.log("🎧 Received audio:", pcmPath);

  // Конвертируем PCM → OGG (Opus)
  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -f s16le -ar 16000 -ac 1 -i ${pcmPath} -c:a libopus ${oggPath}`,
      (err) => (err ? reject(err) : resolve())
    );
  });

  console.log("✅ Converted to OGG:", oggPath);

  // Отправляем в Яндекс
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

  // Очищаем временные файлы
  fs.unlinkSync(pcmPath);
  fs.unlinkSync(oggPath);

  res.send(text);
});

app.listen(8080, () => console.log("🌐 Server running on http://localhost:8080"));
