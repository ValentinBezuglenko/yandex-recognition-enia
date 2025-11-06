// npm install ws fs
import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";

const PORT = 10000;
const SAMPLE_RATE = 24000; // Гц
const BYTES_PER_SAMPLE = 2; // PCM16
const CHANNELS = 1; // моно

let audioBuffer = [];

const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`🚀 Local server listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", (ws, req) => {
  console.log("✅ ESP connected", req.socket.remoteAddress);

  ws.on("message", (msg) => {
    // Все сообщения сначала конвертируем в строку для проверки
    const text = msg.toString('utf8');
    
    // Проверяем текстовые команды
    if (text.includes("STREAM_STARTED")) {
      audioBuffer = [];
      console.log("🎙 Stream started");
      return;
    }
    
    if (text.includes("STREAM STOPPED") || text.includes("STREAM_STOPPED")) {
      console.log("🛑 Stream stopped — saving buffer");
      saveAudioBuffer();
      return;
    }
    
    // Если сообщение маленькое (< 100 байт) и содержит только печатные символы - это текст
    if (msg.length < 100 && /^[\x20-\x7E\s]*$/.test(text)) {
      console.log(`📝 Text message: ${text.substring(0, 50)}`);
      return;
    }
    
    // Иначе это аудио данные
    const buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    audioBuffer.push(buffer);
    console.log(`🎧 Got ${buffer.length} bytes from ESP`);
  });

  ws.on("close", () => {
    console.log("🔌 ESP disconnected, saving remaining buffer");
    saveAudioBuffer();
  });
});

function saveAudioBuffer() {
  if (audioBuffer.length === 0) {
    console.log("⚠️ Buffer empty, nothing to save");
    return;
  }

  const full = Buffer.concat(audioBuffer);

  // --- Сохраняем raw ---
  fs.writeFileSync("audio.raw", full);

  // --- Конвертируем в WAV ---
  const wav = encodeWAV(full, SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE);
  fs.writeFileSync("audio.wav", wav);

  const duration = full.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`💾 Saved audio.raw (${full.length} bytes)`);
  console.log(`💾 Saved audio.wav (~${duration.toFixed(2)} s)`);

  audioBuffer = [];
}

// --- WAV энкодер ---
function encodeWAV(samples, sampleRate, channels, bytesPerSample) {
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4); // file size - 8
  buffer.write("WAVE", 8);

  // fmt subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);

  // data subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  samples.copy(buffer, 44);

  return buffer;
}
