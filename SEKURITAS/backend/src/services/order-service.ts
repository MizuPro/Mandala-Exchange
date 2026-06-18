import { and, eq, gte, sql } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/db.js";
import { broker_accounts, cash_balances, order_amendments, orders, securities_positions, trade_fills } from "../db/schema.js";
import { isFillOrderStatus, isTerminalOrderStatus, normalizeOrderStatus } from "../lib/order-status.js";
import { estimateFee } from "./fee-service.js";
import { MatsClientError, matsClient } from "./mats-client.js";
import { createNotificationTx } from "./notification-service.js";
import { processPendingSettlementsForOrder } from "./settlement-service.js";

const BROKER_CODE = process.env.BROKER_CODE || "MANDALA";
const LOT_SIZE = Number(process.env.ORDER_LOT_SIZE || 100);
type BrokerOrderType = "limit" | "market";

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function sqlNumeric(value: number) {
  return value.toFixed(6);
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sqlInteger(value: number) {
  return Math.trunc(value);
}

function validateLotQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer");
  }
  if (LOT_SIZE > 0 && quantity % LOT_SIZE !== 0) {
    throw new Error(`Quantity must be a multiple of lot size ${LOT_SIZE}`);
  }
}

function orderStatusRank(status: string) {
  const normalized = String(status || "").toLowerCase();
  if (["rejected", "filled", "cancelled", "expired"].includes(normalized)) return 6;
  if (normalized === "partially_filled") return 5;
  if (normalized === "amended") return 4;
  if (normalized === "locked_non_cancellable") return 3;
  if (normalized === "open") return 2;
  if (normalized === "accepted") return 1;
  return 0;
}

function matsOrderToWebhookPayload(matsOrder: any, trades: any[] = []) {
  const fills = trades
    .filter((trade) => trade.buy_order_id === matsOrder.id || trade.sell_order_id === matsOrder.id)
    .map((trade) => ({
      trade_id: trade.id,
      mats_order_id: matsOrder.id,
      price: Number(trade.price),
      quantity: Number(trade.quantity),
      side: trade.buy_order_id === matsOrder.id ? "buy" : "sell",
      occurred_at: trade.occurred_at,
      idempotency_key: trade.idempotency_key || `trade:${trade.id}:${matsOrder.id}`,
    }));

  return {
    client_order_id: matsOrder.client_order_id,
    mats_order_id: matsOrder.id,
    status: matsOrder.status,
    price: Number(matsOrder.price || 0),
    original_quantity: Number(matsOrder.original_quantity || 0),
    event_sequence: Number(matsOrder.sequence_number || 0),
    filled_quantity: Number(matsOrder.filled_quantity || 0),
    remaining_quantity: Number(matsOrder.remaining_quantity || 0),
    reject_reason: matsOrder.reject_reason,
    fills,
  };
}

async function reserveForOrder(
  tx: any,
  brokerAccountId: string,
  symbol: string,
  side: "buy" | "sell",
  price: number,
  quantity: number,
  orderType: BrokerOrderType
) {
  if (side === "buy") {
    if (orderType === "market") {
      const [cash] = await tx
        .select()
        .from(cash_balances)
        .where(eq(cash_balances.broker_account_id, brokerAccountId))
        .limit(1);
      const available = Number(cash?.available || 0);
      if (!cash || available <= 0) {
        throw new Error("Insufficient cash for market buy order");
      }
      await tx
        .update(cash_balances)
        .set({
          available: "0",
          reserved: sql`${cash_balances.reserved} + ${sqlNumeric(available)}` as any,
          updated_at: new Date(),
        })
        .where(eq(cash_balances.id, cash.id));
      return available;
    }

    const grossValue = price * quantity;
    const fee = await estimateFee(grossValue, "BUY"); // Fee service might still expect uppercase BUY
    const totalRequired = grossValue + fee.totalFee;
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
    return totalRequired;
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
  return 0;
}

async function applyBuyReserveAdjustment(tx: any, brokerAccountId: string, currentReserved: number, targetReserved: number) {
  const delta = targetReserved - currentReserved;
  if (Math.abs(delta) < 0.000001) return;

  if (delta > 0) {
    const [updatedCash] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} - ${sqlNumeric(delta)}` as any,
        reserved: sql`${cash_balances.reserved} + ${sqlNumeric(delta)}` as any,
        updated_at: new Date(),
      })
      .where(and(
        eq(cash_balances.broker_account_id, brokerAccountId),
        gte(cash_balances.available, sqlNumeric(delta)),
      ))
      .returning();
    if (!updatedCash) throw new Error("Insufficient cash for amended buy order");
    return;
  }

  const release = Math.abs(delta);
  await tx.update(cash_balances)
    .set({
      available: sql`${cash_balances.available} + ${sqlNumeric(release)}` as any,
      reserved: sql`${cash_balances.reserved} - ${sqlNumeric(release)}` as any,
      updated_at: new Date(),
    })
    .where(eq(cash_balances.broker_account_id, brokerAccountId));
}

async function applySellReserveAdjustment(tx: any, brokerAccountId: string, symbol: string, currentReservedQty: number, targetReservedQty: number) {
  const delta = targetReservedQty - currentReservedQty;
  if (delta === 0) return;

  if (delta > 0) {
    const [updatedPosition] = await tx
      .update(securities_positions)
      .set({
        available: sql`${securities_positions.available} - ${delta}` as any,
        reserved: sql`${securities_positions.reserved} + ${delta}` as any,
        updated_at: new Date(),
      })
      .where(and(
        eq(securities_positions.broker_account_id, brokerAccountId),
        eq(securities_positions.symbol, symbol),
        gte(securities_positions.available, delta),
      ))
      .returning();
    if (!updatedPosition) throw new Error("Insufficient shares for amended sell order");
    return;
  }

  const release = Math.abs(delta);
  await tx.update(securities_positions)
    .set({
      available: sql`${securities_positions.available} + ${release}` as any,
      reserved: sql`${securities_positions.reserved} - ${release}` as any,
      updated_at: new Date(),
    })
    .where(and(eq(securities_positions.broker_account_id, brokerAccountId), eq(securities_positions.symbol, symbol)));
}

export async function placeOrder(
  userId: string,
  symbol: string,
  side: "buy" | "sell",
  price: number | undefined,
  quantity: number,
  orderType: BrokerOrderType = "limit"
) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");
  if (brokerAcc.status !== "ACTIVE") throw new Error("Broker account is not active");
  if (orderType === "limit" && (!price || price <= 0)) throw new Error("Price is required for limit orders");
  validateLotQuantity(quantity);

  const clientOrderId = `SEQ-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const placeIdempotencyKey = idempotencyKey(`place-${clientOrderId}`);
  const orderPrice = orderType === "market" ? 0 : Number(price);

  const orderRecord = await db.transaction(async (tx) => {
    const reservedAmount = await reserveForOrder(tx, brokerAcc.id, symbol, side, orderPrice, quantity, orderType);

    const [newOrder] = await tx.insert(orders).values({
      client_order_id: clientOrderId,
      broker_account_id: brokerAcc.id,
      symbol,
      side,
      order_type: orderType,
      price: orderPrice.toString(),
      original_quantity: quantity,
      remaining_quantity: quantity,
      reserved_amount: side === "buy" ? reservedAmount.toFixed(6) : "0",
      place_idempotency_key: placeIdempotencyKey,
      submission_status: "pending",
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
      side,
      order_type: orderType,
      price: orderType === "limit" ? orderPrice : undefined,
      quantity,
      idempotency_key: placeIdempotencyKey,
    });

    const matsResponse = matsRes as any;
    if (matsResponse?.order) {
      await handleWebhookUpdate(matsOrderToWebhookPayload(matsResponse.order, matsResponse.trades || []));
    }
  } catch (err: any) {
    const errorMessage = err.message || "MATS connection error";
    // Differentiate between definitive pre-accept failures and transport unknowns.
    // If the error clearly indicates MATS rejected before accepting (validation errors,
    // 4xx responses), rollback reservation and mark as rejected.
    const isDefinitiveReject = /invalid|required|rejected|not_found|bad_request|validation|4\d{2}/i.test(errorMessage);

    if (isDefinitiveReject) {
      // MATS definitively did not accept this order — safe to rollback reservation
      await db.transaction(async (tx) => {
        if (orderRecord.side === "buy") {
          const reservedAmount = Number(orderRecord.reserved_amount || 0);
          if (reservedAmount > 0) {
            await tx.update(cash_balances)
              .set({
                available: sql`${cash_balances.available} + ${sqlNumeric(reservedAmount)}` as any,
                reserved: sql`GREATEST(0, ${cash_balances.reserved} - ${sqlNumeric(reservedAmount)})` as any,
                updated_at: new Date(),
              })
              .where(eq(cash_balances.broker_account_id, orderRecord.broker_account_id));
          }
        } else {
          await tx.update(securities_positions)
            .set({
              available: sql`${securities_positions.available} + ${orderRecord.original_quantity}` as any,
              reserved: sql`GREATEST(0, ${securities_positions.reserved} - ${orderRecord.original_quantity})` as any,
              updated_at: new Date(),
            })
            .where(and(
              eq(securities_positions.broker_account_id, orderRecord.broker_account_id),
              eq(securities_positions.symbol, orderRecord.symbol)
            ));
        }
        await tx.update(orders).set({
          status: "rejected",
          submission_status: "failed",
          remaining_quantity: 0,
          reserved_amount: "0",
          last_submission_error: errorMessage,
          reject_reason: `mats_pre_accept_reject: ${errorMessage}`,
          updated_at: new Date(),
        }).where(eq(orders.id, orderRecord.id));
      });
      throw new Error(`Failed to place order to MATS: ${errorMessage}`);
    } else {
      // Transport timeout / unknown — MATS may or may not have received the order.
      // Keep reservation locked, mark as submit_unknown for reconciliation.
      await db.update(orders).set({
        status: "submit_unknown",
        submission_status: "unknown",
        last_submission_error: errorMessage,
        updated_at: new Date(),
      }).where(eq(orders.id, orderRecord.id));
      
      const [unknownOrder] = await db.select().from(orders).where(eq(orders.id, orderRecord.id)).limit(1);
      return Object.assign(unknownOrder || orderRecord, { deferred: true });
    }
  }

  const [updatedOrder] = await db.select().from(orders).where(eq(orders.id, orderRecord.id)).limit(1);
  return updatedOrder || orderRecord;
}

export async function handleWebhookUpdate(payload: any) {
  const clientOrderId = String(payload.client_order_id || "").trim();
  const matsOrderId = payload.mats_order_id ? String(payload.mats_order_id) : "";
  const rawStatus = payload.status ? normalizeOrderStatus(payload.status) : "";
  const isStandaloneFillPayload = payload.event_type === "trade_fill" || Boolean(payload.trade_id);
  const fillPayloads = Array.isArray(payload.fills)
    ? payload.fills
    : isStandaloneFillPayload
      ? [payload]
      : [];
  const isOrderSnapshot = !isStandaloneFillPayload;
  const rejectReason = payload.reject_reason;

  if (!clientOrderId && !matsOrderId) throw new Error("client_order_id_or_mats_order_id_required");

  await db.transaction(async (tx) => {
    const [order] = clientOrderId
      ? await tx.select().from(orders).where(eq(orders.client_order_id, clientOrderId)).limit(1)
      : await tx.select().from(orders).where(eq(orders.mats_order_id, matsOrderId)).limit(1);
    if (!order) return;

    if (rawStatus === "locked_non_cancellable") {
      await tx.update(orders).set({
        last_action_status: "locked_non_cancellable",
        last_action_reason: rejectReason || "non_cancellation_period",
        updated_at: new Date(),
      }).where(eq(orders.id, order.id));
      return;
    }

    if (isTerminalOrderStatus(order.status) && fillPayloads.length === 0) {
      return;
    }

    const eventSequence = sqlInteger(toNumber(payload.event_sequence ?? payload.order_sequence_number, 0));
    const lastEventSequence = Number(order.last_mats_event_sequence || 0);
    if (eventSequence > 0 && lastEventSequence > 0 && eventSequence < lastEventSequence) {
      return;
    }
    if (
      eventSequence > 0 &&
      lastEventSequence > 0 &&
      eventSequence === lastEventSequence &&
      rawStatus &&
      orderStatusRank(rawStatus) < orderStatusRank(order.status)
    ) {
      return;
    }

    const previousFilledQuantity = Number(order.filled_quantity || 0);
    const shouldApplyOrderSnapshot = isOrderSnapshot || Array.isArray(payload.fills);
    const nextOrderPrice = shouldApplyOrderSnapshot
      ? toNumber(payload.price, Number(order.price))
      : Number(order.price);
    const nextOriginalQuantity = !shouldApplyOrderSnapshot || payload.original_quantity === undefined
      ? order.original_quantity
      : sqlInteger(toNumber(payload.original_quantity, order.original_quantity));
    let filledQuantity = payload.filled_quantity === undefined
      ? previousFilledQuantity
      : Math.max(Number(payload.filled_quantity || 0), previousFilledQuantity);
    let remainingQuantity = payload.remaining_quantity === undefined
      ? Number(order.remaining_quantity || 0)
      : Math.max(Number(payload.remaining_quantity || 0), 0);
    if (
      eventSequence > 0 &&
      lastEventSequence > 0 &&
      eventSequence === lastEventSequence &&
      remainingQuantity > Number(order.remaining_quantity || 0) &&
      rawStatus !== "amended"
    ) {
      return;
    }
    let nextReservedAmount = Number(order.reserved_amount || 0);
    let processedFillQuantity = 0;

    for (const fill of fillPayloads) {
      const tradeId = fill.trade_id ? String(fill.trade_id) : "";
      const fillQuantity = sqlInteger(toNumber(fill.quantity, 0));
      const executionPrice = toNumber(fill.price || fill.average_price, 0);
      if (fillQuantity <= 0 || executionPrice <= 0) continue;

      if (tradeId) {
        const [insertedFill] = await tx.insert(trade_fills).values({
          order_id: order.id,
          trade_id: tradeId,
          price: executionPrice.toString(),
          quantity: fillQuantity,
          timestamp: fill.occurred_at ? new Date(fill.occurred_at) : new Date(),
        }).onConflictDoNothing().returning();
        if (!insertedFill) continue;
      }

      const filledValue = executionPrice * fillQuantity;
      const feeEstimate = await estimateFee(filledValue, order.side.toUpperCase() as "BUY" | "SELL");
      processedFillQuantity += fillQuantity;

      if (order.side === "buy") {
        const totalPending = filledValue + feeEstimate.totalFee;
        nextReservedAmount = Math.max(nextReservedAmount - totalPending, 0);
        await tx.update(cash_balances)
          .set({
            reserved: sql`GREATEST(0, ${cash_balances.reserved} - ${sqlNumeric(totalPending)})` as any,
            available: sql`${cash_balances.available} - GREATEST(0, ${sqlNumeric(totalPending)} - ${cash_balances.reserved})` as any,
            pending: sql`${cash_balances.pending} + ${sqlNumeric(totalPending)}` as any,
            updated_at: new Date(),
          })
          .where(eq(cash_balances.broker_account_id, order.broker_account_id));

        const [pos] = await tx.select().from(securities_positions)
          .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)))
          .limit(1);

        if (pos) {
          await tx.update(securities_positions)
          .set({ pending: sql`${securities_positions.pending} + ${fillQuantity}` as any, updated_at: new Date() })
          .where(eq(securities_positions.id, pos.id));
        } else {
          await tx.insert(securities_positions).values({
            broker_account_id: order.broker_account_id,
            symbol: order.symbol,
            available: 0,
            reserved: 0,
            pending: fillQuantity,
          }).onConflictDoUpdate({
            target: [securities_positions.broker_account_id, securities_positions.symbol],
            set: {
              pending: sql`${securities_positions.pending} + ${fillQuantity}` as any,
              updated_at: new Date(),
            },
          });
        }
      } else {
        await tx.update(securities_positions)
          .set({ reserved: sql`${securities_positions.reserved} - ${fillQuantity}` as any, updated_at: new Date() })
          .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)));

        const pendingCashGained = filledValue - feeEstimate.totalFee;
        await tx.update(cash_balances)
          .set({
            pending: sql`${cash_balances.pending} + ${sqlNumeric(pendingCashGained)}` as any,
            updated_at: new Date(),
          })
          .where(eq(cash_balances.broker_account_id, order.broker_account_id));
      }
    }

    if (processedFillQuantity > 0 && payload.filled_quantity === undefined) {
      filledQuantity = Math.min(nextOriginalQuantity, previousFilledQuantity + processedFillQuantity);
      remainingQuantity = Math.max(nextOriginalQuantity - filledQuantity, 0);
    }

    const status = rawStatus || (processedFillQuantity > 0 ? (remainingQuantity === 0 ? "filled" : "partially_filled") : order.status);
    const fillRows = await tx.select().from(trade_fills).where(eq(trade_fills.order_id, order.id));
    const accountedFilledQuantity = fillRows.reduce((sum: number, fill: typeof trade_fills.$inferSelect) => sum + fill.quantity, 0);
    const remainingReserveQuantity = status === "filled"
      ? Math.max(nextOriginalQuantity - accountedFilledQuantity, 0)
      : remainingQuantity;
    const terminalReleasesReservation = ["rejected", "cancelled", "expired"].includes(status) ||
      (status === "filled" && processedFillQuantity > 0 && remainingReserveQuantity === 0);
    const terminalSellReleaseQuantity = order.side === "sell" && ["rejected", "cancelled", "expired"].includes(status)
      ? Math.max(Number(order.remaining_quantity || 0) - processedFillQuantity, 0)
      : 0;

    if (order.side === "buy") {
      const targetFee = await estimateFee(nextOrderPrice * remainingReserveQuantity, "BUY");
      let targetReservedAmount = 0;
      if (!terminalReleasesReservation) {
        if (order.order_type === "market") {
          targetReservedAmount = nextReservedAmount;
        } else {
          targetReservedAmount = nextOrderPrice * remainingReserveQuantity + targetFee.totalFee;
        }
      }
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

    if (terminalSellReleaseQuantity > 0) {
      await tx.update(securities_positions)
        .set({
          available: sql`${securities_positions.available} + ${terminalSellReleaseQuantity}` as any,
          reserved: sql`GREATEST(0, ${securities_positions.reserved} - ${terminalSellReleaseQuantity})` as any,
          updated_at: new Date(),
        })
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol)));
    }

    await tx.update(orders).set({
      ...(matsOrderId && !order.mats_order_id ? { mats_order_id: matsOrderId } : {}),
      price: nextOrderPrice.toString(),
      original_quantity: nextOriginalQuantity,
      ...(eventSequence > lastEventSequence ? { last_mats_event_sequence: eventSequence } : {}),
      status,
      filled_quantity: filledQuantity,
      remaining_quantity: status === "rejected" ? 0 : remainingQuantity,
      reserved_amount: order.side === "buy" ? sqlNumeric(nextReservedAmount) : "0",
      reject_reason: rejectReason,
      submission_status: matsOrderId || status !== "pending" ? "submitted" : order.submission_status,
      last_submission_error: null,
      last_action_status: null,
      last_action_reason: null,
      updated_at: new Date(),
    }).where(eq(orders.id, order.id));

    if (status !== order.status || processedFillQuantity > 0) {
      const notificationType = processedFillQuantity > 0 ? "order_fill" : "order_status";
      await createNotificationTx(tx, {
        brokerAccountId: order.broker_account_id,
        type: notificationType,
        title: processedFillQuantity > 0 ? `Order filled: ${order.symbol}` : `Order ${status}: ${order.symbol}`,
        body: processedFillQuantity > 0
          ? `${processedFillQuantity} shares of ${order.symbol} were filled.`
          : `Your ${order.side} ${order.order_type || "limit"} order is now ${status.replace(/_/g, " ")}.`,
        referenceType: "ORDER",
        referenceId: order.id,
        idempotencyKey: `notification:order:${order.id}:${status}:${filledQuantity}:${remainingQuantity}`,
        metadata: {
          symbol: order.symbol,
          side: order.side,
          order_type: order.order_type,
          status,
          filled_quantity: filledQuantity,
          remaining_quantity: remainingQuantity,
        },
      });
    }
  });

  if (matsOrderId) {
    await processPendingSettlementsForOrder(matsOrderId);
  }
}

export async function amendOrder(userId: string, orderId: string, price?: number, quantity?: number) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!brokerAcc) throw new Error("Broker account not found");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.broker_account_id !== brokerAcc.id) throw new Error("Order not found or unauthorized");
  if (order.order_type === "market") throw new Error("Market orders cannot be amended");
  if (isTerminalOrderStatus(order.status)) throw new Error("Order cannot be amended in its current state");
  if (!order.mats_order_id) throw new Error("Order not yet accepted by MATS");

  const nextPrice = price ?? Number(order.price);
  const nextQuantity = quantity ?? order.original_quantity;
  validateLotQuantity(nextQuantity);
  if (nextQuantity < order.filled_quantity) throw new Error("Amended quantity cannot be below filled quantity");

  const previousReservedAmount = Number(order.reserved_amount || 0);
  const previousRemainingQuantity = Number(order.remaining_quantity || 0);
  const nextRemainingQuantity = nextQuantity - order.filled_quantity;
  const nextGrossValue = nextPrice * nextRemainingQuantity;
  const nextFee = order.side === "buy" ? await estimateFee(nextGrossValue, "BUY") : null;
  const nextReservedAmount = order.side === "buy" ? nextGrossValue + (nextFee?.totalFee || 0) : 0;
  
  const reserveDelta = nextReservedAmount - previousReservedAmount;
  const qtyDelta = nextRemainingQuantity - previousRemainingQuantity;
  const amendIdempotencyKey = idempotencyKey(`amend-${order.client_order_id}`);
  let amendmentId = "";

  await db.transaction(async (tx) => {
    if (order.side === "buy" && reserveDelta > 0) {
      await applyBuyReserveAdjustment(tx, order.broker_account_id, previousReservedAmount, nextReservedAmount);
    } else if (order.side === "sell" && qtyDelta > 0) {
      await applySellReserveAdjustment(tx, order.broker_account_id, order.symbol, previousRemainingQuantity, nextRemainingQuantity);
    }
    const [amendment] = await tx.insert(order_amendments).values({
      order_id: order.id,
      old_price: order.price,
      old_original_quantity: order.original_quantity,
      new_price: nextPrice.toString(),
      new_original_quantity: nextQuantity,
      status: "pending",
    }).returning();
    amendmentId = amendment.id;
  });

  try {
    const matsRes = await matsClient.amendOrder(order.mats_order_id, {
      ...(price !== undefined ? { price } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      idempotency_key: amendIdempotencyKey,
    });
    const matsResponse = matsRes as any;
    const hasAcceptedMatsOrder = Boolean(matsResponse?.order);
    if (matsResponse?.order) {
      await handleWebhookUpdate(matsOrderToWebhookPayload(matsResponse.order, matsResponse.trades || []));
    }
    await db.transaction(async (tx) => {
      if (order.side === "buy" && reserveDelta < 0 && !hasAcceptedMatsOrder) {
        await applyBuyReserveAdjustment(tx, order.broker_account_id, previousReservedAmount, nextReservedAmount);
      } else if (order.side === "sell" && qtyDelta < 0) {
        await applySellReserveAdjustment(tx, order.broker_account_id, order.symbol, previousRemainingQuantity, nextRemainingQuantity);
      }
      const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, order.id)).limit(1);
      if (currentOrder && order.side === "buy") {
        const acceptedPrice = hasAcceptedMatsOrder ? Number(currentOrder.price || nextPrice) : nextPrice;
        const acceptedRemaining = hasAcceptedMatsOrder ? Number(currentOrder.remaining_quantity || nextRemainingQuantity) : nextRemainingQuantity;
        const terminal = isTerminalOrderStatus(currentOrder.status);
        const acceptedFee = terminal ? null : await estimateFee(acceptedPrice * acceptedRemaining, "BUY");
        const acceptedReservedAmount = terminal ? 0 : acceptedPrice * acceptedRemaining + (acceptedFee?.totalFee || 0);
        await tx.update(orders).set({
          ...(!hasAcceptedMatsOrder ? {
            price: nextPrice.toString(),
            original_quantity: nextQuantity,
            remaining_quantity: nextRemainingQuantity,
          } : {}),
          reserved_amount: sqlNumeric(acceptedReservedAmount),
          updated_at: new Date(),
        }).where(eq(orders.id, order.id));
      } else if (currentOrder && !hasAcceptedMatsOrder) {
        await tx.update(orders).set({
          price: nextPrice.toString(),
          original_quantity: nextQuantity,
          remaining_quantity: nextRemainingQuantity,
          updated_at: new Date(),
        }).where(eq(orders.id, order.id));
      }
      if (amendmentId) {
        await tx.update(order_amendments).set({ status: "accepted", updated_at: new Date() }).where(eq(order_amendments.id, amendmentId));
      }
    });
  } catch (e: any) {
    await db.transaction(async (tx) => {
      if (order.side === "buy" && reserveDelta > 0) {
        await applyBuyReserveAdjustment(tx, order.broker_account_id, nextReservedAmount, previousReservedAmount);
      } else if (order.side === "sell" && qtyDelta > 0) {
        await applySellReserveAdjustment(tx, order.broker_account_id, order.symbol, nextRemainingQuantity, previousRemainingQuantity);
      }
      if (amendmentId) {
        await tx.update(order_amendments).set({ status: "rejected", updated_at: new Date() }).where(eq(order_amendments.id, amendmentId));
      }
    });
    throw new Error(`Failed to send amend request: ${e.message}`);
  }

  return { message: "Amend request sent to MATS" };
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
      await handleWebhookUpdate(matsOrderToWebhookPayload(matsResponse.order, matsResponse.trades || []));
    }
  } catch (e: any) {
    throw new Error(`Failed to send cancel request: ${e.message}`);
  }

  return { message: "Cancel request sent to MATS" };
}

const SUBMIT_UNKNOWN_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

function isDefinitiveMatsReconcileFailure(error: unknown) {
  if (!(error instanceof MatsClientError)) return false;
  if (error.status === 404 || error.status === 409) return true;
  if (error.status >= 500 || error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429) return false;
  return /not_found|idempotency_key_payload_conflict|invalid|required|validation|rejected/i.test(error.message);
}

export async function reconcileSubmitUnknownOrders() {
  const unknownOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.submission_status, "unknown"));

  const results: Array<{ orderId: string; action: string; detail: string }> = [];

  for (const order of unknownOrders) {
    const ageMs = Date.now() - new Date(order.created_at).getTime();

    try {
      // Try to look up the order on MATS by placing with the same idempotency key.
      // MATS returns the existing order if it was already accepted.
      const matsRes = await matsClient.placeOrder({
        client_order_id: order.client_order_id,
        broker_code: BROKER_CODE,
        account_id: order.broker_account_id,
        symbol: order.symbol,
        side: order.side,
        order_type: order.order_type || "limit",
        price: order.order_type === "limit" ? Number(order.price) : undefined,
        quantity: order.original_quantity,
        idempotency_key: order.place_idempotency_key,
      });

      const matsResponse = matsRes as any;
      if (matsResponse?.order) {
        // MATS has the order — sync local state
        await handleWebhookUpdate(
          matsOrderToWebhookPayload(matsResponse.order, matsResponse.trades || [])
        );
        results.push({
          orderId: order.id,
          action: "synced",
          detail: `Synced with MATS order ${matsResponse.order.id}`,
        });
      }
    } catch (err: any) {
      if (ageMs > SUBMIT_UNKNOWN_GRACE_PERIOD_MS && isDefinitiveMatsReconcileFailure(err)) {
        // Grace period exceeded and MATS definitively rejected or does not know this order.
        await db.transaction(async (tx) => {
          if (order.side === "buy") {
            const reservedAmount = Number(order.reserved_amount || 0);
            if (reservedAmount > 0) {
              await tx
                .update(cash_balances)
                .set({
                  available: sql`${cash_balances.available} + ${sqlNumeric(reservedAmount)}` as any,
                  reserved: sql`GREATEST(0, ${cash_balances.reserved} - ${sqlNumeric(reservedAmount)})` as any,
                  updated_at: new Date(),
                })
                .where(eq(cash_balances.broker_account_id, order.broker_account_id));
            }
          } else {
            const remainingQty = order.remaining_quantity || order.original_quantity;
            await tx
              .update(securities_positions)
              .set({
                available: sql`${securities_positions.available} + ${remainingQty}` as any,
                reserved: sql`GREATEST(0, ${securities_positions.reserved} - ${remainingQty})` as any,
                updated_at: new Date(),
              })
              .where(
                and(
                  eq(securities_positions.broker_account_id, order.broker_account_id),
                  eq(securities_positions.symbol, order.symbol)
                )
              );
          }
          await tx
            .update(orders)
            .set({
              status: "rejected",
              submission_status: "failed",
              remaining_quantity: 0,
              reserved_amount: "0",
              reject_reason: "reconcile_timeout: MATS did not accept order within grace period",
              last_submission_error: err.message,
              updated_at: new Date(),
            })
            .where(eq(orders.id, order.id));
        });
        results.push({
          orderId: order.id,
          action: "released",
          detail: "Grace period exceeded, reservation released",
        });
      } else {
        results.push({
          orderId: order.id,
          action: "waiting",
          detail: ageMs > SUBMIT_UNKNOWN_GRACE_PERIOD_MS
            ? `Waiting for definitive MATS reconciliation response: ${err.message}`
            : `Still within grace period (${Math.round(ageMs / 1000)}s / ${SUBMIT_UNKNOWN_GRACE_PERIOD_MS / 1000}s)`,
        });
      }
    }
  }

  return { reconciled: results.length, results };
}
