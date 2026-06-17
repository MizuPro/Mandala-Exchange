import { FastifyInstance } from "fastify";
import { processSettlement } from "../services/settlement-service.js";
import { z } from "zod";
import { requireServiceToken } from "../lib/auth.js";

const settlementDetailSchema = z.object({
  mats_order_id: z.string().min(1),
  trade_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  price: z.coerce.number().finite().positive(),
  quantity: z.coerce.number().int().positive(),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).optional(),
  settled_at: z.string().optional(),
}).passthrough();

const settlementWebhookSchema = z.object({
  status: z.string().optional(),
  details: z.array(settlementDetailSchema).min(1),
}).passthrough();

const corporateActionWebhookSchema = z.object({
  action_type: z.string().min(1),
  symbol: z.string().min(1),
  details: z.unknown().optional(),
}).passthrough();

export default async function beiWebhookRoutes(app: FastifyInstance) {
  // Webhook from BEI for Settlement Completed
  app.post("/webhook/bei/settlement", async (request, reply) => {
    const expectedToken = process.env.BEI_TO_SEKURITAS_TOKEN || process.env.SEKURITAS_SERVICE_TOKEN;
    if (!requireServiceToken(request, reply, expectedToken, "BEI")) return;

    const parsed = settlementWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid settlement webhook payload" });
    }
    
    try {
      for (const trade of parsed.data.details) {
        await processSettlement(trade.mats_order_id, trade);
      }
      return reply.send({ success: true });
    } catch (error: any) {
      app.log.error(error, "Settlement processing failed");
      return reply.status(500).send({ error: "Settlement processing error" });
    }
  });

  // Webhook from BEI for Corporate Actions (Dividends, Splits, etc)
  app.post("/webhook/bei/corporate-action", async (request, reply) => {
    const expectedToken = process.env.BEI_TO_SEKURITAS_TOKEN || process.env.SEKURITAS_SERVICE_TOKEN;
    if (!requireServiceToken(request, reply, expectedToken, "BEI")) return;

    const parsed = corporateActionWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid corporate action webhook payload" });
    }

    return reply.status(501).send({
      error: "Corporate action webhook is not implemented safely yet",
      action_type: parsed.data.action_type,
      symbol: parsed.data.symbol.toUpperCase(),
    });
  });
}
