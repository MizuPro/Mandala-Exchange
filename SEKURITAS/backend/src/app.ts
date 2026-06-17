import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import portfolioRoutes from "./routes/portfolio.js";
import orderRoutes from "./routes/orders.js";
import beiWebhookRoutes from "./routes/bei-webhooks.js";
import marketRoutes from "./routes/market.js";
import matsWebhookRoutes from "./routes/mats-webhooks.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import notificationRoutes from "./routes/notifications.js";


export async function createApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: ["http://localhost:5173", "https://mandala-sekuritas.michaelk.fun"],
    credentials: true
  });

  await app.register(helmet);

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

  return app;
}
