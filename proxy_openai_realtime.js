// npm install ws axios https-proxy-agent http-proxy-agent
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

const PORT = process.env.PORT || 8765;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Для обхода географических ограничений - укажите прокси в формате http://host:port или https://host:port
// Примеры:
// const PROXY_URL = "http://proxy.example.com:8080";
// const PROXY_URL = "socks5://proxy.example.com:1080";
// Или используйте переменные окружения: HTTP_PROXY, HTTPS_PROXY, PROXY_URL
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY_URL;
// const PROXY_URL = "http://your-proxy-host:port"; // Раскомментируйте и укажите ваш прокси здесь

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");

// Создаёт новую Realtime-сессию
async function createRealtimeSession() {
  try {
    const config = {
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
    };

    // Добавляем прокси для HTTP запросов, если указан
    if (PROXY_URL) {
      const ProxyAgent = PROXY_URL.startsWith('https') ? HttpsProxyAgent : HttpProxyAgent;
      config.httpAgent = new ProxyAgent(PROXY_URL);
      config.httpsAgent = new ProxyAgent(PROXY_URL);
      console.log(`🌐 Using proxy: ${PROXY_URL}`);
    }

    const response = await axios.post(
      "https://api.openai.com/v1/realtime/sessions",
      {
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
      },
      config
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
        console.error("   - Географические ограничения");
        console.error("   - Неверный API ключ");
        console.error("   - Недостаточно прав у API ключа");
        console.error("\n💡 Решение: Используйте VPN или HTTP/HTTPS прокси для обхода географических ограничений.");
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
    
    // Отправляем подтверждение подключения сразу
    try {
      esp.send(JSON.stringify({ type: "connection.ack", event: "connected" }));
    } catch (e) {
      console.error("Failed to send ack:", e.message);
    }

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
      const wsOptions = {
        headers: { 
          Authorization: `Bearer ${clientSecretToken}`,
          "OpenAI-Beta": "realtime=v1"
        },
      };

      // Добавляем прокси для WebSocket соединения, если указан
      if (PROXY_URL) {
        const ProxyAgent = PROXY_URL.startsWith('https') || PROXY_URL.startsWith('wss') 
          ? HttpsProxyAgent 
          : HttpProxyAgent;
        wsOptions.agent = new ProxyAgent(PROXY_URL);
        console.log(`🌐 Using proxy for WebSocket: ${PROXY_URL}`);
      }

      const oa = new WebSocket(wsUrl, wsOptions);

      oa.on("open", () => {
        console.log("✅ Connected to OpenAI Realtime");
        openAIConnected = true; // Устанавливаем флаг подключения
        // Сессия уже инициализирована через API, дополнительных действий не требуется
      });

      oa.on("message", (data) => {
        const msg = data.toString();
        console.log("<<<", msg.slice(0, 200)); // Увеличил до 200 символов для полного сообщения об ошибке
        
        // Если это ошибка, логируем полностью
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "error") {
            console.error("❌ OpenAI Error:", JSON.stringify(parsed, null, 2));
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
        openAIConnected = false; // Сбрасываем флаг подключения
        if (esp.readyState === WebSocket.OPEN) {
          esp.close();
        }
      });

      // Счетчик отправленных аудио чанков для отслеживания количества данных
      let audioChunksSent = 0;
      let lastAudioTime = 0;
      let openAIConnected = false; // Флаг подключения к OpenAI
      
      // Конвертируем 32-битный PCM в 16-битный PCM для OpenAI
      function convert32to16Bit(buffer) {
        const samples32 = new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        const samples16 = new Int16Array(samples32.length);
        for (let i = 0; i < samples32.length; i++) {
          // Конвертируем 32-битный sample в 16-битный (берем старшие 16 бит)
          samples16[i] = samples32[i] >> 16;
        }
        return Buffer.from(samples16.buffer);
      }

      // УБРАЛИ автоматический commit по таймауту - теперь commit только при явной остановке от ESP32
      // Это предотвращает ошибки с пустым буфером

      // Пересылаем бинарные чанки от ESP → OpenAI
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          if (oa.readyState === WebSocket.OPEN && openAIConnected) {
            // Конвертируем 32-битный PCM в 16-битный PCM для OpenAI
            const audio16Bit = convert32to16Bit(msg);
            
            // Отправляем аудио как input_audio_buffer.append только если OpenAI подключен
            oa.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: audio16Bit.toString("base64")
            }));
            
            audioChunksSent++;
            lastAudioTime = Date.now();
            if (audioChunksSent % 10 === 0) {
              console.log(`📊 Sent ${audioChunksSent} audio chunks (${audio16Bit.length} bytes each)`);
            }
          } else {
            // OpenAI еще не подключен - игнорируем чанки, чтобы не терять счетчик
            console.log("⚠️  Audio chunk received but OpenAI not ready (connected: " + openAIConnected + ", readyState: " + oa.readyState + ")");
          }
        } else {
          const textMsg = msg.toString();
          console.log("📝 Text from ESP:", textMsg);
          
          // Если получен сигнал остановки, отправляем commit и response.create
          if (textMsg.includes("STREAM STOPPED") || textMsg.includes("STOP")) {
            if (oa.readyState === WebSocket.OPEN && openAIConnected) {
              // Проверяем, что есть аудио данные перед commit
              if (audioChunksSent > 0) {
                console.log(`📤 Committing ${audioChunksSent} audio chunks after stop signal`);
                // Увеличиваем задержку перед commit, чтобы убедиться, что все последние аудио чанки доставлены
                setTimeout(() => {
                  oa.send(JSON.stringify({
                    type: "input_audio_buffer.commit"
                  }));
                  
                  setTimeout(() => {
                    oa.send(JSON.stringify({
                      type: "response.create",
                      response: {
                        modalities: ["text"]
                      }
                    }));
                  }, 100);
                }, 500); // Увеличена задержка до 500ms перед commit
              } else {
                console.log("⚠️  No audio data to commit");
              }
            } else {
              console.log("⚠️  Stop signal received but OpenAI not ready to commit");
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
      try {
        esp.send(JSON.stringify({ 
          type: "error", 
          error: error.message 
        }));
      } catch (sendError) {
        console.error("Failed to send error to ESP:", sendError.message);
      }
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

