// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// Минимальный буфер для отправки: 2 сек PCM16 @ 24kHz
const MIN_BUFFER_SIZE = 24000 * 2 * 2; // 96000 байт

//
// === 1. Создание Realtime-сессии ===
//
async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17" },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

//
// === 2. Запуск WS-сервера ===
//
async function start() {
  console.log(`\n🚀 Proxy listening on ws://0.0.0.0:${PORT}`);
  if (process.env.RENDER_SERVICE_NAME) {
    console.log(`   WebSocket URL: wss://${process.env.RENDER_SERVICE_NAME}.onrender.com/ws`);
  }

  const wss = new WebSocketServer({ port: PORT, path: "/ws" });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");
    console.log("ESP IP:", esp._socket.remoteAddress);

    try {
      //
      // === 3. Создаём Realtime-сессию ===
      //
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

      //
      // === 4. Переменные состояния ===
      //
      let ready = false;
      let audioBuffer = [];

      //
      // === 5. Отправка аудио при накоплении 2 секунд ===
      //
      function flushAudio() {
        if (!ready) return;

        const full = Buffer.concat(audioBuffer);
        if (full.length < MIN_BUFFER_SIZE) {
          console.log(`⏳ Buffer too small (${full.length} bytes), waiting for 2s of audio`);
          return; // не отправляем
        }

        const base64 = full.toString("base64");
        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oa.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["text"], instructions: "Return only raw transcription." }
        }));

        console.log(`📤 Sent buffer: ${full.length} bytes (~${(full.length / 48000).toFixed(2)} sec)`);
        audioBuffer = [];
      }

      //
      // === 6. OpenAI события ===
      //
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

      //
      // === 7. Приём PCM от ESP ===
      //
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          console.log(`🎧 Got ${msg.length} bytes from ESP`);
          audioBuffer.push(msg);
          flushAudio();
          return;
        }

        const text = msg.toString().trim();
        if (text.includes("STREAM_STOPPED") || text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped — attempting final flush");
          flushAudio();
          audioBuffer = []; // сбросим остаток, если меньше 2 сек
        }

        if (text.includes("STREAM_STARTED") || text.includes("STREAM STARTED")) {
          console.log("🎙 Stream started");
          audioBuffer = [];
        }
      });

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
