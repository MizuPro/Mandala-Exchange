import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import portfolioRoutes from "./routes/portfolio.js";
import orderRoutes from "./routes/orders.js";
import beiWebhookRoutes from "./routes/bei-webhooks.js";
import marketRoutes from "./routes/market.js";
import matsWebhookRoutes from "./routes/mats-webhooks.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import notificationRoutes from "./routes/notifications.js";
import { reconcileSubmitUnknownOrders } from "./services/order-service.js";
import { closeMarketWsProxy } from "./services/market-ws-proxy.js";

const defaultFrontendOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://mandala-sekuritas.michaelk.fun",
];

function frontendOrigins() {
  const raw = process.env.FRONTEND_ORIGINS;
  if (!raw) return defaultFrontendOrigins;
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

export async function createApp() {
  const app = Fastify({
    logger: true,
  });

  const allowedOrigins = new Set(frontendOrigins());
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true
  });

  await app.register(helmet);
  await app.register(websocket);

  app.get("/health", async (request, reply) => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(portfolioRoutes, { prefix: "/api/v1/portfolio" });
  await app.register(orderRoutes, { prefix: "/api/v1/orders" });
  await app.register(beiWebhookRoutes, { prefix: "/internal" });
  await app.register(matsWebhookRoutes, { prefix: "/internal/mats" });
  await app.register(marketRoutes, { prefix: "/api/v1/market" });
  await app.register(leaderboardRoutes, { prefix: "/api/v1/leaderboard" });
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });

  let reconcileInProgress = false;
  const reconcileInterval = setInterval(async () => {
    if (reconcileInProgress) return;
    reconcileInProgress = true;
    try {
      await reconcileSubmitUnknownOrders();
    } catch (err) {
      console.error("Auto-reconcile submit_unknown orders failed", err);
    } finally {
      reconcileInProgress = false;
    }
  }, 30000);
  app.addHook("onClose", async () => {
    clearInterval(reconcileInterval);
    closeMarketWsProxy();
  });

  return app;
}
