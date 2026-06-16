import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { registerAuth } from "./lib/auth.js";
import { sendError } from "./lib/errors.js";
import { registerBrokerRoutes } from "./routes/brokers.js";
import { registerCorporateActionRoutes } from "./routes/corporate-actions.js";
import { registerFundamentalRoutes } from "./routes/fundamentals.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIssuerRoutes } from "./routes/issuers.js";
import { registerReportingRoutes } from "./routes/reporting.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerSettlementRoutes } from "./routes/settlement.js";
import { registerSurveillanceRoutes } from "./routes/surveillance.js";
import { registerTradeRoutes } from "./routes/trades.js";

export async function createApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug"
    }
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await registerAuth(app);

  await app.register(registerHealthRoutes);
  await app.register(registerIssuerRoutes, { prefix: "/v1" });
  await app.register(registerFundamentalRoutes, { prefix: "/v1" });
  await app.register(registerRuleRoutes, { prefix: "/v1" });
  await app.register(registerBrokerRoutes, { prefix: "/v1" });
  await app.register(registerTradeRoutes, { prefix: "/v1" });
  await app.register(registerSettlementRoutes, { prefix: "/v1" });
  await app.register(registerCorporateActionRoutes, { prefix: "/v1" });
  await app.register(registerReportingRoutes, { prefix: "/v1" });
  await app.register(registerSurveillanceRoutes, { prefix: "/v1" });

  app.setErrorHandler((error, _request, reply) => {
    sendError(reply, error);
  });

  return app;
}
