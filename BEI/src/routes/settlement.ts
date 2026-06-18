import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import {
  custodyAccounts,
  custodyLedgerEntries,
  settlementBatches,
  settlementInstructions,
  trades
} from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { settlementModes } from "../types/enums.js";
import { ensureCustodyAccount } from "../services/custody.js";
import { postSekuritasWebhook } from "../services/sekuritas-webhook.js";
import { config } from "../config.js";

function internalSettlementToken() {
  return config.BEI_SERVICE_TOKENS.find((identity) =>
    identity.scopes.includes("admin:*") || identity.scopes.includes("settlement:write")
  )?.token;
}

const batchBody = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(settlementModes).default("end_of_session"),
  scheduledFor: z.coerce.date().optional()
});

async function loadTradeContext(sessionId: string) {
  const result = await pool.query(
    `
    SELECT t.*, bb.code AS buy_broker_code, sb.code AS sell_broker_code
    FROM trades t
    JOIN broker_members bb ON bb.id = t.buy_broker_id
    JOIN broker_members sb ON sb.id = t.sell_broker_id
    WHERE t.session_id = $1
    ORDER BY t.sequence_number
    `,
    [sessionId]
  );
  return result.rows;
}

async function notifySekuritasSettlement(sessionId: string, batchId: string) {
  const sessionTrades = await loadTradeContext(sessionId);
  const details = sessionTrades.flatMap((trade) => [
    {
      mats_order_id: trade.buy_order_id,
      trade_id: trade.mats_trade_id,
      idempotency_key: `settlement:${sessionId}:${trade.mats_trade_id}:buy`,
      price: Number(trade.price),
      quantity: Number(trade.quantity),
      side: "BUY",
      settled_at: new Date().toISOString()
    },
    {
      mats_order_id: trade.sell_order_id,
      trade_id: trade.mats_trade_id,
      idempotency_key: `settlement:${sessionId}:${trade.mats_trade_id}:sell`,
      price: Number(trade.price),
      quantity: Number(trade.quantity),
      side: "SELL",
      settled_at: new Date().toISOString()
    }
  ]);

  if (details.length === 0) return { skipped: true };

  return await postSekuritasWebhook("settlement", {
    session_id: sessionId,
    batch_id: batchId,
    status: "COMPLETED",
    details
  });
}

export async function registerSettlementRoutes(app: FastifyInstance) {
  app.post("/settlement/batches", async (request) => {
    const body = batchBody.parse(request.body);
    const [createdBatch] = await db
      .insert(settlementBatches)
      .values({ sessionId: body.sessionId, mode: body.mode, scheduledFor: body.scheduledFor })
      .onConflictDoNothing({ target: settlementBatches.sessionId })
      .returning();
    const [batch] = createdBatch
      ? [createdBatch]
      : await db.select().from(settlementBatches).where(eq(settlementBatches.sessionId, body.sessionId)).limit(1);
    if (!batch) throw badRequest("Settlement batch was not created");

    const sessionTrades = await loadTradeContext(body.sessionId);
    for (const trade of sessionTrades) {
      const buyer = await ensureCustodyAccount({
        brokerId: trade.buy_broker_id,
        brokerCode: trade.buy_broker_code,
        investorId: trade.buy_investor_id
      });
      const seller = await ensureCustodyAccount({
        brokerId: trade.sell_broker_id,
        brokerCode: trade.sell_broker_code,
        investorId: trade.sell_investor_id
      });

      await db
        .insert(settlementInstructions)
        .values([
          {
            batchId: batch.id,
            tradeId: trade.id,
            type: "dvp",
            status: "ready",
            fromCustodyAccountId: seller.id,
            toCustodyAccountId: buyer.id,
            securityId: trade.security_id,
            quantity: trade.quantity,
            cashAmount: "0",
            idempotencyKey: `settlement:${body.sessionId}:${trade.id}:security`
          },
          {
            batchId: batch.id,
            tradeId: trade.id,
            type: "rvp",
            status: "ready",
            fromCustodyAccountId: buyer.id,
            toCustodyAccountId: seller.id,
            securityId: trade.security_id,
            quantity: "0",
            cashAmount: trade.value,
            idempotencyKey: `settlement:${body.sessionId}:${trade.id}:cash`
          }
        ])
        .onConflictDoNothing();
    }

    return {
      batch,
      tradeCount: sessionTrades.length
    };
  });

  app.post("/settlement/batches/:id/process", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [batch] = await db.select().from(settlementBatches).where(eq(settlementBatches.id, params.id));
    if (!batch) throw notFound("Settlement batch not found");

    const instructions = await db
      .select()
      .from(settlementInstructions)
      .where(eq(settlementInstructions.batchId, params.id));

    for (const instruction of instructions) {
      if (instruction.status === "settled") continue;
      if (instruction.type === "dvp") {
        if (!instruction.fromCustodyAccountId || !instruction.toCustodyAccountId || !instruction.securityId) {
          throw badRequest("Invalid DVP instruction", instruction);
        }
        await db
          .insert(custodyLedgerEntries)
          .values([
            {
              custodyAccountId: instruction.fromCustodyAccountId,
              securityId: instruction.securityId,
              entryType: "trade_settlement",
              assetType: "security",
              quantity: `-${instruction.quantity}`,
              cashAmount: "0",
              positionState: "settled",
              referenceType: "settlement_instruction",
              referenceId: instruction.id,
              idempotencyKey: `ledger:${instruction.id}:seller-security`
            },
            {
              custodyAccountId: instruction.toCustodyAccountId,
              securityId: instruction.securityId,
              entryType: "trade_settlement",
              assetType: "security",
              quantity: instruction.quantity,
              cashAmount: "0",
              positionState: "settled",
              referenceType: "settlement_instruction",
              referenceId: instruction.id,
              idempotencyKey: `ledger:${instruction.id}:buyer-security`
            }
          ])
          .onConflictDoNothing();
      }

      if (instruction.type === "rvp") {
        if (!instruction.fromCustodyAccountId || !instruction.toCustodyAccountId) {
          throw badRequest("Invalid RVP instruction", instruction);
        }
        await db
          .insert(custodyLedgerEntries)
          .values([
            {
              custodyAccountId: instruction.fromCustodyAccountId,
              securityId: instruction.securityId,
              entryType: "cash_settlement",
              assetType: "cash",
              quantity: "0",
              cashAmount: `-${instruction.cashAmount}`,
              positionState: "settled",
              referenceType: "settlement_instruction",
              referenceId: instruction.id,
              idempotencyKey: `ledger:${instruction.id}:buyer-cash`
            },
            {
              custodyAccountId: instruction.toCustodyAccountId,
              securityId: instruction.securityId,
              entryType: "cash_settlement",
              assetType: "cash",
              quantity: "0",
              cashAmount: instruction.cashAmount,
              positionState: "settled",
              referenceType: "settlement_instruction",
              referenceId: instruction.id,
              idempotencyKey: `ledger:${instruction.id}:seller-cash`
            }
          ])
          .onConflictDoNothing();
      }

      await db
        .update(settlementInstructions)
        .set({ status: "settled", updatedAt: new Date() })
        .where(eq(settlementInstructions.id, instruction.id));
    }

    const [updatedBatch] = await db
      .update(settlementBatches)
      .set({ status: "settled", processedAt: new Date(), updatedAt: new Date() })
      .where(eq(settlementBatches.id, params.id))
      .returning();
    try {
      const webhookResult = await notifySekuritasSettlement(batch.sessionId, batch.id);
      
      let newStatus = "sent";
      let errorReason = null;
      if (webhookResult && "deferred" in webhookResult && webhookResult.deferred) {
        newStatus = "deferred";
        errorReason = (webhookResult as any).reason;
      }
      
      const [notifiedBatch] = await db
        .update(settlementBatches)
        .set({
          notificationStatus: newStatus,
          notificationAttempts: sql`${settlementBatches.notificationAttempts} + 1` as any,
          lastNotificationError: errorReason,
          notifiedAt: newStatus === "sent" ? new Date() : batch.notifiedAt,
          updatedAt: new Date()
        })
        .where(eq(settlementBatches.id, params.id))
        .returning();
      return notifiedBatch || updatedBatch;
    } catch (error: any) {
      await db
        .update(settlementBatches)
        .set({
          notificationStatus: "failed",
          notificationAttempts: sql`${settlementBatches.notificationAttempts} + 1` as any,
          lastNotificationError: error?.message || "Settlement notification failed",
          updatedAt: new Date()
        })
        .where(eq(settlementBatches.id, params.id));
      throw error;
    }
  });

  app.get("/settlement/session/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const result = await pool.query(
      `
      SELECT b.*, COALESCE(json_agg(i.*) FILTER (WHERE i.id IS NOT NULL), '[]') AS instructions
      FROM settlement_batches b
      LEFT JOIN settlement_instructions i ON i.batch_id = b.id
      WHERE b.session_id = $1
      GROUP BY b.id
      ORDER BY b.created_at DESC
      `,
      [params.sessionId]
    );
    return result.rows;
  });

  app.get("/custody/accounts/:brokerCode/:investorId/summary", async (request) => {
    const params = z
      .object({
        brokerCode: z.string().transform((value) => value.toUpperCase()),
        investorId: z.string()
      })
      .parse(request.params);
    const accountResult = await pool.query(
      `
      SELECT ca.*
      FROM custody_accounts ca
      JOIN broker_members bm ON bm.id = ca.broker_id
      WHERE bm.code = $1 AND ca.investor_id = $2
      `,
      [params.brokerCode, params.investorId]
    );
    const account = accountResult.rows[0];
    if (!account) throw notFound("Custody account not found");

    const positions = await pool.query(
      `
      SELECT cle.security_id, ls.symbol, cle.asset_type,
        SUM(cle.quantity) AS quantity,
        SUM(COALESCE(cle.cash_amount, 0)) AS cash_amount
      FROM custody_ledger_entries cle
      LEFT JOIN listed_securities ls ON ls.id = cle.security_id
      WHERE cle.custody_account_id = $1
      GROUP BY cle.security_id, ls.symbol, cle.asset_type
      ORDER BY ls.symbol NULLS LAST, cle.asset_type
      `,
      [account.id]
    );

    return { account, positions: positions.rows };
  });

  app.get("/reconciliation/:brokerCode/:investorId", async (request) => {
    const params = z
      .object({
        brokerCode: z.string().transform((value) => value.toUpperCase()),
        investorId: z.string()
      })
      .parse(request.params);
    const summary = await app.inject({
      method: "GET",
      url: `/v1/custody/accounts/${params.brokerCode}/${encodeURIComponent(params.investorId)}/summary`,
      headers: { "x-service-token": request.headers["x-service-token"] as string }
    });
    return JSON.parse(summary.body) as unknown;
  });

  app.get("/reports/settlements/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const result = await pool.query(
      `
      SELECT b.session_id, b.status AS batch_status, i.type, i.status AS instruction_status,
        COUNT(*) AS instruction_count, SUM(i.quantity) AS total_quantity, SUM(i.cash_amount) AS total_cash
      FROM settlement_batches b
      JOIN settlement_instructions i ON i.batch_id = b.id
      WHERE b.session_id = $1
      GROUP BY b.session_id, b.status, i.type, i.status
      ORDER BY i.type, i.status
      `,
      [params.sessionId]
    );
    return result.rows;
  });

  app.get("/reports/custody-movements", async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return db
      .select()
      .from(custodyLedgerEntries)
      .orderBy(sql`${custodyLedgerEntries.createdAt} DESC`)
      .limit(query.limit);
  });

  // Background retry job for deferred/failed settlements
  setInterval(async () => {
    try {
      const deferredBatches = await pool.query(
        `SELECT id FROM settlement_batches WHERE notification_status IN ('deferred', 'failed') AND updated_at < NOW() - INTERVAL '30 seconds' LIMIT 10`
      );
      const settlementToken = internalSettlementToken();
      for (const row of deferredBatches.rows) {
        await app.inject({
          method: "POST",
          url: `/v1/settlement/batches/${row.id}/process`,
          headers: settlementToken ? { "x-service-token": settlementToken } : {}
        });
      }
    } catch (err) {
      console.error("Retry deferred settlement failed", err);
    }
  }, 30000);
}
