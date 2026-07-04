import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import {
  broker_accounts,
  cash_balances,
  ipo_investor_subscriptions
} from "../db/schema.js";
import { env } from "../config/env.js";
import { appendBotAccountEventTx } from "./bot-event-service.js";

const ACTIVE_STATUSES = ["cash_reserved", "submitted_to_bei", "allocated", "settled"];
const CANCELLABLE_STATUSES = ["cash_reserved", "submitted_to_bei"];

export class IpoSubscriptionError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public retryable = statusCode >= 500,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

type Identity = { accountId?: string; userId?: string };

async function resolveAccount(identity: Identity, tx: any = db) {
  const [account] = await tx
    .select()
    .from(broker_accounts)
    .where(
      identity.accountId
        ? eq(broker_accounts.id, identity.accountId)
        : eq(broker_accounts.user_id, identity.userId || "")
    )
    .limit(1);
  if (!account) throw new IpoSubscriptionError(404, "ACCOUNT_NOT_FOUND", "Broker account not found");
  if (account.status !== "ACTIVE") throw new IpoSubscriptionError(409, "ACCOUNT_INACTIVE", "Broker account is not active");
  return account;
}

function responseOf(subscription: typeof ipo_investor_subscriptions.$inferSelect) {
  return {
    subscription_id: subscription.id,
    ipo_event_id: subscription.ipo_event_id,
    symbol: subscription.symbol,
    status: subscription.status,
    requested_shares: subscription.requested_shares,
    allocated_shares: subscription.allocated_shares,
    offering_price_idr: String(subscription.offering_price_idr),
    reserved_cash_idr: String(subscription.reserved_cash_idr),
    actual_debit_idr: String(subscription.actual_debit_idr),
    official_fee_idr: String(subscription.official_fee_idr),
    bei_subscription_id: subscription.bei_subscription_id,
    event_version: subscription.event_version,
    created_at: subscription.created_at,
    updated_at: subscription.updated_at
  };
}

async function fetchIpoEvent(ipoEventId: string) {
  const response = await fetch(`${env.beiApiUrl}/v1/ipo-events/${ipoEventId}`, {
    headers: { "x-service-token": env.beiServiceToken },
    signal: AbortSignal.timeout(5000)
  }).catch(() => null);
  if (!response?.ok) throw new IpoSubscriptionError(503, "DEPENDENCY_UNAVAILABLE", "IPO authority unavailable", true);
  return response.json() as Promise<any>;
}

function nextRetry(attempts: number) {
  const seconds = Math.min(300, Math.max(2, 2 ** Math.min(attempts, 8)));
  return new Date(Date.now() + seconds * 1000);
}

export async function forwardIpoSubscription(subscriptionId: string) {
  const [subscription] = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(eq(ipo_investor_subscriptions.id, subscriptionId))
    .limit(1);
  if (!subscription) throw new IpoSubscriptionError(404, "NOT_FOUND", "Subscription not found");
  if (subscription.status !== "cash_reserved") return responseOf(subscription);

  const attempt = subscription.forward_attempts + 1;
  const forwarded = await fetch(`${env.beiApiUrl}/v1/ipo-events/${subscription.ipo_event_id}/subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-token": env.beiServiceToken,
      "idempotency-key": subscription.idempotency_key
    },
    body: JSON.stringify({
      brokerCode: env.brokerCode,
      investorId: subscription.broker_account_id,
      requestedShares: subscription.requested_shares,
      idempotencyKey: subscription.idempotency_key
    }),
    signal: AbortSignal.timeout(5000)
  }).catch(() => null);

  if (!forwarded?.ok) {
    const errorBody = forwarded ? await forwarded.text().catch(() => "") : "BEI unavailable";
    await db
      .update(ipo_investor_subscriptions)
      .set({
        forward_attempts: attempt,
        next_retry_at: nextRetry(attempt),
        last_forward_error: errorBody.slice(0, 2000),
        updated_at: new Date()
      })
      .where(eq(ipo_investor_subscriptions.id, subscription.id));
    return { ...responseOf(subscription), status: "cash_reserved", retry_scheduled: true };
  }

  const result: any = await forwarded.json();
  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ipo_investor_subscriptions)
      .set({
        status: "submitted_to_bei",
        bei_subscription_id: result.id || subscription.bei_subscription_id,
        event_version: subscription.event_version + 1,
        forward_attempts: attempt,
        next_retry_at: null,
        last_forward_error: null,
        submitted_at: new Date(),
        updated_at: new Date()
      })
      .where(and(eq(ipo_investor_subscriptions.id, subscription.id), eq(ipo_investor_subscriptions.status, "cash_reserved")))
      .returning();
    if (row) {
      await appendBotAccountEventTx(tx, {
        brokerAccountId: row.broker_account_id,
        eventType: "ipo_subscription_updated",
        entityId: row.id,
        entityVersion: row.event_version,
        payload: responseOf(row)
      });
    }
    return [row];
  });
  return responseOf(updated || subscription);
}

export async function subscribeIpo(input: {
  identity: Identity;
  ipoEventId: string;
  requestedShares: number;
  idempotencyKey: string;
}) {
  const [existing] = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(eq(ipo_investor_subscriptions.idempotency_key, input.idempotencyKey))
    .limit(1);
  if (existing) {
    const account = await resolveAccount(input.identity);
    if (
      existing.broker_account_id !== account.id
      || existing.ipo_event_id !== input.ipoEventId
      || existing.requested_shares !== input.requestedShares
    ) {
      throw new IpoSubscriptionError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with different payload");
    }
    return responseOf(existing);
  }

  const event = await fetchIpoEvent(input.ipoEventId);
  const now = Date.now();
  if (
    event.status !== "subscription"
    || now < new Date(event.subscription_start).getTime()
    || now > new Date(event.subscription_end).getTime()
  ) {
    throw new IpoSubscriptionError(409, "IPO_NOT_OPEN", "IPO subscription is not open");
  }
  const lotSize = Number(event.subscription_lot_size);
  if (!Number.isSafeInteger(lotSize) || lotSize <= 0 || input.requestedShares % lotSize !== 0) {
    throw new IpoSubscriptionError(400, "VALIDATION_ERROR", "requested_shares must be a subscription lot multiple", false, { subscription_lot_size: lotSize });
  }
  const offeringPrice = Number(event.offering_price_idr);
  if (!Number.isSafeInteger(offeringPrice) || offeringPrice <= 0) {
    throw new IpoSubscriptionError(503, "DEPENDENCY_UNAVAILABLE", "IPO offering price is invalid", true);
  }
  const reserve = BigInt(offeringPrice) * BigInt(input.requestedShares);

  const subscription = await db.transaction(async (tx) => {
    const account = await resolveAccount(input.identity, tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.ipoEventId}:${account.id}`}))`);
    const [active] = await tx
      .select()
      .from(ipo_investor_subscriptions)
      .where(
        and(
          eq(ipo_investor_subscriptions.ipo_event_id, input.ipoEventId),
          eq(ipo_investor_subscriptions.broker_account_id, account.id),
          inArray(ipo_investor_subscriptions.status, ACTIVE_STATUSES)
        )
      )
      .limit(1);
    if (active) throw new IpoSubscriptionError(409, "IPO_SUBSCRIPTION_EXISTS", "Account already has an active subscription", false, { subscription_id: active.id });

    const [cash] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} - ${reserve.toString()}`,
        reserved: sql`${cash_balances.reserved} + ${reserve.toString()}`,
        updated_at: new Date()
      })
      .where(and(eq(cash_balances.broker_account_id, account.id), gte(cash_balances.available, reserve.toString())))
      .returning();
    if (!cash) throw new IpoSubscriptionError(409, "INSUFFICIENT_BUYING_POWER", "Insufficient available cash");

    const [created] = await tx
      .insert(ipo_investor_subscriptions)
      .values({
        ipo_event_id: input.ipoEventId,
        broker_account_id: account.id,
        idempotency_key: input.idempotencyKey,
        requested_shares: input.requestedShares,
        offering_price_idr: String(offeringPrice),
        reserved_cash_idr: reserve.toString(),
        status: "cash_reserved",
        event_version: Number(event.version || 1),
        symbol: String(event.symbol || "").toUpperCase() || null,
        next_retry_at: new Date()
      })
      .returning();
    if (!created) throw new Error("IPO subscription was not created");
    await appendBotAccountEventTx(tx, {
      brokerAccountId: account.id,
      eventType: "ipo_subscription_updated",
      entityId: created.id,
      entityVersion: created.event_version,
      payload: responseOf(created)
    });
    return created;
  });

  return forwardIpoSubscription(subscription.id);
}

export async function cancelIpoSubscription(input: {
  identity: Identity;
  ipoEventId: string;
  subscriptionId: string;
}) {
  const account = await resolveAccount(input.identity);
  const [subscription] = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(
      and(
        eq(ipo_investor_subscriptions.id, input.subscriptionId),
        eq(ipo_investor_subscriptions.ipo_event_id, input.ipoEventId),
        eq(ipo_investor_subscriptions.broker_account_id, account.id)
      )
    )
    .limit(1);
  if (!subscription) throw new IpoSubscriptionError(404, "NOT_FOUND", "Subscription not found");
  if (subscription.status === "cancelled") return responseOf(subscription);
  if (!CANCELLABLE_STATUSES.includes(subscription.status)) {
    throw new IpoSubscriptionError(409, "IPO_NOT_OPEN", "Subscription can no longer be cancelled");
  }

  if (subscription.bei_subscription_id) {
    const response = await fetch(
      `${env.beiApiUrl}/v1/ipo-events/${input.ipoEventId}/subscriptions/${subscription.bei_subscription_id}/cancel`,
      {
        method: "POST",
        headers: { "x-service-token": env.beiServiceToken },
        signal: AbortSignal.timeout(5000)
      }
    ).catch(() => null);
    if (!response?.ok) throw new IpoSubscriptionError(503, "DEPENDENCY_UNAVAILABLE", "BEI cancellation could not be confirmed", true);
  }

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ipo_investor_subscriptions)
      .set({ status: "cancelled", event_version: subscription.event_version + 1, next_retry_at: null, updated_at: new Date() })
      .where(and(eq(ipo_investor_subscriptions.id, subscription.id), inArray(ipo_investor_subscriptions.status, CANCELLABLE_STATUSES)))
      .returning();
    if (!row) return [subscription];
    const [cash] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} + ${subscription.reserved_cash_idr}`,
        reserved: sql`${cash_balances.reserved} - ${subscription.reserved_cash_idr}`,
        updated_at: new Date()
      })
      .where(
        and(
          eq(cash_balances.broker_account_id, subscription.broker_account_id),
          gte(cash_balances.reserved, String(subscription.reserved_cash_idr))
        )
      )
      .returning();
    if (!cash) throw new Error("IPO reserved cash invariant failed during cancellation");
    await appendBotAccountEventTx(tx, {
      brokerAccountId: row.broker_account_id,
      eventType: "ipo_subscription_updated",
      entityId: row.id,
      entityVersion: row.event_version,
      payload: responseOf(row)
    });
    return [row];
  });
  return responseOf(updated);
}

export async function listIpoSubscriptions(identity: Identity, ipoEventId?: string) {
  const account = await resolveAccount(identity);
  const where = ipoEventId
    ? and(eq(ipo_investor_subscriptions.broker_account_id, account.id), eq(ipo_investor_subscriptions.ipo_event_id, ipoEventId))
    : eq(ipo_investor_subscriptions.broker_account_id, account.id);
  const rows = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(where)
    .orderBy(asc(ipo_investor_subscriptions.created_at));
  return rows.map(responseOf);
}

export async function getIpoSubscription(identity: Identity, subscriptionId: string) {
  const account = await resolveAccount(identity);
  const [row] = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(and(eq(ipo_investor_subscriptions.id, subscriptionId), eq(ipo_investor_subscriptions.broker_account_id, account.id)))
    .limit(1);
  if (!row) throw new IpoSubscriptionError(404, "NOT_FOUND", "Subscription not found");
  return responseOf(row);
}

export async function retryDueIpoSubscriptions(limit = 50) {
  const rows = await db
    .select({ id: ipo_investor_subscriptions.id })
    .from(ipo_investor_subscriptions)
    .where(
      and(
        eq(ipo_investor_subscriptions.status, "cash_reserved"),
        or(isNull(ipo_investor_subscriptions.next_retry_at), lte(ipo_investor_subscriptions.next_retry_at, new Date()))
      )
    )
    .orderBy(asc(ipo_investor_subscriptions.created_at))
    .limit(limit);
  for (const row of rows) await forwardIpoSubscription(row.id);
  return rows.length;
}
