import { FastifyInstance } from "fastify";
import { placeOrder, cancelOrder, amendOrder } from "../services/order-service.js";
import { db } from "../db/db.js";
import { order_amendments, orders, broker_accounts } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";

const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.-]+$/).transform((value) => value.toUpperCase()),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).transform((value) => value.toLowerCase() as "buy" | "sell"),
  order_type: z.enum(["LIMIT", "MARKET", "limit", "market"]).default("limit").transform((value) => value.toLowerCase() as "limit" | "market"),
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive(),
}).refine((value) => value.order_type === "market" || value.price !== undefined, {
  message: "price is required for limit orders",
});

const amendOrderSchema = z.object({
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive().optional(),
}).refine((value) => value.price !== undefined || value.quantity !== undefined, {
  message: "price or quantity is required",
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
    const { symbol, side, price, quantity, order_type } = parsed.data;

    try {
      const order: any = await placeOrder(user_id, symbol, side, price, quantity, order_type);
      if (order.deferred) {
        return reply.status(202).send(order);
      }
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

  app.patch("/:id", async (request: any, reply) => {
    const user_id = request.user_id;
    const { id } = request.params as any;
    const parsed = amendOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid amend payload" });
    }

    try {
      const result = await amendOrder(user_id, id, parsed.data.price, parsed.data.quantity);
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

    const userOrders = await db.select().from(orders)
      .where(eq(orders.broker_account_id, brokerAcc.id))
      .orderBy(desc(orders.created_at));
    return reply.send(userOrders);
  });

  app.get("/:id/amendments", async (request: any, reply) => {
    const user_id = request.user_id;
    const { id } = request.params as any;
    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user_id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const [order] = await db.select().from(orders).where(and(eq(orders.id, id), eq(orders.broker_account_id, brokerAcc.id))).limit(1);
    if (!order) return reply.status(404).send({ error: "Order not found" });

    const rows = await db
      .select()
      .from(order_amendments)
      .where(eq(order_amendments.order_id, order.id))
      .orderBy(desc(order_amendments.created_at));
    return reply.send(rows);
  });
}
