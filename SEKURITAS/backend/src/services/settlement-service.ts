import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { cash_balances, fee_ledgers, orders, securities_positions, settlement_events, trade_fills } from "../db/schema.js";

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function estimatedFee(value: number) {
  return value * 0.0015;
}

function calculateFees(value: number, side: string) {
  const brokerFee = value * 0.0010;
  const levyFee = value * 0.00043;
  const vatFee = brokerFee * 0.11;
  const whtFee = side === "SELL" ? value * 0.001 : 0;
  const totalFee = brokerFee + levyFee + vatFee + whtFee;
  return { brokerFee, levyFee, vatFee, whtFee, totalFee };
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
    const fees = calculateFees(value, order.side);
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
      total_fee: fees.totalFee.toFixed(6),
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
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId || null, amount: fees.brokerFee.toFixed(6), fee_type: "BROKER" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId || null, amount: fees.levyFee.toFixed(6), fee_type: "LEVY_CLEARING" },
      { broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId || null, amount: fees.vatFee.toFixed(6), fee_type: "VAT" },
      ...(fees.whtFee > 0 ? [{ broker_account_id: order.broker_account_id, order_id: order.id, trade_id: tradeId || null, amount: fees.whtFee.toFixed(6), fee_type: "WHT" }] : [])
    ]);

    const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
    if (!cash) throw new Error("Cash balance not found");

    const pendingBasisPrice = existingFill ? actualPrice : toNumber(order.price);
    const pendingBasisValue = pendingBasisPrice * quantity;
    const pendingBasisFee = estimatedFee(pendingBasisValue);

    if (order.side === "BUY") {
      const cashReturn = (pendingBasisValue + pendingBasisFee) - (value + fees.totalFee);
      const newAvailableCash = toNumber(cash.available) + cashReturn;
      const newPendingCash = Math.max(toNumber(cash.pending) - (pendingBasisValue + pendingBasisFee), 0);

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
      const pendingCashToClear = pendingBasisValue - pendingBasisFee;
      const actualNetGained = value - fees.totalFee;
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
        const pl = ((actualPrice - avgPrice) * quantity) - fees.totalFee;

        await tx.update(securities_positions).set({
          realized_pl: (toNumber(pos.realized_pl) + pl).toFixed(6),
          updated_at: new Date()
        }).where(eq(securities_positions.id, pos.id));
      }
    }
  });
}
