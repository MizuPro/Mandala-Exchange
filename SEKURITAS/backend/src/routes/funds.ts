import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { authenticateActiveUser } from "../lib/auth.js";
import { depositSimulatorFunds, withdrawSimulatorFunds } from "../services/funds-simulator-service.js";
import { rdnIntegrationPending } from "../services/rdn-service.js";
import { requestWithdrawal } from "../services/withdrawal-service.js";
import { db } from "../db/db.js";
import { broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { reconcileUserBalance } from "../services/reconciliation-service.js";

const fundsSchema = z.object({
  amount: z.coerce.number().finite().positive().max(1_000_000_000_000),
});

export function isSimulatorFundsEnabled(config = env) {
  return config.financeMode !== "rdn" || !config.isProduction;
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

    if (isSimulatorFundsEnabled()) {
      try {
        const result = await withdrawSimulatorFunds(request.user_id, parsed.data.amount);
        return reply.send({ success: true, mode: "simulator", ...result });
      } catch (error: any) {
        return reply.status(error.statusCode || 500).send({ error: error.message || "Withdraw failed" });
      }
    } else {
      try {
        const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, request.user_id)).limit(1);
        if (!account) {
          return reply.status(404).send({ error: "Broker account not found" });
        }

        const result = await requestWithdrawal(account.id, parsed.data.amount);
        return reply.send({ success: true, mode: "rdn", withdrawal: result });
      } catch (error: any) {
        return reply.status(error.statusCode || 500).send({
          error: error.message || "Withdrawal failed",
          code: error.code,
        });
      }
    }
  });

  app.post("/sync-balance", async (request: any, reply) => {
    try {
      const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, request.user_id)).limit(1);
      if (!account) {
        return reply.status(404).send({ error: "Broker account not found" });
      }

      await reconcileUserBalance(account.id);
      return reply.send({ success: true });
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({
        error: error.message || "Failed to sync balance",
      });
    }
  });
}
