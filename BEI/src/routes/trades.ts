import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { brokerMembers, listedSecurities, sessionTemplates, trades } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

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
  idempotencyKey: z.string().min(8)
});

export async function registerTradeRoutes(app: FastifyInstance) {
  app.post("/trades/capture", async (request) => {
    const body = tradeCaptureBody.parse(request.body);
    const [existing] = await db.select().from(trades).where(eq(trades.idempotencyKey, body.idempotencyKey));
    if (existing) return { idempotent: true, trade: existing };

    // Validasi sessionId terhadap session_templates yang terdaftar di BEI
    const [session] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, body.sessionId));
    if (!session) throw badRequest("Session not found: sessionId does not match any known session template", { sessionId: body.sessionId });
    if (!session.isActive) throw badRequest("Session is not active", { sessionId: body.sessionId, sessionName: session.name });

    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, body.symbol));
    if (!security) throw notFound("Security not found");
    if (security.status !== "listed") throw badRequest("Security is not listed", { status: security.status });

    const [buyBroker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, body.buyBrokerCode));
    const [sellBroker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, body.sellBrokerCode));
    if (!buyBroker || buyBroker.status !== "active") throw badRequest("Buy broker is not active");
    if (!sellBroker || sellBroker.status !== "active") throw badRequest("Sell broker is not active");

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
}
