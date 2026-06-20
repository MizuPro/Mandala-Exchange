import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { issuerAnnouncements, issuers, listedSecurities, specialNotations } from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { announcementTypes, boardTypes, listingStatuses, marketMechanisms, notationTypes } from "../types/enums.js";

const issuerBody = z.object({
  code: z.string().min(2).max(12).transform((value) => value.toUpperCase()),
  name: z.string().min(2),
  sector: z.string().min(2),
  summary: z.string().optional().default(""),
  businessDescription: z.string().optional().default(""),
  isActive: z.boolean().optional().default(true),
  metadata: z.record(z.unknown()).optional().default({})
});

const issuerPatchBody = issuerBody.partial().extend({
  code: z.string().min(2).max(12).transform((value) => value.toUpperCase()).optional()
});

const securityBody = z.object({
  issuerId: z.string().uuid(),
  symbol: z.string().min(2).max(8).transform((value) => value.toUpperCase()),
  name: z.string().min(2),
  board: z.enum(boardTypes).default("main"),
  sector: z.string().min(2),
  sharesOutstanding: z.coerce.number().positive(),
  ipoPrice: z.coerce.number().positive().optional(),
  referencePrice: z.coerce.number().positive(),
  previousClose: z.coerce.number().positive().optional(),
  status: z.enum(listingStatuses).default("listed"),
  marketMechanism: z.enum(marketMechanisms).default("regular"),
  listedAt: z.string().date().optional(),
  suspendedReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({})
});

const securityPatchBody = securityBody.partial().extend({
  symbol: z.string().min(2).max(8).transform((value) => value.toUpperCase()).optional()
});

const notationBody = z.object({
  type: z.enum(notationTypes),
  note: z.string().min(3),
  isActive: z.boolean().default(true),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().optional(),
  createdBy: z.string().optional().default("admin")
});

const announcementBody = z.object({
  securityId: z.string().uuid().optional(),
  type: z.enum(announcementTypes),
  title: z.string().min(3),
  body: z.string().min(3),
  publishedAt: z.coerce.date().optional(),
  metadata: z.record(z.unknown()).optional().default({})
});

function numericString(value: number | undefined) {
  return value === undefined ? undefined : value.toString();
}

async function validateSecurityTickValues(values: {
  board: string;
  marketMechanism?: string;
  referencePrice?: number | string | null;
  previousClose?: number | string | null;
  ipoPrice?: number | string | null;
}) {
  const marketSegment = values.marketMechanism || "regular";
  const rules = await pool.query(
    `
    SELECT t.min_price, t.max_price, t.tick_size
    FROM trading_rule_profiles p
    JOIN tick_size_rules t ON t.profile_id = p.id
    WHERE p.board = $1 AND (p.market_segment = $2 OR p.market_segment = 'regular')
    ORDER BY t.min_price::numeric
    `,
    [values.board, marketSegment]
  );

  if (rules.rows.length === 0) {
    throw badRequest("Tick size rule not found for security board", { board: values.board, marketSegment });
  }

  const ensureValid = (field: string, rawValue: number | string | null | undefined) => {
    if (rawValue === undefined || rawValue === null) return;
    const price = Number(rawValue);
    if (!Number.isFinite(price) || price <= 0) return;
    const rule = rules.rows.find((row) => {
      const min = Number(row.min_price);
      const max = row.max_price === null ? Number.POSITIVE_INFINITY : Number(row.max_price);
      return price >= min && price <= max;
    });
    if (!rule) {
      throw badRequest(`${field} has no matching tick size rule`, { field, price });
    }
    const tick = Number(rule.tick_size);
    if (tick <= 0 || price % tick !== 0) {
      throw badRequest(`${field} is not valid for tick size`, { field, price, tickSize: tick });
    }
  };

  ensureValid("referencePrice", values.referencePrice);
  ensureValid("previousClose", values.previousClose);
  ensureValid("ipoPrice", values.ipoPrice);
}

export async function registerIssuerRoutes(app: FastifyInstance) {
  app.get("/issuers", async () => {
    return db.select().from(issuers).orderBy(issuers.code);
  });

  app.post("/issuers", async (request) => {
    const body = issuerBody.parse(request.body);
    const [created] = await db.insert(issuers).values(body).returning();
    if (!created) throw badRequest("Issuer was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "issuer.create",
      entityType: "issuer",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.get("/issuers/:id", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [issuer] = await db.select().from(issuers).where(eq(issuers.id, params.id));
    if (!issuer) throw notFound("Issuer not found");
    return issuer;
  });

  app.patch("/issuers/:id", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = issuerPatchBody.parse(request.body);
    const [before] = await db.select().from(issuers).where(eq(issuers.id, params.id));
    if (!before) throw notFound("Issuer not found");
    const [updated] = await db
      .update(issuers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(issuers.id, params.id))
      .returning();
    if (!updated) throw badRequest("Issuer was not updated");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "issuer.update",
      entityType: "issuer",
      entityId: updated.id,
      before,
      after: updated,
      correlationId: correlationIdFromRequest(request)
    });
    return updated;
  });

  app.post("/securities", async (request) => {
    const body = securityBody.parse(request.body);
    await validateSecurityTickValues(body);
    const [created] = await db
      .insert(listedSecurities)
      .values({
        ...body,
        sharesOutstanding: body.sharesOutstanding.toString(),
        ipoPrice: numericString(body.ipoPrice),
        referencePrice: body.referencePrice.toString(),
        previousClose: numericString(body.previousClose)
      })
      .returning();
    if (!created) throw badRequest("Security was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "security.create",
      entityType: "listed_security",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.patch("/securities/:symbol", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const body = securityPatchBody.parse(request.body);
    const [before] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, params.symbol));
    if (!before) throw notFound("Security not found");
    await validateSecurityTickValues({
      board: body.board ?? before.board,
      marketMechanism: body.marketMechanism ?? before.marketMechanism,
      referencePrice: body.referencePrice ?? before.referencePrice,
      previousClose: body.previousClose ?? before.previousClose,
      ipoPrice: body.ipoPrice ?? before.ipoPrice
    });
    const [updated] = await db
      .update(listedSecurities)
      .set({
        ...body,
        sharesOutstanding: numericString(body.sharesOutstanding),
        ipoPrice: numericString(body.ipoPrice),
        referencePrice: numericString(body.referencePrice),
        previousClose: numericString(body.previousClose),
        updatedAt: new Date()
      })
      .where(eq(listedSecurities.symbol, params.symbol))
      .returning();
    if (!updated) throw badRequest("Security was not updated");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "security.update",
      entityType: "listed_security",
      entityId: updated.id,
      before,
      after: updated,
      correlationId: correlationIdFromRequest(request)
    });
    return updated;
  });

  app.get("/public/securities", async () => {
    const result = await pool.query(`
      SELECT s.*, i.code AS issuer_code, i.name AS issuer_name,
        (
          SELECT t.price
          FROM trades t
          WHERE t.security_id = s.id
          ORDER BY t.occurred_at DESC, t.sequence_number DESC
          LIMIT 1
        ) AS last,
        (
          SELECT t.occurred_at
          FROM trades t
          WHERE t.security_id = s.id
          ORDER BY t.occurred_at DESC, t.sequence_number DESC
          LIMIT 1
        ) AS last_occurred_at,
        COALESCE(json_agg(n.*) FILTER (WHERE n.id IS NOT NULL AND n.is_active = true), '[]') AS active_notations
      FROM listed_securities s
      JOIN issuers i ON i.id = s.issuer_id
      LEFT JOIN special_notations n ON n.security_id = s.id
      GROUP BY s.id, i.id
      ORDER BY s.symbol
    `);
    return result.rows;
  });

  app.get("/integration/mats/securities", async () => {
    const result = await pool.query(`
      SELECT s.symbol, s.board, s.status, s.market_mechanism, s.reference_price, s.previous_close,
        s.shares_outstanding, COALESCE(json_agg(n.*) FILTER (WHERE n.id IS NOT NULL AND n.is_active = true), '[]') AS active_notations
      FROM listed_securities s
      LEFT JOIN special_notations n ON n.security_id = s.id
      GROUP BY s.id
      ORDER BY s.symbol
    `);
    return result.rows;
  });

  app.get("/public/securities/:symbol", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const result = await pool.query(
      `
      SELECT s.*, i.code AS issuer_code, i.name AS issuer_name, i.summary, i.business_description,
        (
          SELECT t.price
          FROM trades t
          WHERE t.security_id = s.id
          ORDER BY t.occurred_at DESC, t.sequence_number DESC
          LIMIT 1
        ) AS last,
        (
          SELECT t.occurred_at
          FROM trades t
          WHERE t.security_id = s.id
          ORDER BY t.occurred_at DESC, t.sequence_number DESC
          LIMIT 1
        ) AS last_occurred_at,
        COALESCE(json_agg(n.*) FILTER (WHERE n.id IS NOT NULL AND n.is_active = true), '[]') AS active_notations
      FROM listed_securities s
      JOIN issuers i ON i.id = s.issuer_id
      LEFT JOIN special_notations n ON n.security_id = s.id
      WHERE s.symbol = $1
      GROUP BY s.id, i.id
      `,
      [params.symbol]
    );
    if (!result.rows[0]) throw notFound("Security not found");
    return result.rows[0];
  });

  app.post("/securities/:symbol/notations", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const body = notationBody.parse(request.body);
    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, params.symbol));
    if (!security) throw notFound("Security not found");
    const [created] = await db
      .insert(specialNotations)
      .values({
        ...body,
        securityId: security.id,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo
      })
      .returning();
    if (!created) throw badRequest("Notation was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "security.notation.create",
      entityType: "special_notation",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.get("/securities/:symbol/notations", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const [security] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, params.symbol));
    if (!security) throw notFound("Security not found");
    return db
      .select()
      .from(specialNotations)
      .where(eq(specialNotations.securityId, security.id))
      .orderBy(desc(specialNotations.createdAt));
  });

  app.post("/issuers/:issuerId/announcements", async (request) => {
    const params = z.object({ issuerId: z.string().uuid() }).parse(request.params);
    const body = announcementBody.parse(request.body);
    const [issuer] = await db.select().from(issuers).where(eq(issuers.id, params.issuerId));
    if (!issuer) throw notFound("Issuer not found");
    const [created] = await db
      .insert(issuerAnnouncements)
      .values({ ...body, issuerId: params.issuerId, publishedAt: body.publishedAt })
      .returning();
    if (!created) throw badRequest("Announcement was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "issuer.announcement.create",
      entityType: "issuer_announcement",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.get("/issuers/:issuerId/announcements", async (request) => {
    const params = z.object({ issuerId: z.string().uuid() }).parse(request.params);
    return db
      .select()
      .from(issuerAnnouncements)
      .where(eq(issuerAnnouncements.issuerId, params.issuerId))
      .orderBy(desc(issuerAnnouncements.publishedAt));
  });

  app.post("/securities/:symbol/suspend", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const body = z.object({ reason: z.string().min(3) }).parse(request.body);
    const [before] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, params.symbol));
    if (!before) throw notFound("Security not found");
    const [updated] = await db
      .update(listedSecurities)
      .set({ status: "suspended", suspendedReason: body.reason, updatedAt: new Date() })
      .where(eq(listedSecurities.symbol, params.symbol))
      .returning();
    if (!updated) throw badRequest("Security was not suspended");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "security.suspend",
      entityType: "listed_security",
      entityId: updated.id,
      before,
      after: updated,
      reason: body.reason,
      correlationId: correlationIdFromRequest(request)
    });
    return updated;
  });

  app.post("/securities/:symbol/resume", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const [before] = await db.select().from(listedSecurities).where(eq(listedSecurities.symbol, params.symbol));
    if (!before) throw notFound("Security not found");
    const [updated] = await db
      .update(listedSecurities)
      .set({ status: "listed", suspendedReason: null, updatedAt: new Date() })
      .where(and(eq(listedSecurities.symbol, params.symbol), eq(listedSecurities.status, "suspended")))
      .returning();
    if (!updated) throw badRequest("Security is not suspended");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "security.resume",
      entityType: "listed_security",
      entityId: updated.id,
      before,
      after: updated,
      correlationId: correlationIdFromRequest(request)
    });
    return updated;
  });
}
