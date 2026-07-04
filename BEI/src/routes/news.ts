import type { FastifyInstance } from "fastify";
import { and, desc, eq, SQL } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { news } from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { newsIntensities, newsSentiments, newsStatuses } from "../types/enums.js";
import { publishMarketUpdate } from "../lib/redis.js";

const newsCreateBody = z.object({
  title: z.string().min(3),
  body: z.string().min(3),
  symbol: z.string().min(1).max(20).transform((v) => v.toUpperCase()).optional().nullable(),
  sector: z.string().min(1).optional().nullable(),
  sentiment: z.enum(newsSentiments).default("neutral"),
  intensity: z.enum(newsIntensities).default("medium"),
  simulationOnly: z.boolean().default(false),
  expirySession: z.number().int().positive().optional().nullable()
});

const newsUpdateBody = newsCreateBody.partial();

export async function registerNewsRoutes(app: FastifyInstance) {
  // 1. GET /v1/public/news (Player/Public List News)
  app.get("/public/news", async (request, reply) => {
    const query = request.query as any;
    const limit = Math.min(Number(query.limit) || 20, 100);
    const offset = Number(query.offset) || 0;

    // Ambil sesi aktif saat ini
    const sessionResult = await pool.query(
      `SELECT virtual_day_index FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`
    );
    const activeSession = sessionResult.rows[0] ? Number(sessionResult.rows[0].virtual_day_index) : null;

    let sqlQuery = `
      SELECT * FROM news 
      WHERE status = 'published' AND simulation_only = false
    `;
    const params: any[] = [];

    if (activeSession !== null) {
      sqlQuery += ` AND (expiry_session IS NULL OR expiry_session >= $${params.length + 1})`;
      params.push(activeSession);
    }

    if (query.symbol) {
      sqlQuery += ` AND symbol = $${params.length + 1}`;
      params.push(query.symbol.toUpperCase());
    }

    sqlQuery += ` ORDER BY published_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(sqlQuery, params);

    // Ambil total count
    let countQuery = `
      SELECT COUNT(*) as total FROM news 
      WHERE status = 'published' AND simulation_only = false
    `;
    const countParams: any[] = [];
    if (activeSession !== null) {
      countQuery += ` AND (expiry_session IS NULL OR expiry_session >= $1)`;
      countParams.push(activeSession);
    }
    if (query.symbol) {
      countQuery += ` AND symbol = $${countParams.length + 1}`;
      countParams.push(query.symbol.toUpperCase());
    }
    const countResult = await pool.query(countQuery, countParams);
    const total = Number(countResult.rows[0]?.total || 0);

    return reply.status(200).send({
      data: result.rows,
      pagination: {
        total,
        limit,
        offset
      }
    });
  });

  // 2. GET /v1/public/news/:id (Player/Public News Detail)
  app.get("/public/news/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [record] = await db
      .select()
      .from(news)
      .where(and(eq(news.id, id), eq(news.status, "published"), eq(news.simulationOnly, false)))
      .limit(1);

    if (!record) {
      throw notFound("News article not found or not published");
    }

    return reply.status(200).send(record);
  });

  // 3. POST /v1/news (Admin Create News)
  app.post("/news", async (request, reply) => {
    const body = newsCreateBody.parse(request.body);
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [created] = await db
      .insert(news)
      .values({
        title: body.title,
        body: body.body,
        symbol: body.symbol,
        sector: body.sector,
        sentiment: body.sentiment,
        intensity: body.intensity,
        status: "draft",
        simulationOnly: body.simulationOnly,
        expirySession: body.expirySession,
        createdBy: actor
      })
      .returning();

    if (!created) {
      throw badRequest("Failed to create news draft");
    }

    await writeAudit({
      actor,
      action: "news.create",
      entityType: "news",
      entityId: created.id,
      after: created,
      correlationId
    });

    return reply.status(201).send(created);
  });

  // 4. GET /v1/news (Admin List News)
  app.get("/news", async (request, reply) => {
    const query = request.query as any;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    let conditions = "";
    const params: any[] = [];

    if (query.status) {
      conditions += ` AND status = $${params.length + 1}`;
      params.push(query.status);
    }
    if (query.symbol) {
      conditions += ` AND symbol = $${params.length + 1}`;
      params.push(query.symbol.toUpperCase());
    }
    if (query.sentiment) {
      conditions += ` AND sentiment = $${params.length + 1}`;
      params.push(query.sentiment);
    }

    const queryStr = `
      SELECT * FROM news 
      WHERE 1=1 ${conditions} 
      ORDER BY created_at DESC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const result = await pool.query(queryStr, params);

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM news WHERE 1=1 ${conditions}`, params.slice(0, -2));
    const total = Number(countResult.rows[0]?.total || 0);

    return reply.status(200).send({
      data: result.rows,
      pagination: {
        total,
        limit,
        offset
      }
    });
  });

  // 5. GET /v1/news/:id (Admin News Detail)
  app.get("/news/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [record] = await db
      .select()
      .from(news)
      .where(eq(news.id, id))
      .limit(1);

    if (!record) {
      throw notFound("News record not found");
    }

    return reply.status(200).send(record);
  });

  // 6. PATCH /v1/news/:id (Admin Update News)
  app.patch("/news/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = newsUpdateBody.parse(request.body);
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [existing] = await db
      .select()
      .from(news)
      .where(eq(news.id, id))
      .limit(1);

    if (!existing) {
      throw notFound("News record not found");
    }

    if (existing.status !== "draft") {
      return reply.status(409).send({
        error: "Conflict",
        message: `Cannot modify news that is not in draft status. Current status: ${existing.status}`
      });
    }

    const [updated] = await db
      .update(news)
      .set({
        title: body.title !== undefined ? body.title : existing.title,
        body: body.body !== undefined ? body.body : existing.body,
        symbol: body.symbol !== undefined ? body.symbol : existing.symbol,
        sector: body.sector !== undefined ? body.sector : existing.sector,
        sentiment: body.sentiment !== undefined ? body.sentiment : existing.sentiment,
        intensity: body.intensity !== undefined ? body.intensity : existing.intensity,
        simulationOnly: body.simulationOnly !== undefined ? body.simulationOnly : existing.simulationOnly,
        expirySession: body.expirySession !== undefined ? body.expirySession : existing.expirySession,
        updatedAt: new Date()
      })
      .where(eq(news.id, id))
      .returning();

    await writeAudit({
      actor,
      action: "news.update",
      entityType: "news",
      entityId: id,
      before: existing,
      after: updated,
      correlationId
    });

    return reply.status(200).send(updated);
  });

  // 7. POST /v1/news/:id/publish (Admin Publish News)
  app.post("/news/:id/publish", async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [existing] = await db
      .select()
      .from(news)
      .where(eq(news.id, id))
      .limit(1);

    if (!existing) {
      throw notFound("News record not found");
    }

    if (existing.status !== "draft") {
      return reply.status(409).send({
        error: "Conflict",
        message: `Only draft news can be published. Current status: ${existing.status}`
      });
    }

    // Ambil sesi aktif
    const sessionResult = await pool.query(
      `SELECT virtual_day_index FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`
    );
    const activeSession = sessionResult.rows[0] ? Number(sessionResult.rows[0].virtual_day_index) : null;

    const [updated] = await db
      .update(news)
      .set({
        status: "published",
        publishedAt: new Date(),
        publishedSession: activeSession,
        updatedAt: new Date()
      })
      .where(eq(news.id, id))
      .returning();

    await writeAudit({
      actor,
      action: "news.publish",
      entityType: "news",
      entityId: id,
      before: existing,
      after: updated,
      correlationId
    });

    // Publish to Redis channel untuk real-time update
    await publishMarketUpdate("news", {
      event: "news_published",
      data: updated
    });

    return reply.status(200).send(updated);
  });

  // 8. POST /v1/news/:id/archive (Admin Archive News)
  app.post("/news/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [existing] = await db
      .select()
      .from(news)
      .where(eq(news.id, id))
      .limit(1);

    if (!existing) {
      throw notFound("News record not found");
    }

    const [updated] = await db
      .update(news)
      .set({
        status: "archived",
        updatedAt: new Date()
      })
      .where(eq(news.id, id))
      .returning();

    await writeAudit({
      actor,
      action: "news.archive",
      entityType: "news",
      entityId: id,
      before: existing,
      after: updated,
      correlationId
    });

    return reply.status(200).send(updated);
  });

  // 9. DELETE /v1/news/:id (Admin Delete News - Draft Only)
  app.delete("/news/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = actorFromRequest(request) || "admin";
    const correlationId = correlationIdFromRequest(request);

    const [existing] = await db
      .select()
      .from(news)
      .where(eq(news.id, id))
      .limit(1);

    if (!existing) {
      throw notFound("News record not found");
    }

    if (existing.status !== "draft") {
      return reply.status(409).send({
        error: "Conflict",
        message: `Only draft news can be deleted. Current status: ${existing.status}. Please archive it instead.`
      });
    }

    await db.delete(news).where(eq(news.id, id));

    await writeAudit({
      actor,
      action: "news.delete",
      entityType: "news",
      entityId: id,
      before: existing,
      after: null,
      correlationId
    });

    return reply.status(204).send();
  });
}
