import { FastifyInstance } from "fastify";
import { db } from "../db/db.js";
import { securities_positions, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

export default async function portfolioRoutes(app: FastifyInstance) {
  app.get("/portfolio", async (request, reply) => {
    // In real app, get user from JWT, for now mock:
    const user_id = (request.headers['x-user-id'] as string) || "mock-user-id";
    
    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user_id as string)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, brokerAcc.id));
    
    return {
      broker_account_id: brokerAcc.id,
      positions,
      // the unrealized P/L is updated asynchronously via market data worker, so we just return the stored value
    };
  });
}
