// npm install ws axios form-data
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RECORDINGS_DIR = "./recordings";

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

// === 1. Создание Realtime-сессии ===
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

// === 2. Функция конвертации RAW → WAV ===
function rawToWav(rawPath, wavPath, sampleRate = 24000) {
  const rawData = fs.readFileSync(rawPath);
  const header = Buffer.alloc(44);
  const dataSize = rawData.length;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(wavPath, Buffer.concat([header, rawData]));
}

// === 3. Загрузка файла на file.io ===
async function uploadToFileIO(filePath) {
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    const resp = await axios.post("https://file.io", form, {
      headers: form.getHeaders(),
    });
    return resp.data.link || null;
  } catch (e) {
    console.error("❌ Upload error:", e.message);
    return null;
  }
}

// === 4. Запуск локального WS-прокси ===
async function start() {
  console.log(`🚀 Proxy listening on ws://0.0.0.0:${PORT}`);
  if (process.env.RENDER_SERVICE_NAME) {
    console.log(
      `   WebSocket URL: wss://${process.env.RENDER_SERVICE_NAME}.onrender.com/ws`
    );
  }

  const wss = new WebSocketServer({ port: PORT, path: "/ws" });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");
    console.log("ESP IP:", esp._socket.remoteAddress);

    const sessionName = `session_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const rawPath = path.join(RECORDINGS_DIR, `${sessionName}.raw`);
    const fileStream = fs.createWriteStream(rawPath);
    console.log(`🎙 Recording raw audio to: ${rawPath}`);

    try {
      const session = await createRealtimeSession();
      const clientSecret = session?.client_secret?.value || session?.client_secret;
      const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecret)}`;

      const oa = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      let ready = false;
      let audioBuffer = [];
      let flushTimer = null;
      const FLUSH_THRESHOLD = 8;
      const FLUSH_INTERVAL = 200;

      function flushAudioBuffer() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN || !ready)
          return;
        const full = Buffer.concat(audioBuffer);
        const base64 = full.toString("base64");
        oa.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
        console.log(`📤 Sent batch: ${audioBuffer.length} chunks (${full.length} bytes)`);
        fileStream.write(full);
        audioBuffer = [];
        clearTimeout(flushTimer);
        flushTimer = null;
      }

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
          if (parsed.type === "error") {
            console.error("❌ OpenAI Error:", parsed.error);
          }
        } catch (err) {
          console.error("⚠️ Parse error:", err.message);
        }
      });

      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          audioBuffer.push(msg);
          if (audioBuffer.length >= FLUSH_THRESHOLD) flushAudioBuffer();
          else {
            clearTimeout(flushTimer);
            flushTimer = setTimeout(flushAudioBuffer, FLUSH_INTERVAL);
          }
          return;
        }

        const text = msg.toString().trim();
        console.log("📝", text);

        if (text.includes("STREAM STOPPED")) {
          console.log("🛑 Stream stopped");
          flushAudioBuffer();
          fileStream.end(async () => {
            const wavPath = rawPath.replace(".raw", ".wav");
            rawToWav(rawPath, wavPath);
            console.log("🎧 Converted to WAV:", wavPath);

            const link = await uploadToFileIO(wavPath);
            if (link) console.log(`🌐 Uploaded: ${link}`);
            else console.log("⚠️ Upload failed");
          });

          setTimeout(() => {
            oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            oa.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["text"],
                  instructions:
                    "Transcribe and respond briefly to the spoken input.",
                },
              })
            );
            console.log("📨 Sent commit + response.create");
          }, 300);
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
