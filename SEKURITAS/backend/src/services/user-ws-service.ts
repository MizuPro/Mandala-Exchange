import WebSocket from "ws";

const userClients = new Map<string, Set<WebSocket>>();

export function registerUserWsClient(userId: string, socket: WebSocket) {
  let clients = userClients.get(userId);
  if (!clients) {
    clients = new Set();
    userClients.set(userId, clients);
  }
  clients.add(socket);

  socket.on("close", () => {
    clients?.delete(socket);
    if (clients?.size === 0) {
      userClients.delete(userId);
    }
  });

  socket.on("error", (err) => {
    console.error(`User WS error for ${userId}:`, err);
    socket.close();
  });
}

export function broadcastUserEvent(userId: string, type: string, payload: any) {
  const clients = userClients.get(userId);
  if (!clients) return;

  const message = JSON.stringify({ type, data: payload });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
