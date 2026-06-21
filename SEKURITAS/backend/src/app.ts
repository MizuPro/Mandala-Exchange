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
import fundsRoutes from "./routes/funds.js";
import { reconcileSubmitUnknownOrders } from "./services/order-service.js";
import { closeMarketWsProxy } from "./services/market-ws-proxy.js";
import { reconcileAllUsers } from "./services/reconciliation-service.js";
import { env } from "./config/env.js";

export async function createApp() {
  const app = Fastify({
    logger: true,
  });

  const allowedOrigins = new Set(env.frontendOrigins);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
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
  await app.register(fundsRoutes, { prefix: "/api/v1/funds" });
  await app.register((await import("./routes/user-ws.js")).default, { prefix: "/api/v1/user" });
  await app.register((await import("./routes/rdn-webhooks.js")).default, { prefix: "/api/v1/webhooks" });

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

  // Reconciliation interval untuk saldo RDN Bank Mandala (berjalan setiap 10 menit)
  let rdnReconcileInProgress = false;
  const rdnReconcileInterval = setInterval(async () => {
    if (rdnReconcileInProgress) return;
    rdnReconcileInProgress = true;
    try {
      await reconcileAllUsers();
    } catch (err) {
      console.error("Auto-reconcile RDN balances failed", err);
    } finally {
      rdnReconcileInProgress = false;
    }
  }, 600000); // 10 menit

  app.addHook("onClose", async () => {
    clearInterval(reconcileInterval);
    clearInterval(rdnReconcileInterval);
    closeMarketWsProxy();
  });

  return app;
}
