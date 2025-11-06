// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// ---------------- 1. Создание Realtime-сессии ----------------
async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17" },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

// ---------------- 2. Запуск WS-сервера ----------------
async function start() {
  console.log(`\n🚀 Proxy listening on ws://0.0.0.0:${PORT}`);

  const wss = new WebSocketServer({ port: PORT, path: "/ws" });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected", esp._socket.remoteAddress);

    try {
      // ---------------- 3. Создание Realtime-сессии ----------------
      const session = await createRealtimeSession();
      const clientSecret = session?.client_secret?.value || session?.client_secret;
      if (!clientSecret) throw new Error("No client_secret in OpenAI response");

      const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecret)}`;
      const oa = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      // ---------------- 4. Состояние ----------------
      let ready = false;
      let audioBuffer = [];
      let flushTimer = null;
      let lastAudioTime = 0;

      const MIN_BUFFER_SIZE = 48000; // 2 сек * 24kHz * 2 байта
      const FORCE_FLUSH_MS = 2000;   // таймаут 2 сек после последнего чанка
      const FLUSH_INTERVAL = 200;    // периодическая проверка

      // ---------------- 5. Функция flush ----------------
      function flushAudio() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN) return;

        const full = Buffer.concat(audioBuffer);
        if (full.length < MIN_BUFFER_SIZE) {
          console.log(`⏳ Buffer too small (${full.length} bytes), waiting for 2s of audio`);
          return;
        }

        const base64 = full.toString("base64");
        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        console.log(`📤 Sent ${full.length} bytes to OpenAI`);
        audioBuffer = [];
        lastAudioTime = 0;
      }

      // ---------------- 6. Обработка OpenAI ----------------
      oa.on("open", () => console.log("🔗 Connected to OpenAI Realtime"));
      oa.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());

          if (parsed.type === "session.created") {
            console.log("🟢 OpenAI session ready");
            ready = true;
          }

          if (parsed.type === "response.output_text.delta") {
            process.stdout.write(parsed.delta);
          }

          if (parsed.type === "response.completed") {
            console.log("\n✅ Transcription complete\n");
          }

          if (parsed.type === "error") {
            console.error("❌ OpenAI Error:", parsed.error);
          }
        } catch (err) {
          console.error("⚠️ Parse error:", err.message);
        }
      });

      oa.on("close", () => console.log("🔌 OpenAI closed"));
      oa.on("error", (e) => console.error("❌ OpenAI WS Error:", e.message));

      // ---------------- 7. Приём PCM от ESP ----------------
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          audioBuffer.push(msg);
          lastAudioTime = Date.now();
          return;
        }

        const text = msg.toString().trim();

        if (text.includes("STREAM_STOPPED")) {
          console.log("🛑 Stream stopped — will flush buffer after 2s timeout");
          // flush остатка через 2 секунды
          setTimeout(() => flushAudio(), FORCE_FLUSH_MS);
        }

        if (text.includes("STREAM_STARTED")) {
          console.log("🎙 Stream started");
          audioBuffer = [];
          lastAudioTime = 0;
        }
      });

      // ---------------- 8. Таймаут на случай, если ESP перестало слать данные ----------------
      setInterval(() => {
        if (audioBuffer.length && lastAudioTime && (Date.now() - lastAudioTime) > FORCE_FLUSH_MS) {
          flushAudio();
        }
      }, FLUSH_INTERVAL);

      esp.on("close", () => {
        console.log("🔌 ESP disconnected");
        oa.close();
      });
    } catch (err) {
      console.error("❌ Setup error:", err.message);
      if (esp.readyState === WebSocket.OPEN) esp.close();
    }
  });
}

start().catch(console.error);
