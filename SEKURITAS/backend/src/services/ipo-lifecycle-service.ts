import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { cash_balances, ipo_investor_subscriptions, securities_positions } from "../db/schema.js";
import { appendBotAccountEventTx } from "./bot-event-service.js";

export async function processIpoLifecycle(payload: any) {
  const eventId = String(payload.corporate_action_id || payload.ipo_event_id || "");
  const action = String(payload.action_type || "");
  if (!eventId) throw new Error("ipo_event_id is required");
  if (action === "ipo_allocation") {
    const securities = (payload.entitlements || []).filter((item: any) => item.asset_type === "security");
    for (const entitlement of securities) {
      const accountId = String(entitlement.broker_account_id || entitlement.investor_id);
      const allocated = Math.max(0, Math.trunc(Number(entitlement.quantity || 0)));
      await db.transaction(async (tx) => {
        const [subscription] = await tx.select().from(ipo_investor_subscriptions)
          .where(and(eq(ipo_investor_subscriptions.ipo_event_id, eventId), eq(ipo_investor_subscriptions.broker_account_id, accountId))).for("update").limit(1);
        if (!subscription || ["allocated", "settled", "reversed", "cancelled", "refunded"].includes(subscription.status)) return;
        if (allocated > subscription.requested_shares) throw new Error("allocated shares exceed requested shares");
        const actualDebit = BigInt(allocated) * BigInt(String(subscription.offering_price_idr).split(".")[0]);
        const reserve = BigInt(String(subscription.reserved_cash_idr).split(".")[0]);
        if (actualDebit > reserve) throw new Error("actual IPO debit exceeds reserve");
        await tx.update(cash_balances).set({
          reserved: sql`${cash_balances.reserved} - ${reserve.toString()}`,
          available: sql`${cash_balances.available} + ${(reserve - actualDebit).toString()}`,
          updated_at: new Date(),
        }).where(eq(cash_balances.broker_account_id, accountId));
        if (allocated > 0) {
          await tx.insert(securities_positions).values({
            broker_account_id: accountId, symbol: String(payload.symbol).toUpperCase(),
            available: 0, reserved: 0, pending: allocated, average_price: String(subscription.offering_price_idr),
          }).onConflictDoUpdate({
            target: [securities_positions.broker_account_id, securities_positions.symbol],
            set: { pending: sql`${securities_positions.pending} + ${allocated}`, updated_at: new Date() },
          });
        }
        await tx.update(ipo_investor_subscriptions).set({
          allocated_shares: allocated, actual_debit_idr: actualDebit.toString(), status: "allocated", updated_at: new Date(),
        }).where(eq(ipo_investor_subscriptions.id, subscription.id));
        await appendBotAccountEventTx(tx, { brokerAccountId: accountId, eventType: "ipo_subscription_updated", entityId: subscription.id, entityVersion: 2, payload: { status: "allocated", allocated_shares: allocated, actual_debit_idr: actualDebit.toString() } });
      });
    }
    return { status: "allocated" };
  }
  const subscriptions = await db.select().from(ipo_investor_subscriptions).where(eq(ipo_investor_subscriptions.ipo_event_id, eventId));
  for (const subscription of subscriptions) {
    if (action === "ipo_cancellation" && ["cash_reserved", "submitted_to_bei"].includes(subscription.status)) {
      await db.transaction(async (tx) => {
        await tx.update(cash_balances).set({
          reserved: sql`${cash_balances.reserved} - ${subscription.reserved_cash_idr}`,
          available: sql`${cash_balances.available} + ${subscription.reserved_cash_idr}`,
          updated_at: new Date(),
        }).where(eq(cash_balances.broker_account_id, subscription.broker_account_id));
        await tx.update(ipo_investor_subscriptions).set({ status: "refunded", updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
        await appendBotAccountEventTx(tx, { brokerAccountId: subscription.broker_account_id, eventType: "ipo_subscription_updated", entityId: subscription.id, entityVersion: 2, payload: { status: "refunded" } });
      });
    } else if (action === "ipo_listing" && subscription.status === "allocated") {
      await db.transaction(async (tx) => {
        await tx.update(securities_positions).set({
          pending: sql`${securities_positions.pending} - ${subscription.allocated_shares}`,
          available: sql`${securities_positions.available} + ${subscription.allocated_shares}`,
          updated_at: new Date(),
        }).where(and(eq(securities_positions.broker_account_id, subscription.broker_account_id), eq(securities_positions.symbol, String(payload.symbol).toUpperCase())));
        await tx.update(ipo_investor_subscriptions).set({ status: "settled", updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
        await appendBotAccountEventTx(tx, { brokerAccountId: subscription.broker_account_id, eventType: "ipo_subscription_updated", entityId: subscription.id, entityVersion: 3, payload: { status: "settled", listed: true } });
      });
    } else if (action === "ipo_reversal" && ["allocated", "settled"].includes(subscription.status)) {
      await db.transaction(async (tx) => {
        const field = subscription.status === "settled" ? securities_positions.available : securities_positions.pending;
        await tx.update(securities_positions).set({ [field.name]: sql`${field} - ${subscription.allocated_shares}`, updated_at: new Date() } as any)
          .where(and(eq(securities_positions.broker_account_id, subscription.broker_account_id), eq(securities_positions.symbol, String(payload.symbol).toUpperCase())));
        await tx.update(cash_balances).set({ available: sql`${cash_balances.available} + ${subscription.actual_debit_idr}`, updated_at: new Date() }).where(eq(cash_balances.broker_account_id, subscription.broker_account_id));
        await tx.update(ipo_investor_subscriptions).set({ status: "reversed", updated_at: new Date() }).where(eq(ipo_investor_subscriptions.id, subscription.id));
        await appendBotAccountEventTx(tx, { brokerAccountId: subscription.broker_account_id, eventType: "ipo_subscription_updated", entityId: subscription.id, entityVersion: 4, payload: { status: "reversed" } });
      });
    }
  }
  return { status: action };
}
