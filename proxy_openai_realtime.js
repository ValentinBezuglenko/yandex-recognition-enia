import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";

const app = express();
const server = app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running on port", process.env.PORT || 3000)
);

const RECORDINGS_DIR = path.resolve("recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ ESP connected");

  let fileStream = null;
  let filePath = null;
  let totalBytes = 0;
  let sessionReady = false;

  ws.on("message", async (msg, isBinary) => {
    if (isBinary) {
      if (fileStream) {
        fileStream.write(msg);
        totalBytes += msg.length;
      }
      return;
    }

    const text = msg.toString().trim();

    if (text.includes("STREAM STARTED")) {
      const filename = `session_${new Date().toISOString().replace(/[:.]/g, "-")}.raw`;
      filePath = path.join(RECORDINGS_DIR, filename);
      fileStream = fs.createWriteStream(filePath);
      totalBytes = 0;

      console.log(`🎙 Recording raw audio to: ${filePath}`);
      console.log("     ==> Available at:", process.env.RENDER_EXTERNAL_URL || "local server");
      return;
    }

    if (text.includes("STREAM STOPPED")) {
      console.log(`=== ⏹ STREAM STOPPED ===`);
      if (fileStream) {
        fileStream.end(async () => {
          console.log(`💾 Recording closed (${(totalBytes / 1024).toFixed(1)} KB)`);

          const wavPath = filePath.replace(".raw", ".wav");
          try {
            await rawToWav(filePath, wavPath);
            await uploadToFileIO(wavPath);
          } catch (err) {
            console.error("❌ Conversion/upload failed:", err);
          }
        });
      }
      return;
    }

    if (text.includes("Connected to OpenAI Realtime")) {
      sessionReady = true;
    }
  });

  ws.on("close", () => {
    console.log("🔌 ESP disconnected");
    if (fileStream) fileStream.end();
  });
});

async function rawToWav(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath);
  const header = Buffer.alloc(44);
  const dataSize = raw.length;
  const sampleRate = 24000;
  const byteRate = sampleRate * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outputPath, Buffer.concat([header, raw]));
  console.log("🎧 WAV file created:", outputPath);
}

async function uploadToFileIO(filePath) {
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const res = await axios.post("https://file.io", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (res.data && res.data.link) {
      console.log(`🌐 Uploaded: ${res.data.link}`);
      return res.data.link;
    } else {
      console.error("⚠️ Upload failed:", res.data);
    }
  } catch (e) {
    console.error("❌ Upload error:", e.message);
  }
}
