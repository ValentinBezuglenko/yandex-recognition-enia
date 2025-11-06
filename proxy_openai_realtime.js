import express from "express";
import expressWs from "express-ws";
import fetch from "node-fetch";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();
const app = express();
expressWs(app);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

let currentSession = null;

app.ws("/ws", async (ws, req) => {
  console.log("🔌 ESP connected");

  // step 1 — wait for auth JSON
  ws.once("message", async (msg) => {
    let apiKey = OPENAI_API_KEY;
    try {
      const data = JSON.parse(msg.toString());
      if (data.api_key) apiKey = data.api_key;
    } catch (e) {
      console.log("⚠️ Invalid JSON auth, using server key");
    }

    // step 2 — connect to OpenAI Realtime
    console.log("🌐 Connecting to OpenAI Realtime...");
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let audioBuffers = [];
    let lastBinaryTime = 0;
    let sessionReady = false;
    let stopRequested = false;

    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime");
      ws.send(JSON.stringify({ type: "connection.ack" }));
    });

    openaiWs.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "session.created") {
          console.log("✅ OpenAI session ready");
          sessionReady = true;
          ws.send(JSON.stringify({ type: "session.created" }));
        }
        if (data.type === "response.output_text.delta") {
          ws.send(JSON.stringify({ text: data.delta }));
        }
      } catch {
        console.log("📨 OpenAI:", msg.toString());
      }
    });

    ws.on("message", async (data) => {
      // binary audio from ESP
      if (Buffer.isBuffer(data)) {
        audioBuffers.push(data);
        lastBinaryTime = Date.now();
        console.log(`🎧 Got binary chunk (${data.length} bytes, total ${audioBuffers.length})`);
        return;
      }

      const text = data.toString();

      if (text === "STREAM STARTED") {
        console.log("🎙 Stream start signal");
        audioBuffers = [];
        stopRequested = false;
        ws.send(JSON.stringify({ type: "ack.start" }));
        return;
      }

      if (text === "STREAM STOPPED") {
        stopRequested = true;
        const now = Date.now();

        // wait a moment if too few chunks (OpenAI needs >= ~100 ms audio)
        if (audioBuffers.length < 4 && now - lastBinaryTime < 300) {
          console.log("⌛ Waiting a bit before commit (too few chunks)");
          await new Promise(r => setTimeout(r, 150));
        }

        if (audioBuffers.length === 0) {
          console.warn("⚠️ No audio chunks received → skipping commit");
          ws.send(JSON.stringify({ type: "warn.empty" }));
          return;
        }

        const fullAudio = Buffer.concat(audioBuffers);
        console.log(`📊 Committing ${audioBuffers.length} chunks (${fullAudio.length} bytes)`);

        const base64Audio = fullAudio.toString("base64");
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        }));

        // commit
        setTimeout(() => {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create" }));
          console.log("📨 Sent commit + response.create to OpenAI");
          ws.send(JSON.stringify({ type: "commit.sent", size: fullAudio.length }));
          audioBuffers = [];
        }, 100);
      }
    });

    ws.on("close", () => {
      console.log("❌ ESP disconnected");
      openaiWs.close();
    });
  });
});

app.get("/", (req, res) => {
  res.send("✅ OpenAI Realtime Proxy running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server listening on port", PORT));
