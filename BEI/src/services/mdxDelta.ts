import { pool } from "../db/index.js";
import redisClient, { publishMarketUpdate } from "../lib/redis.js";

/**
 * Inisialisasi session MDX di Redis.
 * Mengambil base value dari market_indices dan kapitalisasi pasar saat ini dari listed_securities.
 */
export async function initializeMdxSession() {
  try {
    if (redisClient.status !== "ready") {
      console.warn("[MDX-Delta] Redis not ready, skipping initialization");
      return;
    }

    const res = await pool.query(`
      WITH idx_data AS (
        SELECT last_value FROM market_indices WHERE code = 'MDX' LIMIT 1
      )
      SELECT 
        (SELECT last_value FROM idx_data) as last_value,
        id as security_id,
        symbol,
        COALESCE(previous_close, reference_price) as prev_price,
        shares_outstanding
      FROM listed_securities
      WHERE status = 'listed'
    `);

    if (res.rows.length === 0) return;

    const lastValue = parseFloat(res.rows[0].last_value || "1000");
    let totalPrevMcap = 0;

    const pipeline = redisClient.pipeline();

    for (const row of res.rows) {
      const shares = parseFloat(row.shares_outstanding || "0");
      const prevPrice = parseFloat(row.prev_price || "0");
      const mcap = prevPrice * shares;
      totalPrevMcap += mcap;

      // Set initial last price for delta calculation
      pipeline.set(`mdx:last_price:${row.symbol}`, prevPrice.toString());
      // Also cache shares outstanding to avoid querying DB on every trade
      pipeline.set(`mdx:shares:${row.symbol}`, shares.toString());
    }

    pipeline.set("mdx:last_value_start", lastValue.toString());
    pipeline.set("mdx:prev_mcap", totalPrevMcap.toString());
    pipeline.set("mdx:current_mcap", totalPrevMcap.toString());

    await pipeline.exec();
    console.log(`[MDX-Delta] Session initialized. Prev Mcap: ${totalPrevMcap}, Start Value: ${lastValue}`);

    // Siarkan nilai awal indeks
    await publishMarketUpdate("INDEX_UPDATE", {
      code: "MDX",
      last_value: lastValue.toFixed(2),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("[MDX-Delta] Error initializing session:", error);
  }
}

/**
 * Menghitung Delta (Perubahan) kapitalisasi pasar saat sebuah trade terjadi.
 */
export async function applyTradeDelta(symbol: string, newPrice: number) {
  try {
    if (redisClient.status !== "ready") return;

    const lastPriceStr = await redisClient.get(`mdx:last_price:${symbol}`);
    const sharesStr = await redisClient.get(`mdx:shares:${symbol}`);

    if (!lastPriceStr || !sharesStr) {
      return;
    }

    const lastPrice = parseFloat(lastPriceStr);
    const shares = parseFloat(sharesStr);

    if (newPrice === lastPrice) {
      return; 
    }

    const delta = (newPrice - lastPrice) * shares;

    await redisClient.set(`mdx:last_price:${symbol}`, newPrice.toString());

    const currentMcapStr = await redisClient.incrbyfloat("mdx:current_mcap", delta);
    const currentMcap = parseFloat(currentMcapStr);

    const prevMcapStr = await redisClient.get("mdx:prev_mcap");
    const lastValueStartStr = await redisClient.get("mdx:last_value_start");

    if (prevMcapStr && lastValueStartStr) {
      const prevMcap = parseFloat(prevMcapStr);
      const lastValueStart = parseFloat(lastValueStartStr);

      if (prevMcap > 0) {
        const indexRatio = currentMcap / prevMcap;
        const newIndexValue = lastValueStart * indexRatio;
        
        await publishMarketUpdate("INDEX_UPDATE", {
          code: "MDX",
          last_value: newIndexValue.toFixed(2),
          timestamp: new Date().toISOString()
        });
      }
    }
  } catch (error) {
    console.error("[MDX-Delta] Error applying trade delta:", error);
  }
}
