// === server.js ===
// npm install ws axios

import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 10000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// --- создаёт realtime-сессию ---
async function createRealtimeSession() {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/realtime/sessions",
      {
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error("❌ Error creating session:", err.response?.data || err.message);
    throw err;
  }
}

// --- запуск сервера ---
async function start() {
  console.log(`🚀 WebSocket proxy running on ws://0.0.0.0:${PORT}`);
  const wss = new WebSocketServer({ port: PORT });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");

    esp.send(JSON.stringify({ type: "connection.ack" }));

    // --- создаём realtime session ---
    console.log("🔧 Creating OpenAI Realtime session...");
    const session = await createRealtimeSession();
    const token = session.client_secret?.value || session.client_secret;
    const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(token)}`;

    // --- подключаемся к OpenAI ---
    const oa = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let audioChunksSent = 0;
    let openAIConnected = false;

    oa.on("open", () => {
      openAIConnected = true;
      console.log("✅ Connected to OpenAI Realtime");
    });

    oa.on("message", (data) => {
      const msg = data.toString();
      // логируем только начало
      console.log("<<<", msg.slice(0, 200));

      // отправляем весь ответ обратно ESP
      if (esp.readyState === WebSocket.OPEN) esp.send(msg);

      // выводим финальный результат в консоль
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "response.text.done") {
          console.log(`\n🎯 TRANSCRIPTION: "${parsed.text}"\n`);
        }
      } catch {}
    });

    oa.on("error", (e) => console.error("❌ OpenAI WS error:", e.message));
    oa.on("close", () => console.log("🔌 OpenAI WebSocket closed"));

    // === Приём данных от ESP ===
    esp.on("message", (msg) => {
      if (Buffer.isBuffer(msg)) {
        if (oa.readyState === WebSocket.OPEN && openAIConnected) {
          oa.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.toString("base64"),
            })
          );
          audioChunksSent++;
          if (audioChunksSent % 10 === 0)
            console.log(`📊 Sent ${audioChunksSent} audio chunks`);
        } else {
          console.log("⚠️ OpenAI not ready, chunk skipped");
        }
      } else {
        const text = msg.toString();
        console.log("📝 Text from ESP:", text);

        // --- кнопка отпущена ---
        if (text.includes("STREAM STOPPED") || text.includes("STOP")) {
          console.log("\n🛑 STOP signal received");
          if (oa.readyState === WebSocket.OPEN && openAIConnected) {
            if (audioChunksSent > 0) {
              console.log(`📤 Committing ${audioChunksSent} chunks`);
              oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              setTimeout(() => {
                if (oa.readyState === WebSocket.OPEN) {
                  console.log("📤 Creating response...");
                  oa.send(
                    JSON.stringify({
                      type: "response.create",
                      response: { modalities: ["text"] },
                    })
                  );
                }
              }, 300);
            } else {
              console.log("⚠️ No audio sent yet");
            }
          }
        }
      }
    });

    esp.on("close", () => {
      console.log("🔌 ESP disconnected");
      if (oa.readyState === WebSocket.OPEN) oa.close();
    });
  });
}

start().catch(console.error);
