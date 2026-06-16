import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db/index.js";
import { financialReports, issuers, listedSecurities } from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { decimal, toNumber } from "../lib/number.js";

const financialReportBody = z.object({
  issuerId: z.string().uuid(),
  period: z.string().min(4),
  periodEndDate: z.string().date(),
  revenue: z.coerce.number(),
  netIncome: z.coerce.number(),
  assets: z.coerce.number(),
  liabilities: z.coerce.number(),
  equity: z.coerce.number(),
  dividendPayout: z.coerce.number().optional(),
  source: z.string().optional().default("manual")
});

const generatorBody = z.object({
  issuerId: z.string().uuid(),
  startPeriod: z.string().default("FY2026"),
  periods: z.coerce.number().int().min(1).max(12).default(4),
  baseRevenue: z.coerce.number().positive(),
  revenueGrowthRate: z.coerce.number().default(0.08),
  netMargin: z.coerce.number().default(0.12),
  assetToRevenueRatio: z.coerce.number().default(1.8),
  liabilityToAssetRatio: z.coerce.number().default(0.45),
  dividendPayout: z.coerce.number().default(0.25),
  scenario: z.enum(["bull", "base", "bear"]).default("base")
});

function calculateRatios(input: {
  netIncome: number;
  equity: number;
  assets: number;
  liabilities: number;
  revenue: number;
  sharesOutstanding: number;
  referencePrice?: number;
}) {
  const eps = input.sharesOutstanding > 0 ? input.netIncome / input.sharesOutstanding : 0;
  const bvps = input.sharesOutstanding > 0 ? input.equity / input.sharesOutstanding : 0;
  const roe = input.equity > 0 ? input.netIncome / input.equity : 0;
  const roa = input.assets > 0 ? input.netIncome / input.assets : 0;
  const debtToEquity = input.equity > 0 ? input.liabilities / input.equity : 0;
  const netMargin = input.revenue > 0 ? input.netIncome / input.revenue : 0;
  const per = input.referencePrice && eps > 0 ? input.referencePrice / eps : null;
  const pbv = input.referencePrice && bvps > 0 ? input.referencePrice / bvps : null;

  return {
    eps,
    bookValuePerShare: bvps,
    ratios: {
      roe,
      roa,
      debtToEquity,
      netMargin,
      per,
      pbv
    }
  };
}

async function getSharesContext(issuerId: string) {
  const securities = await db.select().from(listedSecurities).where(eq(listedSecurities.issuerId, issuerId));
  const primary = securities[0];
  return {
    sharesOutstanding: toNumber(primary?.sharesOutstanding, 1),
    referencePrice: toNumber(primary?.referencePrice, 0)
  };
}

export async function registerFundamentalRoutes(app: FastifyInstance) {
  app.post("/financial-reports", async (request) => {
    const body = financialReportBody.parse(request.body);
    const [issuer] = await db.select().from(issuers).where(eq(issuers.id, body.issuerId));
    if (!issuer) throw notFound("Issuer not found");
    const context = await getSharesContext(body.issuerId);
    const calculated = calculateRatios({ ...body, ...context });
    const [created] = await db
      .insert(financialReports)
      .values({
        ...body,
        revenue: body.revenue.toString(),
        netIncome: body.netIncome.toString(),
        assets: body.assets.toString(),
        liabilities: body.liabilities.toString(),
        equity: body.equity.toString(),
        eps: decimal(calculated.eps),
        bookValuePerShare: decimal(calculated.bookValuePerShare),
        dividendPayout: body.dividendPayout?.toString(),
        ratios: calculated.ratios
      })
      .returning();
    if (!created) throw badRequest("Financial report was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "financial_report.create",
      entityType: "financial_report",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.get("/issuers/:issuerId/financial-reports", async (request) => {
    const params = z.object({ issuerId: z.string().uuid() }).parse(request.params);
    return db
      .select()
      .from(financialReports)
      .where(eq(financialReports.issuerId, params.issuerId))
      .orderBy(desc(financialReports.periodEndDate));
  });

  app.get("/public/securities/:symbol/fundamentals", async (request) => {
    const params = z.object({ symbol: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const result = await pool.query(
      `
      SELECT s.symbol, s.reference_price, i.id AS issuer_id, i.name AS issuer_name,
        COALESCE(json_agg(fr.* ORDER BY fr.period_end_date DESC) FILTER (WHERE fr.id IS NOT NULL), '[]') AS reports
      FROM listed_securities s
      JOIN issuers i ON i.id = s.issuer_id
      LEFT JOIN financial_reports fr ON fr.issuer_id = i.id
      WHERE s.symbol = $1
      GROUP BY s.id, i.id
      `,
      [params.symbol]
    );
    if (!result.rows[0]) throw notFound("Security not found");
    return result.rows[0];
  });

  app.post("/financial-reports/generate", async (request) => {
    const body = generatorBody.parse(request.body);
    const [issuer] = await db.select().from(issuers).where(eq(issuers.id, body.issuerId));
    if (!issuer) throw notFound("Issuer not found");
    const context = await getSharesContext(body.issuerId);
    const scenarioMultiplier = body.scenario === "bull" ? 1.25 : body.scenario === "bear" ? 0.72 : 1;
    const generated = [];

    for (let index = 0; index < body.periods; index += 1) {
      const growth = Math.pow(1 + body.revenueGrowthRate * scenarioMultiplier, index);
      const revenue = body.baseRevenue * growth;
      const netIncome = revenue * body.netMargin * scenarioMultiplier;
      const assets = revenue * body.assetToRevenueRatio;
      const liabilities = assets * body.liabilityToAssetRatio;
      const equity = assets - liabilities;
      const calculated = calculateRatios({ revenue, netIncome, assets, liabilities, equity, ...context });
      const period = `${body.startPeriod}-${index + 1}`;
      const [created] = await db
        .insert(financialReports)
        .values({
          issuerId: body.issuerId,
          period,
          periodEndDate: `${new Date().getUTCFullYear() + index}-12-31`,
          revenue: revenue.toFixed(2),
          netIncome: netIncome.toFixed(2),
          assets: assets.toFixed(2),
          liabilities: liabilities.toFixed(2),
          equity: equity.toFixed(2),
          eps: decimal(calculated.eps),
          bookValuePerShare: decimal(calculated.bookValuePerShare),
          dividendPayout: body.dividendPayout.toString(),
          ratios: calculated.ratios,
          source: "generated"
        })
        .onConflictDoNothing()
        .returning();
      if (created) generated.push(created);
    }

    await writeAudit({
      actor: actorFromRequest(request),
      action: "financial_report.generate",
      entityType: "issuer",
      entityId: body.issuerId,
      after: { generated: generated.length, scenario: body.scenario },
      correlationId: correlationIdFromRequest(request)
    });

    return { generated };
  });
}
