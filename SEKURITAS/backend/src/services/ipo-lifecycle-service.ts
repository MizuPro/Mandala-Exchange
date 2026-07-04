import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import {
  cash_balances,
  ipo_investor_subscriptions,
  ipo_lifecycle_inbox,
  securities_positions
} from "../db/schema.js";
import { appendBotAccountEventTx } from "./bot-event-service.js";

function eventKey(payload: any) {
  return String(payload.event_id || payload.idempotency_key || "");
}

function eventPayload(subscription: typeof ipo_investor_subscriptions.$inferSelect, status: string, listed = false) {
  return {
    ipo_event_id: subscription.ipo_event_id,
    subscription_id: subscription.id,
    symbol: subscription.symbol,
    status,
    requested_shares: subscription.requested_shares,
    allocated_shares: subscription.allocated_shares,
    reserved_cash_idr: String(subscription.reserved_cash_idr),
    actual_debit_idr: String(subscription.actual_debit_idr),
    official_fee_idr: String(subscription.official_fee_idr),
    listed
  };
}

async function updateInbox(id: string, status: string, error?: unknown) {
  await db
    .update(ipo_lifecycle_inbox)
    .set({
      status,
      processed_at: status === "processed" ? new Date() : null,
      last_error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 2000) : null,
      updated_at: new Date()
    })
    .where(eq(ipo_lifecycle_inbox.id, id));
}

async function processAllocation(eventId: string, payload: any) {
  const securities = (payload.entitlements || []).filter((item: any) => item.asset_type === "security");
  for (const entitlement of securities) {
    const accountId = String(entitlement.broker_account_id || entitlement.investor_id || "");
    if (!accountId) continue;
    const allocated = Math.max(0, Math.trunc(Number(entitlement.quantity || 0)));
    await db.transaction(async (tx) => {
      const [subscription] = await tx
        .select()
        .from(ipo_investor_subscriptions)
        .where(and(eq(ipo_investor_subscriptions.ipo_event_id, eventId), eq(ipo_investor_subscriptions.broker_account_id, accountId)))
        .for("update")
        .limit(1);
      if (!subscription) return;
      if (["allocated", "settled"].includes(subscription.status)) return;
      if (!["cash_reserved", "submitted_to_bei"].includes(subscription.status)) {
        throw new Error(`Invalid IPO allocation transition from ${subscription.status}`);
      }
      if (allocated > subscription.requested_shares) throw new Error("Allocated shares exceed requested shares");
      const price = BigInt(String(subscription.offering_price_idr).split(".")[0]);
      const actualDebit = BigInt(allocated) * price;
      const reserve = BigInt(String(subscription.reserved_cash_idr).split(".")[0]);
      if (actualDebit > reserve) throw new Error("Actual IPO debit exceeds reserved cash");

      const [cash] = await tx
        .update(cash_balances)
        .set({
          reserved: sql`${cash_balances.reserved} - ${reserve.toString()}`,
          available: sql`${cash_balances.available} + ${(reserve - actualDebit).toString()}`,
          updated_at: new Date()
        })
        .where(and(eq(cash_balances.broker_account_id, accountId), gte(cash_balances.reserved, reserve.toString())))
        .returning();
      if (!cash) throw new Error("IPO reserved cash invariant failed during allocation");

      const symbol = String(payload.symbol || subscription.symbol || "").toUpperCase();
      if (allocated > 0) {
        if (!symbol) throw new Error("IPO allocation symbol is required");
        await tx
          .insert(securities_positions)
          .values({
            broker_account_id: accountId,
            symbol,
            available: 0,
            reserved: 0,
            pending: allocated,
            average_price: String(subscription.offering_price_idr)
          })
          .onConflictDoUpdate({
            target: [securities_positions.broker_account_id, securities_positions.symbol],
            set: {
              pending: sql`${securities_positions.pending} + ${allocated}`,
              updated_at: new Date()
            }
          });
      }

      const nextVersion = subscription.event_version + 1;
      const [updated] = await tx
        .update(ipo_investor_subscriptions)
        .set({
          symbol: symbol || subscription.symbol,
          allocated_shares: allocated,
          actual_debit_idr: actualDebit.toString(),
          status: allocated === 0 ? "refunded" : "allocated",
          event_version: nextVersion,
          updated_at: new Date()
        })
        .where(eq(ipo_investor_subscriptions.id, subscription.id))
        .returning();
      if (updated) {
        await appendBotAccountEventTx(tx, {
          brokerAccountId: accountId,
          eventType: "ipo_subscription_updated",
          entityId: subscription.id,
          entityVersion: nextVersion,
          payload: eventPayload(updated, updated.status)
        });
      }
    });
  }
}

async function processCancellation(eventId: string) {
  const subscriptions = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(eq(ipo_investor_subscriptions.ipo_event_id, eventId));
  for (const subscription of subscriptions) {
    if (!["cash_reserved", "submitted_to_bei"].includes(subscription.status)) continue;
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ipo_investor_subscriptions)
        .set({ status: "refunded", event_version: subscription.event_version + 1, next_retry_at: null, updated_at: new Date() })
        .where(and(eq(ipo_investor_subscriptions.id, subscription.id), inArray(ipo_investor_subscriptions.status, ["cash_reserved", "submitted_to_bei"])))
        .returning();
      if (!updated) return;
      const [cash] = await tx
        .update(cash_balances)
        .set({
          reserved: sql`${cash_balances.reserved} - ${subscription.reserved_cash_idr}`,
          available: sql`${cash_balances.available} + ${subscription.reserved_cash_idr}`,
          updated_at: new Date()
        })
        .where(and(eq(cash_balances.broker_account_id, subscription.broker_account_id), gte(cash_balances.reserved, String(subscription.reserved_cash_idr))))
        .returning();
      if (!cash) throw new Error("IPO reserved cash invariant failed during cancellation");
      await appendBotAccountEventTx(tx, {
        brokerAccountId: subscription.broker_account_id,
        eventType: "ipo_subscription_updated",
        entityId: subscription.id,
        entityVersion: updated.event_version,
        payload: eventPayload(updated, "refunded")
      });
    });
  }
}

async function processListing(eventId: string, payload: any) {
  const subscriptions = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(eq(ipo_investor_subscriptions.ipo_event_id, eventId));
  if (subscriptions.some((item) => ["cash_reserved", "submitted_to_bei"].includes(item.status))) {
    return { deferred: true, reason: "IPO allocation has not been processed" };
  }
  for (const subscription of subscriptions) {
    if (subscription.status !== "allocated") continue;
    await db.transaction(async (tx) => {
      if (subscription.allocated_shares > 0) {
        const symbol = String(payload.symbol || subscription.symbol || "").toUpperCase();
        const [position] = await tx
          .update(securities_positions)
          .set({
            pending: sql`${securities_positions.pending} - ${subscription.allocated_shares}`,
            available: sql`${securities_positions.available} + ${subscription.allocated_shares}`,
            updated_at: new Date()
          })
          .where(
            and(
              eq(securities_positions.broker_account_id, subscription.broker_account_id),
              eq(securities_positions.symbol, symbol),
              gte(securities_positions.pending, subscription.allocated_shares)
            )
          )
          .returning();
        if (!position) throw new Error("IPO pending position invariant failed during listing");
      }
      const [updated] = await tx
        .update(ipo_investor_subscriptions)
        .set({ status: "settled", event_version: subscription.event_version + 1, updated_at: new Date() })
        .where(and(eq(ipo_investor_subscriptions.id, subscription.id), eq(ipo_investor_subscriptions.status, "allocated")))
        .returning();
      if (updated) {
        await appendBotAccountEventTx(tx, {
          brokerAccountId: subscription.broker_account_id,
          eventType: "ipo_subscription_updated",
          entityId: subscription.id,
          entityVersion: updated.event_version,
          payload: eventPayload(updated, "settled", true)
        });
      }
    });
  }
  return { deferred: false };
}

async function processReversal(eventId: string, payload: any) {
  const subscriptions = await db
    .select()
    .from(ipo_investor_subscriptions)
    .where(eq(ipo_investor_subscriptions.ipo_event_id, eventId));
  for (const subscription of subscriptions) {
    if (!["allocated", "settled"].includes(subscription.status)) continue;
    await db.transaction(async (tx) => {
      if (subscription.allocated_shares > 0) {
        const symbol = String(payload.symbol || subscription.symbol || "").toUpperCase();
        const field = subscription.status === "settled" ? securities_positions.available : securities_positions.pending;
        const [position] = await tx
          .update(securities_positions)
          .set({
            [field.name]: sql`${field} - ${subscription.allocated_shares}`,
            updated_at: new Date()
          } as any)
          .where(
            and(
              eq(securities_positions.broker_account_id, subscription.broker_account_id),
              eq(securities_positions.symbol, symbol),
              gte(field, subscription.allocated_shares)
            )
          )
          .returning();
        if (!position) throw new Error("IPO position invariant failed during reversal");
      }
      await tx
        .update(cash_balances)
        .set({
          available: sql`${cash_balances.available} + ${subscription.actual_debit_idr} + ${subscription.official_fee_idr}`,
          updated_at: new Date()
        })
        .where(eq(cash_balances.broker_account_id, subscription.broker_account_id));
      const [updated] = await tx
        .update(ipo_investor_subscriptions)
        .set({ status: "reversed", event_version: subscription.event_version + 1, updated_at: new Date() })
        .where(and(eq(ipo_investor_subscriptions.id, subscription.id), inArray(ipo_investor_subscriptions.status, ["allocated", "settled"])))
        .returning();
      if (updated) {
        await appendBotAccountEventTx(tx, {
          brokerAccountId: subscription.broker_account_id,
          eventType: "ipo_subscription_updated",
          entityId: subscription.id,
          entityVersion: updated.event_version,
          payload: eventPayload(updated, "reversed")
        });
      }
    });
  }
}

export async function processIpoLifecycle(payload: any) {
  const ipoEventId = String(payload.corporate_action_id || payload.ipo_event_id || "");
  const action = String(payload.action_type || "");
  const key = eventKey(payload);
  if (!ipoEventId || !key) throw new Error("IPO lifecycle event ID and idempotency key are required");

  const [existing] = await db
    .select()
    .from(ipo_lifecycle_inbox)
    .where(eq(ipo_lifecycle_inbox.event_key, key))
    .limit(1);
  if (existing?.status === "processed") return { status: action, idempotent: true };

  const inbox = existing || (await db
    .insert(ipo_lifecycle_inbox)
    .values({ event_key: key, ipo_event_id: ipoEventId, event_type: action, payload })
    .onConflictDoNothing()
    .returning())[0];
  if (!inbox) return processIpoLifecycle(payload);

  const [claimed] = await db
    .update(ipo_lifecycle_inbox)
    .set({ status: "processing", attempts: inbox.attempts + 1, updated_at: new Date() })
    .where(
      and(
        eq(ipo_lifecycle_inbox.id, inbox.id),
        inArray(ipo_lifecycle_inbox.status, ["received", "failed", "deferred"])
      )
    )
    .returning();
  if (!claimed) {
    const [current] = await db.select().from(ipo_lifecycle_inbox).where(eq(ipo_lifecycle_inbox.id, inbox.id)).limit(1);
    if (current?.status === "processed") return { status: action, idempotent: true };
    return { status: "deferred", message: "IPO lifecycle event is already processing" };
  }

  try {
    if (action === "ipo_allocation") await processAllocation(ipoEventId, payload);
    else if (action === "ipo_cancellation") await processCancellation(ipoEventId);
    else if (action === "ipo_listing") {
      const result = await processListing(ipoEventId, payload);
      if (result.deferred) {
        await updateInbox(inbox.id, "deferred", result.reason);
        return { status: "deferred", message: result.reason };
      }
    } else if (action === "ipo_reversal") await processReversal(ipoEventId, payload);
    else throw new Error(`Unsupported IPO lifecycle action ${action}`);
    await updateInbox(inbox.id, "processed");
    return { status: action };
  } catch (error) {
    await updateInbox(inbox.id, "failed", error);
    throw error;
  }
}
