const PUBLIC_FRONTEND_HOSTS = new Set(["mandala-sekuritas.michaelk.fun"]);

const PUBLIC_API_BASE = "https://api-mandala-sekuritas.michaelk.fun/api/v1";
const PUBLIC_MARKET_WS_URL = "wss://api-mandala-sekuritas.michaelk.fun/api/v1/market/ws";

const LOCAL_API_BASE = "http://localhost:3002/api/v1";
const LOCAL_MARKET_WS_URL = "ws://localhost:3002/api/v1/market/ws";

function isPublicFrontendHost() {
  return (
    typeof window !== "undefined" &&
    PUBLIC_FRONTEND_HOSTS.has(window.location.hostname)
  );
}

export function resolveApiBase() {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  if (isPublicFrontendHost()) {
    return PUBLIC_API_BASE;
  }

  return LOCAL_API_BASE;
}

export function resolveMarketWsUrl() {
  if (import.meta.env.VITE_MATS_WS_URL) {
    return import.meta.env.VITE_MATS_WS_URL;
  }

  if (isPublicFrontendHost()) {
    return PUBLIC_MARKET_WS_URL;
  }

  return LOCAL_MARKET_WS_URL;
}

export function resolveUserWsUrl() {
  const base = resolveApiBase();
  // Convert http/https to ws/wss
  const wsBase = base.replace(/^http/, 'ws');
  return `${wsBase}/user/ws`;
}
