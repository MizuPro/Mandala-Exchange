import { FastifyInstance } from "fastify";
import { placeOrder, cancelOrder, amendOrder } from "../services/order-service.js";
import { db } from "../db/db.js";
import { orders, broker_accounts, ipo_investor_subscriptions, cash_balances } from "../db/schema.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";
import { env } from "../config/env.js";

// Error helper
function sendError(reply: any, status: number, code: string, message: string, correlationId?: string) {
  return reply.status(status).send({
    error: {
      code,
      message,
      retryable: status >= 500,
      correlation_id: correlationId || null,
      details: {}
    }
  });
}

const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.-]+$/).transform((value) => value.toUpperCase()),
  side: z.enum(["BUY", "SELL", "buy", "sell"]).transform((value) => value.toLowerCase() as "buy" | "sell"),
  order_type: z.enum(["LIMIT", "MARKET", "limit", "market"]).default("limit").transform((value) => value.toLowerCase() as "limit" | "market"),
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive(),
  client_order_id: z.string().min(1).max(100).optional(),
}).refine((value) => value.order_type === "market" || value.price !== undefined, {
  message: "price is required for limit orders",
});

const amendOrderSchema = z.object({
  price: z.coerce.number().finite().int().positive().optional(),
  quantity: z.coerce.number().finite().int().positive().optional(),
}).refine((value) => value.price !== undefined || value.quantity !== undefined, {
  message: "price or quantity is required",
});

export default async function botIntegrationRoutes(app: FastifyInstance) {
  // Semua endpoint operasional di bawah /bot/... dilindungi dengan JWT token bot
  app.addHook("onRequest", authenticateActiveUser);

  // ==========================================
  // 1. ORDER ENDPOINTS (/bot/orders)
  // ==========================================

  // Place Order
  app.post("/orders", async (request: any, reply) => {
    const user_id = request.user_id;
    const correlationId = request.headers["x-correlation-id"] as string;
    const parsed = placeOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid order payload" });
    }
    const { symbol, side, price, quantity, order_type, client_order_id } = parsed.data;

    // Validasi client_order_id wajib untuk BOT order
    if (request.account_id && (!client_order_id || !/^bot:[^:]+:[0-9a-f-]{36}:\d+$/i.test(client_order_id))) {
      return sendError(reply, 400, "VALIDATION_ERROR", "BOT orders require stable client_order_id", correlationId);
    }

    try {
      const order: any = await placeOrder(user_id, symbol, side, price, quantity, order_type, client_order_id, request.account_id);
      if (order.deferred) {
        return reply.status(202).send(order);
      }
      return reply.status(201).send(order);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Cancel Order
  app.delete("/orders/:id", async (request: any, reply) => {
    const user_id = request.user_id;
    const { id } = request.params as any;

    try {
      const result = await cancelOrder(user_id, id);
      return reply.status(200).send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Amend Order
  app.patch("/orders/:id", async (request: any, reply) => {
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

  // Lookup order by client_order_id
  app.get("/orders/by-client-id/:clientOrderId", async (request: any, reply) => {
    const clientOrderId = String(request.params.clientOrderId || "");
    const correlationId = request.headers["x-correlation-id"] as string;

    const [brokerAcc] = await db.select().from(broker_accounts)
      .where(request.account_id ? eq(broker_accounts.id, request.account_id) : eq(broker_accounts.user_id, request.user_id)).limit(1);
    
    if (!brokerAcc) {
      return sendError(reply, 404, "BOT_NOT_FOUND", "Broker account not found", correlationId);
    }

    const [order] = await db.select().from(orders)
      .where(and(eq(orders.client_order_id, clientOrderId), eq(orders.broker_account_id, brokerAcc.id)))
      .limit(1);

    if (!order) {
      return sendError(reply, 404, "ORDER_NOT_FOUND", "Order not found", correlationId);
    }

    return reply.send(order);
  });

  // ==========================================
  // 2. IPO SUBSCRIPTION ENDPOINTS (/bot/ipo)
  // ==========================================

  // Subscribe IPO
  app.post("/ipo/:id/subscribe", async (request: any, reply) => {
    const correlationId = request.headers["x-correlation-id"] as string;
    const idempotencyKey = request.headers["idempotency-key"] as string;
    
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Missing or invalid Idempotency-Key", correlationId);
    }
    
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ requested_shares: z.number().int().positive() }).safeParse(request.body);
    
    if (!params.success || !body.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Invalid IPO subscription request", correlationId);
    }

    const [existing] = await db.select().from(ipo_investor_subscriptions).where(eq(ipo_investor_subscriptions.idempotency_key, idempotencyKey)).limit(1);
    if (existing) {
      if (existing.ipo_event_id !== params.data.id || existing.requested_shares !== body.data.requested_shares) {
        return sendError(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with different payload", correlationId);
      }
      return reply.send({
        subscription_id: existing.id,
        status: existing.status,
        requested_shares: existing.requested_shares,
        offering_price_idr: String(existing.offering_price_idr),
        reserved_cash_idr: String(existing.reserved_cash_idr)
      });
    }

    const eventResponse = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}`, {
      headers: { "x-service-token": env.beiServiceToken },
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);

    if (!eventResponse?.ok) {
      return sendError(reply, 503, "DEPENDENCY_UNAVAILABLE", "IPO authority unavailable", correlationId);
    }

    const event: any = await eventResponse.json();
    const now = Date.now();
    if (event.status !== "subscription" || now < new Date(event.subscription_start).getTime() || now > new Date(event.subscription_end).getTime()) {
      return sendError(reply, 409, "IPO_NOT_OPEN", "IPO subscription is not open", correlationId);
    }

    if (body.data.requested_shares % Number(event.subscription_lot_size) !== 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "requested_shares must be a subscription lot multiple", correlationId);
    }

    const offeringPrice = Number(event.offering_price_idr);
    if (!Number.isSafeInteger(offeringPrice) || offeringPrice <= 0) {
      return sendError(reply, 503, "DEPENDENCY_UNAVAILABLE", "IPO offering price is not a valid integer rupiah amount", correlationId);
    }

    const reserve = BigInt(offeringPrice) * BigInt(body.data.requested_shares);
    const subscription = await db.transaction(async (tx) => {
      const [account] = await tx.select().from(broker_accounts).where(request.account_id ? eq(broker_accounts.id, request.account_id) : eq(broker_accounts.user_id, request.user_id)).limit(1);
      if (!account || account.status !== "ACTIVE") throw new Error("ACCOUNT_INACTIVE");
      
      const [cash] = await tx.update(cash_balances).set({
        available: sql`${cash_balances.available} - ${reserve.toString()}`,
        reserved: sql`${cash_balances.reserved} + ${reserve.toString()}`,
        updated_at: new Date(),
      }).where(and(eq(cash_balances.broker_account_id, account.id), gte(cash_balances.available, reserve.toString()))).returning();
      
      if (!cash) throw new Error("INSUFFICIENT_BUYING_POWER");
      
      const [created] = await tx.insert(ipo_investor_subscriptions).values({
        ipo_event_id: params.data.id,
        broker_account_id: account.id,
        idempotency_key: idempotencyKey,
        requested_shares: body.data.requested_shares,
        offering_price_idr: String(event.offering_price_idr),
        reserved_cash_idr: reserve.toString(),
        status: "cash_reserved",
        event_version: Number(event.version || 1),
      }).returning();
      
      return created;
    }).catch((cause: any) => cause);

    if (subscription instanceof Error) {
      return sendError(reply, subscription.message === "INSUFFICIENT_BUYING_POWER" ? 409 : 400, subscription.message, correlationId);
    }

    const forwarded = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": env.beiServiceToken },
      body: JSON.stringify({
        brokerCode: env.brokerCode,
        investorId: subscription.broker_account_id,
        requestedShares: subscription.requested_shares,
        idempotencyKey
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (forwarded?.ok) {
      const result: any = await forwarded.json();
      await db.update(ipo_investor_subscriptions)
        .set({ status: "submitted_to_bei", bei_subscription_id: result.id || subscription.bei_subscription_id, updated_at: new Date() })
        .where(eq(ipo_investor_subscriptions.id, subscription.id));
    }

    return reply.send({
      subscription_id: subscription.id,
      status: forwarded?.ok ? "submitted_to_bei" : "cash_reserved",
      requested_shares: subscription.requested_shares,
      offering_price_idr: String(subscription.offering_price_idr),
      reserved_cash_idr: String(subscription.reserved_cash_idr)
    });
  });

  // Cancel IPO Subscription
  app.post("/ipo/:id/subscriptions/:subscriptionId/cancel", async (request: any, reply) => {
    const correlationId = request.headers["x-correlation-id"] as string;
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Invalid subscription identifier", correlationId);
    }

    const [account] = await db.select().from(broker_accounts).where(request.account_id ? eq(broker_accounts.id, request.account_id) : eq(broker_accounts.user_id, request.user_id)).limit(1);
    const [subscription] = await db.select().from(ipo_investor_subscriptions).where(and(eq(ipo_investor_subscriptions.id, params.data.subscriptionId), eq(ipo_investor_subscriptions.broker_account_id, account?.id || ""))).limit(1);
    
    if (!subscription) {
      return sendError(reply, 404, "NOT_FOUND", "Subscription not found", correlationId);
    }
    if (!["cash_reserved", "submitted_to_bei"].includes(subscription.status)) {
      return sendError(reply, 409, "IPO_NOT_OPEN", "Subscription can no longer be cancelled", correlationId);
    }

    if (subscription.bei_subscription_id) {
      const cancelResponse = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}/subscriptions/${subscription.bei_subscription_id}/cancel`, {
        method: "POST",
        headers: { "x-service-token": env.beiServiceToken },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!cancelResponse?.ok) {
        return sendError(reply, 503, "DEPENDENCY_UNAVAILABLE", "BEI cancellation could not be confirmed", correlationId);
      }
    }

    await db.transaction(async (tx) => {
      await tx.update(ipo_investor_subscriptions).set({ status: "cancelled", updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
      await tx.update(cash_balances).set({
        available: sql`${cash_balances.available} + ${subscription.reserved_cash_idr}`,
        reserved: sql`${cash_balances.reserved} - ${subscription.reserved_cash_idr}`,
        updated_at: new Date()
      }).where(eq(cash_balances.broker_account_id, subscription.broker_account_id));
    });

    return reply.send({ subscription_id: subscription.id, status: "cancelled" });
  });
}
