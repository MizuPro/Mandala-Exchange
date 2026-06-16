import { FastifyInstance } from "fastify";
import { placeOrder, cancelOrder, handleWebhookUpdate } from "../services/order-service.js";
import { db } from "../db/db.js";
import { orders, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

export default async function orderRoutes(app: FastifyInstance) {
  // Place Order
  app.post("/", async (request, reply) => {
    const user_id = (request.headers['x-user-id'] as string) || "mock-user-id";
    const { symbol, side, price, quantity } = request.body as any;

    try {
      const order = await placeOrder(user_id, symbol, side, parseFloat(price), parseInt(quantity));
      return reply.status(201).send(order);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Cancel Order
  app.delete("/:id", async (request, reply) => {
    const user_id = (request.headers['x-user-id'] as string) || "mock-user-id";
    const { id } = request.params as any;

    try {
      const result = await cancelOrder(user_id, id);
      return reply.status(200).send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List user orders
  app.get("/", async (request, reply) => {
    const user_id = (request.headers['x-user-id'] as string) || "mock-user-id";
    const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user_id)).limit(1);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const userOrders = await db.select().from(orders).where(eq(orders.broker_account_id, brokerAcc.id));
    return reply.send(userOrders);
  });

  // Webhook from MATS
  app.post("/webhook/mats/update", async (request, reply) => {
    // Ideally verify MATS signature/token here
    const payload = request.body as any;
    
    try {
      await handleWebhookUpdate(payload);
      return reply.send({ success: true });
    } catch (error: any) {
      app.log.error(error, "Webhook processing failed");
      return reply.status(500).send({ error: "Internal processing error" });
    }
  });
}
