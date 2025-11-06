#include <WiFi.h>
#include <WebSocketsClient.h>  // SSL WebSocket с хорошей поддержкой на ESP32
#include <driver/i2s.h>

// ---------- Wi-Fi / WS ----------
const char* ssid = "Keenetic-4342";
const char* password = "Gf4HsZTH";
const char* ws_host = "openai-realtime-proxy-uwlf.onrender.com";
const int ws_port = 443;
const char* ws_path = "/ws";  // <-- Исправлено: сервер может ожидать /ws
const char* openai_token = "ek_690bde8dcd6c8191802cbbce8cebf517";  // токен

// ---------- I2S ----------
#define I2S_WS 25
#define I2S_SD 22
#define I2S_SCK 26
#define I2S_PORT I2S_NUM_0
#define SAMPLE_RATE 16000
#define SAMPLE_BITS 32   // Исправлено: большинство I2S микрофонов 24/32 бит
#define BUFFER_SIZE 1024
#define DMA_BUF_COUNT 4

// ---------- BUTTON ----------
#define BUTTON_PIN 32
volatile BaseType_t buttonEvent = 0;
volatile TickType_t lastISRTick = 0;
const TickType_t DEBOUNCE_TICKS = pdMS_TO_TICKS(50);

// ---------- AUDIO QUEUE ----------
bool streaming = false;
unsigned long lastChunkTime = 0;
unsigned long lastStatTime = 0;
uint64_t totalSentBytes = 0;

#define QUEUE_SIZE 3
uint8_t audioQueue[QUEUE_SIZE][BUFFER_SIZE];
bool queueFull[QUEUE_SIZE] = {false};
int queueHead = 0;
int queueTail = 0;

WebSocketsClient webSocket;

// ---------- ISR ----------
void IRAM_ATTR buttonISR() {
  TickType_t now = xTaskGetTickCountFromISR();
  if ((now - lastISRTick) > DEBOUNCE_TICKS) {
    lastISRTick = now;
    buttonEvent = 1;
  }
}

// ---------- I2S ----------
void setupI2S() {
  i2s_driver_uninstall(I2S_PORT);

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = (i2s_bits_per_sample_t)SAMPLE_BITS,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,  // Исправлено
    .intr_alloc_flags = 0,
    .dma_buf_count = DMA_BUF_COUNT,
    .dma_buf_len = BUFFER_SIZE / 4,
    .use_apll = false
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  if (i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL) == ESP_OK) {
    i2s_set_pin(I2S_PORT, &pin_config);
    i2s_zero_dma_buffer(I2S_PORT);
    Serial.println("✓ I2S configured");
  } else {
    Serial.println("✗ I2S install failed");
  }
}

// ---------- AUDIO READ ----------
void readAudioData() {
  size_t bytesRead = 0;
  if (queueFull[queueHead]) return;

  size_t total = 0;
  while (total < BUFFER_SIZE) {
    esp_err_t r = i2s_read(I2S_PORT, audioQueue[queueHead] + total, BUFFER_SIZE - total, &bytesRead, 100 / portTICK_PERIOD_MS);
    if (r != ESP_OK) {
      Serial.printf("[I2S] Read error: %d\n", r);
      return;
    }
    if (bytesRead == 0) {
      Serial.println("[I2S] No data available");
      return;
    }
    total += bytesRead;
  }

  queueFull[queueHead] = true;
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  if (queueHead == queueTail && queueFull[queueTail]) {
    queueTail = (queueTail + 1) % QUEUE_SIZE;
  }
}

// ---------- SEND ----------
void sendAudioData() {
  if (!webSocket.isConnected()) return;
  if (!queueFull[queueTail]) return;

  bool ok = webSocket.sendBIN(audioQueue[queueTail], BUFFER_SIZE);
  if (ok) totalSentBytes += BUFFER_SIZE;
  else Serial.println("[WS] Send failed!");

  queueFull[queueTail] = false;
  queueTail = (queueTail + 1) % QUEUE_SIZE;
}

// ---------- WS CALLBACKS ----------
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] ❌ Disconnected");
      break;
    case WStype_CONNECTED:
      Serial.println("[WS] ✅ Connected!");
      Serial.printf("[WS] Connected to: %s:%d%s\n", ws_host, ws_port, ws_path);
      // Отправляем токен как JSON, чтобы сервер не пытался интерпретировать его как URL
      {
        String msg = "{\"api_key\":\"" + String(openai_token) + "\"}";
        webSocket.sendTXT(msg);
        Serial.println("[WS] → Sent auth JSON");
      }
      break;
    case WStype_TEXT:
      Serial.printf("[WS RX] %s\n", payload);
      if (strstr((char*)payload, "connection.ack")) {
        Serial.println("[WS] ✅ Server acknowledged connection!");
      }
      break;
    case WStype_ERROR:
      Serial.printf("[WS] Error: %s\n", payload);
      break;
    default:
      break;
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== START ===");

  // Button
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, CHANGE);
  Serial.println("Button ready on GPIO32");

  // Wi-Fi
  Serial.print("Connecting Wi-Fi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n✓ Wi-Fi: " + WiFi.localIP().toString());

  // WebSocket
  webSocket.beginSSL(ws_host, ws_port, ws_path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  Serial.println("Connecting to: wss://" + String(ws_host) + ws_path);
  Serial.println("Waiting for connection...");

  // I2S
  setupI2S();
  Serial.println("Ready — press button to start streaming");
}

// ---------- LOOP ----------
void loop() {
  webSocket.loop();

  // Кнопка
  if (buttonEvent) {
    noInterrupts();
    buttonEvent = 0;
    interrupts();

    if (digitalRead(BUTTON_PIN) == LOW) {
      bool wasStreaming = streaming;
      streaming = !streaming;
      
      if (wasStreaming && !streaming) {
        // Останавливаем поток - отправляем сигнал серверу
        if (webSocket.isConnected()) {
          webSocket.sendTXT("STREAM STOPPED");
          Serial.println("[WS] → Sent STREAM STOPPED");
        }
        totalSentBytes = 0;
      }
      
      Serial.println(streaming ? "=== 🎙 STREAM STARTED ===" : "=== ⏹ STREAM STOPPED ===");
    }
  }

  if (streaming) {
    readAudioData();
    if (millis() - lastChunkTime >= 100) {
      sendAudioData();
      lastChunkTime = millis();
    }

    if (millis() - lastStatTime >= 2000) {
      Serial.printf("[STAT] Sent total: %llu bytes (%.2f KB)\n", totalSentBytes, totalSentBytes / 1024.0);
      lastStatTime = millis();
    }
  } else {
    delay(10);
  }
}
