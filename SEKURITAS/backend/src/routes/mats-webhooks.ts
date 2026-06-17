import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireServiceToken } from "../lib/auth.js";
import { handleWebhookUpdate } from "../services/order-service.js";

const matsOrderStatusSchema = z.object({
  event_type: z.string().optional(),
  client_order_id: z.string().min(1).optional(),
  mats_order_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  filled_quantity: z.coerce.number().int().nonnegative().optional(),
  remaining_quantity: z.coerce.number().int().nonnegative().optional(),
  trade_id: z.string().min(1).optional(),
  price: z.coerce.number().finite().positive().optional(),
  quantity: z.coerce.number().int().positive().optional(),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).optional(),
  idempotency_key: z.string().min(1).optional(),
  fills: z.array(z.object({
    trade_id: z.string().min(1),
    mats_order_id: z.string().min(1).optional(),
    price: z.coerce.number().finite().positive(),
    quantity: z.coerce.number().int().positive(),
    side: z.enum(["BUY", "SELL", "buy", "sell"]).optional(),
    occurred_at: z.string().optional(),
    idempotency_key: z.string().min(1).optional(),
  })).optional(),
  reject_reason: z.string().optional(),
  occurred_at: z.string().optional(),
  correlation_id: z.string().optional(),
}).refine((value) => value.client_order_id || value.mats_order_id, {
  message: "client_order_id or mats_order_id is required",
});

export default async function matsWebhookRoutes(app: FastifyInstance) {
  app.post("/events", async (request, reply) => {
    const expectedToken = process.env.MATS_TO_SEKURITAS_TOKEN || process.env.SEKURITAS_SERVICE_TOKEN;
    if (!requireServiceToken(request, reply, expectedToken, "MATS")) return;

    const parsed = matsOrderStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid MATS event payload" });
    }

    try {
      await handleWebhookUpdate(parsed.data);
      return reply.send({ success: true });
    } catch (error: any) {
      app.log.error(error, "MATS event processing failed");
      return reply.status(500).send({ error: "Internal processing error" });
    }
  });
}
