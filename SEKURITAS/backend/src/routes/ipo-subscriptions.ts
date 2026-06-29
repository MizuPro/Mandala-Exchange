import type { FastifyInstance } from "fastify";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";
import { db } from "../db/db.js";
import { broker_accounts, cash_balances, ipo_investor_subscriptions } from "../db/schema.js";
import { env } from "../config/env.js";

function error(reply: any, status: number, code: string, message: string, correlationId?: string) {
  return reply.status(status).send({ error: { code, message, retryable: status >= 500, correlation_id: correlationId || null, details: {} } });
}

export default async function ipoSubscriptionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticateActiveUser);

  app.post("/:id/subscriptions", async (request: any, reply) => {
    const correlationId = request.headers["x-correlation-id"] as string;
    const idempotencyKey = request.headers["idempotency-key"] as string;
    if (!idempotencyKey || idempotencyKey.length > 128) return error(reply, 400, "VALIDATION_ERROR", "Missing or invalid Idempotency-Key", correlationId);
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ requested_shares: z.number().int().positive() }).safeParse(request.body);
    if (!params.success || !body.success) return error(reply, 400, "VALIDATION_ERROR", "Invalid IPO subscription request", correlationId);
    const [existing] = await db.select().from(ipo_investor_subscriptions).where(eq(ipo_investor_subscriptions.idempotency_key, idempotencyKey)).limit(1);
    if (existing) {
      if (existing.ipo_event_id !== params.data.id || existing.requested_shares !== body.data.requested_shares) return error(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with different payload", correlationId);
      return reply.send({ subscription_id: existing.id, status: existing.status, requested_shares: existing.requested_shares, offering_price_idr: String(existing.offering_price_idr), reserved_cash_idr: String(existing.reserved_cash_idr) });
    }
    const eventResponse = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}`, { headers: { "x-service-token": env.beiServiceToken }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!eventResponse?.ok) return error(reply, 503, "DEPENDENCY_UNAVAILABLE", "IPO authority unavailable", correlationId);
    const event: any = await eventResponse.json();
    const now = Date.now();
    if (event.status !== "subscription" || now < new Date(event.subscription_start).getTime() || now > new Date(event.subscription_end).getTime()) return error(reply, 409, "IPO_NOT_OPEN", "IPO subscription is not open", correlationId);
    if (body.data.requested_shares % Number(event.subscription_lot_size) !== 0) return error(reply, 400, "VALIDATION_ERROR", "requested_shares must be a subscription lot multiple", correlationId);
    const offeringPrice = Number(event.offering_price_idr);
    if (!Number.isSafeInteger(offeringPrice) || offeringPrice <= 0) return error(reply, 503, "DEPENDENCY_UNAVAILABLE", "IPO offering price is not a valid integer rupiah amount", correlationId);
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
        ipo_event_id: params.data.id, broker_account_id: account.id, idempotency_key: idempotencyKey,
        requested_shares: body.data.requested_shares, offering_price_idr: String(event.offering_price_idr),
        reserved_cash_idr: reserve.toString(), status: "cash_reserved", event_version: Number(event.version || 1),
      }).returning();
      return created;
    }).catch((cause: any) => cause);
    if (subscription instanceof Error) return error(reply, subscription.message === "INSUFFICIENT_BUYING_POWER" ? 409 : 400, subscription.message, subscription.message, correlationId);
    const forwarded = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}/subscriptions`, {
      method: "POST", headers: { "content-type": "application/json", "x-service-token": env.beiServiceToken },
      body: JSON.stringify({ brokerCode: env.brokerCode, investorId: subscription.broker_account_id, requestedShares: subscription.requested_shares, idempotencyKey }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (forwarded?.ok) {
      const result: any = await forwarded.json();
      await db.update(ipo_investor_subscriptions).set({ status: "submitted_to_bei", bei_subscription_id: result.id || subscription.bei_subscription_id, updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
    }
    return reply.send({ subscription_id: subscription.id, status: forwarded?.ok ? "submitted_to_bei" : "cash_reserved", requested_shares: subscription.requested_shares, offering_price_idr: String(subscription.offering_price_idr), reserved_cash_idr: String(subscription.reserved_cash_idr) });
  });

  app.post("/:id/subscriptions/:subscriptionId/cancel", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return error(reply, 400, "VALIDATION_ERROR", "Invalid subscription identifier");
    const [account] = await db.select().from(broker_accounts).where(request.account_id ? eq(broker_accounts.id, request.account_id) : eq(broker_accounts.user_id, request.user_id)).limit(1);
    const [subscription] = await db.select().from(ipo_investor_subscriptions).where(and(eq(ipo_investor_subscriptions.id, params.data.subscriptionId), eq(ipo_investor_subscriptions.broker_account_id, account?.id || ""))).limit(1);
    if (!subscription) return error(reply, 404, "NOT_FOUND", "Subscription not found");
    if (!["cash_reserved", "submitted_to_bei"].includes(subscription.status)) return error(reply, 409, "IPO_NOT_OPEN", "Subscription can no longer be cancelled");
    if (subscription.bei_subscription_id) {
      const cancelResponse = await fetch(`${env.beiApiUrl}/v1/ipo-events/${params.data.id}/subscriptions/${subscription.bei_subscription_id}/cancel`, {
        method: "POST", headers: { "x-service-token": env.beiServiceToken }, signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!cancelResponse?.ok) return error(reply, 503, "DEPENDENCY_UNAVAILABLE", "BEI cancellation could not be confirmed");
    }
    await db.transaction(async (tx) => {
      await tx.update(ipo_investor_subscriptions).set({ status: "cancelled", updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
      await tx.update(cash_balances).set({ available: sql`${cash_balances.available} + ${subscription.reserved_cash_idr}`, reserved: sql`${cash_balances.reserved} - ${subscription.reserved_cash_idr}`, updated_at: new Date() }).where(eq(cash_balances.broker_account_id, subscription.broker_account_id));
    });
    return { subscription_id: subscription.id, status: "cancelled" };
  });
}
