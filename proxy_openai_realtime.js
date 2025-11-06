// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const IAM_TOKEN = process.env.YC_IAM_TOKEN;
if (!IAM_TOKEN) throw new Error("Set Yandex IAM token in YC_IAM_TOKEN");

const SAMPLE_RATE = 24000; // 24 kHz
const BYTES_PER_SAMPLE = 2; // PCM16
const CHANNELS = 1;

let audioBuffer = [];

const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`🚀 Yandex STT proxy listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", (esp) => {
  console.log("✅ ESP connected", esp._socket.remoteAddress);

  let flushTimer = null;
  const FLUSH_INTERVAL = 2000; // 2 сек

  esp.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      audioBuffer.push(msg);

      // если данных нет 2 секунды, сбрасываем
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flushAudioToYandex(), FLUSH_INTERVAL);
      return;
    }

    const text = msg.toString().trim();
    if (text.includes("STREAM_STARTED")) {
      audioBuffer = [];
      console.log("🎙 Stream started");
    }
    if (text.includes("STREAM_STOPPED")) {
      flushAudioToYandex(true);
    }
  });

  esp.on("close", () => {
    console.log("🔌 ESP disconnected, flushing buffer");
    flushAudioToYandex(true);
  });

  async function flushAudioToYandex(force = false) {
    if (audioBuffer.length === 0) return;
    const full = Buffer.concat(audioBuffer);
    if (!force && full.length < SAMPLE_RATE * BYTES_PER_SAMPLE) return; // хотя бы 1 секунда аудио

    audioBuffer = [];

    try {
      // Отправляем в Yandex STT
      const res = await axios.post(
        "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
        full,
        {
          headers: {
            "Authorization": `Bearer ${IAM_TOKEN}`,
            "Content-Type": "application/octet-stream",
            "Transfer-Encoding": "chunked",
          },
          params: {
            lang: "ru-RU",
            format: "lpcm",
            sampleRateHertz: SAMPLE_RATE,
          },
          responseType: "json",
        }
      );

      const text = res.data.result || "";
      console.log("📝 STT result:", text);

      // Отправляем текст обратно ESP
      if (esp.readyState === WebSocket.OPEN) {
        esp.send(text);
      }

    } catch (err) {
      console.error("❌ Yandex STT error:", err.response?.data || err.message);
    }
  }
});
