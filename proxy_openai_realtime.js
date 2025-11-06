// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SAMPLE_RATE = 24000; // Гц
const BYTES_PER_SAMPLE = 2; // PCM16
const MIN_SEC = 2;          // Минимум 2 секунды для отправки
const MIN_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_SEC;
const CHUNK_SIZE = 32 * 1024; // 32 KB

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

async function createRealtimeSession() {
  const response = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17" },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

let audioBuffer = [];

const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`🚀 Proxy server listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", async (esp, req) => {
  console.log("✅ ESP connected", req.socket.remoteAddress);

  try {
    const session = await createRealtimeSession();
    const clientSecret = session?.client_secret?.value || session?.client_secret;
    if (!clientSecret) throw new Error("No client_secret from OpenAI");

    const oa = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecret)}`,
      { headers: { Authorization: `Bearer ${clientSecret}`, "OpenAI-Beta": "realtime=v1" } }
    );

    let ready = false;
    let flushTimer = null;

    function flushAudioBuffer(force = false) {
      if (!ready || audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN) return;

      const full = Buffer.concat(audioBuffer);
      if (!force && full.length < MIN_BYTES) {
        console.log(`⏳ Buffer too small (${full.length} bytes), waiting for 2s`);
        return;
      }

      // Разбиваем на чанки по 32 KB
      let offset = 0;
      while (offset < full.length) {
        const end = Math.min(offset + CHUNK_SIZE, full.length);
        const chunk = full.slice(offset, end);
        const base64 = chunk.toString("base64");
        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        offset = end;
      }

      oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log(`📤 Sent ${full.length} bytes to OpenAI in ${Math.ceil(full.length / CHUNK_SIZE)} chunks`);

      audioBuffer = [];
      clearTimeout(flushTimer);
      flushTimer = null;

      // Создаём транскрипт
      oa.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["text"], instructions: "Return only transcription" }
      }));
    }

    oa.on("open", () => console.log("🔗 Connected to OpenAI Realtime"));
    oa.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "session.created") {
        ready = true;
        console.log("🟢 OpenAI session ready");
      }
      if (msg.type === "response.output_text.delta") process.stdout.write(msg.delta);
      if (msg.type === "response.completed") console.log("\n✅ Transcription complete\n");
      if (msg.type === "error") console.error("❌ OpenAI Error:", msg.error);
    });
    oa.on("close", () => console.log("🔌 OpenAI closed"));
    oa.on("error", (e) => console.error("❌ OpenAI WS Error:", e.message));

    esp.on("message", (msg) => {
      const text = msg.toString("utf8");

      if (text.includes("STREAM_STARTED")) {
        audioBuffer = [];
        flushTimer = null;
        console.log("🎙 Stream started");
        return;
      }

      if (text.includes("STREAM_STOPPED") || text.includes("STREAM STOPPED")) {
        flushAudioBuffer(true);
        return;
      }

      // Если это аудио — добавляем в буфер
      if (Buffer.isBuffer(msg)) {
        audioBuffer.push(msg);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flushAudioBuffer(), 2000); // принудительный flush через 2с
        console.log(`🎧 Got ${msg.length} bytes from ESP`);
      }
    });

    esp.on("close", () => {
      console.log("🔌 ESP disconnected — flushing buffer");
      flushAudioBuffer(true);
      oa.close();
    });

    esp.on("error", (e) => console.error("❌ ESP error:", e.message));

  } catch (err) {
    console.error("❌ Setup error:", err.message);
    if (esp.readyState === WebSocket.OPEN) esp.close();
  }
});
