#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>

// ---------- Wi-Fi / WS ----------
const char* ssid = "Keenetic-4342";
const char* password = "Gf4HsZTH";
const char* ws_host = "192.168.1.58";  // Локальный IP вашего компьютера
const int ws_port = 10000;              // Порт локального сервера
const char* ws_path = "/ws";            // Путь WebSocket

// ---------- I2S ----------
#define I2S_WS 25
#define I2S_SD 22
#define I2S_SCK 26
#define I2S_PORT I2S_NUM_0
#define SAMPLE_RATE 24000
#define SAMPLE_BITS 16
#define BUFFER_SIZE 1024
#define DMA_BUF_COUNT 4
#define I2S_CHANNEL I2S_CHANNEL_FMT_ONLY_LEFT // моно

// ---------- BUTTON ----------
#define BUTTON_PIN 32
volatile BaseType_t buttonEvent = 0;
volatile TickType_t lastISRTick = 0;
const TickType_t DEBOUNCE_TICKS = pdMS_TO_TICKS(50);

// ---------- AUDIO QUEUE ----------
#define QUEUE_SIZE 3
uint8_t audioQueue[QUEUE_SIZE][BUFFER_SIZE];
bool queueFull[QUEUE_SIZE] = {false};
int queueHead = 0;
int queueTail = 0;

WebSocketsClient webSocket;

bool streaming = false;
unsigned long lastChunkTime = 0;
unsigned long lastStatTime = 0;
uint64_t totalSentBytes = 0;

// ---------- BUFFER AGGREGATION ----------
#define AGGREGATE_COUNT 5  // Сколько чанков объединяем
uint8_t sendBuffer[BUFFER_SIZE * AGGREGATE_COUNT];
size_t sendBufferOffset = 0;

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
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = 0,
    .dma_buf_count = DMA_BUF_COUNT,
    .dma_buf_len = BUFFER_SIZE / 2,
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
    if (r != ESP_OK) return;
    if (bytesRead == 0) return;
    total += bytesRead;
  }

  queueFull[queueHead] = true;
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  if (queueHead == queueTail && queueFull[queueTail]) {
    queueTail = (queueTail + 1) % QUEUE_SIZE;
  }
}

// ---------- AGGREGATED SEND ----------
void sendAudioData() {
  if (!webSocket.isConnected()) return;
  if (!queueFull[queueTail]) return;

  // Копируем данные в общий буфер
  memcpy(sendBuffer + sendBufferOffset, audioQueue[queueTail], BUFFER_SIZE);
  sendBufferOffset += BUFFER_SIZE;

  queueFull[queueTail] = false;
  queueTail = (queueTail + 1) % QUEUE_SIZE;

  // Если буфер набрался — отправляем
  if (sendBufferOffset >= sizeof(sendBuffer)) {
    bool ok = webSocket.sendBIN(sendBuffer, sendBufferOffset);
    if (ok) {
      totalSentBytes += sendBufferOffset;
      sendBufferOffset = 0;
    } else {
      Serial.println("[WS] Send failed!");
    }
  }
}

// ---------- PERIODIC FLUSH ----------
void flushSendBuffer() {
  if (sendBufferOffset > 0) {
    bool ok = webSocket.sendBIN(sendBuffer, sendBufferOffset);
    if (ok) totalSentBytes += sendBufferOffset;
    sendBufferOffset = 0;
  }
}

// ---------- WS CALLBACKS ----------
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] ❌ Disconnected");
      break;
    case WStype_CONNECTED:
      Serial.println("[WS] ✅ Connected!");
      Serial.println("[WS] → Ready to stream");
      // Отправляем сигнал начала стрима
      webSocket.sendTXT("STREAM_STARTED");
      break;
    case WStype_TEXT:
      Serial.printf("[WS RX] %s\n", payload);
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

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, CHANGE);
  Serial.println("Button ready on GPIO32");

  WiFi.begin(ssid, password);
  Serial.print("Connecting Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n✓ Wi-Fi: " + WiFi.localIP().toString());

  // Подключение БЕЗ SSL (ws:// вместо wss://)
  webSocket.begin(ws_host, ws_port, ws_path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

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
        flushSendBuffer();
        if (webSocket.isConnected()) {
          webSocket.sendTXT("STREAM STOPPED");
          Serial.println("[WS] → Sent STREAM STOPPED");
        }
        totalSentBytes = 0;
      }

      Serial.println(streaming ? "=== 🎙 STREAM STARTED ===" : "=== ⏹ STREAM STOPPED ===");
    }
  }

  // Поток
  if (streaming) {
    readAudioData();
    sendAudioData();

    // Принудительно сбрасываем каждые 100 мс
    if (millis() - lastChunkTime >= 100) {
      flushSendBuffer();
      lastChunkTime = millis();
    }

    // Статистика
    if (millis() - lastStatTime >= 2000) {
      Serial.printf("[STAT] Sent total: %llu bytes (%.2f KB)\n", totalSentBytes, totalSentBytes / 1024.0);
      lastStatTime = millis();
    }
  } else {
    delay(10);
  }
}

