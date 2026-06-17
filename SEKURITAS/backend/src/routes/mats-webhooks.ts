import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireServiceToken } from "../lib/auth.js";
import { handleWebhookUpdate } from "../services/order-service.js";

const matsOrderStatusSchema = z.object({
  client_order_id: z.string().min(1),
  mats_order_id: z.string().min(1).optional(),
  status: z.string().min(1),
  filled_quantity: z.coerce.number().int().nonnegative().default(0),
  remaining_quantity: z.coerce.number().int().nonnegative(),
  reject_reason: z.string().optional(),
  occurred_at: z.string().optional(),
  correlation_id: z.string().optional(),
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

