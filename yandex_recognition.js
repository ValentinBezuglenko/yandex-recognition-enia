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

// --- HTTP endpoint для Render ---
app.get("/", (req, res) => res.send("✅ Server is alive"));

// --- Создаём сервер HTTP и WS ---
const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- Настройки Yandex STT ---
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// --- Ключевые слова для эмоций ---
const emotionKeywords = {
  greeting: ["привет", "хай", "здарова", "ёня", "юня"],
  happy: ["супер", "молодец", "улыбнись"],
  sad: ["грустно", "печаль"],
  angry: ["злюсь", "сердит", "дурак"],
  laugh: ["ха-ха", "смешно", "смейся"],
  sleep: ["спать", "сон", "спи", "ложись спать"],
  victory: ["победа", "выиграл"],
  idle: [],
  yes: ["ты хороший", "любишь цифровой пирог"],
  no: ["ты злой робот", "тебя обижают"],
  love: ["я тебя люблю", "люблю тебя"]
};

// --- Определяем эмоции по ключевым словам ---
function detectEmotions(text) {
  const recognized = String(text).toLowerCase().trim();
  const detectedEmotions = [];

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    for (const kw of keywords) {
      const pattern = kw.toLowerCase().trim();
      // Регулярка для точного совпадения фразы, игнорируя пробелы и спецсимволы
      const regex = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (regex.test(recognized)) {
        detectedEmotions.push(emotion);
        break;
      }
    }
  }

  return detectedEmotions;
}

// --- GAME COMMANDS ---
const gamePhrases = {
  "category": ["запусти игру распределение","запусти распределение","открой игру распределение","открой распределение","игра распределение"],
  "order": ["запусти игру последовательности","запусти последовательности","открой игру последовательности","открой последовательности","игра последовательности"],
  "diff": ["открой игру отличия","открой отличия","запусти игру отличия","запусти отличия","игра отличия","игра 'отличия'"],
  "match": ["запусти игру сравнение","открой игру сравнение","игра сравнение","сравнение"],
  "verb": ["запусти игру действия","открой игру действия","игра действия","действия"],
  "story": ["запусти игру история","открой игру история","игра история","история"]
};

function detectGameCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  for (const [gameId, phrases] of Object.entries(gamePhrases)) {
    for (const p of phrases) {
      if (t.includes(p)) {
        return gameId;
      }
    }
  }
  return null;
}

// --- Подключение к backend.enia-kids.ru ---
const socket = io("ws://backend.enia-kids.ru:8025", { transports: ["websocket"] });
socket.on("connect", () => console.log("🟢 Подключено к backend.enia-kids.ru"));
socket.on("disconnect", () => console.log("🔴 Отключено от backend.enia-kids.ru"));

// --- WebSocket приём аудио ---
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
        let recognizedText = "";

        try {
          const parsed = JSON.parse(text);
          recognizedText = parsed.result || "";
          detectedEmotions = detectEmotions(recognizedText);
        } catch {
          recognizedText = text;
          detectedEmotions = detectEmotions(recognizedText);
        }

        const gameId = detectGameCommand(recognizedText);
        if (gameId) {
          console.log(`🎮 Обнаружена команда запуска игры: ${gameId}`);
          try {
            socket.emit("/bot/action/21", { type: "game-select", game: gameId });
            console.log(`📤 Отправлено событие на /bot/action/21: { type: "game-select", game: ${gameId} }`);
          } catch (e) {
            console.warn("⚠️ Не удалось отправить событие на /bot/action/21:", e.message || e);
          }
        }

        detectedEmotions.forEach(emotion => {
          console.log(`🟢 Обнаружена эмоция '${emotion}'`);
          wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(JSON.stringify({ emotion }));
          });
        });

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

// --- Ретрансляция эмоций от backend ---
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

// --- Запуск сервера ---
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
