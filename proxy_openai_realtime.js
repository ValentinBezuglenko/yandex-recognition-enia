// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

//
// === 1. Создание Realtime-сессии ===
//
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

//
// === 2. Запуск WS-сервера ===
//
async function start() {
  console.log(`\n🚀 Proxy listening on ws://0.0.0.0:${PORT}`);
  if (process.env.RENDER_SERVICE_NAME) {
    console.log(
      `   WebSocket URL: wss://${process.env.RENDER_SERVICE_NAME}.onrender.com/ws`
    );
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
      const clientSecret =
        session?.client_secret?.value || session?.client_secret;
      if (!clientSecret)
        throw new Error("No client_secret in OpenAI response");

      const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(
        clientSecret
      )}`;

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
      let flushTimer = null;
      const FLUSH_TIMEOUT = 2000; // 2 секунды простоя → flush

      //
      // === 5. Функция отправки аудио на OpenAI ===
      //
      function flushAudioBuffer() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN) return;

        const full = Buffer.concat(audioBuffer);
        const base64 = full.toString("base64");

        oa.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64,
          })
        );

        console.log(`📤 Sent batch: ${audioBuffer.length} chunks (${full.length} bytes)`);

        audioBuffer = [];
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      //
      // === 6. Обработка сообщений от OpenAI ===
      //
      oa.on("open", () => {
        console.log("🔗 Connected to OpenAI Realtime");
      });

      oa.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());

          if (parsed.type === "session.created") {
            console.log("🟢 OpenAI session ready");
            ready = true;
          }

          if (parsed.type === "response.output_text.delta") {
            process.stdout.write(parsed.delta); // без переноса строки
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

          // Сбрасываем таймер и ставим новый на 2 секунды
          clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            console.log("⏳ 2s timeout — flushing buffer");
            flushAudioBuffer();
          }, FLUSH_TIMEOUT);

          return;
        }

        const text = msg.toString().trim();

        if (text.includes("STREAM_STOPPED") || text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped — committing buffer");
          flushAudioBuffer();

          setTimeout(() => {
            oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            oa.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text"],
                instructions: "Return only the raw transcription of the spoken audio.",
              },
            }));
            console.log("📨 Sent commit + response.create");
          }, 300);
        }

        if (text.includes("STREAM_STARTED") || text.includes("STREAM STARTED")) {
          console.log("🎙 Stream started");
          audioBuffer = [];
          clearTimeout(flushTimer);
        }
      });

      esp.on("close", () => {
        console.log("🔌 ESP disconnected");
        oa.close();
      });

      esp.on("error", (e) => console.error("❌ ESP error:", e.message));
    } catch (err) {
      console.error("❌ Setup error:", err.message);
      if (esp.readyState === WebSocket.OPEN) esp.close();
    }
  });
}

start().catch(console.error);
