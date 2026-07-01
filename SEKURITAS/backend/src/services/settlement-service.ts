import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import {
  cash_balances,
  fee_ledgers,
  orders,
  securities_positions,
  settlement_events,
  settlement_inbox,
  trade_fills
} from "../db/schema.js";
import { calculateFee, getFeeScheduleSnapshot } from "./fee-service.js";
import { createNotificationTx } from "./notification-service.js";
import { appendBotAccountEventTx, botAccountSnapshotTx } from "./bot-event-service.js";

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function payloadHash(payload: any) {
  const sanitized = { ...payload };
  delete sanitized.settled_at;
  delete sanitized.batch_id;
  return crypto.createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
}

function settlementKey(matsOrderId: string, tradeDetails: any, fallbackOrderId: string) {
  return String(
    tradeDetails?.idempotency_key ||
    tradeDetails?.settlement_id ||
    tradeDetails?.trade_id ||
    `settlement:${matsOrderId}:${fallbackOrderId}`
  );
}

function normalizeSide(side: unknown) {
  const normalized = String(side || "").trim().toLowerCase();
  if (normalized !== "buy" && normalized !== "sell") {
    throw new Error("unsupported_order_side_for_settlement");
  }
  return normalized as "buy" | "sell";
}

type SettlementProcessResult = {
  status: "processed" | "duplicate" | "deferred";
  idempotencyKey: string;
  reason?: string;
};

async function deferSettlement(tx: any, idempotencyKey: string, reason: string): Promise<SettlementProcessResult> {
  await tx.update(settlement_inbox).set({
    status: "pending_dependency",
    last_error: reason,
    updated_at: new Date(),
  }).where(eq(settlement_inbox.idempotency_key, idempotencyKey));
  return { status: "deferred", idempotencyKey, reason };
}

export async function processSettlement(matsOrderId: string, tradeDetails: any = {}): Promise<SettlementProcessResult> {
  const tradeId = tradeDetails.trade_id ? String(tradeDetails.trade_id) : "";
  if (!tradeId || !tradeDetails.idempotency_key) {
    throw new Error("settlement_trade_id_and_idempotency_key_required");
  }
  const idempotencyKey = settlementKey(matsOrderId, tradeDetails, "");
  const hash = payloadHash(tradeDetails);

  return db.transaction(async (tx) => {
    const [existingInbox] = await tx
      .select()
      .from(settlement_inbox)
      .where(eq(settlement_inbox.idempotency_key, idempotencyKey))
      .limit(1);

    if (existingInbox) {
      if (existingInbox.payload_hash !== hash) {
        throw new Error("settlement_idempotency_payload_conflict");
      }
      if (existingInbox.status === "processed") {
        return { status: "duplicate", idempotencyKey };
      }
      await tx.update(settlement_inbox).set({
        status: "received",
        attempts: sql`${settlement_inbox.attempts} + 1` as any,
        last_error: null,
        updated_at: new Date(),
      }).where(eq(settlement_inbox.idempotency_key, idempotencyKey));
    } else {
      await tx.insert(settlement_inbox).values({
        idempotency_key: idempotencyKey,
        mats_order_id: matsOrderId,
        trade_id: tradeId,
        status: "received",
        payload_hash: hash,
        payload: tradeDetails,
        attempts: 1,
      });
    }

    const [order] = await tx.select().from(orders).where(eq(orders.mats_order_id, matsOrderId)).limit(1);
    if (!order) return deferSettlement(tx, idempotencyKey, "order_not_found");
    const side = normalizeSide(order.side);
    const feeSide = side === "buy" ? "BUY" : "SELL";

    const [existingFill] = tradeId
      ? await tx.select().from(trade_fills).where(and(eq(trade_fills.order_id, order.id), eq(trade_fills.trade_id, tradeId))).limit(1)
      : [];
    if (!existingFill) {
      return deferSettlement(tx, idempotencyKey, "waiting_for_fill_accounting");
    }

    const actualPrice = toNumber(tradeDetails.price, toNumber(existingFill.price, toNumber(order.price)));
    const quantity = Math.min(
      toNumber(tradeDetails.quantity, existingFill.quantity),
      existingFill.quantity
    );
    if (quantity <= 0) return deferSettlement(tx, idempotencyKey, "fill_not_ready");
    if (actualPrice <= 0) return deferSettlement(tx, idempotencyKey, "price_not_ready");

    const value = actualPrice * quantity;
    const fee = calculateFee(value, feeSide, await getFeeScheduleSnapshot());

    const [event] = await tx.insert(settlement_events).values({
      idempotency_key: idempotencyKey,
      order_id: order.id,
      trade_id: tradeId || null,
      mats_order_id: matsOrderId,
      side,
      price: actualPrice.toFixed(6),
      quantity,
      gross_value: value.toFixed(6),
      total_fee: fee.totalFee.toFixed(6),
      payload_hash: hash,
    }).onConflictDoNothing().returning();

    if (!event) {
      await tx.update(settlement_inbox).set({
        status: "processed",
        processed_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      }).where(eq(settlement_inbox.idempotency_key, idempotencyKey));
      return { status: "duplicate", idempotencyKey };
    }

    await tx.insert(fee_ledgers).values([
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.brokerFee.toFixed(6), fee_type: "BROKER" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.marketFee.toFixed(6), fee_type: "LEVY_CLEARING" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.vatFee.toFixed(6), fee_type: "VAT" },
      ...(fee.sellTax > 0 ? [{ broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.sellTax.toFixed(6), fee_type: "WHT" }] : [])
    ]);

    const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
    if (!cash) throw new Error("Cash balance not found");

    const pendingBasisPrice = actualPrice;
    const pendingBasisValue = pendingBasisPrice * quantity;
    const pendingBasisFee = calculateFee(pendingBasisValue, feeSide, await getFeeScheduleSnapshot());

    if (side === "buy") {
      const cashReturn = (pendingBasisValue + pendingBasisFee.totalFee) - (value + fee.totalFee);
      const newAvailableCash = toNumber(cash.available) + cashReturn;
      const newPendingCash = Math.max(toNumber(cash.pending) - (pendingBasisValue + pendingBasisFee.totalFee), 0);

      await tx.update(cash_balances).set({
        available: newAvailableCash.toFixed(6),
        pending: newPendingCash.toFixed(6),
        updated_at: new Date()
      }).where(eq(cash_balances.id, cash.id));

      const [pos] = await tx.select().from(securities_positions)
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)))
        .limit(1);

      if (pos) {
        const oldAvailable = pos.available;
        const oldAverage = toNumber(pos.average_price);
        const newAvailable = oldAvailable + quantity;
        const newAverage = newAvailable > 0
          ? ((oldAverage * oldAvailable) + value) / newAvailable
          : 0;

        await tx.update(securities_positions).set({
          pending: Math.max(pos.pending - quantity, 0),
          available: newAvailable,
          average_price: newAverage.toFixed(6),
          updated_at: new Date()
        }).where(eq(securities_positions.id, pos.id));
      } else {
        await tx.insert(securities_positions).values({
          broker_account_id: order.broker_account_id,
          symbol: order.symbol,
          available: quantity,
          reserved: 0,
          pending: 0,
          average_price: actualPrice.toFixed(6),
          realized_pl: "0",
          unrealized_pl: "0",
        });
      }
    } else {
      const pendingCashToClear = pendingBasisValue - pendingBasisFee.totalFee;
      const actualNetGained = value - fee.totalFee;
      const newAvailableCash = toNumber(cash.available) + actualNetGained;
      const newPendingCash = Math.max(toNumber(cash.pending) - pendingCashToClear, 0);

      await tx.update(cash_balances).set({
        available: newAvailableCash.toFixed(6),
        pending: newPendingCash.toFixed(6),
        updated_at: new Date()
      }).where(eq(cash_balances.id, cash.id));

      const [pos] = await tx.select().from(securities_positions)
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)))
        .limit(1);

      if (pos) {
        const avgPrice = toNumber(pos.average_price);
        const pl = ((actualPrice - avgPrice) * quantity) - fee.totalFee;

        await tx.update(securities_positions).set({
          realized_pl: (toNumber(pos.realized_pl) + pl).toFixed(6),
          updated_at: new Date()
        }).where(eq(securities_positions.id, pos.id));
      }
    }

    await createNotificationTx(tx, {
      brokerAccountId: order.broker_account_id,
      type: "settlement_completed",
      title: `Settlement completed: ${order.symbol}`,
      body: `${quantity} shares of ${order.symbol} settled for order ${order.client_order_id}.`,
      referenceType: "SETTLEMENT",
      referenceId: event.id,
      idempotencyKey: `notification:settlement:${idempotencyKey}`,
      metadata: {
        symbol: order.symbol,
        side,
        trade_id: tradeId,
        mats_order_id: matsOrderId,
        quantity,
        price: actualPrice,
      },
    });

    await tx.update(settlement_inbox).set({
      status: "processed",
      processed_at: new Date(),
      last_error: null,
      updated_at: new Date(),
    }).where(eq(settlement_inbox.idempotency_key, idempotencyKey));

    await appendBotAccountEventTx(tx, {
      brokerAccountId: order.broker_account_id,
      eventType: "settlement_completed",
      entityId: event.id,
      entityVersion: 1,
      payload: {
        order_id: order.id, mats_order_id: matsOrderId, trade_id: tradeId,
        symbol: order.symbol, side, quantity, price: actualPrice,
        account: await botAccountSnapshotTx(tx, order.broker_account_id),
      },
    });

    return { status: "processed", idempotencyKey };
  });
}

export async function processPendingSettlementsForOrder(matsOrderId: string) {
  if (!matsOrderId) return [];
  const pending = await db
    .select()
    .from(settlement_inbox)
    .where(and(
      eq(settlement_inbox.mats_order_id, matsOrderId),
      sql`${settlement_inbox.status} IN ('pending_dependency', 'failed')`
    ));

  const results: SettlementProcessResult[] = [];
  for (const item of pending) {
    results.push(await processSettlement(item.mats_order_id, item.payload));
  }
  return results;
}
