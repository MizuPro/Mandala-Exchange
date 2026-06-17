import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { surveillanceAlerts } from "../db/schema.js";
import { toNumber } from "../lib/number.js";
import { sessionTemplates, listedSecurities, specialNotations } from "../db/schema.js";
import { publishMarketUpdate } from "../lib/redis.js";

export async function registerSurveillanceRoutes(app: FastifyInstance) {
  app.post("/surveillance/scan/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const summaries = await pool.query(
      `
      SELECT ms.*, ls.symbol, ls.reference_price
      FROM market_summaries ms
      JOIN listed_securities ls ON ls.id = ms.security_id
      WHERE ms.session_id = $1
      `,
      [params.sessionId]
    );
    const generated = [];

    for (const summary of (summaries.rows as any[])) {
      const reference = toNumber(summary.reference_price);
      const last = toNumber(summary.last ?? summary.close);
      const volume = toNumber(summary.volume);
      const change = reference > 0 ? (last - reference) / reference : 0;

      if (Math.abs(change) >= 0.15) {
        const [alert] = await db
          .insert(surveillanceAlerts)
          .values({
            sessionId: params.sessionId,
            securityId: summary.security_id,
            type: change > 0 ? "ara_or_extreme_gain" : "arb_or_extreme_drop",
            severity: Math.abs(change) >= 0.25 ? "high" : "medium",
            message: `${summary.symbol} moved ${(change * 100).toFixed(2)}% from reference price`,
            evidence: summary
          })
          .returning();
        if (alert) generated.push(alert);

        // CIRCUIT BREAKER: Auto Suspend Symbol on extreme drop/gain
        // In real world, maybe wait for consecutive hits, but for this, we suspend directly.
        await db.insert(specialNotations).values({
          securityId: summary.security_id,
          type: "suspend",
          note: `Auto-suspended by circuit breaker due to extreme price movement (${(change * 100).toFixed(2)}%)`,
          isActive: true
        });
        
        await publishMarketUpdate("suspend_symbol", {
          symbol: summary.symbol,
          reason: `circuit_breaker_price_movement_${(change * 100).toFixed(2)}`
        });
      }

      if (volume > 0 && volume >= toNumber(summary.metadata?.averageVolume, Number.POSITIVE_INFINITY) * 3) {
        const [alert] = await db
          .insert(surveillanceAlerts)
          .values({
            sessionId: params.sessionId,
            securityId: summary.security_id,
            type: "unusual_volume",
            severity: "medium",
            message: `${summary.symbol} volume is materially above average`,
            evidence: summary
          })
          .returning();
        if (alert) generated.push(alert);
      }
    }

    // CIRCUIT BREAKER: Market Halt on index drop
    // We calculate a simple equally weighted index change from the scanned summaries
    let totalChange = 0;
    let validCount = 0;
    for (const summary of (summaries.rows as any[])) {
      const reference = toNumber(summary.reference_price);
      if (reference > 0) {
        const last = toNumber(summary.last ?? summary.close);
        const change = (last - reference) / reference;
        totalChange += change;
        validCount++;
      }
    }
    const averageChange = validCount > 0 ? totalChange / validCount : 0;

    // If average drop is > 5%, trigger market halt
    if (averageChange <= -0.05) {
      await db
        .update(sessionTemplates)
        .set({ status: "halted", updatedAt: new Date() })
        .where(eq(sessionTemplates.id, params.sessionId));

      await publishMarketUpdate("market_halt", {
        sessionId: params.sessionId,
        reason: `circuit_breaker_index_drop_${(averageChange * 100).toFixed(2)}`
      });

      const [alert] = await db
        .insert(surveillanceAlerts)
        .values({
          sessionId: params.sessionId,
          type: "market_halt_signal",
          severity: "high",
          message: `Market HALTED due to extreme average drop of ${(averageChange * 100).toFixed(2)}%`,
          evidence: { averageChange }
        })
        .returning();
      if (alert) generated.push(alert);
    }

    const washTrade = await pool.query(
      `
      SELECT symbol, buy_investor_id, sell_investor_id, COUNT(*) AS count
      FROM trades
      WHERE session_id = $1 AND buy_investor_id = sell_investor_id
      GROUP BY symbol, buy_investor_id, sell_investor_id
      HAVING COUNT(*) > 0
      `,
      [params.sessionId]
    );

    for (const row of (washTrade.rows as any[])) {
      const [alert] = await db
        .insert(surveillanceAlerts)
        .values({
          sessionId: params.sessionId,
          type: "wash_trade_signal",
          severity: "high",
          message: `${row.symbol} has same investor on buy and sell side`,
          evidence: row
        })
        .returning();
      if (alert) generated.push(alert);
    }

    const botDominance = await pool.query(
      `
      SELECT symbol, COUNT(*) AS count
      FROM trades
      WHERE session_id = $1 AND (buy_investor_id ILIKE 'bot%' OR sell_investor_id ILIKE 'bot%')
      GROUP BY symbol
      HAVING COUNT(*) >= 10
      `,
      [params.sessionId]
    );

    for (const row of (botDominance.rows as any[])) {
      const [alert] = await db
        .insert(surveillanceAlerts)
        .values({
          sessionId: params.sessionId,
          type: "bot_dominance",
          severity: "medium",
          message: `${row.symbol} has high bot trade count`,
          evidence: row
        })
        .returning();
      if (alert) generated.push(alert);
    }

    return { generated };
  });

  app.get("/surveillance/alerts", async (request) => {
    const query = z
      .object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      })
      .parse(request.query);
    if (query.status) {
      return db.select().from(surveillanceAlerts).where(eq(surveillanceAlerts.status, query.status)).limit(query.limit);
    }
    return db.select().from(surveillanceAlerts).limit(query.limit);
  });
}
