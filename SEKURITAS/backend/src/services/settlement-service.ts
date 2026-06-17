import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { cash_balances, fee_ledgers, orders, securities_positions, settlement_events, trade_fills } from "../db/schema.js";
import { calculateFee, getFeeScheduleSnapshot } from "./fee-service.js";
import { createNotificationTx } from "./notification-service.js";

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function payloadHash(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function settlementKey(matsOrderId: string, tradeDetails: any, fallbackOrderId: string) {
  return String(
    tradeDetails?.idempotency_key ||
    tradeDetails?.settlement_id ||
    tradeDetails?.trade_id ||
    `settlement:${matsOrderId}:${fallbackOrderId}`
  );
}

export async function processSettlement(matsOrderId: string, tradeDetails: any = {}) {
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.mats_order_id, matsOrderId)).limit(1);
    if (!order) return;

    const tradeId = tradeDetails.trade_id ? String(tradeDetails.trade_id) : "";
    if (!tradeId || !tradeDetails.idempotency_key) {
      throw new Error("settlement_trade_id_and_idempotency_key_required");
    }
    const [existingFill] = tradeId
      ? await tx.select().from(trade_fills).where(eq(trade_fills.trade_id, tradeId)).limit(1)
      : [];

    const actualPrice = toNumber(tradeDetails.price, existingFill ? toNumber(existingFill.price, toNumber(order.price)) : toNumber(order.price));
    const quantity = Math.min(
      toNumber(tradeDetails.quantity, existingFill ? existingFill.quantity : order.filled_quantity),
      order.filled_quantity
    );
    if (quantity <= 0 || actualPrice <= 0) return;

    const idempotencyKey = settlementKey(matsOrderId, tradeDetails, order.id);
    const value = actualPrice * quantity;
    const fee = calculateFee(value, order.side as "BUY" | "SELL", await getFeeScheduleSnapshot());
    const hash = payloadHash(tradeDetails);

    const [event] = await tx.insert(settlement_events).values({
      idempotency_key: idempotencyKey,
      order_id: order.id,
      trade_id: tradeId || null,
      mats_order_id: matsOrderId,
      side: order.side,
      price: actualPrice.toFixed(6),
      quantity,
      gross_value: value.toFixed(6),
      total_fee: fee.totalFee.toFixed(6),
      payload_hash: hash,
    }).onConflictDoNothing().returning();

    if (!event) return;

    if (tradeId) {
      await tx.insert(trade_fills).values({
        order_id: order.id,
        trade_id: tradeId,
        price: actualPrice.toFixed(6),
        quantity,
        timestamp: tradeDetails.settled_at ? new Date(tradeDetails.settled_at) : new Date(),
      }).onConflictDoNothing();
    }

    await tx.insert(fee_ledgers).values([
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.brokerFee.toFixed(6), fee_type: "BROKER" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.marketFee.toFixed(6), fee_type: "LEVY_CLEARING" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.vatFee.toFixed(6), fee_type: "VAT" },
      ...(fee.sellTax > 0 ? [{ broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId, amount: fee.sellTax.toFixed(6), fee_type: "WHT" }] : [])
    ]);

    const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
    if (!cash) throw new Error("Cash balance not found");

    const pendingBasisPrice = existingFill ? actualPrice : toNumber(order.price);
    const pendingBasisValue = pendingBasisPrice * quantity;
    const pendingBasisFee = calculateFee(pendingBasisValue, order.side as "BUY" | "SELL", await getFeeScheduleSnapshot());

    if (order.side === "BUY") {
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
        side: order.side,
        trade_id: tradeId,
        mats_order_id: matsOrderId,
        quantity,
        price: actualPrice,
      },
    });
  });
}
