import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { fairValues, marketRegimes, securityLiquidityProfiles } from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest } from "../lib/errors.js";
import { config } from "../config.js";
import { listPublicIpos } from "../services/ipo-public.js";

// Validation schema untuk set fair value
const fairValueBody = z.object({
  symbol: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
  fairValue: z.number().positive(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  method: z.string().default("admin_estimate"),
  effectiveFromSession: z.number().int().optional(),
  effectiveUntilSession: z.number().int().optional(),
  notes: z.string().optional(),
  visibleToPlayer: z.boolean().default(true),
  visibleToBot: z.boolean().default(true)
});

// Validation schema untuk set market regime
const marketRegimeBody = z.object({
  sessionId: z.number().int().optional(),
  globalRegime: z.enum([
    "neutral",
    "mild_positive",
    "mild_negative",
    "strong_positive",
    "strong_negative",
    "event_driven",
    "panic"
  ]).default("neutral"),
  sectorRegimes: z.record(z.string()).default({}),
  volatilityRegime: z.enum(["low", "normal", "high", "extreme"]).default("normal")
});

export async function registerBotRoutes(app: FastifyInstance) {
  // 1. GET /bot/daftar-saham-aktif
  app.get("/bot/daftar-saham-aktif", async () => {
    const result = await pool.query(`
      SELECT 
        s.id, 
        s.symbol, 
        s.name, 
        s.board, 
        s.sector, 
        s.shares_outstanding AS shares_outstanding, 
        s.ipo_price AS ipo_price, 
        s.reference_price AS reference_price, 
        s.previous_close AS previous_close, 
        s.status, 
        s.market_mechanism, 
        s.listed_at,
        i.code AS issuer_code, 
        i.name AS issuer_name,
        COALESCE(json_agg(n.*) FILTER (WHERE n.id IS NOT NULL AND n.is_active = true), '[]') AS active_notations
      FROM listed_securities s
      JOIN issuers i ON i.id = s.issuer_id
      LEFT JOIN special_notations n ON n.security_id = s.id
      WHERE s.status = 'listed'
      GROUP BY s.id, i.id
      ORDER BY s.symbol;
    `);
    return result.rows;
  });

  // 2. GET /bot/trading-rules
  app.get("/bot/trading-rules", async () => {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.board,
        p.market_segment,
        p.is_default,
        p.metadata,
        COALESCE(
          (
            SELECT json_agg(l.*) 
            FROM lot_size_rules l 
            WHERE l.profile_id = p.id
          ),
          '[]'
        ) AS lot_size_rules,
        COALESCE(
          (
            SELECT json_agg(t.* ORDER BY t.min_price::numeric) 
            FROM tick_size_rules t 
            WHERE t.profile_id = p.id
          ),
          '[]'
        ) AS tick_size_rules,
        COALESCE(
          (
            SELECT json_agg(b.*) 
            FROM price_band_rules b 
            WHERE b.profile_id = p.id
          ),
          '[]'
        ) AS price_band_rules,
        COALESCE(
          (
            SELECT json_agg(a.*) 
            FROM auto_rejection_rules a 
            WHERE a.profile_id = p.id
          ),
          '[]'
        ) AS auto_rejection_rules
      FROM trading_rule_profiles p
      ORDER BY p.board, p.market_segment;
    `);
    return result.rows;
  });

  // 3. GET /bot/fee-schedule
  app.get("/bot/fee-schedule", async () => {
    const result = await pool.query(`
      SELECT *
      FROM fee_schedules
      ORDER BY name;
    `);
    return result.rows;
  });

  // 4. GET /bot/session-state
  app.get("/bot/session-state", async () => {
    const result = await pool.query(`
      SELECT si.*, st.name AS template_name
      FROM session_instances si
      JOIN session_templates st ON st.id = si.session_template_id
      ORDER BY si.virtual_day_index DESC
      LIMIT 1;
    `);
    return result.rows[0] ?? null;
  });

  // 5. GET /bot/ipo-lifecycle
  app.get("/bot/ipo-lifecycle", async (_request, reply) => listPublicIpos(reply));

  // 6. GET /bot/corporate-action-minimal
  app.get("/bot/corporate-action-minimal", async () => {
    const result = await pool.query(`
      SELECT 
        c.*,
        s.symbol AS security_symbol
      FROM corporate_actions c
      JOIN listed_securities s ON s.id = c.security_id
      WHERE c.status IN ('announced', 'recording', 'processing')
      ORDER BY c.announcement_date DESC;
    `);
    return result.rows;
  });

  // 7. GET /bot/news-module
  app.get("/bot/news-module", async (request) => {
    const query = request.query as any;
    const simulationMode = query.simulation_mode === "true" || config.APP_ENV === "development";

    // Ambil sesi aktif
    const sessionResult = await pool.query(
      `SELECT virtual_day_index FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`
    );
    const activeSession = sessionResult.rows[0] ? Number(sessionResult.rows[0].virtual_day_index) : null;

    let queryStr = `
      SELECT * FROM news 
      WHERE status = 'published'
    `;
    const params: any[] = [];

    if (!simulationMode) {
      queryStr += ` AND simulation_only = false`;
    }

    if (activeSession !== null) {
      queryStr += ` AND (expiry_session IS NULL OR expiry_session >= $${params.length + 1})`;
      params.push(activeSession);
    }

    queryStr += ` ORDER BY published_at DESC LIMIT 100`;

    const result = await pool.query(queryStr, params);
    return result.rows;
  });

  // 8. GET /bot/fair-value-module
  app.get("/bot/fair-value-module", async () => {
    const result = await pool.query(`
      SELECT DISTINCT ON (symbol) *
      FROM fair_values
      WHERE visible_to_bot = true
      ORDER BY symbol, version DESC;
    `);
    return result.rows;
  });

  // 9. GET /bot/market-regime
  app.get("/bot/market-regime", async () => {
    const result = await pool.query(`
      SELECT *
      FROM market_regimes
      ORDER BY created_at DESC
      LIMIT 1;
    `);
    return (
      result.rows[0] ?? {
        global_regime: "neutral",
        sector_regimes: {},
        volatility_regime: "normal"
      }
    );
  });

  // 10. GET /bot/liquidity-profile
  app.get("/bot/liquidity-profile", async () => {
    const result = await pool.query(`
      SELECT *
      FROM security_liquidity_profiles
      ORDER BY symbol;
    `);
    return result.rows;
  });

  // 11. POST /bot/admin/fair-value (Admin set/update Fair Value)
  app.post("/bot/admin/fair-value", async (request, reply) => {
    const body = fairValueBody.parse(request.body);
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    // Dapatkan versi terakhir dari symbol tersebut
    const prevResult = await pool.query(
      `SELECT version FROM fair_values WHERE symbol = $1 ORDER BY version DESC LIMIT 1`,
      [body.symbol]
    );
    const nextVersion = prevResult.rows[0] ? Number(prevResult.rows[0].version) + 1 : 1;

    const [created] = await db
      .insert(fairValues)
      .values({
        symbol: body.symbol,
        fairValue: body.fairValue.toString(),
        confidence: body.confidence,
        method: body.method,
        effectiveFromSession: body.effectiveFromSession,
        effectiveUntilSession: body.effectiveUntilSession,
        version: nextVersion,
        notes: body.notes,
        visibleToPlayer: body.visibleToPlayer,
        visibleToBot: body.visibleToBot,
        createdBy: actor
      })
      .returning();

    if (!created) {
      throw badRequest("Fair value record was not created");
    }

    await writeAudit({
      actor,
      action: "bot.fair_value.create",
      entityType: "fair_value",
      entityId: created.id,
      after: created,
      correlationId
    });

    return reply.status(201).send(created);
  });

  // 12. POST /bot/admin/market-regime (Admin set Market Regime)
  app.post("/bot/admin/market-regime", async (request, reply) => {
    const body = marketRegimeBody.parse(request.body);
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [created] = await db
      .insert(marketRegimes)
      .values({
        sessionId: body.sessionId,
        globalRegime: body.globalRegime,
        sectorRegimes: body.sectorRegimes,
        volatilityRegime: body.volatilityRegime,
        createdBy: actor
      })
      .returning();

    if (!created) {
      throw badRequest("Market regime record was not created");
    }

    await writeAudit({
      actor,
      action: "bot.market_regime.create",
      entityType: "market_regime",
      entityId: created.id,
      after: created,
      correlationId
    });

    return reply.status(201).send(created);
  });
}
