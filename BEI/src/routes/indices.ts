import type { FastifyInstance } from "fastify";
import { pool } from "../db/index.js";

export async function registerIndexRoutes(app: FastifyInstance) {
  // GET /v1/indices — daftar semua indeks (last value saat ini)
  app.get("/indices", async () => {
    const result = await pool.query(`
      SELECT id, code, name, base_value, last_value, sector, calculated_at, updated_at
      FROM market_indices
      ORDER BY code
    `);
    return result.rows;
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
    return result.rows[0];
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
}
