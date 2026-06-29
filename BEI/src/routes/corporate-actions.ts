import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import {
  brokerMembers,
  corporateActions,
  custodyLedgerEntries,
  ipoAllocations,
  ipoEvents,
  ipoSubscriptions,
  listedSecurities
} from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { corporateActionStatuses, corporateActionTypes, ipoStatuses } from "../types/enums.js";
import { ensureCustodyAccount } from "../services/custody.js";
import { toNumber } from "../lib/number.js";
import { postSekuritasWebhook } from "../services/sekuritas-webhook.js";

const corporateActionBody = z.object({
  securityId: z.string().uuid(),
  type: z.enum(corporateActionTypes),
  status: z.enum(corporateActionStatuses).default("draft"),
  title: z.string().min(3),
  description: z.string().default(""),
  announcementDate: z.string().date().optional(),
  recordingDate: z.string().date().optional(),
  executionDate: z.string().date().optional(),
  ratioNumerator: z.coerce.number().positive().optional(),
  ratioDenominator: z.coerce.number().positive().optional(),
  cashAmountPerShare: z.coerce.number().positive().optional(),
  exercisePrice: z.coerce.number().positive().optional(),
  entitlementSymbol: z.string().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.unknown()).default({})
});

const ipoEventBody = z.object({
  issuerId: z.string().uuid(),
  securityId: z.string().uuid().optional(),
  offeredShares: z.coerce.number().positive(),
  offeringPrice: z.coerce.number().positive(),
  bookbuildingStart: z.coerce.date().optional(),
  bookbuildingEnd: z.coerce.date().optional(),
  subscriptionStart: z.coerce.date().optional(),
  subscriptionEnd: z.coerce.date().optional(),
  listingDate: z.string().date().optional(),
  status: z.enum(ipoStatuses).default("draft"),
  underwriterBrokerId: z.string().uuid(),
  metadata: z.record(z.unknown()).default({})
});

async function positiveSecurityPositions(securityId: string) {
  const result = await pool.query(
    `
    SELECT cle.custody_account_id, ca.investor_id, ca.sid, ca.sre, ca.rdn, bm.code AS broker_code, SUM(cle.quantity) AS quantity
    FROM custody_ledger_entries cle
    JOIN custody_accounts ca ON ca.id = cle.custody_account_id
    JOIN broker_members bm ON bm.id = ca.broker_id
    WHERE cle.security_id = $1 AND cle.asset_type = 'security'
    GROUP BY cle.custody_account_id, ca.id, bm.id
    HAVING SUM(cle.quantity) > 0
    `,
    [securityId]
  );
  return result.rows as Array<{
    custody_account_id: string;
    investor_id: string;
    sid: string;
    sre: string;
    rdn: string;
    broker_code: string;
    quantity: string;
  }>;
}

function entitlementFromLedgerRow(row: any, position: Awaited<ReturnType<typeof positiveSecurityPositions>>[number], symbol: string) {
  return {
    broker_account_id: position.investor_id,
    investor_id: position.investor_id,
    broker_code: position.broker_code,
    custody_account_id: position.custody_account_id,
    sid: position.sid,
    sre: position.sre,
    rdn: position.rdn,
    symbol,
    asset_type: row.assetType,
    quantity: row.quantity,
    cash_amount: row.cashAmount,
    idempotency_key: row.idempotencyKey
  };
}

async function existingEntitlementsForAction(actionId: string, symbol: string) {
  const result = await pool.query(
    `
    SELECT cle.*, ca.investor_id, ca.sid, ca.sre, ca.rdn, bm.code AS broker_code
    FROM custody_ledger_entries cle
    JOIN custody_accounts ca ON ca.id = cle.custody_account_id
    JOIN broker_members bm ON bm.id = ca.broker_id
    WHERE cle.reference_type = 'corporate_action' AND cle.reference_id = $1
    ORDER BY cle.created_at
    `,
    [actionId]
  );
  return result.rows.map((row) => ({
    broker_account_id: row.investor_id,
    investor_id: row.investor_id,
    broker_code: row.broker_code,
    custody_account_id: row.custody_account_id,
    sid: row.sid,
    sre: row.sre,
    rdn: row.rdn,
    symbol,
    asset_type: row.asset_type,
    quantity: row.quantity,
    cash_amount: row.cash_amount,
    idempotency_key: row.idempotency_key
  }));
}

async function sendCorporateActionWebhook(action: typeof corporateActions.$inferSelect, symbol: string, entitlements: unknown[]) {
  const metadata = action.metadata as any;
  const entitlementSymbol = metadata?.entitlement_symbol || metadata?.entitlementSymbol;

  await postSekuritasWebhook("corporate_action", {
    event_id: `bei:corporate-action:${action.id}:completed`,
    idempotency_key: action.idempotencyKey || `bei:corporate-action:${action.id}:completed`,
    corporate_action_id: action.id,
    action_type: action.type,
    symbol,
    title: action.title,
    details: {
      security_id: action.securityId,
      ratio_numerator: action.ratioNumerator,
      ratio_denominator: action.ratioDenominator,
      cash_amount_per_share: action.cashAmountPerShare,
      exercise_price: action.exercisePrice,
      announcement_date: action.announcementDate,
      recording_date: action.recordingDate,
      execution_date: action.executionDate,
      description: action.description,
      entitlement_symbol: entitlementSymbol,
      metadata: action.metadata
    },
    entitlements
  });
}

export async function registerCorporateActionRoutes(app: FastifyInstance) {
  app.get("/corporate-actions", async () => db.select().from(corporateActions).orderBy(corporateActions.createdAt));

  app.post("/corporate-actions", async (request) => {
    const body = corporateActionBody.parse(request.body);
    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.id, body.securityId));
    if (!security) throw notFound("Security not found");

    const entitlementSymbol = body.entitlementSymbol || (request.body as any).entitlementSymbol;
    const metadata = {
      ...body.metadata,
      ...(entitlementSymbol ? { entitlement_symbol: entitlementSymbol } : {})
    };

    const [created] = await db
      .insert(corporateActions)
      .values({
        ...body,
        ratioNumerator: body.ratioNumerator?.toString(),
        ratioDenominator: body.ratioDenominator?.toString(),
        cashAmountPerShare: body.cashAmountPerShare?.toString(),
        exercisePrice: body.exercisePrice?.toString(),
        metadata
      })
      .returning();
    if (!created) throw badRequest("Corporate action was not created");
    return created;
  });

  app.post("/corporate-actions/:id/process", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [action] = await db.select().from(corporateActions).where(eq(corporateActions.id, params.id));
    if (!action) throw notFound("Corporate action not found");
    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.id, action.securityId));
    if (!security) throw notFound("Security not found");
    if (action.status === "completed") {
      const entitlements = await existingEntitlementsForAction(action.id, security.symbol);
      await sendCorporateActionWebhook(action, security.symbol, entitlements);
      return { idempotent: true, corporateAction: action, webhookEntitlements: entitlements.length };
    }

    const positions = await positiveSecurityPositions(action.securityId);
    const ledgerRows = [];
    const entitlements = [];

    for (const position of positions) {
      const quantity = toNumber(position.quantity);
      if (action.type === "cash_dividend") {
        const amount = quantity * toNumber(action.cashAmountPerShare);
        const row = {
          custodyAccountId: position.custody_account_id,
          securityId: action.securityId,
          entryType: "cash_dividend" as const,
          assetType: "cash" as const,
          quantity: "0",
          cashAmount: amount.toFixed(2),
          positionState: "settled",
          referenceType: "corporate_action",
          referenceId: action.id,
          idempotencyKey: `ledger:ca:${action.id}:${position.custody_account_id}:cash-dividend`
        };
        ledgerRows.push(row);
        entitlements.push(entitlementFromLedgerRow(row, position, security.symbol));
      }

      if (action.type === "stock_split" || action.type === "reverse_split") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const adjusted = quantity * (numerator / denominator);
        const delta = adjusted - quantity;
        const row = {
          custodyAccountId: position.custody_account_id,
          securityId: action.securityId,
          entryType: action.type,
          assetType: "security" as const,
          quantity: delta.toFixed(4),
          cashAmount: "0",
          positionState: "settled",
          referenceType: "corporate_action",
          referenceId: action.id,
          idempotencyKey: `ledger:ca:${action.id}:${position.custody_account_id}:${action.type}`
        };
        ledgerRows.push(row);
        entitlements.push(entitlementFromLedgerRow(row, position, security.symbol));
      }

      if (action.type === "bonus_share") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const bonus = quantity * (numerator / denominator);
        const row = {
          custodyAccountId: position.custody_account_id,
          securityId: action.securityId,
          entryType: "bonus_share" as const,
          assetType: "security" as const,
          quantity: bonus.toFixed(4),
          cashAmount: "0",
          positionState: "settled",
          referenceType: "corporate_action",
          referenceId: action.id,
          idempotencyKey: `ledger:ca:${action.id}:${position.custody_account_id}:bonus`
        };
        ledgerRows.push(row);
        entitlements.push(entitlementFromLedgerRow(row, position, security.symbol));
      }

      if (action.type === "rights_issue" || action.type === "warrant") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const entitlement = quantity * (numerator / denominator);
        const row = {
          custodyAccountId: position.custody_account_id,
          securityId: action.securityId,
          entryType: action.type,
          assetType: action.type === "rights_issue" ? ("right" as const) : ("warrant" as const),
          quantity: entitlement.toFixed(4),
          cashAmount: "0",
          positionState: "settled",
          referenceType: "corporate_action",
          referenceId: action.id,
          idempotencyKey: `ledger:ca:${action.id}:${position.custody_account_id}:${action.type}`
        };
        ledgerRows.push(row);
        entitlements.push(entitlementFromLedgerRow(row, position, security.symbol));
      }
    }

    if (ledgerRows.length > 0) {
      await db.insert(custodyLedgerEntries).values(ledgerRows).onConflictDoNothing();
    }

    // POIN 2: Auto-register simbol waran/right ke listed_securities jika belum ada
    if (action.type === "rights_issue" || action.type === "warrant") {
      const suffix = action.type === "rights_issue" ? "-R" : "-W";
      const derivativeSymbol = `${security.symbol}${suffix}`;
      const derivativeName = action.type === "rights_issue"
        ? `${security.name} - Rights Issue`
        : `${security.name} - Warrant`;
      const numeratorVal = toNumber(action.ratioNumerator, 1);
      const denominatorVal = toNumber(action.ratioDenominator, 1);
      const totalDerivativeShares = positions.reduce((sum, p) => {
        return sum + Math.trunc(toNumber(p.quantity) * (numeratorVal / denominatorVal));
      }, 0);
      await pool.query(
        `INSERT INTO listed_securities
           (issuer_id, symbol, name, board, sector, shares_outstanding,
            ipo_price, reference_price, previous_close, status, market_mechanism, listed_at)
         VALUES ($1, $2, $3, 'derivatives', $4, $5, 50, 50, 50, 'listed', 'regular', CURRENT_DATE)
         ON CONFLICT (symbol) DO NOTHING`,
        [security.issuerId, derivativeSymbol, derivativeName, security.sector, totalDerivativeShares]
      );
    }

    const [updated] = await db
      .update(corporateActions)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(corporateActions.id, action.id))
      .returning();
    await sendCorporateActionWebhook(action, security.symbol, entitlements);
    return { corporateAction: updated, generatedLedgerEntries: ledgerRows.length, webhookEntitlements: entitlements.length };
  });

  app.post("/ipo-events", async (request) => {
    const body = ipoEventBody.parse(request.body);
    const [created] = await db
      .insert(ipoEvents)
      .values({
        ...body,
        offeredShares: body.offeredShares.toString(),
        offeringPrice: body.offeringPrice.toString()
      })
      .returning();
    if (!created) throw badRequest("IPO event was not created");
    return created;
  });

  app.get("/ipo-events/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "IPO event not found", retryable: false, details: {} } });
    return {
      id: event.id,
      status: event.status,
      offering_price_idr: String(event.offeringPrice),
      offered_shares: Number(event.offeredShares),
      subscription_lot_size: Number((event.metadata as any)?.subscription_lot_size || 100),
      subscription_start: event.subscriptionStart,
      subscription_end: event.subscriptionEnd,
      listing_at: event.listingDate,
      version: Number((event.metadata as any)?.version || 1),
    };
  });

  app.post("/ipo-events/:id/subscriptions", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        brokerCode: z.string().transform((value) => value.toUpperCase()),
        investorId: z.string().min(1),
        requestedShares: z.coerce.number().positive(),
        idempotencyKey: z.string().min(8)
      })
      .parse(request.body);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) throw notFound("IPO event not found");
    const [broker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, body.brokerCode));
    if (!broker || broker.status !== "active") throw badRequest("Broker is not active");

    const [created] = await db
      .insert(ipoSubscriptions)
      .values({
        ipoEventId: event.id,
        brokerId: broker.id,
        investorId: body.investorId,
        requestedShares: body.requestedShares.toString(),
        idempotencyKey: body.idempotencyKey
      })
      .onConflictDoNothing()
      .returning();
    return created ?? { idempotent: true };
  });

  app.post("/ipo-events/:id/subscriptions/:subscriptionId/cancel", async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).parse(request.params);
    const [subscription] = await db.select().from(ipoSubscriptions).where(and(eq(ipoSubscriptions.id, params.subscriptionId), eq(ipoSubscriptions.ipoEventId, params.id)));
    if (!subscription) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "IPO subscription not found", retryable: false, details: {} } });
    if (subscription.status === "cancelled") return { id: subscription.id, status: "cancelled", idempotent: true };
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event || event.status !== "subscription" || (event.subscriptionEnd && Date.now() > new Date(event.subscriptionEnd).getTime())) {
      return reply.status(409).send({ error: { code: "IPO_NOT_OPEN", message: "IPO subscription can no longer be cancelled", retryable: false, details: {} } });
    }
    await db.update(ipoSubscriptions).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ipoSubscriptions.id, subscription.id));
    return { id: subscription.id, status: "cancelled" };
  });

  app.post("/ipo-events/:id/allocate", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ allocationRatio: z.coerce.number().min(0).max(1).default(1) }).parse(request.body);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) throw notFound("IPO event not found");
    if (!event.securityId) throw badRequest("IPO event must have securityId before allocation");
    if (!event.underwriterBrokerId) throw badRequest("IPO event must have underwriterBrokerId before allocation");

    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.id, event.securityId));
    const symbol = security?.symbol || "N/A";

    const [underwriterBroker] = await db.select().from(brokerMembers).where(eq(brokerMembers.id, event.underwriterBrokerId));
    if (!underwriterBroker) throw badRequest("Underwriter broker not found");
    const underwriterAccount = await ensureCustodyAccount({
      brokerId: underwriterBroker.id,
      brokerCode: underwriterBroker.code,
      investorId: `TREASURY_IPO_${event.id}`
    });

    // Mint initial supply to Underwriter Account
    await db
      .insert(custodyLedgerEntries)
      .values({
        custodyAccountId: underwriterAccount.id,
        securityId: event.securityId,
        entryType: "ipo_allocation",
        assetType: "security",
        quantity: event.offeredShares.toString(),
        cashAmount: "0",
        positionState: "settled",
        referenceType: "ipo_allocation",
        referenceId: event.id,
        idempotencyKey: `ledger:ipo:mint:${event.id}`
      })
      .onConflictDoNothing();

    const subscriptions = await db.select().from(ipoSubscriptions).where(eq(ipoSubscriptions.ipoEventId, event.id));
    const generated = [];
    const entitlements = [];

    for (const subscription of subscriptions) {
      const allocatedShares = Math.floor(toNumber(subscription.requestedShares) * body.allocationRatio);
      const allocationValue = allocatedShares * toNumber(event.offeringPrice);
      const [allocation] = await db
        .insert(ipoAllocations)
        .values({
          ipoSubscriptionId: subscription.id,
          allocatedShares: allocatedShares.toString(),
          allocationValue: allocationValue.toFixed(2),
          allocationKey: `ipo:${event.id}:${subscription.id}`
        }).onConflictDoNothing()
        .returning();
      if (!allocation) continue;

      const [broker] = await db.select().from(brokerMembers).where(eq(brokerMembers.id, subscription.brokerId));
      if (!broker) continue;
      const account = await ensureCustodyAccount({
        brokerId: broker.id,
        brokerCode: broker.code,
        investorId: subscription.investorId
      });
      await db
        .insert(custodyLedgerEntries)
        .values({
          custodyAccountId: account.id,
          securityId: event.securityId,
          entryType: "ipo_allocation",
          assetType: "security",
          quantity: allocatedShares.toString(),
          cashAmount: "0",
          positionState: "settled",
          referenceType: "ipo_allocation",
          referenceId: allocation.id,
          idempotencyKey: `ledger:ipo:${allocation.id}`
        })
        .onConflictDoNothing();

      // Double-Entry: Debit Securities from Underwriter Account
      await db
        .insert(custodyLedgerEntries)
        .values({
          custodyAccountId: underwriterAccount.id,
          securityId: event.securityId,
          entryType: "ipo_allocation",
          assetType: "security",
          quantity: (-allocatedShares).toString(),
          cashAmount: "0",
          positionState: "settled",
          referenceType: "ipo_allocation",
          referenceId: allocation.id,
          idempotencyKey: `ledger:ipo:${allocation.id}:underwriter_sec`
        })
        .onConflictDoNothing();

      generated.push(allocation);

      entitlements.push({
        broker_account_id: subscription.investorId,
        investor_id: subscription.investorId,
        broker_code: broker.code,
        symbol: symbol,
        asset_type: "security",
        quantity: allocatedShares,
        idempotency_key: `ledger:ipo:${allocation.id}`
      });

      // POIN 1: Pemotongan kas RDN senilai alokasi IPO
      const totalCost = allocatedShares * toNumber(event.offeringPrice);
      if (totalCost > 0) {
        await db
          .insert(custodyLedgerEntries)
          .values({
            custodyAccountId: account.id,
            securityId: event.securityId,
            entryType: "ipo_allocation",
            assetType: "cash",
            quantity: "0",
            cashAmount: (-totalCost).toFixed(2),
            positionState: "settled",
            referenceType: "ipo_allocation",
            referenceId: allocation.id,
            idempotencyKey: `ledger:ipo:${allocation.id}:cash`
          })
          .onConflictDoNothing();

        // Double-Entry: Credit Cash to Underwriter Account
        await db
          .insert(custodyLedgerEntries)
          .values({
            custodyAccountId: underwriterAccount.id,
            securityId: event.securityId,
            entryType: "ipo_allocation",
            assetType: "cash",
            quantity: "0",
            cashAmount: totalCost.toFixed(2),
            positionState: "settled",
            referenceType: "ipo_allocation",
            referenceId: allocation.id,
            idempotencyKey: `ledger:ipo:${allocation.id}:underwriter_cash`
          })
          .onConflictDoNothing();

        entitlements.push({
          broker_account_id: subscription.investorId,
          investor_id: subscription.investorId,
          broker_code: broker.code,
          symbol: symbol,
          asset_type: "cash",
          quantity: 0,
          cash_amount: -totalCost,
          idempotency_key: `ledger:ipo:${allocation.id}:cash`
        });
      }
    }

    await db.update(ipoEvents).set({ status: "allocation", updatedAt: new Date() }).where(eq(ipoEvents.id, event.id));

    if (generated.length > 0) {
      try {
        await postSekuritasWebhook("corporate_action", {
          event_id: `bei:ipo-allocation:${event.id}:completed`,
          idempotency_key: `bei:ipo-allocation:${event.id}:completed`,
          corporate_action_id: event.id,
          action_type: "ipo_allocation",
          symbol,
          title: `IPO Allocation: ${symbol}`,
          details: {
            offering_price: toNumber(event.offeringPrice)
          },
          entitlements
        });
      } catch (err: any) {
        request.log.error(err, "Failed to send IPO allocation webhook to Sekuritas");
      }
    }

    return { allocations: generated };
  });

  app.post("/ipo-events/:id/list", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "IPO event not found", retryable: false, details: {} } });
    if (event.status === "listed") return { id: event.id, status: "listed", idempotent: true };
    if (event.status !== "allocation") return reply.status(409).send({ error: { code: "IPO_NOT_OPEN", message: "IPO must be allocated before listing", retryable: false, details: {} } });
    const [security] = event.securityId ? await db.select().from(listedSecurities).where(eq(listedSecurities.id, event.securityId)) : [];
    await db.update(ipoEvents).set({ status: "listed", updatedAt: new Date() }).where(eq(ipoEvents.id, event.id));
    await postSekuritasWebhook("corporate_action", {
      event_id: `bei:ipo-listing:${event.id}`,
      idempotency_key: `bei:ipo-listing:${event.id}`,
      corporate_action_id: event.id,
      action_type: "ipo_listing",
      symbol: security?.symbol || "N/A",
      entitlements: [],
    });
    return { id: event.id, status: "listed" };
  });

  app.post("/ipo-events/:id/cancel", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "IPO event not found", retryable: false, details: {} } });
    if (event.status === "cancelled") return { id: event.id, status: "cancelled", idempotent: true };
    if (event.status === "listed") return reply.status(409).send({ error: { code: "IPO_NOT_OPEN", message: "Listed IPO requires exceptional corporate-action process", retryable: false, details: {} } });
    const previousStatus = event.status;
    const [security] = event.securityId ? await db.select().from(listedSecurities).where(eq(listedSecurities.id, event.securityId)) : [];
    if (previousStatus === "allocation" && event.securityId) {
      const subscriptions = await db.select().from(ipoSubscriptions).where(eq(ipoSubscriptions.ipoEventId, event.id));
      for (const subscription of subscriptions) {
        const [allocation] = await db.select().from(ipoAllocations).where(eq(ipoAllocations.ipoSubscriptionId, subscription.id));
        if (!allocation || toNumber(allocation.allocatedShares) <= 0) continue;
        const [broker] = await db.select().from(brokerMembers).where(eq(brokerMembers.id, subscription.brokerId));
        if (!broker) continue;
        const account = await ensureCustodyAccount({ brokerId: broker.id, brokerCode: broker.code, investorId: subscription.investorId });
        await db.insert(custodyLedgerEntries).values([
          {
            custodyAccountId: account.id, securityId: event.securityId, entryType: "reversal", assetType: "security",
            quantity: (-toNumber(allocation.allocatedShares)).toString(), cashAmount: "0", positionState: "settled",
            referenceType: "ipo_reversal", referenceId: allocation.id, idempotencyKey: `ledger:ipo:${allocation.id}:reversal:security`
          },
          {
            custodyAccountId: account.id, securityId: event.securityId, entryType: "reversal", assetType: "cash",
            quantity: "0", cashAmount: toNumber(allocation.allocationValue).toFixed(2), positionState: "settled",
            referenceType: "ipo_reversal", referenceId: allocation.id, idempotencyKey: `ledger:ipo:${allocation.id}:reversal:cash`
          }
        ]).onConflictDoNothing();
      }
    }
    await db.update(ipoEvents).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ipoEvents.id, event.id));
    await postSekuritasWebhook("corporate_action", {
      event_id: `bei:ipo-cancel:${event.id}`,
      idempotency_key: `bei:ipo-cancel:${event.id}`,
      corporate_action_id: event.id,
      action_type: previousStatus === "allocation" ? "ipo_reversal" : "ipo_cancellation",
      symbol: security?.symbol || "N/A",
      entitlements: [],
    });
    return { id: event.id, status: "cancelled" };
  });

  app.get("/ipo-events", async () => db.select().from(ipoEvents).orderBy(ipoEvents.createdAt));
}
