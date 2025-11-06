// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    {
      model: "gpt-4o-realtime-preview-2024-12-17",
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

      let ready = false;
      let pendingChunks = [];
      let audioBuffer = [];
      let flushTimer = null;
      const FLUSH_THRESHOLD = 8;
      const FLUSH_INTERVAL = 200;

      function flushAudioBuffer() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN || !ready) return;
        const full = Buffer.concat(audioBuffer);
        const base64 = full.toString("base64");
        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        console.log(`📤 Sent batch: ${audioBuffer.length} chunks (${full.length} bytes)`);
        audioBuffer = [];
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      oa.on("open", () => {
        console.log("🔗 Connected to OpenAI Realtime");
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

          // --- Выводим транскрипцию ---
          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            console.log("💬 Partial:", parsed.delta);
          }
          if (parsed.type === "response.output_text.done") {
            console.log("✅ Final transcription:", parsed.output[0].content[0].text);
            esp.send(parsed.output[0].content[0].text);
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

      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
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

        if (text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped — committing buffer");
          flushAudioBuffer();

          setTimeout(() => {
            oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            oa.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text"],
                instructions: "Transcribe the user's speech audio and return only the recognized text.",
              },
            }));
            console.log("📨 Sent commit + transcription request");
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
        oa.close();
      });
    } catch (err) {
      console.error("❌ Setup error:", err.message);
      if (esp.readyState === WebSocket.OPEN) esp.close();
    }
  });
}

start().catch(console.error);
