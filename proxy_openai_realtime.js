import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

async function createRealtimeSession() {
  const res = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17" },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const MIN_SEC = 2;
const MIN_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_SEC;
const CHUNK_SIZE = 32 * 1024; // 32 KB

let audioBuffer = [];

const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`🚀 Proxy server listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", async (esp) => {
  console.log("✅ ESP connected", esp._socket.remoteAddress);

  let ready = false;
  let oa = null;
  let flushTimer = null;

  try {
    const session = await createRealtimeSession();
    const clientSecret = session?.client_secret?.value || session?.client_secret;
    if (!clientSecret) throw new Error("No client_secret");

    oa = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecret)}`, {
      headers: { Authorization: `Bearer ${clientSecret}`, "OpenAI-Beta": "realtime=v1" }
    });

    oa.on("open", () => console.log("🔗 Connected to OpenAI Realtime"));
    oa.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "session.created") ready = true;
        if (parsed.type === "response.output_text.delta") process.stdout.write(parsed.delta);
        if (parsed.type === "response.completed") console.log("\n✅ Transcription complete\n");
        if (parsed.type === "error") console.error("❌ OpenAI Error:", parsed.error);
      } catch (err) { console.error("⚠️ Parse error:", err.message); }
    });
    oa.on("close", () => console.log("🔌 OpenAI closed"));
    oa.on("error", (e) => console.error("❌ OpenAI WS Error:", e.message));
  } catch (err) {
    console.error("❌ Failed to create Realtime session:", err.message);
    esp.close();
    return;
  }

  function flushAudio(force = false) {
    if (!ready || audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN) return;

    let full = Buffer.concat(audioBuffer);
    if (!force && full.length < MIN_BYTES) return;

    // Разбиваем на чанки по CHUNK_SIZE
    let offset = 0;
    while (offset < full.length) {
      const end = Math.min(offset + CHUNK_SIZE, full.length);
      const chunk = full.slice(offset, end);
      oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
      offset = end;
      console.log(`📤 Sent chunk: ${chunk.length} bytes`);
    }

    audioBuffer = [];
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  esp.on("message", (msg) => {
    if (!ready) return;

    if (Buffer.isBuffer(msg)) {
      audioBuffer.push(msg);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flushAudio(), 2000); // 2s inactivity flush
      return;
    }

    const text = msg.toString().trim();
    if (text.includes("STREAM_STOPPED")) {
      flushAudio(true);
      if (oa.readyState === WebSocket.OPEN) {
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oa.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"], instructions: "Return only transcription" } }));
        console.log("📨 Commit + response.create sent");
      }
    }

    if (text.includes("STREAM_STARTED")) {
      audioBuffer = [];
      flushTimer = null;
      console.log("🎙 Stream started");
    }
  });

  esp.on("close", () => {
    console.log("🔌 ESP disconnected, flushing remaining audio");
    flushAudio(true);
    if (oa.readyState === WebSocket.OPEN) {
      oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      oa.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"], instructions: "Return only transcription" } }));
      console.log("📨 Commit + response.create sent after ESP disconnect");
    }
    oa.close();
  });

  esp.on("error", (e) => console.error("❌ ESP error:", e.message));
});
