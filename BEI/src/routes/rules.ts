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
import { initializeMdxSession } from "../services/mdxDelta.js";
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

    if (body.status === "pre_open") {
      initializeMdxSession().catch(err => console.error("[MDX-Delta] Failed to initialize session:", err));
    }

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

        if (summaryRes.rows.length > 0) {
          // 2. Update market_indices (MDX) using Market Cap weighted Close Price
          // MUST BE DONE BEFORE updating listed_securities previous_close!
          const idxRes = await pool.query(`
            WITH session_close AS (
              SELECT security_id, (array_agg(price ORDER BY sequence_number DESC))[1] as close_price
              FROM trades
              WHERE session_id = $1
              GROUP BY security_id
            ),
            index_calc AS (
              SELECT 
                SUM(COALESCE(sc.close_price, ls.previous_close, ls.reference_price) * ls.shares_outstanding) as current_mcap,
                SUM(COALESCE(ls.previous_close, ls.reference_price) * ls.shares_outstanding) as prev_mcap
              FROM listed_securities ls
              LEFT JOIN session_close sc ON sc.security_id = ls.id
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

          // 3. Update listed_securities (previous_close and reference_price)
          for (const row of summaryRes.rows) {
            await pool.query(`
              UPDATE listed_securities 
              SET previous_close = $1, reference_price = $1, updated_at = now()
              WHERE id = $2
            `, [row.close, row.security_id]);
          }
          console.log(`[Market-Data] Updated previous_close for ${summaryRes.rowCount} securities.`);
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

  /**
   * GET /integration/mats/sessions/instance/active
   *
   * Task 0.1: MATS memanggil endpoint ini saat startup untuk melihat apakah ada
   * session instance yang belum selesai (status != 'closed'). Jika ada, MATS
   * melanjutkan dari posisi terakhir (currentSegmentSequence, realTimeRemainingSeconds).
   * Jika tidak ada, MATS akan membuat instance baru via POST /activate.
   *
   * Scope: rules:read
   */
  app.get("/integration/mats/sessions/instance/active", async (_request, reply) => {
    const result = await pool.query(
      `SELECT si.*, st.name AS template_name, st.settlement_mode,
              COALESCE(json_agg(ss.* ORDER BY ss.sequence) FILTER (WHERE ss.id IS NOT NULL), '[]') AS segments
       FROM session_instances si
       JOIN session_templates st ON st.id = si.session_template_id
       LEFT JOIN session_segments ss ON ss.template_id = si.session_template_id
       WHERE si.status != 'closed'
       GROUP BY si.id, st.name, st.settlement_mode
       ORDER BY si.virtual_day_index DESC
       LIMIT 1`
    );

    if (!result.rows[0]) {
      return reply.status(200).send(null);
    }
    return result.rows[0];
  });

  /**
   * POST /integration/mats/sessions/instance/activate
   *
   * Task 0.1: MATS membuat session instance baru atau mengklaim instance yang
   * sudah ada (idempotent via virtual_day_index). MATS menyediakan virtual_day_index
   * yang monotonically increasing. BEI menyimpan mats_node_id untuk audit.
   *
   * Request: { session_template_id, virtual_day_index, virtual_duration_seconds,
   *            real_duration_seconds, mats_node_id? }
   * Scope: session:write
   */
  app.post("/integration/mats/sessions/instance/activate", async (request: any, reply) => {
    const bodySchema = z.object({
      session_template_id: z.string().uuid(),
      virtual_day_index: z.number().int().min(1),
      virtual_duration_seconds: z.number().int().min(1),
      real_duration_seconds: z.number().int().min(1),
      mats_node_id: z.string().optional()
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message || "Invalid instance payload",
          retryable: false,
          details: parsed.error.issues
        }
      });
    }

    const { session_template_id, virtual_day_index, virtual_duration_seconds, real_duration_seconds, mats_node_id } = parsed.data;

    // Cek apakah template aktif
    const templateResult = await pool.query(
      `SELECT id FROM session_templates WHERE id = $1 AND is_active = true LIMIT 1`,
      [session_template_id]
    );
    if (!templateResult.rows[0]) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Active session template ${session_template_id} not found`,
          retryable: false,
          details: {}
        }
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('session_instance_activate'))");
      const active = await client.query(`SELECT * FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`);
      if (active.rows[0]) {
        await client.query("COMMIT");
        return reply.status(200).send({ ...active.rows[0], created: false });
      }
      const existing = await client.query(`SELECT * FROM session_instances WHERE virtual_day_index = $1 LIMIT 1`, [virtual_day_index]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return reply.status(200).send({ ...existing.rows[0], created: false });
      }
      const insertResult = await client.query(
        `INSERT INTO session_instances (
           session_template_id, virtual_day_index, status, current_segment_sequence,
           virtual_duration_seconds, real_duration_seconds, real_time_remaining_seconds,
           mats_node_id, started_at, expected_end_at, version
         ) VALUES ($1, $2, 'pre_open', 0, $3, $4::int, $4::int, $5, now(),
                   now() + make_interval(secs => $4::int), 1)
         RETURNING *`,
        [session_template_id, virtual_day_index, virtual_duration_seconds, real_duration_seconds, mats_node_id || null]
      );
      await client.query("COMMIT");
      return reply.status(201).send({ ...insertResult.rows[0], created: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * POST /integration/mats/sessions/instance/finalize
   *
   * Task 0.1: MATS menandai session instance sebagai selesai ('closed').
   * Menggunakan optimistic locking via version untuk mencegah double-finalize.
   *
   * Request: { instance_id, version }
   * Scope: session:write
   */
  app.post("/integration/mats/sessions/instance/finalize", async (request: any, reply) => {
    const bodySchema = z.object({
      instance_id: z.string().uuid(),
      version: z.number().int().min(1)
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message || "Invalid finalize payload",
          retryable: false,
          details: parsed.error.issues
        }
      });
    }

    const { instance_id, version } = parsed.data;

    // Optimistic locking: versi harus cocok
    const updateResult = await pool.query(
      `UPDATE session_instances
       SET status = 'closed', finalized_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2 AND status != 'closed'
       RETURNING *`,
      [instance_id, version]
    );

    if (!updateResult.rows[0]) {
      // Cek apakah sudah closed (idempotent)
      const checkResult = await pool.query(
        `SELECT id, status, version FROM session_instances WHERE id = $1 LIMIT 1`,
        [instance_id]
      );
      const inst = checkResult.rows[0];

      if (!inst) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Session instance ${instance_id} not found`, retryable: false, details: {} }
        });
      }
      if (inst.status === "closed") {
        return reply.status(200).send({ id: inst.id, status: "closed", already_finalized: true });
      }
      return reply.status(409).send({
        error: {
          code: "VERSION_CONFLICT",
          message: `Optimistic lock failed: expected version ${version}, current version is ${inst.version}`,
          retryable: true,
          details: { current_version: inst.version }
        }
      });
    }

    return reply.status(200).send({ ...updateResult.rows[0], already_finalized: false });
  });
}
