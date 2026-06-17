import { FastifyInstance } from "fastify";
import { db } from "../db/db.js";
import { cash_balances, ledger_movements, broker_accounts, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdminToken, signUserToken } from "../lib/auth.js";
import { hashPassword } from "../lib/password.js";
import { createBrokerAccount } from "../services/account-service.js";
import { reconcileSubmitUnknownOrders } from "../services/order-service.js";
import crypto from "crypto";

const depositSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  amount: z.coerce.number().finite().positive().max(1_000_000_000_000),
});

const createBotSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  password: z.string().min(12).optional(),
});

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
  });

  // Deposit manual by admin
  app.post("/deposit", async (request, reply) => {
    const parsed = depositSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid deposit payload" });
    }
    const { email, amount } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return reply.status(404).send({ error: "User not found" });

    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    await db.transaction(async (tx) => {
      const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
      if (!cash) {
        throw new Error("Cash balance not found");
      }
      
      const newAvailable = (parseFloat(cash.available) + amount).toFixed(6);

      await tx.update(cash_balances).set({ available: newAvailable, updated_at: new Date() }).where(eq(cash_balances.id, cash.id));

      await tx.insert(ledger_movements).values({
        broker_account_id: brokerAcc.id,
        asset_type: "CASH",
        amount: amount.toFixed(6),
        balance_after: newAvailable,
        reference_type: "DEPOSIT",
      });
    });

    return { message: "Deposit successful" };
  });

  app.post("/bots", async (request, reply) => {
    const parsed = createBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid bot payload" });
    }
    const { email } = parsed.data;
    const password = parsed.data.password || cryptoRandomPassword();

    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const [user] = await db.insert(users).values({
      email,
      password_hash: hashPassword(password),
      status: "verified",
    }).returning();

    const brokerAccount = await createBrokerAccount(user.id, "BOT");

    return {
      token: signUserToken(user.id),
      user: {
        id: user.id,
        email: user.email,
        is_verified: true,
        status: user.status,
      },
      broker_account: brokerAccount,
      generated_password: parsed.data.password ? undefined : password,
    };
  });

  // Reconcile submit_unknown orders
  app.post("/reconcile-orders", async (request, reply) => {
    try {
      const result = await reconcileSubmitUnknownOrders();
      return reply.send(result);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });
}

function cryptoRandomPassword() {
  return `bot-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}
