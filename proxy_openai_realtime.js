// === server.js ===
// Рабочая версия: сохраняет RAW и транскрибирует через OpenAI
// Запуск: node server.js
// Требует: npm install ws axios

import fs from "fs";
import path from "path";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// === Подготовка папки для записей ===
const recordingsDir = path.resolve("recordings");
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

// === Создаём OpenAI Realtime сессию ===
async function createRealtimeSession() {
  const r = await axios.post(
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
  return r.data;
}

// === Запуск WebSocket-прокси ===
async function start() {
  console.log(`\n🚀 Proxy listening on ws://0.0.0.0:${PORT}`);
  const wss = new WebSocketServer({ port: PORT, path: "/ws" });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");
    console.log("ESP IP:", esp._socket.remoteAddress);

    // Переменные для записи
    let rawFilePath = "";
    let rawStream = null;
    let totalBytes = 0;
    let session = null;

    try {
      // Создаём realtime-сессию OpenAI
      session = await createRealtimeSession();
      const clientSecret =
        session?.client_secret?.value || session?.client_secret;

      const oa = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(
          clientSecret
        )}`,
        {
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "OpenAI-Beta": "realtime=v1",
          },
        }
      );

      oa.on("open", () => console.log("🔗 Connected to OpenAI Realtime"));
      oa.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.created")
            console.log("🟢 OpenAI session ready");
          else if (msg.type === "error")
            console.error("❌ OpenAI Error:", msg.error);
        } catch (err) {
          console.error("⚠️ JSON parse error:", err.message);
        }
      });

      // === Приём данных от ESP ===
      esp.on("message", async (msg) => {
        if (Buffer.isBuffer(msg)) {
          if (rawStream) {
            rawStream.write(msg);
            totalBytes += msg.length;
          }
          return;
        }

        const text = msg.toString().trim();

        if (text.includes("STREAM STARTED")) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          rawFilePath = path.join(
            recordingsDir,
            `session_${timestamp}.raw`
          );
          rawStream = fs.createWriteStream(rawFilePath);
          totalBytes = 0;
          console.log(`🎙 Recording raw audio to: ${rawFilePath}`);
        }

        if (text.includes("STREAM STOPPED")) {
          if (rawStream) {
            rawStream.end(() => {
              console.log(
                `💾 Recording closed (${(totalBytes / 1024).toFixed(1)} KB)`
              );
            });
            rawStream = null;

            // После остановки можно (необязательно) сделать запрос на транскрипцию
            if (fs.existsSync(rawFilePath)) {
              console.log("🧠 Sending for transcription...");
              try {
                const audioData = fs.readFileSync(rawFilePath);
                const base64 = audioData.toString("base64");

                oa.send(
                  JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: base64,
                  })
                );
                oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                oa.send(
                  JSON.stringify({
                    type: "response.create",
                    response: {
                      modalities: ["text"],
                      instructions:
                        "Transcribe and briefly summarize the recorded audio.",
                    },
                  })
                );

                console.log("📨 Sent for OpenAI transcription");
              } catch (err) {
                console.error("❌ Transcription send error:", err.message);
              }
            }
          }
        }
      });

      esp.on("close", () => {
        console.log("🔌 ESP disconnected");
        if (rawStream) rawStream.end();
        oa.close();
      });
    } catch (err) {
      console.error("❌ Setup error:", err.message);
      if (esp.readyState === WebSocket.OPEN) esp.close();
    }
  });
}

start().catch(console.error);
