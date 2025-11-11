import fs from "fs";
import https from "https";
import { WebSocketServer } from "ws";

// ==== SSL для Render: можно использовать свои сертификаты или самоподписанные ====
const options = {
  key: fs.readFileSync("./privkey.pem"),
  cert: fs.readFileSync("./fullchain.pem")
};

// ==== HTTPS сервер на 443 ====
const server = https.createServer(options);
server.listen(process.env.PORT || 443, () => {
  console.log("🌐 HTTPS server running on port 443");
});

// ==== WebSocket сервер на пути /ws ====
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", ws => {
  const timestamp = Date.now();
  const filename = `stream_${timestamp}.pcm`;
  const file = fs.createWriteStream(filename);
  let totalBytes = 0;

  console.log("🎙 Client connected");

  ws.on("message", data => {
    if (typeof data === "string" && data === "/end") {
      file.end();
      console.log(`⏹ Stream ended: ${filename} (total: ${totalBytes} bytes)`);
      return;
    }

    if (data instanceof Buffer) {
      file.write(data);
      totalBytes += data.length;
      console.log(`⬇️ Chunk received: ${data.length} bytes (total: ${totalBytes})`);
    }
  });

  ws.on("close", () => {
    file.end();
    console.log("❌ Client disconnected");
  });

  ws.on("error", err => console.error("❌ WebSocket error:", err));
});
