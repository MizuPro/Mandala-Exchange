import { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db/db.js";
import { securities_positions, broker_accounts, cash_balances } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authenticateActiveUser } from "../lib/auth.js";

export default async function portfolioRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.get("/summary", async (request: any, reply: FastifyReply) => {
    const user_id = request.user_id;
    
    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user_id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
    const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, brokerAcc.id));
    
    return {
      cash: cash ? { available: cash.available, reserved: cash.reserved, pending: cash.pending } : { available: "0", reserved: "0", pending: "0" },
      positions: positions.map(p => ({
        symbol: p.symbol,
        available: p.available,
        reserved: p.reserved,
        pending: p.pending,
        average_price: p.average_price,
        realized_pl: p.realized_pl
      }))
    };
  });
}
