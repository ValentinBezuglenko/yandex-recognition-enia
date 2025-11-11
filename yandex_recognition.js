import { WebSocketServer } from "ws";
import fs from "fs";
import { exec } from "child_process";
import fetch from "node-fetch";

const PORT = process.env.PORT || 10000;
const PATH = "/stream";

// ===== Yandex STT =====
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// ===== WebSocket Server =====
const wss = new WebSocketServer({ port: PORT, path: PATH });
console.log(`🌐 WebSocket server running on ws://localhost:${PORT}${PATH}`);

wss.on("connection", ws => {
  const timestamp = Date.now();
  const pcmFile = `stream_${timestamp}.pcm`;
  const oggFile = `stream_${timestamp}.ogg`;
  const file = fs.createWriteStream(pcmFile);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", async data => {
    if (data.toString() === "/end") {
      file.end();
      console.log(`⏹ Stream ended: ${pcmFile} (total bytes: ${totalBytes})`);

      try {
        // ===== Конвертация PCM → OGG =====
        await new Promise((resolve, reject) => {
          exec(
            `ffmpeg -f s16le -ar 16000 -ac 1 -i ${pcmFile} -af "volume=3" -c:a libopus ${oggFile}`,
            (err, stdout, stderr) => {
              if (err) {
                console.error("❌ ffmpeg error:", stderr);
                reject(err);
              } else {
                console.log("✅ Converted to OGG:", oggFile);
                resolve();
              }
            }
          );
        });

        // ===== Отправка на Yandex STT =====
        const oggData = fs.readFileSync(oggFile);
        const response = await fetch(STT_URL, {
          method: "POST",
          headers: {
            "Authorization": AUTH_HEADER,
            "Content-Type": "audio/ogg; codecs=opus",
          },
          body: oggData,
        });

        const text = await response.text();
        console.log("🗣️ Yandex response:", text);

        // Можно отправить обратно клиенту
        if(ws.readyState === ws.OPEN){
          ws.send(text);
        }

      } catch(err){
        console.error("🔥 STT error:", err);
        if(ws.readyState === ws.OPEN){
          ws.send("❌ Error processing audio");
        }
      }

      return;
    }

    if (data instanceof Buffer) {
      file.write(data);
      totalBytes += data.length;
      console.log(`⬇️ Chunk received: ${data.length} bytes (total: ${totalBytes})`);
    }
  });

  ws.on("close", () => {
    file.end();
    console.log("❌ Client disconnected");
  });

  ws.on("error", err => {
    console.error("❌ WebSocket error:", err);
  });
});
