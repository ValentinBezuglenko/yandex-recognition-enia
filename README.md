# OpenAI Realtime Proxy Server

Прокси-сервер для подключения ESP32 к OpenAI Realtime API через WebSocket.

## Описание

Сервер принимает WebSocket соединения от ESP32 и проксирует аудио в OpenAI Realtime API для транскрипции речи в текст.

## Установка

```bash
npm install
```

## Настройка переменных окружения

**⚠️ ВАЖНО: Никогда не храните API ключи в коде! Используйте переменные окружения.**

### Локальный запуск

Создайте файл `.env` в корне проекта (не коммитьте его в Git):

```env
OPENAI_API_KEY=sk-proj-your-api-key-here
PORT=8765
```

Или установите переменные окружения в системе:

**Windows (PowerShell):**
```powershell
$env:OPENAI_API_KEY="sk-proj-your-api-key-here"
$env:PORT=8765
```

**Linux/Mac:**
```bash
export OPENAI_API_KEY="sk-proj-your-api-key-here"
export PORT=8765
```

### Для использования прокси (опционально):

```env
HTTP_PROXY=http://proxy.example.com:8080
# или
HTTPS_PROXY=https://proxy.example.com:8080
# или
PROXY_URL=http://proxy.example.com:8080
```

## Запуск локально

```bash
npm start
```

Или с указанием порта:
```bash
PORT=8765 node proxy_openai_realtime.js
```

## Переменные окружения

- `PORT` - Порт для WebSocket сервера (по умолчанию: 8765)
- `OPENAI_API_KEY` - API ключ OpenAI (обязательно)
- `HTTP_PROXY` / `HTTPS_PROXY` / `PROXY_URL` - Прокси для обхода географических ограничений (опционально)

## Деплой на Render

1. Создайте новый Web Service на Render
2. Подключите этот репозиторий
3. Установите переменную окружения `OPENAI_API_KEY` в настройках сервиса:
   - Dashboard → Settings → Environment Variables
   - Добавьте: `OPENAI_API_KEY` = `ваш-ключ`
4. Build Command: `npm install`
5. Start Command: `npm start`

Сервер автоматически будет использовать порт из переменной окружения `PORT`, которую Render устанавливает автоматически.

## Безопасность

- ✅ Все ключи хранятся в переменных окружения
- ✅ Файл `.env` добавлен в `.gitignore`
- ✅ Ключи никогда не коммитятся в Git
- ⚠️ Не передавайте API ключи в URL или логах
