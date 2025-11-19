import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { io } from "socket.io-client";
import fetch from "node-fetch";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => res.send("✅ Server is alive"));

const server = createServer(app);
const wss = new WebSocketServer({ server });
console.log(`✅ WebSocket proxy запущен на порту ${PORT}`);

const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

const emotionKeywords = {
  greeting: ["привет", "хай", "здарова", "ёня", "юня"],
  happy: ["супер", "молодец"],
  sad: ["грустно", "печаль"],
  angry: ["злюсь", "сердит", "дурак"],
  laugh: ["ха-ха", "смешно", "смейся"],
  sleep: ["спать", "сон", "спи", "ложись спать"],
  victory: ["победа", "выиграл"],
  idle: []
};

function detectEmotions(text) {
  const recognized = text.toLowerCase();
  const detectedEmotions = [];
  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    for (const kw of keywords) {
      if (recognized.includes(kw)) {
        detectedEmotions.push(emotion);
        break;
      }
    }
  }
  return detectedEmotions;
}

// --- Игры и ключевые фразы ---
const gameKeywords = {
  actions: ["запусти игру действия", "действия открой", "запусти действия", "открой действия"],
  compare: ["запусти игру сравнение", "сравнение открой", "открой сравнение"],
  differences: ["запусти игру отличия", "отличия открой", "открой отличия"],
  distribution: ["запусти игру распределение", "распределение открой", "открой распределение"],
  order: ["запусти игру очередность", "очередность открой", "открой очередность"],
  history: ["запусти игру история", "история открой", "открой история"]
};

function detectGameCommand(text) {
  const recognized = text.toLowerCase();
  for (const [game, phrases] of Object.entries(gameKeywords)) {
    for (const phrase of phrases) {
      if (recognized.includes(phrase)) return game;
    }
  }
  return null;
}

wss.on("connection", ws => {
  let pcmChunks = [];

  ws.on("message", async data => {
    if (data.toString() === "/end") {
      if (!pcmChunks.length) return;

      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      try {
        const oggBuffer = await new Promise((resolve, reject) => {
          const ffmpeg = spawn("ffmpeg", [
            "-f", "s16le",
            "-ar", "16000",
            "-ac", "1",
            "-i", "pipe:0",
            "-af", "volume=3",
            "-c:a", "libopus",
            "-f", "ogg",
            "pipe:1"
          ]);

          const chunks = [];
          ffmpeg.stdout.on("data", chunk => chunks.push(chunk));
          ffmpeg.stderr.on("data", () => {});
          ffmpeg.on("close", code => code === 0
            ? resolve(Buffer.concat(chunks))
            : reject(new Error("ffmpeg failed"))
          );

          ffmpeg.stdin.write(pcmBuffer);
          ffmpeg.stdin.end();
        });

        console.log(`✅ PCM конвертирован в OGG (в памяти)`);

        const response = await fetch(STT_URL, {
          method: "POST",
          headers: {
            "Authorization": AUTH_HEADER,
            "Content-Type": "audio/ogg; codecs=opus",
          },
          body: oggBuffer
        });
        const text = await response.text();
        console.log("🗣️ Yandex STT response:", text);

        let detectedEmotions = [];
        try {
          const parsed = JSON.parse(text);
          detectedEmotions = detectEmotions(parsed.result || "");
        } catch {
          detectedEmotions = detectEmotions(text);
        }

        ws.send(JSON.stringify({ type: "stt_result", text }));

        // --- Отправка эмоций всем клиентам ---
        detectedEmotions.forEach(emotion => {
          console.log(`🟢 Обнаружена эмоция '${emotion}'`);
          wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(JSON.stringify({ emotion }));
          });
        });

        // --- Проверка на команду игры ---
        const game = detectGameCommand(text);
        if (game) {
          ws.send(JSON.stringify({ type: "run_game_action", game }));
        }

      } catch (err) {
        console.error("❌ Ошибка конвертации или распознавания:", err);
      }

      return;
    }

    if (data instanceof Buffer) {
      pcmChunks.push(data);
    }
  });

  ws.on("close", () => {
    pcmChunks = [];
    console.log("🔌 Client disconnected");
  });
});

const socket = io("ws://backend.enia-kids.ru:8025", { transports: ["websocket"] });
socket.on("connect", () => console.log("🟢 Подключено к backend.enia-kids.ru"));
socket.on("disconnect", () => console.log("🔴 Отключено от backend.enia-kids.ru"));

socket.on("/child/game-level/action", msg => {
  let emotion = null;
  switch (msg.type) {
    case "fail": emotion = "sad"; break;
    case "success": emotion = "happy"; break;
    case "completed": emotion = "victory"; break;
  }
  if (emotion) {
    console.log(`📩 Эмоция от backend: ${emotion}`);
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(JSON.stringify({ emotion }));
    });
  }
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log("💓 Self ping OK"))
    .catch(err => console.log("⚠️ Self ping error:", err.message));
}, 4 * 60 * 1000);

server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
