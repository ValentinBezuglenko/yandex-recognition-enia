import express from "express";
import fetch from "node-fetch";
import { spawn } from "child_process";
import fs from "fs";

const app = express();
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY environment variable is not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// ==========================
// 🎧 Потоковая передача PCM → OGG → Yandex
// ==========================
app.post("/stream", async (req, res) => {
  console.log("🎙️ Incoming audio stream...");

  const oggPath = `stream_${Date.now()}.ogg`;
  const ffmpeg = spawn("ffmpeg", [
    "-f", "s16le",
    "-ar", "16000",
    "-ac", "1",
    "-i", "pipe:0",
    "-c:a", "libopus",
    oggPath,
  ]);

  req.pipe(ffmpeg.stdin);

  ffmpeg.on("close", async (code) => {
    console.log("✅ Audio saved:", oggPath);
    try {
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
      console.log("🗣️ Yandex:", text);
      res.send(text);
    } catch (err) {
      console.error("🔥 STT error:", err);
      res.status(500).send("SpeechKit error");
    } finally {
      fs.unlink(oggPath, () => {});
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("❌ ffmpeg spawn error:", err);
    res.status(500).send("ffmpeg failed");
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Streaming server running on port ${PORT}`));
