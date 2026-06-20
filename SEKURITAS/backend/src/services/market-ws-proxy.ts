import type { FastifyBaseLogger } from "fastify";
import WebSocket, { type RawData } from "ws";

const clients = new Set<WebSocket>();
let upstream: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let connecting = false;

// Cache untuk menyimpan data terakhir
const depthCache = new Map<string, any>();
const lastPriceCache = new Map<string, any>();
const summaryCache = new Map<string, any>();
let sessionStateCache: any | null = null;

function upstreamUrl() {
  const baseUrl = process.env.MATS_MARKET_WS_URL || "ws://127.0.0.1:8082/v1/market-data/ws";
  const url = new URL(baseUrl);
  const token = process.env.MATS_SERVICE_TOKEN || process.env.MATS_SEKURITAS_TOKEN || "";
  if (!token) {
    console.warn('[MarketWsProxy] WARNING: MATS_SERVICE_TOKEN is empty — upstream auth may fail');
  }
  if (token && !url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  // Daftarkan symbols default agar MATS mengirim snapshot
  if (!url.searchParams.has("symbols")) {
    url.searchParams.set("symbols", "MNDL,NUSA,BARA");
  }
  return url.toString();
}


function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function broadcast(data: RawData, isBinary: boolean) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  }
}

function broadcastStatus(status: string) {
  const payload = JSON.stringify({
    type: "proxy_status",
    occurred_at: new Date().toISOString(),
    payload: { status },
  });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(logger?: FastifyBaseLogger) {
  if (reconnectTimer || clients.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureUpstream(logger);
  }, 3000);
}

function ensureUpstream(logger?: FastifyBaseLogger) {
  if (connecting) return;
  if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (clients.size === 0) return;

  connecting = true;
  const socket = new WebSocket(upstreamUrl());
  upstream = socket;

  socket.on("open", () => {
    connecting = false;
    clearReconnectTimer();
    broadcastStatus("upstream_connected");
    logger?.info("MATS market WebSocket upstream connected");
  });

  socket.on("message", (data, isBinary) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === "depth_snapshot" && event.symbol) {
        depthCache.set(event.symbol, event);
      } else if (event.type === "last_price" && event.symbol) {
        lastPriceCache.set(event.symbol, event);
      } else if (event.type === "market_summary" && event.symbol) {
        summaryCache.set(event.symbol, event);
      } else if (event.type === "session_state") {
        const status = event.payload?.status || event.payload?.session_status || '';
        sessionStateCache = event;
        // Reset order book jika sesi selesai / dimulai
        if (status === "closed" || status === "pre_open") {
          depthCache.clear();
          summaryCache.clear();
        }
      } else if (event.type === "session_timer" && event.payload?.status) {
        sessionStateCache = {
          type: "session_state",
          sequence: event.sequence,
          occurred_at: event.occurred_at,
          payload: {
            status: event.payload.status,
          },
        };
      }
    } catch (e) {
      // Abaikan error parsing JSON
    }
    broadcast(data, isBinary);
  });

  socket.on("error", (error) => {
    logger?.warn({ err: error }, "MATS market WebSocket upstream error");
  });

  socket.on("close", () => {
    connecting = false;
    if (upstream === socket) {
      upstream = null;
    }
    broadcastStatus("upstream_disconnected");
    scheduleReconnect(logger);
  });
}

function maybeCloseUpstream() {
  if (clients.size > 0) return;
  clearReconnectTimer();
  if (upstream) {
    upstream.close();
    upstream = null;
  }
  connecting = false;
}

export function handleMarketWsClient(socket: WebSocket, logger?: FastifyBaseLogger) {
  clients.add(socket);
  sendJson(socket, {
    type: "proxy_status",
    occurred_at: new Date().toISOString(),
    payload: { status: "client_connected" },
  });

  // Kirim data cache saat terhubung
  if (sessionStateCache) {
    sendJson(socket, sessionStateCache);
  }
  for (const event of depthCache.values()) {
    sendJson(socket, event);
  }
  for (const event of lastPriceCache.values()) {
    sendJson(socket, event);
  }
  for (const event of summaryCache.values()) {
    sendJson(socket, event);
  }

  socket.on("message", () => {
    // Browser messages are intentionally ignored for now; the upstream
    // subscription receives the complete public market stream.
  });

  socket.on("close", () => {
    clients.delete(socket);
    maybeCloseUpstream();
  });

  socket.on("error", (error) => {
    logger?.warn({ err: error }, "Market WebSocket client error");
    clients.delete(socket);
    maybeCloseUpstream();
  });

  ensureUpstream(logger);
}


export function closeMarketWsProxy() {
  clearReconnectTimer();
  for (const client of clients) {
    client.close();
  }
  clients.clear();
  if (upstream) {
    upstream.close();
    upstream = null;
  }
  connecting = false;
}
