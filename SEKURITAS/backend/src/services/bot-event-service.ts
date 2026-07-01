import crypto from "node:crypto";
import { bot_account_events, broker_accounts, cash_balances, orders, securities_positions } from "../db/schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";

export async function botAccountSnapshotTx(tx: any, brokerAccountId: string) {
  const [cash] = await tx.select().from(cash_balances)
    .where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1);
  const positions = await tx.select().from(securities_positions)
    .where(eq(securities_positions.broker_account_id, brokerAccountId));
  const openOrders = await tx.select().from(orders).where(and(
    eq(orders.broker_account_id, brokerAccountId),
    inArray(orders.status, ["pending", "submit_unknown", "accepted", "open", "partially_filled", "amended", "locked_non_cancellable"])
  ));
  return {
    account_id: brokerAccountId,
    cash: {
      available_idr: String(cash?.available || "0"),
      reserved_idr: String(cash?.reserved || "0"),
      pending_idr: String(cash?.pending || "0"),
    },
    positions: positions.map((position: any) => ({
      symbol: position.symbol,
      available_shares: position.available,
      reserved_shares: position.reserved,
      pending_shares: position.pending,
      average_price_idr: String(position.average_price),
    })),
    open_orders: openOrders.map((order: any) => ({
      order_id: order.id,
      client_order_id: order.client_order_id,
      symbol: order.symbol,
      side: order.side,
      status: order.status,
      quantity_shares: order.original_quantity,
      filled_quantity_shares: order.filled_quantity,
      entity_version: order.last_mats_event_sequence,
    })),
  };
}

export async function appendBotAccountEventTx(tx: any, input: {
  brokerAccountId: string;
  eventType: string;
  entityId: string;
  entityVersion: number;
  correlationId?: string;
  payload?: Record<string, unknown>;
}) {
  const [account] = await tx.select({ accountType: broker_accounts.account_type })
    .from(broker_accounts)
    .where(eq(broker_accounts.id, input.brokerAccountId))
    .limit(1);
  if (account?.accountType !== "BOT") return;
  const sequenceResult = await tx.execute(sql`
    UPDATE bot_event_sequence_counter
    SET value = value + 1
    WHERE id = 1
    RETURNING value
  `);
  const sequence = Number(sequenceResult.rows?.[0]?.value);
  if (!Number.isSafeInteger(sequence)) throw new Error("BOT event sequence exhausted safe integer range");
  await tx.insert(bot_account_events).values({
    sequence,
    broker_account_id: input.brokerAccountId,
    event_type: input.eventType,
    entity_id: input.entityId,
    entity_version: input.entityVersion,
    correlation_id: input.correlationId || crypto.randomUUID(),
    payload: input.payload || {},
  }).onConflictDoNothing();
}
