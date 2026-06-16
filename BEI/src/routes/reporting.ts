import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/index.js";
import { toNumber } from "../lib/number.js";

export async function registerReportingRoutes(app: FastifyInstance) {
  app.get("/reports/fee-tax/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const feeResult = await pool.query("SELECT * FROM fee_schedules WHERE is_active = true ORDER BY effective_date DESC LIMIT 1");
    const fee = feeResult.rows[0];
    const trades = await pool.query("SELECT * FROM trades WHERE session_id = $1", [params.sessionId]);

    const rows = trades.rows.map((trade) => {
      const value = toNumber(trade.value);
      const buyFees =
        value *
        (toNumber(fee?.broker_buy_rate) +
          toNumber(fee?.exchange_fee_rate) +
          toNumber(fee?.clearing_fee_rate) +
          toNumber(fee?.settlement_fee_rate) +
          toNumber(fee?.guarantee_fund_rate));
      const sellFees =
        value *
        (toNumber(fee?.broker_sell_rate) +
          toNumber(fee?.exchange_fee_rate) +
          toNumber(fee?.clearing_fee_rate) +
          toNumber(fee?.settlement_fee_rate) +
          toNumber(fee?.guarantee_fund_rate) +
          toNumber(fee?.sell_tax_rate));
      const vatOnBrokerFees = value * (toNumber(fee?.broker_buy_rate) + toNumber(fee?.broker_sell_rate)) * toNumber(fee?.vat_rate);
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        value: trade.value,
        buyFees: buyFees.toFixed(2),
        sellFees: sellFees.toFixed(2),
        vatOnBrokerFees: vatOnBrokerFees.toFixed(2)
      };
    });

    return {
      feeSchedule: fee ?? null,
      rows,
      totals: rows.reduce(
        (acc, row) => ({
          buyFees: acc.buyFees + toNumber(row.buyFees),
          sellFees: acc.sellFees + toNumber(row.sellFees),
          vatOnBrokerFees: acc.vatOnBrokerFees + toNumber(row.vatOnBrokerFees)
        }),
        { buyFees: 0, sellFees: 0, vatOnBrokerFees: 0 }
      )
    };
  });

  app.get("/reports/market-summary/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string() }).parse(request.params);
    const result = await pool.query(
      `
      SELECT ms.*, ls.symbol,
        CASE WHEN ls.reference_price::numeric > 0 AND ms.last IS NOT NULL
          THEN ((ms.last::numeric - ls.reference_price::numeric) / ls.reference_price::numeric)
          ELSE NULL
        END AS change_percent
      FROM market_summaries ms
      LEFT JOIN listed_securities ls ON ls.id = ms.security_id
      WHERE ms.session_id = $1
      ORDER BY ms.value DESC, ms.volume DESC
      `,
      [params.sessionId]
    );

    const rows = result.rows;
    return {
      rows,
      topGainers: [...rows].sort((a, b) => toNumber(b.change_percent) - toNumber(a.change_percent)).slice(0, 10),
      topLosers: [...rows].sort((a, b) => toNumber(a.change_percent) - toNumber(b.change_percent)).slice(0, 10),
      mostActive: [...rows].sort((a, b) => toNumber(b.frequency) - toNumber(a.frequency)).slice(0, 10)
    };
  });

  app.get("/reports/corporate-actions", async () => {
    const result = await pool.query(`
      SELECT ca.*, ls.symbol
      FROM corporate_actions ca
      JOIN listed_securities ls ON ls.id = ca.security_id
      ORDER BY ca.created_at DESC
    `);
    return result.rows;
  });
}
