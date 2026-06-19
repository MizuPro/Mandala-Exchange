import WebSocket from "ws";

console.log("Connecting to Sekuritas WebSocket proxy...");
const socket = new WebSocket("ws://localhost:3002/api/v1/market/ws");

socket.on("open", () => {
  console.log("WebSocket connected successfully!");
});

socket.on("message", (data) => {
  try {
    const event = JSON.parse(data.toString());
    console.log(`Received Event [${event.type}]:`, JSON.stringify(event.payload || event, null, 2));
  } catch (e) {
    console.log("Raw Message:", data.toString());
  }
});

socket.on("error", (err) => {
  console.error("WebSocket Connection Error:", err.message);
});

socket.on("close", (code, reason) => {
  console.log(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
  process.exit(0);
});

// Tutup setelah 10 detik pengamatan
setTimeout(() => {
  console.log("Closing test socket...");
  socket.close();
}, 10000);
