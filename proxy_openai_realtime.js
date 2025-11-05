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
    console.log(`   Deployed on Render - WebSocket URL: wss://${process.env.RENDER_SERVICE_NAME}.onrender.com:${PORT}`);
  }
  const wss = new WebSocketServer({ port: PORT });

  wss.on("connection", async (esp) => {
    console.log("✅ ESP connected");

    try {
      // создаём сессию Realtime и открываем WS к OpenAI
      const session = await createRealtimeSession();
      console.log("✅ Realtime session created");

      const wsOptions = {
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      };

      // Добавляем прокси для WebSocket соединения, если указан
      if (PROXY_URL) {
        const ProxyAgent = PROXY_URL.startsWith('https') || PROXY_URL.startsWith('wss') 
          ? HttpsProxyAgent 
          : HttpProxyAgent;
        wsOptions.agent = new ProxyAgent(PROXY_URL);
        console.log(`🌐 Using proxy for WebSocket: ${PROXY_URL}`);
      }

      const oa = new WebSocket(session.client_secret.value, wsOptions);

      oa.on("open", () => {
        console.log("✅ Connected to OpenAI Realtime");
      });

      oa.on("message", (data) => {
        const msg = data.toString();
        console.log("<<<", msg.slice(0, 120));
        esp.send(msg);
      });

      oa.on("error", (error) => {
        console.error("❌ OpenAI WebSocket error:", error.message);
      });

      oa.on("close", () => {
        console.log("🔌 OpenAI WebSocket closed");
        if (esp.readyState === WebSocket.OPEN) {
          esp.close();
        }
      });

      // Пересылаем бинарные чанки от ESP → OpenAI
      esp.on("message", (msg) => {
        if (Buffer.isBuffer(msg)) {
          if (oa.readyState === WebSocket.OPEN) {
            // Отправляем аудио как input_audio_buffer.append
            oa.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.toString("base64")
            }));
          } else {
            console.log("⚠️  Audio chunk received but OpenAI not connected");
          }
        } else {
          const textMsg = msg.toString();
          console.log("📝 Text from ESP:", textMsg);
          
          // Если получен сигнал остановки, отправляем commit и response.create
          if (textMsg.includes("STREAM STOPPED") || textMsg.includes("STOP")) {
            if (oa.readyState === WebSocket.OPEN) {
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
            }
          }
        }
      });

      esp.on("close", () => {
        console.log("🔌 ESP disconnected");
        if (oa.readyState === WebSocket.OPEN) {
          oa.close();
        }
      });

      esp.on("error", (error) => {
        console.error("❌ ESP WebSocket error:", error.message);
      });

      // Автоматически отправляем commit и response.create через 2 секунды после начала потока
      setTimeout(() => {
        if (oa.readyState === WebSocket.OPEN && esp.readyState === WebSocket.OPEN) {
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
        }
      }, 2000);

    } catch (error) {
      console.error("❌ Error setting up connection:", error.message);
      esp.close();
    }
  });

  wss.on("error", (error) => {
    console.error("❌ Server error:", error.message);
  });
}

start().catch(console.error);

