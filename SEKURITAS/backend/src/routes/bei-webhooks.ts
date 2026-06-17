import { FastifyInstance } from "fastify";
import { processSettlement } from "../services/settlement-service.js";
import { processCorporateAction } from "../services/corporate-action-service.js";
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
  event_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
  corporate_action_id: z.string().min(1).optional(),
  action_id: z.string().min(1).optional(),
  action_type: z.string().min(1),
  symbol: z.string().min(1).transform((value) => value.toUpperCase()),
  title: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  entitlements: z.array(z.record(z.string(), z.unknown())).optional(),
  generated_ledger_entries: z.array(z.record(z.string(), z.unknown())).optional(),
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
      const results = [];
      for (const trade of parsed.data.details) {
        results.push(await processSettlement(trade.mats_order_id, trade));
      }
      const deferred = results.filter((result) => result.status === "deferred");
      if (deferred.length > 0) {
        return reply.status(202).send({ success: false, status: "deferred", deferred, results });
      }
      return reply.send({ success: true, results });
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

    try {
      const result = await processCorporateAction(parsed.data as any);
      return reply.send({ success: true, ...result });
    } catch (error: any) {
      app.log.error(error, "Corporate action processing failed");
      return reply.status(500).send({ error: error.message || "Corporate action processing error" });
    }
  });
}
