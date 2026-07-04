import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/db.js";
import { broker_accounts, orders } from "../db/schema.js";
import { authenticateActiveUser } from "../lib/auth.js";
import { amendOrder, cancelOrder, placeOrder } from "../services/order-service.js";
import {
  cancelIpoSubscription,
  getIpoSubscription,
  IpoSubscriptionError,
  listIpoSubscriptions,
  subscribeIpo
} from "../services/ipo-subscription-service.js";

function sendError(reply: any, status: number, code: string, message: string, correlationId?: string, details: Record<string, unknown> = {}) {
  return reply.status(status).send({
    error: { code, message, retryable: status >= 500, correlation_id: correlationId || null, details }
  });
}

function sendIpoError(reply: any, error: unknown, correlationId?: string) {
  const known = error instanceof IpoSubscriptionError
    ? error
    : new IpoSubscriptionError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "IPO operation failed", true);
  return sendError(reply, known.statusCode, known.code, known.message, correlationId, known.details);
}

function identity(request: any) {
  return { accountId: request.account_id, userId: request.user_id };
}

const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.-]+$/).transform((value) => value.toUpperCase()),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).transform((value) => value.toLowerCase() as "buy" | "sell"),
  order_type: z.enum(["LIMIT", "MARKET", "limit", "market"]).default("limit").transform((value) => value.toLowerCase() as "limit" | "market"),
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive(),
  client_order_id: z.string().min(1).max(100).optional()
}).refine((value) => value.order_type === "market" || value.price !== undefined, {
  message: "price is required for limit orders"
});

const amendOrderSchema = z.object({
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive().optional()
}).refine((value) => value.price !== undefined || value.quantity !== undefined, {
  message: "price or quantity is required"
});

export default async function botIntegrationRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.post("/orders", async (request: any, reply) => {
    const parsed = placeOrderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid order payload" });
    const { symbol, side, price, quantity, order_type, client_order_id } = parsed.data;
    if (request.account_id && (!client_order_id || !/^bot:[^:]+:[0-9a-f-]{36}:\d+$/i.test(client_order_id))) {
      return sendError(reply, 400, "VALIDATION_ERROR", "BOT orders require stable client_order_id", request.headers["x-correlation-id"]);
    }
    try {
      const order: any = await placeOrder(request.user_id, symbol, side, price, quantity, order_type, client_order_id, request.account_id);
      return reply.status(order.deferred ? 202 : 201).send(order);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.delete("/orders/:id", async (request: any, reply) => {
    try {
      return reply.send(await cancelOrder(request.user_id, request.params.id));
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.patch("/orders/:id", async (request: any, reply) => {
    const parsed = amendOrderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid amend payload" });
    try {
      return reply.send(await amendOrder(request.user_id, request.params.id, parsed.data.price, parsed.data.quantity));
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.get("/orders/by-client-id/:clientOrderId", async (request: any, reply) => {
    const [account] = await db
      .select()
      .from(broker_accounts)
      .where(request.account_id ? eq(broker_accounts.id, request.account_id) : eq(broker_accounts.user_id, request.user_id))
      .limit(1);
    if (!account) return sendError(reply, 404, "BOT_NOT_FOUND", "Broker account not found", request.headers["x-correlation-id"]);
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.client_order_id, String(request.params.clientOrderId || "")), eq(orders.broker_account_id, account.id)))
      .limit(1);
    if (!order) return sendError(reply, 404, "ORDER_NOT_FOUND", "Order not found", request.headers["x-correlation-id"]);
    return reply.send(order);
  });

  app.post("/ipo/:id/subscribe", async (request: any, reply) => {
    const idempotencyKey = request.headers["idempotency-key"] as string;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ requested_shares: z.coerce.number().int().positive().safe() }).safeParse(request.body);
    if (!idempotencyKey || idempotencyKey.length > 128 || !params.success || !body.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Invalid IPO subscription request", request.headers["x-correlation-id"]);
    }
    try {
      const result = await subscribeIpo({
        identity: identity(request),
        ipoEventId: params.data.id,
        requestedShares: body.data.requested_shares,
        idempotencyKey
      });
      return reply.status(result.status === "cash_reserved" ? 202 : 201).send(result);
    } catch (error) {
      return sendIpoError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.post("/ipo/:id/subscriptions/:subscriptionId/cancel", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid subscription identifier");
    try {
      return reply.send(await cancelIpoSubscription({
        identity: identity(request),
        ipoEventId: params.data.id,
        subscriptionId: params.data.subscriptionId
      }));
    } catch (error) {
      return sendIpoError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.get("/ipo/subscriptions", async (request: any, reply) => {
    try {
      return reply.send({ items: await listIpoSubscriptions(identity(request)) });
    } catch (error) {
      return sendIpoError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.get("/ipo/subscriptions/:subscriptionId", async (request: any, reply) => {
    const params = z.object({ subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid subscription identifier");
    try {
      return reply.send(await getIpoSubscription(identity(request), params.data.subscriptionId));
    } catch (error) {
      return sendIpoError(reply, error, request.headers["x-correlation-id"]);
    }
  });
}
