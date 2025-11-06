// npm install ws
import WebSocket, { WebSocketServer } from "ws";

const PORT = 10000;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_LANG = "ru-RU"; // язык распознавания

if (!YANDEX_API_KEY) throw new Error("YANDEX_API_KEY not set");

const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`🚀 ESP Proxy listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", (esp) => {
  console.log("✅ ESP connected", esp._socket.remoteAddress);

  // --- Подключение к Yandex STT ---
  const sttUrl = `wss://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=${YANDEX_LANG}`;
  const stt = new WebSocket(sttUrl, {
    headers: { Authorization: `Api-Key ${YANDEX_API_KEY}` }
  });

  stt.on("open", () => console.log("🔗 Connected to Yandex STT"));
  stt.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.result) {
        console.log("📝 Transcription:", data.result);
        // Можно пересылать обратно ESP32:
        // if (esp.readyState === WebSocket.OPEN) esp.send(data.result);
      }
    } catch (err) {
      console.error("⚠️ Parse error:", err.message);
    }
  });

  stt.on("close", () => console.log("🔌 Yandex STT closed"));
  stt.on("error", (e) => console.error("❌ Yandex STT error:", e.message));

  let audioBuffer = [];
  let flushTimer = null;
  const MIN_SEC = 0.2; // минимальный пакет для отправки 200ms
  const SAMPLE_RATE = 24000;
  const BYTES_PER_SAMPLE = 2;
  const MIN_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_SEC;

  function flushAudioBuffer(force = false) {
    if (audioBuffer.length === 0 || stt.readyState !== WebSocket.OPEN) return;

    const full = Buffer.concat(audioBuffer);
    if (!force && full.length < MIN_BYTES) {
      return;
    }

    stt.send(full);
    audioBuffer = [];
    clearTimeout(flushTimer);
    flushTimer = null;
    console.log(`📤 Sent ${full.length} bytes to Yandex STT`);
  }

  esp.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      audioBuffer.push(msg);

      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flushAudioBuffer(), 2000); // принудительно через 2s
      return;
    }

    const text = msg.toString().trim();
    if (text.includes("STREAM_STARTED")) {
      audioBuffer = [];
      flushTimer = null;
      console.log("🎙 Stream started");
    }

    if (text.includes("STREAM_STOPPED")) {
      flushAudioBuffer(true); // принудительно отправляем всё
      console.log("🛑 Stream stopped — flushed audio");
    }
  });

  esp.on("close", () => {
    console.log("🔌 ESP disconnected, flushing remaining buffer");
    flushAudioBuffer(true);
    stt.close();
  });

  esp.on("error", (e) => console.error("❌ ESP error:", e.message));
});
