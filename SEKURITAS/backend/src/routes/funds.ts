import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { authenticateActiveUser } from "../lib/auth.js";
import { depositSimulatorFunds, withdrawSimulatorFunds } from "../services/funds-simulator-service.js";
import { rdnIntegrationPending } from "../services/rdn-service.js";

const fundsSchema = z.object({
  amount: z.coerce.number().finite().positive().max(1_000_000_000_000),
});

export function isSimulatorFundsEnabled(config = env) {
  return config.isSimulatorFinance && !config.isProduction;
}

export default async function fundsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.get("/mode", async () => {
    return {
      mode: env.financeMode,
      simulator_enabled: isSimulatorFundsEnabled(),
      rdn_enabled: env.financeMode === "rdn",
    };
  });

  app.post("/deposit", async (request: any, reply) => {
    const parsed = fundsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid deposit payload" });
    }

    if (!isSimulatorFundsEnabled()) {
      return reply.status(501).send(rdnIntegrationPending());
    }

    try {
      const result = await depositSimulatorFunds(request.user_id, parsed.data.amount);
      return reply.send({ success: true, mode: "simulator", ...result });
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || "Deposit failed" });
    }
  });

  app.post("/withdraw", async (request: any, reply) => {
    const parsed = fundsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid withdraw payload" });
    }

    if (!isSimulatorFundsEnabled()) {
      return reply.status(501).send(rdnIntegrationPending());
    }

    try {
      const result = await withdrawSimulatorFunds(request.user_id, parsed.data.amount);
      return reply.send({ success: true, mode: "simulator", ...result });
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || "Withdraw failed" });
    }
  });
}
