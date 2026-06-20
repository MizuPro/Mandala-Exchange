import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import {
  autoRejectionRules,
  feeSchedules,
  lotSizeRules,
  marketSummaries,
  priceBandRules,
  sessionSegments,
  sessionTemplates,
  tickSizeRules,
  tradingHalts,
  tradingRuleProfiles
} from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest } from "../lib/errors.js";
import { boardTypes, sessionStatuses, settlementModes, tradingHaltStatuses } from "../types/enums.js";
import { publishMarketUpdate } from "../lib/redis.js";
import { config } from "../config.js";

const profileBody = z.object({
  name: z.string().min(3),
  board: z.enum(boardTypes),
  marketSegment: z.string().default("regular"),
  isDefault: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({})
});

const lotBody = z.object({
  profileId: z.string().uuid(),
  instrumentType: z.string().default("stock"),
  lotSize: z.coerce.number().int().positive().default(100),
  effectiveDate: z.string().date().optional()
});

const tickBody = z.object({
  profileId: z.string().uuid(),
  minPrice: z.coerce.number().positive(),
  maxPrice: z.coerce.number().positive().optional(),
  tickSize: z.coerce.number().positive()
});

const priceBandBody = z.object({
  profileId: z.string().uuid(),
  minReferencePrice: z.coerce.number().positive(),
  maxReferencePrice: z.coerce.number().positive().optional(),
  araPercent: z.coerce.number().positive(),
  arbPercent: z.coerce.number().positive(),
  minPrice: z.coerce.number().positive().default(1)
});

const autoRejectBody = z.object({
  profileId: z.string().uuid(),
  maxLotsPerOrder: z.coerce.number().int().positive(),
  maxListedSharesPercent: z.coerce.number().positive().optional()
});

const sessionTemplateBody = z.object({
  name: z.string().min(3),
  status: z.enum(sessionStatuses).default("closed"),
  settlementMode: z.enum(settlementModes).default("end_of_session"),
  settlementDelaySessions: z.coerce.number().int().min(0).default(0),
  postClosingEnabled: z.boolean().default(false),
  isActive: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({})
});

const sessionSegmentBody = z.object({
  templateId: z.string().uuid(),
  sequence: z.coerce.number().int().min(1),
  status: z.enum(sessionStatuses),
  durationSeconds: z.coerce.number().int().positive(),
  allowOrderEntry: z.boolean().default(false),
  allowCancelAmend: z.boolean().default(false)
});

const feeScheduleBody = z.object({
  name: z.string().min(3),
  brokerBuyRate: z.coerce.number().min(0),
  brokerSellRate: z.coerce.number().min(0),
  exchangeFeeRate: z.coerce.number().min(0),
  clearingFeeRate: z.coerce.number().min(0),
  settlementFeeRate: z.coerce.number().min(0),
  guaranteeFundRate: z.coerce.number().min(0).default(0),
  vatRate: z.coerce.number().min(0),
  sellTaxRate: z.coerce.number().min(0),
  minimumFee: z.coerce.number().min(0).default(0),
  effectiveDate: z.string().date(),
  isActive: z.boolean().default(true)
});

const haltBody = z.object({
  securityId: z.string().uuid().optional(),
  status: z.enum(tradingHaltStatuses).default("active"),
  reason: z.string().min(3),
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
  metadata: z.record(z.unknown()).default({})
});

function internalSettlementToken() {
  return config.BEI_SERVICE_TOKENS.find((identity) =>
    identity.scopes.includes("admin:*") || identity.scopes.includes("settlement:write")
  )?.token;
}

export async function registerRuleRoutes(app: FastifyInstance) {
  app.get("/rules/profiles", async () => db.select().from(tradingRuleProfiles).orderBy(tradingRuleProfiles.name));

  app.post("/rules/profiles", async (request) => {
    const body = profileBody.parse(request.body);
    const [created] = await db.insert(tradingRuleProfiles).values(body).returning();
    if (!created) throw badRequest("Rule profile was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "rule_profile.create",
      entityType: "trading_rule_profile",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.post("/rules/lot-sizes", async (request) => {
    const body = lotBody.parse(request.body);
    const [created] = await db.insert(lotSizeRules).values(body).returning();
    if (!created) throw badRequest("Lot size rule was not created");
    return created;
  });

  app.post("/rules/tick-sizes", async (request) => {
    const body = tickBody.parse(request.body);
    const [created] = await db
      .insert(tickSizeRules)
      .values({
        profileId: body.profileId,
        minPrice: body.minPrice.toString(),
        maxPrice: body.maxPrice?.toString(),
        tickSize: body.tickSize.toString()
      })
      .returning();
    if (!created) throw badRequest("Tick size rule was not created");
    return created;
  });

  app.post("/rules/price-bands", async (request) => {
    const body = priceBandBody.parse(request.body);
    const [created] = await db
      .insert(priceBandRules)
      .values({
        profileId: body.profileId,
        minReferencePrice: body.minReferencePrice.toString(),
        maxReferencePrice: body.maxReferencePrice?.toString(),
        araPercent: body.araPercent.toString(),
        arbPercent: body.arbPercent.toString(),
        minPrice: body.minPrice.toString()
      })
      .returning();
    if (!created) throw badRequest("Price band rule was not created");
    return created;
  });

  app.post("/rules/auto-rejections", async (request) => {
    const body = autoRejectBody.parse(request.body);
    const [created] = await db
      .insert(autoRejectionRules)
      .values({
        profileId: body.profileId,
        maxLotsPerOrder: body.maxLotsPerOrder,
        maxListedSharesPercent: body.maxListedSharesPercent?.toString()
      })
      .returning();
    if (!created) throw badRequest("Auto rejection rule was not created");
    return created;
  });

  app.post("/sessions/templates", async (request) => {
    const body = sessionTemplateBody.parse(request.body);
    const [created] = await db.insert(sessionTemplates).values(body).returning();
    if (!created) throw badRequest("Session template was not created");
    await publishMarketUpdate("session_template_created", { id: created.id });
    return created;
  });

  app.post("/sessions/segments", async (request) => {
    const body = sessionSegmentBody.parse(request.body);
    const [created] = await db.insert(sessionSegments).values(body).returning();
    if (!created) throw badRequest("Session segment was not created");
    await publishMarketUpdate("session_segment_created", { id: created.id });
    return created;
  });

  app.get("/integration/mats/sessions/active", async () => {
    const result = await pool.query(`
      SELECT t.*, COALESCE(json_agg(s.* ORDER BY s.sequence) FILTER (WHERE s.id IS NOT NULL), '[]') AS segments
      FROM session_templates t
      LEFT JOIN session_segments s ON s.template_id = t.id
      WHERE t.is_active = true
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  });

  app.post("/integration/mats/sessions/active/status", async (request) => {
    const body = z.object({
      sessionId: z.string().uuid(),
      status: z.enum(sessionStatuses),
      expectedTradeCount: z.coerce.number().int().min(0).optional(),
      finalTradeSequence: z.coerce.number().int().min(0).optional()
    }).parse(request.body);

    const [updated] = await db
      .update(sessionTemplates)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(sessionTemplates.id, body.sessionId))
      .returning();

    if (!updated) throw badRequest("Active session not found");

      // Auto-Settlement Trigger
    if (body.status === "closed") {
      // Trade capture finality barrier: if MATS provides an expected trade count,
      // verify that BEI has captured all trades before proceeding with settlement.
      if (body.expectedTradeCount !== undefined && body.expectedTradeCount > 0) {
        const capturedResult = await pool.query(
          `SELECT COUNT(*) AS trade_count FROM trades WHERE session_id = $1`,
          [body.sessionId]
        );
        const capturedCount = Number(capturedResult.rows[0]?.trade_count || 0);
        
        let meta = typeof updated.metadata === "object" && updated.metadata !== null ? updated.metadata : {};
        
        if (capturedCount < body.expectedTradeCount) {
          const newMetadata = {
            ...meta,
            settlementBlockedReason: `expected ${body.expectedTradeCount} trades but only ${capturedCount} captured`,
            settlementBlockedAt: new Date().toISOString()
          };
          await db.update(sessionTemplates)
            .set({ metadata: newMetadata })
            .where(eq(sessionTemplates.id, body.sessionId));

          throw badRequest(
            `Settlement blocked: expected ${body.expectedTradeCount} trades but only ${capturedCount} captured. ` +
            `Waiting for trade delivery to complete before settlement.`
          );
        } else {
          const newMetadata = { ...meta };
          delete (newMetadata as any).settlementBlockedReason;
          delete (newMetadata as any).settlementBlockedAt;
          await db.update(sessionTemplates)
            .set({ metadata: newMetadata })
            .where(eq(sessionTemplates.id, body.sessionId));
        }
      }

      // Data Aggregation & Market Summary Generation
      try {
        console.log(`[Market-Data] Starting aggregation for session ${body.sessionId}`);
        
        // 1. Aggregate trades to generate market_summaries
        const summaryRes = await pool.query(`
          INSERT INTO market_summaries (
            session_id, security_id, open, high, low, close, last, volume, value, frequency
          )
          SELECT 
            $1,
            security_id,
            (array_agg(price ORDER BY sequence_number ASC))[1] as open,
            MAX(price) as high,
            MIN(price) as low,
            (array_agg(price ORDER BY sequence_number DESC))[1] as close,
            (array_agg(price ORDER BY sequence_number DESC))[1] as last,
            SUM(quantity) as volume,
            SUM(value) as value,
            COUNT(id) as frequency
          FROM trades
          WHERE session_id = $1
          GROUP BY security_id
          RETURNING security_id, close, volume, value;
        `, [body.sessionId]);

        console.log(`[Market-Data] Generated summaries for ${summaryRes.rowCount} securities.`);

        // 2. Update listed_securities (previous_close and reference_price)
        if (summaryRes.rows.length > 0) {
          for (const row of summaryRes.rows) {
            await pool.query(`
              UPDATE listed_securities 
              SET previous_close = $1, reference_price = $1, updated_at = now()
              WHERE id = $2
            `, [row.close, row.security_id]);
          }
          console.log(`[Market-Data] Updated previous_close for ${summaryRes.rowCount} securities.`);

          // 3. Update market_indices (MDX) using Market Cap weighted VWAP
          const idxRes = await pool.query(`
            WITH session_vwap AS (
              SELECT security_id, SUM(price::numeric * quantity::numeric) / NULLIF(SUM(quantity::numeric), 0) as vwap
              FROM trades
              WHERE session_id = $1
              GROUP BY security_id
            ),
            index_calc AS (
              SELECT 
                SUM(s.vwap * ls.shares_outstanding) as current_mcap,
                SUM(COALESCE(ls.previous_close, ls.reference_price) * ls.shares_outstanding) as prev_mcap
              FROM session_vwap s
              JOIN listed_securities ls ON s.security_id = ls.id
            )
            UPDATE market_indices 
            SET 
              last_value = CASE 
                WHEN (SELECT prev_mcap FROM index_calc) > 0 
                THEN last_value * (SELECT current_mcap / prev_mcap FROM index_calc)
                ELSE last_value 
              END,
              calculated_at = now(), 
              updated_at = now()
            WHERE code = 'MDX'
            RETURNING last_value;
          `, [body.sessionId]);

          if (idxRes.rowCount && idxRes.rowCount > 0) {
            console.log(`[Market-Data] Updated index MDX to ${parseFloat(idxRes.rows[0].last_value).toFixed(2)}`);
          }
        }
      } catch (err) {
        console.error(`[Market-Data] Error aggregating session data:`, err);
        // Do not throw, allow settlement to proceed even if market data aggregation fails
      }

      const settlementToken = internalSettlementToken();
      if (!settlementToken) {
        throw badRequest("No internal settlement-capable service token configured — cannot trigger auto-settlement");
      }

      const createRes = await app.inject({
        method: "POST",
        url: "/v1/settlement/batches",
        headers: { "x-service-token": settlementToken },
        payload: { sessionId: body.sessionId, mode: "end_of_session" }
      });

      if (createRes.statusCode < 200 || createRes.statusCode >= 300) {
        throw new Error(`[Auto-Settlement] Failed to create batch: ${createRes.statusCode} ${createRes.body}`);
      }

      const createData = JSON.parse(createRes.body);
      if (createData.batch && createData.batch.id) {
        const processRes = await app.inject({
          method: "POST",
          url: `/v1/settlement/batches/${createData.batch.id}/process`,
          headers: { "x-service-token": settlementToken }
        });
        if (processRes.statusCode < 200 || processRes.statusCode >= 300) {
          throw new Error(`[Auto-Settlement] Failed to process settlement batch: ${processRes.statusCode} ${processRes.body}`);
        }
        console.log(`[Auto-Settlement] Successfully created and processed batch for session ${body.sessionId}`);
      }
    }

    await publishMarketUpdate("session_status_changed", {
      sessionId: body.sessionId,
      status: body.status,
    });

    return updated;
  });

  app.post("/fee-schedules", async (request) => {
    const body = feeScheduleBody.parse(request.body);
    const [created] = await db
      .insert(feeSchedules)
      .values({
        name: body.name,
        brokerBuyRate: body.brokerBuyRate.toString(),
        brokerSellRate: body.brokerSellRate.toString(),
        exchangeFeeRate: body.exchangeFeeRate.toString(),
        clearingFeeRate: body.clearingFeeRate.toString(),
        settlementFeeRate: body.settlementFeeRate.toString(),
        guaranteeFundRate: body.guaranteeFundRate.toString(),
        vatRate: body.vatRate.toString(),
        sellTaxRate: body.sellTaxRate.toString(),
        minimumFee: body.minimumFee.toString(),
        effectiveDate: body.effectiveDate,
        isActive: body.isActive
      })
      .returning();
    if (!created) throw badRequest("Fee schedule was not created");
    return created;
  });

  app.get("/public/fee-schedule", async () => {
    const rows = await db
      .select()
      .from(feeSchedules)
      .where(eq(feeSchedules.isActive, true))
      .orderBy(desc(feeSchedules.effectiveDate));
    return rows[0] ?? null;
  });

  app.post("/trading-halts", async (request) => {
    const body = haltBody.parse(request.body);
    const [created] = await db.insert(tradingHalts).values(body).returning();
    if (!created) throw badRequest("Trading halt was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "trading_halt.create",
      entityType: "trading_halt",
      entityId: created.id,
      after: created,
      reason: created.reason,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.post("/market-summaries", async (request) => {
    const body = z
      .object({
        sessionId: z.string(),
        securityId: z.string().uuid().optional(),
        open: z.coerce.number().optional(),
        high: z.coerce.number().optional(),
        low: z.coerce.number().optional(),
        close: z.coerce.number().optional(),
        last: z.coerce.number().optional(),
        volume: z.coerce.number().default(0),
        value: z.coerce.number().default(0),
        frequency: z.coerce.number().int().default(0),
        metadata: z.record(z.unknown()).default({})
      })
      .parse(request.body);

    const [created] = await db
      .insert(marketSummaries)
      .values({
        sessionId: body.sessionId,
        securityId: body.securityId,
        open: body.open?.toString(),
        high: body.high?.toString(),
        low: body.low?.toString(),
        close: body.close?.toString(),
        last: body.last?.toString(),
        volume: body.volume.toString(),
        value: body.value.toString(),
        frequency: body.frequency,
        metadata: body.metadata
      })
      .returning();
    if (!created) throw badRequest("Market summary was not created");
    return created;
  });

  app.get("/integration/mats/rules", async () => {
    const result = await pool.query(`
      SELECT p.*,
        COALESCE(json_agg(DISTINCT l.*) FILTER (WHERE l.id IS NOT NULL), '[]') AS lot_size_rules,
        COALESCE(json_agg(DISTINCT t.*) FILTER (WHERE t.id IS NOT NULL), '[]') AS tick_size_rules,
        COALESCE(json_agg(DISTINCT b.*) FILTER (WHERE b.id IS NOT NULL), '[]') AS price_band_rules,
        COALESCE(json_agg(DISTINCT a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS auto_rejection_rules
      FROM trading_rule_profiles p
      LEFT JOIN lot_size_rules l ON l.profile_id = p.id
      LEFT JOIN tick_size_rules t ON t.profile_id = p.id
      LEFT JOIN price_band_rules b ON b.profile_id = p.id
      LEFT JOIN auto_rejection_rules a ON a.profile_id = p.id
      GROUP BY p.id
      ORDER BY p.board, p.market_segment
    `);
    return result.rows;
  });
}
