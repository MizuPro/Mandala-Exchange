import type { FastifyInstance } from "fastify";
import { and, eq, desc } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { fairValues } from "../db/schema.js";
import { notFound } from "../lib/errors.js";

export async function registerFairValuePublicRoutes(app: FastifyInstance) {
  // 1. GET /v1/public/fair-values (List all visible fair values)
  app.get("/public/fair-values", async (request, reply) => {
    const query = request.query as any;
    const targetSymbol = query.symbol ? String(query.symbol).toUpperCase() : null;

    // Ambil sesi aktif
    const sessionResult = await pool.query(
      `SELECT virtual_day_index FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`
    );
    const activeSession = sessionResult.rows[0] ? Number(sessionResult.rows[0].virtual_day_index) : null;

    let queryStr = `
      SELECT DISTINCT ON (symbol) *
      FROM fair_values
      WHERE visible_to_player = true
    `;
    const params: any[] = [];

    if (activeSession !== null) {
      queryStr += ` AND (effective_from_session IS NULL OR effective_from_session <= $${params.length + 1})`;
      params.push(activeSession);
      queryStr += ` AND (effective_until_session IS NULL OR effective_until_session >= $${params.length})`;
    }

    if (targetSymbol) {
      queryStr += ` AND symbol = $${params.length + 1}`;
      params.push(targetSymbol);
    }

    queryStr += ` ORDER BY symbol, version DESC`;

    const result = await pool.query(queryStr, params);
    return reply.status(200).send(result.rows);
  });

  // 2. GET /v1/public/fair-values/:symbol (Get latest fair value for a specific symbol)
  app.get("/public/fair-values/:symbol", async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const upperSymbol = symbol.toUpperCase();

    // Ambil sesi aktif
    const sessionResult = await pool.query(
      `SELECT virtual_day_index FROM session_instances WHERE status != 'closed' ORDER BY virtual_day_index DESC LIMIT 1`
    );
    const activeSession = sessionResult.rows[0] ? Number(sessionResult.rows[0].virtual_day_index) : null;

    let queryStr = `
      SELECT *
      FROM fair_values
      WHERE symbol = $1 AND visible_to_player = true
    `;
    const params: any[] = [upperSymbol];

    if (activeSession !== null) {
      queryStr += ` AND (effective_from_session IS NULL OR effective_from_session <= $2)`;
      queryStr += ` AND (effective_until_session IS NULL OR effective_until_session >= $2)`;
      params.push(activeSession);
    }

    queryStr += ` ORDER BY version DESC LIMIT 1`;

    const result = await pool.query(queryStr, params);
    const record = result.rows[0];

    if (!record) {
      throw notFound(`Fair value for symbol ${upperSymbol} not found or not visible to player`);
    }

    return reply.status(200).send(record);
  });
}
