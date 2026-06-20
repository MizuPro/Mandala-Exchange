import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { brokerMembers, listedSecurities, sessionTemplates, trades } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { applyTradeDelta } from "../services/mdxDelta.js";

const tradeCaptureBody = z.object({
  matsTradeId: z.string().min(1),
  sequenceNumber: z.coerce.number().int().positive(),
  sessionId: z.string().min(1),
  symbol: z.string().transform((value) => value.toUpperCase()),
  price: z.coerce.number().positive(),
  quantity: z.coerce.number().positive(),
  buyBrokerCode: z.string().transform((value) => value.toUpperCase()),
  sellBrokerCode: z.string().transform((value) => value.toUpperCase()),
  buyInvestorId: z.string().min(1),
  sellInvestorId: z.string().min(1),
  buyOrderId: z.string().min(1),
  sellOrderId: z.string().min(1),
  occurredAt: z.coerce.date(),
  idempotencyKey: z.string().min(8),
  sessionState: z.string().optional(),
  securityStatus: z.string().optional(),
  buyBrokerState: z.string().optional(),
  sellBrokerState: z.string().optional()
});

export async function registerTradeRoutes(app: FastifyInstance) {
  app.post("/trades/capture", async (request) => {
    const body = tradeCaptureBody.parse(request.body);
    const [existing] = await db.select().from(trades).where(eq(trades.idempotencyKey, body.idempotencyKey));
    if (existing) return { idempotent: true, trade: existing };

    // Validasi sessionId terhadap session_templates yang terdaftar di BEI
    const [session] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, body.sessionId));
    if (!session) throw badRequest("Session not found: sessionId does not match any known session template", { sessionId: body.sessionId });
    if (body.sessionState && body.sessionState !== "active") throw badRequest("Session was not active at match time");

    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, body.symbol));
    if (!security) throw notFound("Security not found");
    if (body.securityStatus && body.securityStatus !== "listed") throw badRequest("Security was not listed at match time");

    const [buyBroker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, body.buyBrokerCode));
    const [sellBroker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, body.sellBrokerCode));
    if (!buyBroker) throw badRequest("Buy broker not found");
    if (!sellBroker) throw badRequest("Sell broker not found");
    if (body.buyBrokerState && body.buyBrokerState !== "active") throw badRequest("Buy broker was not active at match time");
    if (body.sellBrokerState && body.sellBrokerState !== "active") throw badRequest("Sell broker was not active at match time");

    const duplicate = await db
      .select()
      .from(trades)
      .where(and(eq(trades.matsTradeId, body.matsTradeId), eq(trades.sequenceNumber, body.sequenceNumber)));
    if (duplicate.length > 0) throw conflict("Trade already captured with different idempotency key");


    const value = body.price * body.quantity;
    let [created] = await db
      .insert(trades)
      .values({
        matsTradeId: body.matsTradeId,
        sequenceNumber: body.sequenceNumber,
        sessionId: body.sessionId,
        securityId: security.id,
        symbol: body.symbol,
        price: body.price.toFixed(2),
        quantity: body.quantity.toString(),
        value: value.toFixed(2),
        buyBrokerId: buyBroker.id,
        sellBrokerId: sellBroker.id,
        buyInvestorId: body.buyInvestorId,
        sellInvestorId: body.sellInvestorId,
        buyOrderId: body.buyOrderId,
        sellOrderId: body.sellOrderId,
        occurredAt: body.occurredAt,
        idempotencyKey: body.idempotencyKey,
        rawPayload: body
      })
      .onConflictDoNothing({ target: trades.idempotencyKey })
      .returning();

    if (!created) {
      const [existingConcurrently] = await db.select().from(trades).where(eq(trades.idempotencyKey, body.idempotencyKey));
      if (existingConcurrently) return { idempotent: true, trade: existingConcurrently };
      throw badRequest("Trade was not captured");
    }

    // Fire and forget delta update for MDX real-time index
    applyTradeDelta(body.symbol, body.price).catch(err => console.error("[MDX-Delta] Failed to apply delta:", err));

    return { idempotent: false, trade: created };
  });

  app.get("/trades/session/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    return db.select().from(trades).where(eq(trades.sessionId, params.sessionId)).orderBy(trades.sequenceNumber);
  });

  app.get("/trades/:id", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [trade] = await db.select().from(trades).where(eq(trades.id, params.id));
    if (!trade) throw notFound("Trade not found");
    return trade;
  });

  app.get("/reports/trades/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const result = await pool.query(
      `
      SELECT t.*, bs.code AS buy_broker_code, ss.code AS sell_broker_code
      FROM trades t
      JOIN broker_members bs ON bs.id = t.buy_broker_id
      JOIN broker_members ss ON ss.id = t.sell_broker_id
      WHERE t.session_id = $1
      ORDER BY t.sequence_number
      `,
      [params.sessionId]
    );
    return result.rows;
  });

  app.get("/public/securities/:symbol/candles", async (request, reply) => {
    const params = z.object({ symbol: z.string().transform(s => s.toUpperCase()) }).parse(request.params);
    const query = z.object({
      resolution: z.enum(["1m", "1h", "1d", "1s"]).default("1m")
    }).parse(request.query);

    let timeBucket = "minute";
    let whereClause = "symbol = $1";
    const queryParams: any[] = [params.symbol];

    if (query.resolution === "1h") {
      timeBucket = "hour";
    } else if (query.resolution === "1d") {
      timeBucket = "day";
    } else if (query.resolution === "1s") {
      timeBucket = "second";
      // 1 Session: ambil session_id terbaru dari trade terakhir
      const lastTradeRes = await pool.query(
        "SELECT session_id FROM trades WHERE symbol = $1 ORDER BY occurred_at DESC LIMIT 1",
        [params.symbol]
      );
      if (lastTradeRes.rows.length > 0) {
        const activeSessionId = lastTradeRes.rows[0].session_id;
        whereClause = "symbol = $1 AND session_id = $2";
        queryParams.push(activeSessionId);
      } else {
        return reply.send([]);
      }
    }

    const sql = `
      SELECT 
        date_trunc('${timeBucket}', occurred_at) AS time_bucket,
        (array_agg(price::numeric ORDER BY occurred_at ASC))[1] AS open,
        MAX(price::numeric) AS high,
        MIN(price::numeric) AS low,
        (array_agg(price::numeric ORDER BY occurred_at DESC))[1] AS close,
        SUM(quantity::numeric) AS volume
      FROM trades
      WHERE ${whereClause}
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `;

    try {
      const result = await pool.query(sql, queryParams);
      const candles = result.rows.map(row => ({
        time: Math.floor(new Date(row.time_bucket).getTime() / 1000),
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseFloat(row.volume)
      }));
      return reply.send(candles);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message || "Failed to query candles from database" });
    }
  });
}

