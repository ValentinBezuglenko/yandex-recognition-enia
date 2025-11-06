// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// 1. Создание Realtime-сессии
async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17" },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

// 2. Запуск WS-сервера
async function start() {
  console.log(`🚀 Proxy listening on ws://0.0.0.0:${PORT}`);

  const wss = new WebSocketServer({ port: PORT, path: "/ws" });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");

    try {
      const session = await createRealtimeSession();
      const clientSecret = session?.client_secret?.value || session?.client_secret;
      if (!clientSecret) throw new Error("No client_secret in OpenAI response");

      const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecret)}`;
      const oa = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${clientSecret}`, "OpenAI-Beta": "realtime=v1" }
      });

      let ready = false;
      let audioBuffer = []; // собираем все PCM сюда

      // Отправка всего буфера одним куском
      function sendFullAudio() {
        if (!audioBuffer.length || oa.readyState !== WebSocket.OPEN) return;

        const full = Buffer.concat(audioBuffer);
        const base64 = full.toString("base64");

        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        oa.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text"],
            instructions: "Return only the raw transcription of the spoken audio."
          }
        }));

        console.log(`📤 Sent full audio: ${full.length} bytes`);
        audioBuffer = [];
      }

      oa.on("open", () => {
        console.log("🔗 Connected to OpenAI Realtime");
        ready = true;
      });

      oa.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === "session.created") {
            console.log("🟢 OpenAI session ready");
            ready = true;
          }

          if (msg.type === "response.output_text.delta") {
            process.stdout.write(msg.delta); // печатаем транскрибацию без переноса
          }

          if (msg.type === "response.completed") {
            console.log("\n✅ Transcription complete\n");
          }

          if (msg.type === "error") {
            console.error("❌ OpenAI Error:", msg.error);
          }
        } catch (err) {
          console.error("⚠️ Parse error:", err.message);
        }
      });

      oa.on("close", () => console.log("🔌 OpenAI closed"));
      oa.on("error", (e) => console.error("❌ OpenAI WS Error:", e.message));

      // Приём PCM от ESP
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          console.log(`🎧 Got ${msg.length} bytes from ESP`);
          audioBuffer.push(msg);
          return;
        }

        const text = msg.toString().trim();
        if (text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped — sending full audio");
          sendFullAudio();
        }

        if (text.includes("STREAM STARTED")) {
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
