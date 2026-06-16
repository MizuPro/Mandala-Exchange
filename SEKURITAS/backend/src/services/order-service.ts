import { db } from "../db/db.js";
import { orders, cash_balances, securities_positions, broker_accounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { matsClient } from "./mats-client.js";
import crypto from "crypto";

// Mock fee estimation: 0.15% fee
const calculateEstimatedFee = (price: number, qty: number) => {
  return price * qty * 0.0015; 
};

export async function placeOrder(
  userId: string,
  symbol: string,
  side: "BUY" | "SELL",
  price: number,
  quantity: number
) {
  // Find broker account
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");

  const clientOrderId = `SEQ-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const totalValue = price * quantity;

  // Transaction for atomic reservation
  const orderRecord = await db.transaction(async (tx) => {
    if (side === "BUY") {
      const feeEstimate = calculateEstimatedFee(price, quantity);
      const totalRequired = totalValue + feeEstimate;

      const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
      if (!cash || parseFloat(cash.available) < totalRequired) {
        throw new Error("Insufficient cash for buy order including estimated fees");
      }

      // Reserve cash
      const newAvailable = (parseFloat(cash.available) - totalRequired).toString();
      const newReserved = (parseFloat(cash.reserved) + totalRequired).toString();
      await tx.update(cash_balances)
        .set({ available: newAvailable, reserved: newReserved })
        .where(eq(cash_balances.id, cash.id));
    } else {
      // SELL side
      const [pos] = await tx.select().from(securities_positions)
        .where(and(
          eq(securities_positions.broker_account_id, brokerAcc.id),
          eq(securities_positions.symbol, symbol)
        )).limit(1);
      
      if (!pos || pos.available < quantity) {
        throw new Error("Insufficient shares for sell order");
      }

      // Reserve shares
      await tx.update(securities_positions)
        .set({ available: pos.available - quantity, reserved: pos.reserved + quantity })
        .where(eq(securities_positions.id, pos.id));
    }

    // Create order record
    const [newOrder] = await tx.insert(orders).values({
      client_order_id: clientOrderId,
      broker_account_id: brokerAcc.id,
      symbol,
      side,
      price: price.toString(),
      quantity,
      remaining_quantity: quantity,
      status: "PENDING",
    }).returning();

    return newOrder;
  });

  // Call MATS async
  try {
    const matsRes = await matsClient.placeOrder({
      client_order_id: clientOrderId,
      broker_code: "MANDALA",
      symbol,
      side,
      price,
      quantity,
      time_in_force: "DAY"
    });
    // Assuming MATS returns accepted synchronously or via webhook
  } catch (err: any) {
    // If Mats fails to even receive it, we could reject immediately, but usually we wait for webhook.
    // For safety, let's mark it as REJECTED and rollback reservation if MATS is totally down
    await handleWebhookUpdate({
      client_order_id: clientOrderId,
      status: "REJECTED",
      filled_quantity: 0,
      remaining_quantity: quantity,
      average_price: 0,
      reject_reason: "MATS Connection Error"
    });
    throw new Error("Failed to place order to MATS");
  }

  return orderRecord;
}

export async function handleWebhookUpdate(payload: any) {
  const { client_order_id, mats_order_id, status, filled_quantity, remaining_quantity, reject_reason } = payload;
  
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.client_order_id, client_order_id)).limit(1);
    if (!order) return; // Unknown order

    if (mats_order_id && !order.mats_order_id) {
      await tx.update(orders).set({ mats_order_id }).where(eq(orders.id, order.id));
    }

    const previousStatus = order.status;
    if (["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(previousStatus)) {
      return; // Already terminal
    }

    await tx.update(orders).set({ 
      status, 
      filled_quantity, 
      remaining_quantity, 
      reject_reason,
      updated_at: new Date()
    }).where(eq(orders.id, order.id));

    // Handle Reservation logic based on new status
    if (status === "REJECTED" || status === "CANCELLED" || status === "EXPIRED") {
      // Release remaining reservation
      const releasedQty = remaining_quantity;
      if (releasedQty > 0) {
        if (order.side === "BUY") {
          const releasedValue = parseFloat(order.price) * releasedQty;
          const feeEstimate = calculateEstimatedFee(parseFloat(order.price), releasedQty);
          const totalRelease = releasedValue + feeEstimate;

          const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
          await tx.update(cash_balances)
            .set({ 
              available: (parseFloat(cash.available) + totalRelease).toString(),
              reserved: (parseFloat(cash.reserved) - totalRelease).toString()
            }).where(eq(cash_balances.id, cash.id));
        } else {
          const [pos] = await tx.select().from(securities_positions)
            .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol))).limit(1);
          if (pos) {
            await tx.update(securities_positions)
              .set({ 
                available: pos.available + releasedQty,
                reserved: pos.reserved - releasedQty 
              }).where(eq(securities_positions.id, pos.id));
          }
        }
      }
    } else if (status === "FILLED" || status === "PARTIAL_FILL") {
      // Convert reserved -> pending
      const freshlyFilledQty = filled_quantity - order.filled_quantity;
      if (freshlyFilledQty > 0) {
        if (order.side === "BUY") {
          const filledValue = parseFloat(order.price) * freshlyFilledQty;
          const feeEstimate = calculateEstimatedFee(parseFloat(order.price), freshlyFilledQty);
          const totalPending = filledValue + feeEstimate;

          const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
          await tx.update(cash_balances)
            .set({ 
              reserved: (parseFloat(cash.reserved) - totalPending).toString(),
              pending: (parseFloat(cash.pending) + totalPending).toString() // It will be finalized at settlement
            }).where(eq(cash_balances.id, cash.id));

          // Buyer receives pending shares
          const [pos] = await tx.select().from(securities_positions)
            .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol))).limit(1);
          
          if (pos) {
            await tx.update(securities_positions).set({ pending: pos.pending + freshlyFilledQty }).where(eq(securities_positions.id, pos.id));
          } else {
            await tx.insert(securities_positions).values({
              broker_account_id: order.broker_account_id,
              symbol: order.symbol,
              available: 0,
              reserved: 0,
              pending: freshlyFilledQty
            });
          }
        } else {
          // SELL
          const [pos] = await tx.select().from(securities_positions)
            .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol))).limit(1);
          
          if (pos) {
            await tx.update(securities_positions)
              .set({ 
                reserved: pos.reserved - freshlyFilledQty,
                // pending shares don't exist for sellers, they just lose the reserved shares when filled
              }).where(eq(securities_positions.id, pos.id));
          }

          // Seller receives pending cash
          const filledValue = parseFloat(order.price) * freshlyFilledQty;
          const feeEstimate = calculateEstimatedFee(parseFloat(order.price), freshlyFilledQty);
          const pendingCashGained = filledValue - feeEstimate;

          const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);
          await tx.update(cash_balances)
            .set({ 
              pending: (parseFloat(cash.pending) + pendingCashGained).toString()
            }).where(eq(cash_balances.id, cash.id));
        }
      }
    }
  });
}

export async function cancelOrder(userId: string, orderId: string) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.broker_account_id !== brokerAcc.id) throw new Error("Order not found or unauthorized");

  if (["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) {
    throw new Error("Order cannot be cancelled in its current state");
  }

  if (order.mats_order_id) {
    try {
      await matsClient.cancelOrder(order.mats_order_id);
    } catch (e: any) {
      throw new Error(`Failed to send cancel request: ${e.message}`);
    }
  } else {
    throw new Error("Order not yet submitted to MATS");
  }

  return { message: "Cancel request sent to MATS" };
}
