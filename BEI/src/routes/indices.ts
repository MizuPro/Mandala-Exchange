import type { FastifyInstance } from "fastify";
import { pool } from "../db/index.js";
import redisClient from "../lib/redis.js";
import { z } from "zod";

export async function registerIndexRoutes(app: FastifyInstance) {
  // GET /v1/indices — daftar semua indeks (last value saat ini)
  app.get("/indices", async () => {
    const result = await pool.query(`
      SELECT id, code, name, base_value, last_value, sector, calculated_at, updated_at
      FROM market_indices
      ORDER BY code
    `);
    const rows = result.rows;
    if (redisClient.status === "ready") {
      for (const row of rows) {
        if (row.code === 'MDX') {
          const currentMcapStr = await redisClient.get("mdx:current_mcap");
          const prevMcapStr = await redisClient.get("mdx:prev_mcap");
          const lastValueStartStr = await redisClient.get("mdx:last_value_start");
          if (currentMcapStr && prevMcapStr && lastValueStartStr) {
            const currentMcap = parseFloat(currentMcapStr);
            const prevMcap = parseFloat(prevMcapStr);
            const lastValueStart = parseFloat(lastValueStartStr);
            if (prevMcap > 0) {
              const indexRatio = currentMcap / prevMcap;
              row.last_value = (lastValueStart * indexRatio).toFixed(2);
            }
          }
        }
      }
    }
    return rows;
  });

  // GET /v1/indices/:code — detail satu indeks
  app.get("/indices/:code", async (request: any) => {
    const code = (request.params.code as string).toUpperCase();
    const result = await pool.query(
      `SELECT * FROM market_indices WHERE code = $1`,
      [code]
    );
    if (!result.rows[0]) {
      return request.server.httpErrors?.notFound?.(`Index ${code} not found`) 
        ?? { error: `Index ${code} not found` };
    }
    
    const row = result.rows[0];
    if (row.code === 'MDX' && redisClient.status === "ready") {
      const currentMcapStr = await redisClient.get("mdx:current_mcap");
      const prevMcapStr = await redisClient.get("mdx:prev_mcap");
      const lastValueStartStr = await redisClient.get("mdx:last_value_start");
      if (currentMcapStr && prevMcapStr && lastValueStartStr) {
        const currentMcap = parseFloat(currentMcapStr);
        const prevMcap = parseFloat(prevMcapStr);
        const lastValueStart = parseFloat(lastValueStartStr);
        if (prevMcap > 0) {
          const indexRatio = currentMcap / prevMcap;
          row.last_value = (lastValueStart * indexRatio).toFixed(2);
        }
      }
    }
    return row;
  });

  /**
   * GET /v1/indices/:code/history?period=7D|1M|3M
   *
   * Membangun riwayat indeks dari data trades yang tersedia.
   * Strategi: ambil nilai rata-rata tertimbang harga × volume per bucket waktu
   * kemudian normalkan terhadap base_value dari market_indices.
   * Jika belum ada trade sama sekali, kembalikan array kosong sehingga
   * frontend bisa fallback ke simulasi.
   */
  app.get("/indices/:code/history", async (request: any) => {
    const code = (request.params.code as string).toUpperCase();
    const period: string = (request.query as any)?.period || "1H";

    // Ambil base value dari market_indices
    const idxResult = await pool.query(
      `SELECT base_value, last_value FROM market_indices WHERE code = $1`,
      [code]
    );
    const idx = idxResult.rows[0];
    if (!idx) return [];

    const baseValue = parseFloat(idx.base_value);
    const lastValue = parseFloat(idx.last_value);

    let queryStr: string;
    let queryParams: any[];

    if (period === "1S") {
      // Cari session_id dari trade terakhir
      const sessRes = await pool.query(`
        SELECT session_id 
        FROM trades 
        ORDER BY occurred_at DESC 
        LIMIT 1
      `);
      const sessionId = sessRes.rows[0]?.session_id;
      if (!sessionId) return [];

      // Gunakan bucket 1 menit untuk sesi tersebut
      queryStr = `
        SELECT
          date_trunc('hour', t.occurred_at) + 
            INTERVAL '1 second' * (
              FLOOR(EXTRACT(EPOCH FROM (t.occurred_at - date_trunc('hour', t.occurred_at))) 
              / 60) 
            ) * 60 AS bucket,
          SUM(t.value) AS total_value,
          SUM(t.quantity) AS total_qty,
          COUNT(*) AS trade_count,
          SUM(t.price::numeric * t.quantity::numeric) / NULLIF(SUM(t.quantity::numeric), 0) AS vwap
        FROM trades t
        WHERE t.session_id = $1
        GROUP BY 1
        ORDER BY 1 ASC
      `;
      queryParams = [sessionId];
    } else {
      let bucketInterval: string;
      let lookbackInterval: string;

      if (period === "1m") {
        bucketInterval = "1 minute";
        lookbackInterval = "24 hours";
      } else if (period === "1D") {
        bucketInterval = "1 day";
        lookbackInterval = "90 days";
      } else {
        // default: 1H (setara 7D sebelumnya)
        bucketInterval = "1 hour";
        lookbackInterval = "7 days";
      }

      queryStr = `
        SELECT
          date_trunc('hour', t.occurred_at) + 
            INTERVAL '1 second' * (
              FLOOR(EXTRACT(EPOCH FROM (t.occurred_at - date_trunc('hour', t.occurred_at))) 
              / EXTRACT(EPOCH FROM $1::interval)) 
            ) * EXTRACT(EPOCH FROM $1::interval) AS bucket,
          SUM(t.value) AS total_value,
          SUM(t.quantity) AS total_qty,
          COUNT(*) AS trade_count,
          SUM(t.price::numeric * t.quantity::numeric) / NULLIF(SUM(t.quantity::numeric), 0) AS vwap
        FROM trades t
        WHERE t.occurred_at >= now() - $2::interval
        GROUP BY 1
        ORDER BY 1 ASC
      `;
      queryParams = [bucketInterval, lookbackInterval];
    }

    const histResult = await pool.query(queryStr, queryParams);

    const rows = histResult.rows;

    if (rows.length === 0) {
      // Tidak ada trade — kembalikan array kosong agar frontend fallback ke simulasi
      return [];
    }

    // Normalisasi: hitung index value per bucket
    // Gunakan VWAP kumulatif relatif terhadap reference price keseluruhan
    // Pendekatan sederhana: interpolasi linear dari baseValue ke lastValue,
    // dimodulasi oleh VWAP per bucket
    const firstVwap = parseFloat(rows[0].vwap || "0") || baseValue;
    const result = rows.map((row: any) => {
      const vwap = parseFloat(row.vwap || "0") || firstVwap;
      // Skalakan: index_value = baseValue * (vwap / firstVwap)
      const indexValue = parseFloat((baseValue * (vwap / firstVwap)).toFixed(2));
      return {
        time: new Date(row.bucket).toISOString(),
        value: indexValue,
        volume: parseInt(row.total_qty, 10),
        tradeCount: parseInt(row.trade_count, 10),
      };
    });

    // Pastikan titik terakhir selalu = lastValue dari DB
    const lastPoint = result[result.length - 1];
    if (lastPoint) {
      lastPoint.value = parseFloat(lastValue.toFixed(2));
    }

    return result;
  });

  /**
   * GET /v1/indices/:code/composition
   *
   * Task 0.8: Komposisi indeks aktif untuk BOT Index Tracker.
   * Response mengikuti kontrak BOT_API_CONTRACTS.md Section 11.
   * BOT wajib menggunakan version untuk deteksi perubahan komposisi.
   */
  app.get("/indices/:code/composition", async (request: any, reply) => {
    const code = (request.params.code as string).toUpperCase();

    const result = await pool.query(
      `SELECT id, index_code, version, effective_at, methodology, components, total_weight, is_active, created_by, created_at, updated_at
       FROM index_compositions
       WHERE index_code = $1 AND is_active = true
       ORDER BY version DESC
       LIMIT 1`,
      [code]
    );

    if (!result.rows[0]) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `No active composition found for index ${code}`,
          retryable: false,
          details: {}
        }
      });
    }

    const row = result.rows[0];
    const components = Array.isArray(row.components) ? row.components : [];

    // Validasi total weight dalam tolerance ±0.001
    const totalWeight = parseFloat(row.total_weight);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      return reply.status(409).send({
        error: {
          code: "INVALID_COMPOSITION",
          message: `Index ${code} composition total weight (${totalWeight}) is not within tolerance of 1.0`,
          retryable: false,
          details: { total_weight: row.total_weight }
        }
      });
    }

    return {
      index_code: row.index_code,
      version: row.version,
      effective_at: row.effective_at,
      methodology: row.methodology,
      components: components.map((c: any) => ({
        symbol: c.symbol,
        weight: String(c.weight),
        security_id: c.security_id ?? null
      })),
      total_weight: row.total_weight
    };
  });

  /**
   * POST /v1/indices/:code/composition
   *
   * Admin endpoint untuk membuat versi komposisi baru.
   * Setiap perubahan komposisi menaikkan version.
   * Scope: admin:*
   */
  app.post("/indices/:code/composition", async (request: any, reply) => {
    const code = (request.params.code as string).toUpperCase();

    const bodySchema = z.object({
      methodology: z.string().min(3).default("float_adjusted_market_cap"),
      effective_at: z.string().datetime().optional(),
      components: z.array(z.object({
        symbol: z.string().min(1).max(12),
        weight: z.string().regex(/^\d+(\.\d+)?$/, "weight must be decimal string"),
        security_id: z.string().uuid().optional()
      })).min(1),
      created_by: z.string().default("admin")
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message || "Invalid composition payload",
          retryable: false,
          details: parsed.error.issues
        }
      });
    }

    const { methodology, effective_at, components, created_by } = parsed.data;

    // Validasi total weight harus mendekati 1.0 (tolerance ±0.001)
    const totalWeight = components.reduce((sum, c) => sum + parseFloat(c.weight), 0);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: `Total weight (${totalWeight.toFixed(6)}) must equal 1.0 within ±0.001 tolerance`,
          retryable: false,
          details: { total_weight: totalWeight, components_count: components.length }
        }
      });
    }

    // Ambil versi tertinggi yang ada
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM index_compositions WHERE index_code = $1`,
      [code]
    );
    const nextVersion = parseInt(versionResult.rows[0].max_version, 10) + 1;

    // Nonaktifkan komposisi lama
    await pool.query(
      `UPDATE index_compositions SET is_active = false, updated_at = now() WHERE index_code = $1 AND is_active = true`,
      [code]
    );

    // Buat komposisi baru
    const insertResult = await pool.query(
      `INSERT INTO index_compositions (index_code, version, effective_at, methodology, components, total_weight, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       RETURNING id, index_code, version, effective_at, methodology, components, total_weight`,
      [
        code,
        nextVersion,
        effective_at || new Date().toISOString(),
        methodology,
        JSON.stringify(components),
        totalWeight.toFixed(6),
        created_by
      ]
    );

    const newRow = insertResult.rows[0];
    return reply.status(201).send({
      index_code: newRow.index_code,
      version: newRow.version,
      effective_at: newRow.effective_at,
      methodology: newRow.methodology,
      components: newRow.components,
      total_weight: newRow.total_weight,
      created: true
    });
  });
}
