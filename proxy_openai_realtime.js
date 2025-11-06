// server-working.js
// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// создаём Realtime сессию
async function createRealtimeSession() {
  const res = await axios.post(
    "https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-4o-realtime-preview-2024-12-17", voice: "alloy" },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

async function start() {
  const wss = new WebSocketServer({ port: PORT });
  console.log(`🚀 Proxy listening on ws://0.0.0.0:${PORT}`);

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected:", esp._socket && esp._socket.remoteAddress);

    // создаём сессию
    let session;
    try {
      console.log("🔧 Creating OpenAI session...");
      session = await createRealtimeSession();
      console.log("✅ OpenAI session created:", session.id);
    } catch (e) {
      console.error("❌ createRealtimeSession failed:", e.message || e);
      esp.send(JSON.stringify({ type: "error", error: "session.create failed" }));
      esp.close();
      return;
    }

    const clientSecret = session.client_secret?.value || session.client_secret || "";
    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}&client_secret=${encodeURIComponent(clientSecret)}`;
    const oa = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${clientSecret}`, "OpenAI-Beta": "realtime=v1" } });

    let openAIConnected = false;
    let audioBuffer = [];

    // когда OpenAI WS открылся
    oa.on("open", () => {
      openAIConnected = true;
      console.log("✅ Connected to OpenAI Realtime WS");
      if (esp.readyState === WebSocket.OPEN) {
        esp.send(JSON.stringify({ type: "connection.ack", event: "connected" }));
        console.log("📣 Sent connection.ack to ESP");
      }
    });

    // пересылаем всё от OpenAI обратно на ESP
    oa.on("message", (data) => {
      const msg = data.toString();
      if (esp.readyState === WebSocket.OPEN) esp.send(msg);

      try {
        const p = JSON.parse(msg);
        if (p.type === "error") console.error("OpenAI ERROR:", p.error);
      } catch {}
    });

    oa.on("error", (err) => console.error("❌ OpenAI WS error:", err && err.message));
    oa.on("close", (code, reason) => { openAIConnected = false; console.log("🔌 OpenAI WS closed", code, reason && reason.toString()); });

    // обработка сообщений от ESP
    esp.on("message", (msg, isBinary) => {
      if (!openAIConnected) {
        if (isBinary) console.log("⚠️ OpenAI not ready yet — binary chunk skipped");
        else console.log("⚠️ OpenAI not ready yet — text skipped:", msg.toString().trim());
        return;
      }

      if (isBinary) {
        audioBuffer.push(msg);
        try {
          oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.toString("base64") }));
        } catch (e) {
          console.error("❌ Failed to forward binary to OpenAI:", e.message || e);
        }

        // накопление ~100ms аудио: BUFFER_SIZE = 1024 байт, 16-bit, 16kHz → 32ms / чанк
        let totalBytes = audioBuffer.reduce((a, b) => a + b.length, 0);
        if (totalBytes >= 3200) {
          oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          audioBuffer = [];
          console.log("📌 Committed ~100ms audio to OpenAI");
        }
      } else {
        const text = msg.toString().trim();
        console.log("📝 Text from ESP:", text);
        if (/STOP|STREAM STOPPED/i.test(text)) {
          if (audioBuffer.length > 0) {
            oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            audioBuffer = [];
            console.log("🛑 Committed remaining audio on STOP");
          }
          oa.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"] } }));
        }
      }
    });

    esp.on("close", () => {
      console.log("🔌 ESP disconnected");
      if (oa && oa.readyState === WebSocket.OPEN) oa.close();
    });
  });

  wss.on("error", (e) => console.error("WS Server error:", e.message || e));
}

start().catch(console.error);
