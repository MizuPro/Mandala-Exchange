import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import {
  broker_accounts,
  cash_balances,
  corporate_action_events,
  ledger_movements,
  securities_positions,
} from "../db/schema.js";
import { createNotificationTx } from "./notification-service.js";
import { appendBotAccountEventTx } from "./bot-event-service.js";

type SupportedActionType =
  | "cash_dividend"
  | "stock_split"
  | "reverse_split"
  | "bonus_share"
  | "rights_issue"
  | "warrant"
  | "ipo_allocation";

type CorporateActionEntitlement = {
  broker_account_id?: string;
  investor_id?: string;
  broker_code?: string;
  symbol?: string;
  entitlement_symbol?: string;
  asset_type?: "cash" | "security" | "right" | "warrant" | string;
  quantity?: number | string;
  cash_amount?: number | string;
  idempotency_key?: string;
};

export type CorporateActionWebhookPayload = {
  event_id?: string;
  idempotency_key?: string;
  corporate_action_id?: string;
  action_id?: string;
  action_type: string;
  symbol: string;
  title?: string;
  details?: {
    ratio_numerator?: number | string;
    ratio_denominator?: number | string;
    cash_amount_per_share?: number | string;
    exercise_price?: number | string;
    entitlement_symbol?: string;
    [key: string]: unknown;
  };
  entitlements?: CorporateActionEntitlement[];
  generated_ledger_entries?: CorporateActionEntitlement[];
  [key: string]: unknown;
};

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sqlNumeric(value: number) {
  return value.toFixed(6);
}

function payloadHash(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function normalizeActionType(value: string): SupportedActionType {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "dividend") return "cash_dividend";
  const supported = new Set([
    "cash_dividend",
    "stock_split",
    "reverse_split",
    "bonus_share",
    "rights_issue",
    "warrant",
    "ipo_allocation",
  ]);
  if (!supported.has(normalized)) {
    throw new Error(`Unsupported corporate action type: ${value}`);
  }
  return normalized as SupportedActionType;
}

function eventKey(payload: CorporateActionWebhookPayload) {
  return String(
    payload.idempotency_key ||
      payload.event_id ||
      `bei:corporate-action:${payload.corporate_action_id || payload.action_id || payload.symbol}:${payload.action_type}`
  );
}

function entitlementRows(payload: CorporateActionWebhookPayload) {
  const rows = payload.entitlements || payload.generated_ledger_entries || [];
  return rows.filter((row) => row && typeof row === "object");
}

function entitlementSymbol(baseSymbol: string, actionType: SupportedActionType, entitlement: CorporateActionEntitlement, payload: CorporateActionWebhookPayload) {
  const explicit = entitlement.entitlement_symbol || payload.details?.entitlement_symbol;
  if (explicit) return String(explicit).toUpperCase();
  
  if (entitlement.symbol && entitlement.symbol.toUpperCase() !== baseSymbol.toUpperCase()) {
    return entitlement.symbol.toUpperCase();
  }

  if (actionType === "rights_issue") return `${baseSymbol}-R`;
  if (actionType === "warrant") return `${baseSymbol}-W`;
  return baseSymbol;
}

function titleFor(actionType: SupportedActionType, symbol: string) {
  const labels: Record<SupportedActionType, string> = {
    cash_dividend: "Dividend received",
    stock_split: "Stock split processed",
    reverse_split: "Reverse split processed",
    bonus_share: "Bonus shares received",
    rights_issue: "Rights entitlement received",
    warrant: "Warrant entitlement received",
    ipo_allocation: "IPO allocation shares received",
  };
  return `${labels[actionType]}: ${symbol}`;
}

async function applyCashMovement(tx: any, brokerAccountId: string, amount: number, referenceId: string, actionType: SupportedActionType) {
  if (Math.abs(amount) < 0.000001) return null;
  const [updated] = await tx
    .update(cash_balances)
    .set({
      available: sql`${cash_balances.available} + ${sqlNumeric(amount)}` as any,
      updated_at: new Date(),
    })
    .where(eq(cash_balances.broker_account_id, brokerAccountId))
    .returning();
  if (!updated) throw new Error(`Cash balance not found for broker account ${brokerAccountId}`);

  await tx.insert(ledger_movements).values({
    broker_account_id: brokerAccountId,
    asset_type: "CASH",
    symbol: null,
    amount: sqlNumeric(amount),
    balance_after: updated.available,
    reference_type: "CORPORATE_ACTION",
    reference_id: referenceId,
  });

  await createNotificationTx(tx, {
    brokerAccountId,
    type: "corporate_action",
    title: titleFor(actionType, "CASH"),
    body: `Corporate action cash movement ${amount >= 0 ? "+" : ""}${amount.toFixed(2)} has been posted.`,
    referenceType: "CORPORATE_ACTION",
    referenceId,
    idempotencyKey: `notification:ca:${referenceId}:${brokerAccountId}:cash`,
    metadata: { action_type: actionType, amount },
  });
  await appendBotAccountEventTx(tx, {
    brokerAccountId,
    eventType: "corporate_action_applied",
    entityId: `${referenceId}:cash`,
    entityVersion: 1,
    payload: { action_type: actionType, amount },
  });
  return updated;
}

async function applySecurityMovement(
  tx: any,
  brokerAccountId: string,
  symbol: string,
  quantityDelta: number,
  referenceId: string,
  actionType: SupportedActionType,
  payload?: CorporateActionWebhookPayload
) {
  const delta = Math.trunc(quantityDelta);
  if (delta === 0) return null;

  const [position] = await tx
    .select()
    .from(securities_positions)
    .where(and(eq(securities_positions.broker_account_id, brokerAccountId), eq(securities_positions.symbol, symbol)))
    .limit(1);

  const now = new Date();
  let updated: typeof securities_positions.$inferSelect | undefined;

  if (position) {
    const oldAvailable = Number(position.available || 0);
    const oldAverage = toNumber(position.average_price);
    const newAvailable = oldAvailable + delta;
    if (newAvailable < 0) throw new Error(`Corporate action would create negative position for ${symbol}`);

    let nextAverage = oldAverage;
    if ((actionType === "stock_split" || actionType === "reverse_split" || actionType === "bonus_share") && newAvailable > 0) {
      nextAverage = (oldAverage * oldAvailable) / newAvailable;
    }
    if (actionType === "rights_issue" || actionType === "warrant") {
      nextAverage = 0;
    }
    if (actionType === "ipo_allocation") {
      const buyPrice = toNumber(payload?.details?.offering_price || payload?.details?.ipo_price || 0);
      nextAverage = newAvailable > 0 ? ((oldAverage * oldAvailable) + (buyPrice * delta)) / newAvailable : 0;
    }

    [updated] = await tx
      .update(securities_positions)
      .set({
        available: newAvailable,
        average_price: sqlNumeric(nextAverage),
        updated_at: now,
      })
      .where(eq(securities_positions.id, position.id))
      .returning();
  } else {
    if (delta < 0) throw new Error(`Position not found for ${symbol}`);
    const ipoPrice = toNumber(payload?.details?.offering_price || payload?.details?.ipo_price || 0);
    [updated] = await tx
      .insert(securities_positions)
      .values({
        broker_account_id: brokerAccountId,
        symbol,
        available: delta,
        reserved: 0,
        pending: 0,
        average_price: sqlNumeric(ipoPrice),
        realized_pl: "0",
        unrealized_pl: "0",
      })
      .returning();
  }

  if (!updated) return null;

  await tx.insert(ledger_movements).values({
    broker_account_id: brokerAccountId,
    asset_type: "SECURITIES",
    symbol,
    amount: delta.toString(),
    balance_after: String(updated.available),
    reference_type: "CORPORATE_ACTION",
    reference_id: referenceId,
  });

  await createNotificationTx(tx, {
    brokerAccountId,
    type: "corporate_action",
    title: titleFor(actionType, symbol),
    body: `Corporate action adjusted ${symbol} by ${delta >= 0 ? "+" : ""}${delta} shares.`,
    referenceType: "CORPORATE_ACTION",
    referenceId,
    idempotencyKey: `notification:ca:${referenceId}:${brokerAccountId}:${symbol}`,
    metadata: { action_type: actionType, symbol, quantity_delta: delta },
  });
  await appendBotAccountEventTx(tx, {
    brokerAccountId,
    eventType: "corporate_action_applied",
    entityId: `${referenceId}:${symbol}`,
    entityVersion: 1,
    payload: { action_type: actionType, symbol, quantity_delta: delta },
  });

  return updated;
}

async function processExplicitEntitlements(
  tx: any,
  payload: CorporateActionWebhookPayload,
  actionType: SupportedActionType,
  symbol: string,
  referenceId: string
) {
  let processed = 0;
  for (const entitlement of entitlementRows(payload)) {
    const brokerAccountId = String(entitlement.broker_account_id || entitlement.investor_id || "").trim();
    if (!brokerAccountId) continue;

    const [account] = await tx.select().from(broker_accounts).where(eq(broker_accounts.id, brokerAccountId)).limit(1);
    if (!account) continue;

    const cashAmount = toNumber(entitlement.cash_amount);
    const quantity = toNumber(entitlement.quantity);
    const assetType = String(entitlement.asset_type || (cashAmount !== 0 ? "cash" : "security")).toLowerCase();

    if (assetType === "cash" || cashAmount !== 0) {
      await applyCashMovement(tx, account.id, cashAmount, referenceId, actionType);
      processed++;
      continue;
    }

    const targetSymbol = entitlementSymbol(symbol, actionType, entitlement, payload);
    await applySecurityMovement(tx, account.id, targetSymbol, quantity, referenceId, actionType, payload);
    processed++;
  }
  return processed;
}

async function processLocalPositionFallback(
  tx: any,
  payload: CorporateActionWebhookPayload,
  actionType: SupportedActionType,
  symbol: string,
  referenceId: string
) {
  const positions = await tx.select().from(securities_positions).where(eq(securities_positions.symbol, symbol));
  let processed = 0;
  for (const position of positions) {
    const totalShares = Number(position.available || 0) + Number(position.reserved || 0) + Number(position.pending || 0);
    if (totalShares <= 0) continue;

    if (actionType === "cash_dividend") {
      const amount = totalShares * toNumber(payload.details?.cash_amount_per_share);
      await applyCashMovement(tx, position.broker_account_id, amount, referenceId, actionType);
      processed++;
      continue;
    }

    const numerator = toNumber(payload.details?.ratio_numerator, 1);
    const denominator = toNumber(payload.details?.ratio_denominator, 1);
    if (denominator <= 0) throw new Error("Invalid corporate action ratio denominator");

    if (actionType === "stock_split" || actionType === "reverse_split") {
      const adjusted = Math.trunc(totalShares * (numerator / denominator));
      await applySecurityMovement(tx, position.broker_account_id, symbol, adjusted - totalShares, referenceId, actionType, payload);
      processed++;
      continue;
    }

    if (actionType === "bonus_share") {
      const bonus = Math.trunc(totalShares * (numerator / denominator));
      await applySecurityMovement(tx, position.broker_account_id, symbol, bonus, referenceId, actionType, payload);
      processed++;
      continue;
    }

    const targetSymbol = entitlementSymbol(symbol, actionType, {}, payload);
    const entitlement = Math.trunc(totalShares * (numerator / denominator));
    await applySecurityMovement(tx, position.broker_account_id, targetSymbol, entitlement, referenceId, actionType, payload);
    processed++;
  }
  return processed;
}

export async function processCorporateAction(payload: CorporateActionWebhookPayload) {
  const actionType = normalizeActionType(payload.action_type);
  const symbol = String(payload.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("Corporate action symbol is required");

  const referenceId = String(payload.corporate_action_id || payload.action_id || eventKey(payload));
  const key = eventKey(payload);
  const hash = payloadHash(payload);

  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(corporate_action_events)
      .values({
        idempotency_key: key,
        corporate_action_id: referenceId,
        action_type: actionType,
        symbol,
        payload_hash: hash,
        status: "processing",
      })
      .onConflictDoNothing()
      .returning();

    if (!event) {
      return { idempotent: true, processedAccounts: 0 };
    }

    const processedAccounts = entitlementRows(payload).length > 0
      ? await processExplicitEntitlements(tx, payload, actionType, symbol, referenceId)
      : await processLocalPositionFallback(tx, payload, actionType, symbol, referenceId);

    await tx
      .update(corporate_action_events)
      .set({ status: "processed", processed_at: new Date() })
      .where(eq(corporate_action_events.id, event.id));

    return {
      idempotent: false,
      eventId: event.id,
      processedAccounts,
      actionType,
      symbol,
    };
  });
}
