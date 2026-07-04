import type { FastifyReply } from "fastify";
import { pool } from "../db/index.js";

export const publicIpoProjectionSql = `
  SELECT
    e.id,
    e.version,
    i.code AS issuer_code,
    COALESCE(s.symbol, i.code) AS symbol,
    i.name AS company_name,
    e.status,
    e.offered_shares,
    e.offering_price AS offering_price_idr,
    e.subscription_lot_size,
    e.bookbuilding_start,
    e.bookbuilding_end,
    e.subscription_start,
    e.subscription_end,
    COALESCE(e.listing_at, e.listing_date::timestamptz) AS listing_at,
    e.ipo_hype_score,
    e.ipo_archetype,
    e.oversubscription_ratio,
    e.float_ratio,
    e.sector_sentiment,
    e.listing_sentiment,
    fv.fair_value AS fair_value_initial,
    fv.confidence AS fair_value_confidence,
    e.published_at,
    e.updated_at
  FROM ipo_events e
  JOIN issuers i ON i.id = e.issuer_id
  LEFT JOIN listed_securities s ON s.id = e.security_id
  LEFT JOIN fair_values fv ON fv.id = e.initial_fair_value_id
`;

export async function listPublicIpos(reply?: FastifyReply) {
  const result = await pool.query(`
    ${publicIpoProjectionSql}
    WHERE e.published_at IS NOT NULL
      AND e.status != 'draft'
    ORDER BY e.updated_at DESC, e.id ASC
  `);
  const response = {
    items: result.rows,
    as_of: new Date().toISOString()
  };
  return reply ? reply.status(200).send(response) : response;
}
