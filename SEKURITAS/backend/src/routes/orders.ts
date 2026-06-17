import { FastifyInstance } from "fastify";
import { placeOrder, cancelOrder } from "../services/order-service.js";
import { db } from "../db/db.js";
import { orders, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";

const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.-]+$/).transform((value) => value.toUpperCase()),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).transform((value) => value.toUpperCase() as "BUY" | "SELL"),
  price: z.coerce.number().finite().int().positive(),
  quantity: z.coerce.number().finite().int().positive(),
});

export default async function orderRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  // Place Order
  app.post("/", async (request: any, reply) => {
    const user_id = request.user_id;
    const parsed = placeOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid order payload" });
    }
    const { symbol, side, price, quantity } = parsed.data;

    try {
      const order = await placeOrder(user_id, symbol, side, price, quantity);
      return reply.status(201).send(order);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Cancel Order
  app.delete("/:id", async (request: any, reply) => {
    const user_id = request.user_id;
    const { id } = request.params as any;

    try {
      const result = await cancelOrder(user_id, id);
      return reply.status(200).send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List user orders
  app.get("/", async (request: any, reply) => {
    const user_id = request.user_id;
    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user_id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const userOrders = await db.select().from(orders).where(eq(orders.broker_account_id, brokerAcc.id));
    return reply.send(userOrders);
  });
}
