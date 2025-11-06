// npm install ws axios fs
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RECORDINGS_DIR = "./recordings";

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

//
// === 1. Создание новой Realtime-сессии ===
//
async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    {
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "alloy",
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

//
// === 2. Запуск локального WebSocket-сервера ===
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

    // === Создаём файл для текущей сессии ===
    const filename = path.join(
      RECORDINGS_DIR,
      `session_${new Date().toISOString().replace(/[:.]/g, "-")}.raw`
    );
    const fileStream = fs.createWriteStream(filename);
    console.log(`🎙 Recording raw audio to: ${filename}`);

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
      let pendingChunks = [];
      let audioBuffer = [];
      let flushTimer = null;
      const FLUSH_THRESHOLD = 8;
      const FLUSH_INTERVAL = 200;

      //
      // === 5. Функция буферной отправки ===
      //
      function flushAudioBuffer() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN || !ready) return;

        const full = Buffer.concat(audioBuffer);
        const base64 = full.toString("base64");

        oa.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64,
        }));

        console.log(`📤 Sent batch: ${audioBuffer.length} chunks (${full.length} bytes)`);
        audioBuffer = [];

        clearTimeout(flushTimer);
        flushTimer = null;
      }

      //
      // === 6. OpenAI события ===
      //
      oa.on("open", () => {
        console.log("🔗 Connected to OpenAI Realtime (session via REST)");
        ready = true;
      });

      oa.on("message", (data) => {
        const msg = data.toString();
        try {
          const parsed = JSON.parse(msg);

          if (parsed.type === "session.created") {
            ready = true;
            console.log("🟢 OpenAI session ready");
          }

          if (parsed.type === "response.output_text.delta") {
            console.log("💬", parsed.delta);
          }

          if (parsed.type === "response.completed") {
            console.log("✅ Response complete");
          }

          if (parsed.type === "error") {
            console.error("❌ OpenAI Error:", parsed.error);
          }

          if (parsed.type.startsWith("response.")) {
            esp.send(msg);
          }
        } catch (err) {
          console.error("⚠️ Parse error:", err.message);
        }
      });

      oa.on("close", () => console.log("🔌 OpenAI closed"));
      oa.on("error", (e) => console.error("❌ OpenAI WS Error:", e.message));

      //
      // === 7. ESP → сервер ===
      //
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          // сохраняем входящее аудио в файл
          fileStream.write(msg);

          if (!ready) {
            pendingChunks.push(msg);
            return;
          }

          audioBuffer.push(msg);
          if (audioBuffer.length >= FLUSH_THRESHOLD) {
            flushAudioBuffer();
          } else {
            clearTimeout(flushTimer);
            flushTimer = setTimeout(flushAudioBuffer, FLUSH_INTERVAL);
          }
          return;
        }

        const text = msg.toString().trim();
        console.log(`📝 Text from ESP: ${text}`);

        if (text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped — committing buffer");
          flushAudioBuffer();

          setTimeout(() => {
            oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            oa.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text"],
                instructions: "Transcribe and respond briefly to the spoken input.",
              },
            }));
            console.log("📨 Sent commit + response.create");
          }, 300);
        }

        if (text.includes("STREAM STARTED")) {
          console.log("🎙 Stream started");
          audioBuffer = [];
          pendingChunks = [];
          clearTimeout(flushTimer);
        }
      });

      esp.on("close", () => {
        console.log("🔌 ESP disconnected");
        fileStream.end();
        console.log(`💾 Saved recording: ${filename}`);
        oa.close();
      });

      esp.on("error", (e) => console.error("❌ ESP error:", e.message));

    } catch (err) {
      console.error("❌ Setup error:", err.message);
      fileStream.end();
      if (esp.readyState === WebSocket.OPEN) esp.close();
    }
  });
}

start().catch(console.error);
