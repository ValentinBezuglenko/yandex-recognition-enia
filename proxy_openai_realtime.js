// npm install ws axios
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// Создаёт новую Realtime-сессию
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
    console.log("OpenAI API Response:", JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error("❌ Error creating Realtime session:");
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, JSON.stringify(error.response.data, null, 2));
      if (error.response.status === 403) {
        console.error("\n⚠️  Ошибка 403: Доступ запрещен. Возможные причины:");
        console.error("   - Неверный API ключ");
        console.error("   - Недостаточно прав у API ключа");
      }
    } else {
      console.error(error.message);
    }
    throw error;
  }
}

async function start() {
  console.log(`\n🚀 ESP WebSocket proxy listening on ws://0.0.0.0:${PORT}`);
  if (process.env.RENDER_SERVICE_NAME) {
    console.log(`   Deployed on Render - WebSocket URL: wss://${process.env.RENDER_SERVICE_NAME}.onrender.com`);
    console.log(`   (Render автоматически проксирует WebSocket через порт 443)`);
  }
  const wss = new WebSocketServer({ port: PORT });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");
    console.log("ESP IP:", esp._socket.remoteAddress);

    try {
      // создаём сессию Realtime и открываем WS к OpenAI
      console.log("Creating OpenAI Realtime session...");
      const session = await createRealtimeSession();
      console.log("✅ Realtime session created");
      console.log("Session data:", JSON.stringify(session, null, 2));

      // Проверяем структуру ответа OpenAI
      let clientSecretToken;
      if (session.client_secret && session.client_secret.value) {
        clientSecretToken = session.client_secret.value;
      } else if (session.client_secret) {
        clientSecretToken = session.client_secret;
      } else {
        throw new Error("No client_secret found in session response. Session: " + JSON.stringify(session));
      }

      // Формируем WebSocket URL с client_secret токеном
      // Формат: wss://api.openai.com/v1/realtime?model=...&client_secret=...
      const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&client_secret=${encodeURIComponent(clientSecretToken)}`;
      
      console.log("WebSocket URL:", wsUrl.substring(0, 100) + "..."); // Не логируем полный URL с токеном

      // OpenAI требует Authorization header с client_secret токеном для WebSocket
      const oa = new WebSocket(wsUrl, {
        headers: { 
          Authorization: `Bearer ${clientSecretToken}`,
          "OpenAI-Beta": "realtime=v1"
        },
      });

      // Переменные для управления состоянием и буферизации чанков
      let ready = false; // Флаг готовности сессии (после session.created)
      let pendingChunks = []; // Буфер для чанков, пришедших до готовности
      let audioBuffer = []; // Буфер для накопления чанков перед отправкой
      let autoCommitTimer = null; // Таймер для автоматического commit

      oa.on("open", () => {
        console.log("✅ Connected to OpenAI Realtime");
        // Ждем session.created перед установкой ready = true
      });

      oa.on("message", (data) => {
        const msg = data.toString();
        console.log("<<<", msg.slice(0, 200));
        
        try {
          const parsed = JSON.parse(msg);
          
          // Проверяем готовность сессии
          if (parsed.type === "session.created") {
            console.log("🟢 OpenAI session ready");
            ready = true;
            // Отправляем все накопленные чанки
            if (pendingChunks.length > 0) {
              console.log(`📤 Merging ${pendingChunks.length} pending chunks into buffer...`);
              audioBuffer.push(...pendingChunks);
              pendingChunks = [];
            }
          }
          
          if (parsed.type === "error") {
            console.error("❌ OpenAI Error:", JSON.stringify(parsed, null, 2));
            
            // Если ошибка empty buffer, не сбрасываем счетчик и планируем повторную попытку
            if (parsed.error && parsed.error.code === "input_audio_buffer_commit_empty") {
              console.log(`⚠️  Empty buffer error, will retry commit after more chunks...`);
              // Не сбрасываем счетчик - будем ждать новых чанков
              // Таймер уже сброшен, так что новый чанк установит новый таймер
            }
          }
          
          if (parsed.type === "response.text.delta") {
            process.stdout.write(parsed.delta);
          }
          if (parsed.type === "response.text.done") {
            console.log(`\n🎯 Text: "${parsed.text}"`);
            // Сбрасываем буфер и очищаем таймер после получения ответа
            audioBuffer = [];
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
              autoCommitTimer = null;
            }
          }
          if (parsed.type === "response.created") {
            // Очищаем таймер при создании нового response
            if (autoCommitTimer) {
              clearTimeout(autoCommitTimer);
              autoCommitTimer = null;
            }
          }
        } catch (e) {
          // Не JSON, просто логируем
        }
        
        esp.send(msg);
      });

      oa.on("error", (error) => {
        console.error("❌ OpenAI WebSocket error:", error.message);
      });

      oa.on("close", (code, reason) => {
        console.log("🔌 OpenAI WebSocket closed");
        console.log("Close code:", code, "Reason:", reason.toString());
        ready = false;
        pendingChunks = [];
        audioBuffer = [];
        if (autoCommitTimer) {
          clearTimeout(autoCommitTimer);
          autoCommitTimer = null;
        }
        if (esp.readyState === WebSocket.OPEN) {
          esp.close();
        }
      });

      // Функция для отправки накопленного буфера одним большим чанком
      function sendBufferedAudio() {
        if (audioBuffer.length === 0 || oa.readyState !== WebSocket.OPEN || !ready) {
          return;
        }
        
        // Объединяем все чанки в один большой Buffer
        const totalSize = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        const combinedBuffer = Buffer.concat(audioBuffer, totalSize);
        
        console.log(`📤 Sending ${audioBuffer.length} chunks (${totalSize} bytes) as single buffer...`);
        
        // Отправляем весь буфер одним сообщением
        oa.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: combinedBuffer.toString("base64")
        }));
        
        // Очищаем буфер после отправки
        audioBuffer = [];
        
        // Динамическая задержка в зависимости от размера буфера
        // Для больших буферов нужна большая задержка для обработки
        // При 16kHz, 16-bit: 1 секунда аудио = 32000 байт
        const audioDurationMs = (totalSize / 32000) * 1000; // Примерная длительность в мс
        const commitDelay = Math.max(500, Math.min(1000, audioDurationMs * 0.5)); // От 500ms до 1000ms
        
        console.log(`⏳ Waiting ${commitDelay}ms before commit (audio duration: ~${audioDurationMs.toFixed(0)}ms)...`);
        
        // Делаем commit после задержки, чтобы дать время на обработку
        setTimeout(() => {
          console.log(`📤 Sending input_audio_buffer.commit...`);
          oa.send(JSON.stringify({
            type: "input_audio_buffer.commit"
          }));
          
          setTimeout(() => {
            console.log(`📤 Sending response.create...`);
            oa.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text"]
              }
            }));
          }, 100);
        }, commitDelay); // Динамическая задержка для обработки
      }

      // Пересылаем бинарные чанки от ESP → OpenAI
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          if (oa.readyState !== WebSocket.OPEN) {
            console.log("⚠️  Audio chunk received but OpenAI WS not open");
            return;
          }
          
          if (!ready) {
            // Сессия еще не готова - сохраняем в буфер
            pendingChunks.push(msg);
            if (pendingChunks.length % 10 === 0) {
              console.log(`📦 Buffered ${pendingChunks.length} chunks (waiting for session.created)`);
            }
            return;
          }
          
          // Сессия готова - накапливаем чанки в буфере
          audioBuffer.push(msg);
          
          // Очищаем предыдущий таймер
          if (autoCommitTimer) {
            clearTimeout(autoCommitTimer);
            autoCommitTimer = null;
          }
          
          // Автоматическая отправка через 2 секунды после последнего чанка (если достаточно данных)
          // OpenAI требует минимум 100ms аудио, у нас 1024 байта = ~32ms при 16kHz, так что нужно минимум 4 чанка
          if (audioBuffer.length >= 4) {
            autoCommitTimer = setTimeout(() => {
              sendBufferedAudio();
            }, 2000); // 2 секунды тишины
          }
          
          if (audioBuffer.length % 10 === 0) {
            console.log(`📊 Buffered ${audioBuffer.length} chunks (${audioBuffer.reduce((sum, ch) => sum + ch.length, 0)} bytes)`);
          }
        } else {
          const textMsg = msg.toString();
          console.log("📝 Text from ESP:", textMsg);
          
          // Если получен сигнал остановки, отправляем накопленный буфер
          if (textMsg.includes("STREAM STOPPED") || textMsg.includes("STOP")) {
            console.log(`🛑 Received stop signal. Buffered chunks: ${audioBuffer.length}, OpenAI ready: ${oa.readyState === WebSocket.OPEN}, session ready: ${ready}`);
            if (oa.readyState === WebSocket.OPEN && ready) {
              // Очищаем таймер
              if (autoCommitTimer) {
                clearTimeout(autoCommitTimer);
                autoCommitTimer = null;
              }
              
              // Отправляем накопленный буфер
              if (audioBuffer.length > 0) {
                sendBufferedAudio();
              } else {
                console.log("⚠️  No audio data to commit");
              }
            } else {
              console.log(`⚠️  Stop signal received but OpenAI not ready (readyState: ${oa.readyState}, session ready: ${ready})`);
            }
          }
        }
      });

      esp.on("close", (code, reason) => {
        console.log("🔌 ESP disconnected");
        console.log("Close code:", code, "Reason:", reason.toString());
        if (oa.readyState === WebSocket.OPEN) {
          oa.close();
        }
      });

      esp.on("error", (error) => {
        console.error("❌ ESP WebSocket error:", error.message);
        console.error("Error stack:", error.stack);
      });

      esp.on("ping", () => {
        console.log("🏓 Received ping from ESP");
      });

      esp.on("pong", () => {
        console.log("🏓 Received pong from ESP");
      });

    } catch (error) {
      console.error("❌ Error setting up connection:", error.message);
      console.error("Error stack:", error.stack);
      setTimeout(() => {
        if (esp.readyState === WebSocket.OPEN) {
          esp.close();
        }
      }, 1000);
    }
  });

  wss.on("error", (error) => {
    console.error("❌ WebSocket Server error:", error.message);
  });
}

start().catch(console.error);

