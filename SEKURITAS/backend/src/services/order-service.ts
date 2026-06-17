import { and, eq, gte, sql } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/db.js";
import { broker_accounts, cash_balances, orders, securities_positions, trade_fills } from "../db/schema.js";
import { isFillOrderStatus, isTerminalOrderStatus, normalizeOrderStatus } from "../lib/order-status.js";
import { matsClient } from "./mats-client.js";

const BROKER_CODE = process.env.BROKER_CODE || "MANDALA";

// MVP estimate. Later this should come from BEI fee schedule.
const calculateEstimatedFee = (price: number, qty: number) => price * qty * 0.0015;

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function sqlNumeric(value: number) {
  return value.toFixed(6);
}

function matsOrderToWebhookPayload(matsOrder: any) {
  return {
    client_order_id: matsOrder.client_order_id,
    mats_order_id: matsOrder.id,
    status: matsOrder.status,
    filled_quantity: Number(matsOrder.filled_quantity || 0),
    remaining_quantity: Number(matsOrder.remaining_quantity || 0),
    reject_reason: matsOrder.reject_reason,
  };
}

async function reserveForOrder(tx: any, brokerAccountId: string, symbol: string, side: "BUY" | "SELL", price: number, quantity: number) {
  if (side === "BUY") {
    const totalRequired = price * quantity + calculateEstimatedFee(price, quantity);
    const [updatedCash] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} - ${sqlNumeric(totalRequired)}` as any,
        reserved: sql`${cash_balances.reserved} + ${sqlNumeric(totalRequired)}` as any,
        updated_at: new Date(),
      })
      .where(and(
        eq(cash_balances.broker_account_id, brokerAccountId),
        gte(cash_balances.available, sqlNumeric(totalRequired)),
      ))
      .returning();

    if (!updatedCash) {
      throw new Error("Insufficient cash for buy order including estimated fees");
    }
    return;
  }

  const [updatedPosition] = await tx
    .update(securities_positions)
    .set({
      available: sql`${securities_positions.available} - ${quantity}` as any,
      reserved: sql`${securities_positions.reserved} + ${quantity}` as any,
      updated_at: new Date(),
    })
    .where(and(
      eq(securities_positions.broker_account_id, brokerAccountId),
      eq(securities_positions.symbol, symbol),
      gte(securities_positions.available, quantity),
    ))
    .returning();

  if (!updatedPosition) {
    throw new Error("Insufficient shares for sell order");
  }
}

export async function placeOrder(
  userId: string,
  symbol: string,
  side: "BUY" | "SELL",
  price: number,
  quantity: number
) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");
  if (brokerAcc.status !== "ACTIVE") throw new Error("Broker account is not active");

  const clientOrderId = `SEQ-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const placeIdempotencyKey = idempotencyKey(`place-${clientOrderId}`);

  const orderRecord = await db.transaction(async (tx) => {
    await reserveForOrder(tx, brokerAcc.id, symbol, side, price, quantity);

    const [newOrder] = await tx.insert(orders).values({
      client_order_id: clientOrderId,
      broker_account_id: brokerAcc.id,
      symbol,
      side,
      price: price.toString(),
      quantity,
      remaining_quantity: quantity,
      reserved_amount: side === "BUY" ? (price * quantity + calculateEstimatedFee(price, quantity)).toFixed(6) : "0",
      status: "pending",
    }).returning();

    return newOrder;
  });

  try {
    const matsRes = await matsClient.placeOrder({
      client_order_id: clientOrderId,
      broker_code: BROKER_CODE,
      account_id: brokerAcc.id,
      symbol,
      side: side.toLowerCase(),
      order_type: "limit",
      price,
      quantity,
      idempotency_key: placeIdempotencyKey,
    });

    const matsResponse = matsRes as any;
    if (matsResponse?.order) {
      await handleWebhookUpdate(matsOrderToWebhookPayload(matsResponse.order));
    }
  } catch (err: any) {
    await handleWebhookUpdate({
      client_order_id: clientOrderId,
      status: "rejected",
      filled_quantity: 0,
      remaining_quantity: quantity,
      reject_reason: err.message || "MATS connection error",
    });
    throw new Error(`Failed to place order to MATS: ${err.message}`);
  }

  const [updatedOrder] = await db.select().from(orders).where(eq(orders.id, orderRecord.id)).limit(1);
  return updatedOrder || orderRecord;
}

export async function handleWebhookUpdate(payload: any) {
  const clientOrderId = String(payload.client_order_id || "").trim();
  const status = normalizeOrderStatus(payload.status);
  const filledQuantity = Number(payload.filled_quantity || 0);
  const payloadRemainingQuantity = Number(payload.remaining_quantity || 0);
  const rejectReason = payload.reject_reason;
  const matsOrderId = payload.mats_order_id;
  const tradeId = payload.trade_id ? String(payload.trade_id) : "";

  if (!clientOrderId) throw new Error("client_order_id_required");

  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.client_order_id, clientOrderId)).limit(1);
    if (!order) return;

    if (isTerminalOrderStatus(order.status)) {
      return;
    }

    const previousFilledQuantity = Number(order.filled_quantity || 0);
    const previousRemainingQuantity = Number(order.remaining_quantity || 0);
    const remainingQuantity = status === "rejected"
      ? previousRemainingQuantity
      : Math.max(payloadRemainingQuantity, 0);

    const freshlyFilledQty = Math.max(filledQuantity - previousFilledQuantity, 0);
    let nextReservedAmount = Number(order.reserved_amount || 0);

    if (isFillOrderStatus(status) && freshlyFilledQty > 0) {
      const executionPrice = Number(payload.price || payload.average_price || order.price);
      const filledValue = executionPrice * freshlyFilledQty;
      const feeEstimate = calculateEstimatedFee(executionPrice, freshlyFilledQty);

      if (tradeId) {
        await tx.insert(trade_fills).values({
          order_id: order.id,
          trade_id: tradeId,
          price: executionPrice.toString(),
          quantity: freshlyFilledQty,
          timestamp: payload.occurred_at ? new Date(payload.occurred_at) : new Date(),
        }).onConflictDoNothing();
      }

      if (order.side === "BUY") {
        const totalPending = filledValue + feeEstimate;
        nextReservedAmount = Math.max(nextReservedAmount - totalPending, 0);
        await tx.update(cash_balances)
          .set({
            reserved: sql`${cash_balances.reserved} - ${sqlNumeric(totalPending)}` as any,
            pending: sql`${cash_balances.pending} + ${sqlNumeric(totalPending)}` as any,
            updated_at: new Date(),
          })
          .where(eq(cash_balances.broker_account_id, order.broker_account_id));

        const [pos] = await tx.select().from(securities_positions)
          .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)))
          .limit(1);

        if (pos) {
          await tx.update(securities_positions)
            .set({ pending: sql`${securities_positions.pending} + ${freshlyFilledQty}` as any, updated_at: new Date() })
            .where(eq(securities_positions.id, pos.id));
        } else {
          await tx.insert(securities_positions).values({
            broker_account_id: order.broker_account_id,
            symbol: order.symbol,
            available: 0,
            reserved: 0,
            pending: freshlyFilledQty,
          }).onConflictDoUpdate({
            target: [securities_positions.broker_account_id, securities_positions.symbol],
            set: {
              pending: sql`${securities_positions.pending} + ${freshlyFilledQty}` as any,
              updated_at: new Date(),
            },
          });
        }
      } else {
        await tx.update(securities_positions)
          .set({ reserved: sql`${securities_positions.reserved} - ${freshlyFilledQty}` as any, updated_at: new Date() })
          .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)));

        const pendingCashGained = filledValue - feeEstimate;
        await tx.update(cash_balances)
          .set({
            pending: sql`${cash_balances.pending} + ${sqlNumeric(pendingCashGained)}` as any,
            updated_at: new Date(),
          })
          .where(eq(cash_balances.broker_account_id, order.broker_account_id));
      }
    }

    const terminalReleasesReservation = ["filled", "rejected", "cancelled", "expired"].includes(status);

    if (order.side === "BUY") {
      const targetReservedAmount = terminalReleasesReservation
        ? 0
        : Number(order.price) * remainingQuantity + calculateEstimatedFee(Number(order.price), remainingQuantity);
      const releaseExcess = Math.max(nextReservedAmount - targetReservedAmount, 0);
      if (releaseExcess > 0) {
        await tx.update(cash_balances)
          .set({
            available: sql`${cash_balances.available} + ${sqlNumeric(releaseExcess)}` as any,
            reserved: sql`${cash_balances.reserved} - ${sqlNumeric(releaseExcess)}` as any,
            updated_at: new Date(),
          })
          .where(eq(cash_balances.broker_account_id, order.broker_account_id));
        nextReservedAmount = Math.max(nextReservedAmount - releaseExcess, 0);
      }
    }

    if (order.side === "SELL" && ["rejected", "cancelled", "expired"].includes(status) && remainingQuantity > 0) {
      await tx.update(securities_positions)
        .set({
          available: sql`${securities_positions.available} + ${remainingQuantity}` as any,
          reserved: sql`${securities_positions.reserved} - ${remainingQuantity}` as any,
          updated_at: new Date(),
        })
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)));
    }

    await tx.update(orders).set({
      ...(matsOrderId && !order.mats_order_id ? { mats_order_id: matsOrderId } : {}),
      status,
      filled_quantity: filledQuantity,
      remaining_quantity: status === "rejected" ? 0 : remainingQuantity,
      reserved_amount: order.side === "BUY" ? sqlNumeric(nextReservedAmount) : "0",
      reject_reason: rejectReason,
      updated_at: new Date(),
    }).where(eq(orders.id, order.id));
  });
}

export async function cancelOrder(userId: string, orderId: string) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.broker_account_id !== brokerAcc.id) throw new Error("Order not found or unauthorized");
  if (isTerminalOrderStatus(order.status)) throw new Error("Order cannot be cancelled in its current state");
  if (!order.mats_order_id) throw new Error("Order not yet accepted by MATS");

  try {
    const matsRes = await matsClient.cancelOrder(order.mats_order_id, idempotencyKey(`cancel-${order.client_order_id}`));
    const matsResponse = matsRes as any;
    if (matsResponse?.order) {
      await handleWebhookUpdate(matsOrderToWebhookPayload(matsResponse.order));
    }
  } catch (e: any) {
    throw new Error(`Failed to send cancel request: ${e.message}`);
  }

  return { message: "Cancel request sent to MATS" };
}
