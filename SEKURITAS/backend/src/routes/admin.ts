import { FastifyInstance } from "fastify";
import { db } from "../db/db.js";
import { cash_balances, ledger_movements, broker_accounts, users } from "../db/schema.js";
import { eq } from "drizzle-orm";

export default async function adminRoutes(app: FastifyInstance) {
  // Deposit manual by admin
  app.post("/deposit", async (request, reply) => {
    const { email, amount } = request.body as any;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return reply.status(404).send({ error: "User not found" });

    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    await db.transaction(async (tx) => {
      const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
      
      const newAvailable = (parseFloat(cash.available) + parseFloat(amount)).toString();

      await tx.update(cash_balances).set({ available: newAvailable, updated_at: new Date() }).where(eq(cash_balances.id, cash.id));

      await tx.insert(ledger_movements).values({
        broker_account_id: brokerAcc.id,
        asset_type: "CASH",
        amount: amount.toString(),
        balance_after: newAvailable,
        reference_type: "DEPOSIT",
      });
    });

    return { message: "Deposit successful" };
  });
}
