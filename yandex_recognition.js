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
console.log(`✅ WebSocket proxy запущен на порту ${PORT}`);

// --- Настройки Yandex STT ---
const API_KEY = process.env.YANDEX_API_KEY;
if (!API_KEY) throw new Error("❌ YANDEX_API_KEY not set");

const AUTH_HEADER = API_KEY.startsWith("Api-Key") ? API_KEY : `Api-Key ${API_KEY}`;
const STT_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

// --- Ключевые слова для эмоций ---
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

// --- Определяем эмоции по ключевым словам ---
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

// --- GAME COMMANDS ---
// добавлены фразы для запуска игр: распределение, последовательности, Отличия
const gamePhrases = {
  "распределение": [
    "запусти игру распределение",
    "запусти распределение",
    "открой игру распределение",
    "открой распределение",
    "игра распределение"
  ],
  "последовательности": [
    "запусти игру последовательности",
    "запусти последовательности",
    "открой игру последовательности",
    "открой последовательности",
    "игра последовательности"
  ],
  "отличия": [
    "открой игру отличия",
    "открой отличия",
    "запусти игру отличия",
    "запусти отличия",
    "игра отличия",
    "игра 'отличия'"
  ]
};

function detectGameCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  for (const [game, phrases] of Object.entries(gamePhrases)) {
    for (const p of phrases) {
      if (t.includes(p)) {
        return game; // возвращаем нормализованное имя игры: "распределение" / "последовательности" / "отличия"
      }
    }
  }
  return null;
}

// --- WebSocket приём аудио ---
wss.on("connection", ws => {
  let pcmChunks = [];

  ws.on("message", async data => {
    if (data.toString() === "/end") {
      if (!pcmChunks.length) return;

      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      try {
        // --- Конвертация PCM → OGG через ffmpeg (в памяти) ---
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
          ffmpeg.stderr.on("data", () => {}); // можно логировать ошибки
          ffmpeg.on("close", code => code === 0
            ? resolve(Buffer.concat(chunks))
            : reject(new Error("ffmpeg failed"))
          );

          ffmpeg.stdin.write(pcmBuffer);
          ffmpeg.stdin.end();
        });

        console.log(`✅ PCM конвертирован в OGG (в памяти)`);

        // --- Распознаём через Yandex STT ---
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

        // --- Определяем эмоции ---
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

        // --- Отправка результата стримеру ---
        ws.send(JSON.stringify({ type: "stt_result", text: recognizedText }));

        // --- Обработка игровых команд (новое) ---
        try {
          const game = detectGameCommand(recognizedText);
          if (game) {
            console.log(`🎮 Обнаружена команда запуска игры: ${game}`);

            // Отправляем всем локальным WebSocket-клиентам (wss)
            wss.clients.forEach(client => {
              if (client.readyState === 1) {
                client.send(JSON.stringify({ type: "game_command", action: "launch", game }));
              }
            });

            // Подтверждение источнику (тот ws, который прислал звук)
            try {
              ws.send(JSON.stringify({ type: "stt_command", action: "launch", game }));
            } catch (e) {
              // ignore
            }

            // Отправляем на backend через socket.io — событие согласованное с существующим стилем
            try {
              socket.emit("/child/game/launch", { game });
              console.log("📤 Отправлено событие на backend: /child/game/launch", { game });
            } catch (e) {
              console.warn("⚠️ Не удалось отправить событие на backend:", e && e.message ? e.message : e);
            }
          }
        } catch (e) {
          console.error("❌ Ошибка при обработке игровой команды:", e);
        }

        // --- Отправка эмоций всем клиентам ---
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

    // --- Приём PCM в память ---
    if (data instanceof Buffer) {
      pcmChunks.push(data);
    }
  });

  ws.on("close", () => {
    pcmChunks = [];
    console.log("🔌 Client disconnected");
  });
});

// --- Подключение к backend.enia-kids.ru ---
const socket = io("ws://backend.enia-kids.ru:8025", { transports: ["websocket"] });
socket.on("connect", () => console.log("🟢 Подключено к backend.enia-kids.ru"));
socket.on("disconnect", () => console.log("🔴 Отключено от backend.enia-kids.ru"));

// --- Ретрансляция только эмоций от backend ---
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

// --- Автопинг Render ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log("💓 Self ping OK"))
    .catch(err => console.log("⚠️ Self ping error:", err.message));
}, 4 * 60 * 1000);

// --- Запуск сервера ---
server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
