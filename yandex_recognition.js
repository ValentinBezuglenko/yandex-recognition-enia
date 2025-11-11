import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import { exec } from "child_process";
import fetch from "node-fetch";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

const wss = new WebSocketServer({ port: PORT });
console.log(`🌐 WebSocket server running on port ${PORT}`);

wss.on("connection", ws => {
  const timestamp = Date.now();
  const pcmPath = `stream_${timestamp}.pcm`;
  const oggPath = `stream_${timestamp}.ogg`;
  const fileStream = fs.createWriteStream(pcmPath);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", async (data) => {
    if (typeof data === "string") {
      if (data === "/end") {
        fileStream.end();
        console.log(`⏹ Stream ended: ${pcmPath} (total bytes: ${totalBytes})`);

        // Конвертация PCM → OGG с усилением
        exec(`ffmpeg -f s16le -ar 16000 -ac 1 -i ${pcmPath} -af "volume=3" -c:a libopus ${oggPath}`, async (err) => {
          if (err) {
            console.error("❌ ffmpeg error:", err);
            return;
          }
          console.log("✅ Converted to OGG:", oggPath);

          // Отправка в Yandex STT
          try {
            const oggData = fs.readFileSync(oggPath);
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
            ws.send(text); // отправляем обратно клиенту
          } catch (err) {
            console.error("🔥 STT error:", err);
            ws.send("STT Error: " + err.message);
          }
        });
        return;
      }
    }

    if (data instanceof Buffer) {
      fileStream.write(data);
      totalBytes += data.length;
      console.log(`⬇️ Chunk received: ${data.length} bytes (total: ${totalBytes})`);
    }
  });

  ws.on("close", () => {
    fileStream.end();
    console.log("❌ Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
  });
});
