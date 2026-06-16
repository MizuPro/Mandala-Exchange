import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
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
  metadata: z.record(z.unknown()).default({})
});

async function positiveSecurityPositions(securityId: string) {
  const result = await pool.query(
    `
    SELECT custody_account_id, SUM(quantity) AS quantity
    FROM custody_ledger_entries
    WHERE security_id = $1 AND asset_type = 'security'
    GROUP BY custody_account_id
    HAVING SUM(quantity) > 0
    `,
    [securityId]
  );
  return result.rows as Array<{ custody_account_id: string; quantity: string }>;
}

export async function registerCorporateActionRoutes(app: FastifyInstance) {
  app.get("/corporate-actions", async () => db.select().from(corporateActions).orderBy(corporateActions.createdAt));

  app.post("/corporate-actions", async (request) => {
    const body = corporateActionBody.parse(request.body);
    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.id, body.securityId));
    if (!security) throw notFound("Security not found");
    const [created] = await db
      .insert(corporateActions)
      .values({
        ...body,
        ratioNumerator: body.ratioNumerator?.toString(),
        ratioDenominator: body.ratioDenominator?.toString(),
        cashAmountPerShare: body.cashAmountPerShare?.toString(),
        exercisePrice: body.exercisePrice?.toString()
      })
      .returning();
    if (!created) throw badRequest("Corporate action was not created");
    return created;
  });

  app.post("/corporate-actions/:id/process", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [action] = await db.select().from(corporateActions).where(eq(corporateActions.id, params.id));
    if (!action) throw notFound("Corporate action not found");
    if (action.status === "completed") return { idempotent: true, corporateAction: action };

    const positions = await positiveSecurityPositions(action.securityId);
    const ledgerRows = [];

    for (const position of positions) {
      const quantity = toNumber(position.quantity);
      if (action.type === "cash_dividend") {
        const amount = quantity * toNumber(action.cashAmountPerShare);
        ledgerRows.push({
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
        });
      }

      if (action.type === "stock_split" || action.type === "reverse_split") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const adjusted = quantity * (numerator / denominator);
        const delta = adjusted - quantity;
        ledgerRows.push({
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
        });
      }

      if (action.type === "bonus_share") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const bonus = quantity * (numerator / denominator);
        ledgerRows.push({
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
        });
      }

      if (action.type === "rights_issue" || action.type === "warrant") {
        const numerator = toNumber(action.ratioNumerator, 1);
        const denominator = toNumber(action.ratioDenominator, 1);
        const entitlement = quantity * (numerator / denominator);
        ledgerRows.push({
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
        });
      }
    }

    if (ledgerRows.length > 0) {
      await db.insert(custodyLedgerEntries).values(ledgerRows).onConflictDoNothing();
    }

    const [updated] = await db
      .update(corporateActions)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(corporateActions.id, action.id))
      .returning();
    return { corporateAction: updated, generatedLedgerEntries: ledgerRows.length };
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

  app.post("/ipo-events/:id/allocate", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ allocationRatio: z.coerce.number().min(0).max(1).default(1) }).parse(request.body);
    const [event] = await db.select().from(ipoEvents).where(eq(ipoEvents.id, params.id));
    if (!event) throw notFound("IPO event not found");
    if (!event.securityId) throw badRequest("IPO event must have securityId before allocation");

    const subscriptions = await db.select().from(ipoSubscriptions).where(eq(ipoSubscriptions.ipoEventId, event.id));
    const generated = [];
    for (const subscription of subscriptions) {
      const allocatedShares = Math.floor(toNumber(subscription.requestedShares) * body.allocationRatio);
      const allocationValue = allocatedShares * toNumber(event.offeringPrice);
      const [allocation] = await db
        .insert(ipoAllocations)
        .values({
          ipoSubscriptionId: subscription.id,
          allocatedShares: allocatedShares.toString(),
          allocationValue: allocationValue.toFixed(2)
        })
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
      generated.push(allocation);
    }

    await db.update(ipoEvents).set({ status: "allocation", updatedAt: new Date() }).where(eq(ipoEvents.id, event.id));
    return { allocations: generated };
  });

  app.get("/ipo-events", async () => db.select().from(ipoEvents).orderBy(ipoEvents.createdAt));
}
