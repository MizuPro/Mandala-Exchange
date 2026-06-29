import "dotenv/config";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    await pool.query("BEGIN");

    await pool.query(`
      INSERT INTO broker_members (code, name, status, service_identifier, metadata)
      VALUES ('MANDALA', 'Mandala Sekuritas', 'active', 'mandala-sekuritas', '{"mvp": true}')
      ON CONFLICT (code) DO UPDATE SET status = excluded.status, updated_at = now()
    `);

    const issuerRows = await pool.query(`
      INSERT INTO issuers (code, name, sector, summary, business_description)
      VALUES
        ('MNDL', 'Mandala Digital Infrastruktur Tbk', 'Technology', 'Operator infrastruktur digital simulasi Mandala.', 'Membangun jaringan data, cloud edge, dan layanan teknologi untuk ekosistem Mandala.'),
        ('NUSA', 'Nusantara Consumer Goods Tbk', 'Consumer', 'Produsen barang konsumsi defensif.', 'Memproduksi makanan kemasan, minuman, dan kebutuhan rumah tangga simulasi.'),
        ('BARA', 'Bara Energi Mandiri Tbk', 'Energy', 'Perusahaan energi dan logistik batubara simulasi.', 'Mengelola produksi energi, kontrak pasokan, dan logistik komoditas.')
      ON CONFLICT (code) DO UPDATE SET name = excluded.name, sector = excluded.sector, updated_at = now()
      RETURNING id, code
    `);
    const issuerByCode = Object.fromEntries(issuerRows.rows.map((row) => [row.code, row.id]));

    await pool.query(
      `
      INSERT INTO listed_securities (issuer_id, symbol, name, board, sector, shares_outstanding, ipo_price, reference_price, previous_close, status, market_mechanism, listed_at)
      VALUES
        ($1, 'MNDL', 'Mandala Digital Infrastruktur Tbk', 'new_economy', 'Technology', 10000000000, 250, 320, 316, 'listed', 'regular', CURRENT_DATE),
        ($2, 'NUSA', 'Nusantara Consumer Goods Tbk', 'main', 'Consumer', 8000000000, 500, 740, 735, 'listed', 'regular', CURRENT_DATE),
        ($3, 'BARA', 'Bara Energi Mandiri Tbk', 'development', 'Energy', 12000000000, 150, 188, 190, 'listed', 'regular', CURRENT_DATE)
      ON CONFLICT (symbol) DO UPDATE SET
        name = excluded.name,
        board = excluded.board,
        sector = excluded.sector,
        shares_outstanding = excluded.shares_outstanding,
        ipo_price = COALESCE(listed_securities.ipo_price, excluded.ipo_price),
        reference_price = CASE
          WHEN $4::boolean OR listed_securities.reference_price <= 0 THEN excluded.reference_price
          ELSE listed_securities.reference_price
        END,
        previous_close = CASE
          WHEN $4::boolean OR listed_securities.previous_close IS NULL OR listed_securities.previous_close <= 0 THEN excluded.previous_close
          ELSE listed_securities.previous_close
        END,
        status = excluded.status,
        market_mechanism = excluded.market_mechanism,
        updated_at = now()
      `,
      [issuerByCode.MNDL, issuerByCode.NUSA, issuerByCode.BARA, process.env.SEED_RESET_MARKET?.trim() === "true"]
    );

    await pool.query(`
      INSERT INTO trading_rule_profiles (name, board, market_segment, is_default)
      VALUES
        ('BEI-like Main Board Regular', 'main', 'regular', true),
        ('BEI-like Development Regular', 'development', 'regular', true),
        ('BEI-like New Economy Regular', 'new_economy', 'regular', true),
        ('Special Monitoring Call Auction Ready', 'watchlist', 'regular', true),
        ('Derivatives Board (Waran & Right Issue)', 'derivatives', 'regular', false)
      ON CONFLICT (board, market_segment) DO UPDATE SET
        name = excluded.name,
        is_default = excluded.is_default,
        updated_at = now()
    `);

    const profiles = await pool.query("SELECT id, board FROM trading_rule_profiles WHERE board IN ('main','development','new_economy','watchlist','derivatives')");
    for (const profile of profiles.rows) {
      // === BLOK KHUSUS DERIVATIVES: lot 100, tick 1, ARA/ARB tanpa batas (~999%) ===
      if (profile.board === 'derivatives') {
        await pool.query(
          `
          INSERT INTO lot_size_rules (profile_id, instrument_type, lot_size, effective_date)
          VALUES ($1, 'stock', 100, CURRENT_DATE)
          ON CONFLICT (profile_id, instrument_type, effective_date) DO UPDATE SET
            lot_size = excluded.lot_size,
            updated_at = now()
          `,
          [profile.id]
        );
        await pool.query(
          `
          INSERT INTO tick_size_rules (profile_id, min_price, max_price, tick_size)
          VALUES ($1, 1, NULL, 1)
          ON CONFLICT (profile_id, min_price, max_price) DO UPDATE SET
            tick_size = excluded.tick_size,
            updated_at = now()
          `,
          [profile.id]
        );
        // ARA/ARB 9999.9999 = ~999999.99% => praktis tidak ada batas harga untuk waran/right
        await pool.query(
          `
          INSERT INTO price_band_rules (profile_id, min_reference_price, max_reference_price, ara_percent, arb_percent, min_price)
          VALUES ($1, 1, NULL, 9999.9999, 9999.9999, 1)
          ON CONFLICT (profile_id, min_reference_price, max_reference_price) DO UPDATE SET
            ara_percent = excluded.ara_percent,
            arb_percent = excluded.arb_percent,
            min_price = excluded.min_price,
            updated_at = now()
          `,
          [profile.id]
        );
        await pool.query(
          `
          INSERT INTO auto_rejection_rules (profile_id, max_lots_per_order, max_listed_shares_percent)
          VALUES ($1, 50000, NULL)
          ON CONFLICT (profile_id) DO UPDATE SET
            max_lots_per_order = excluded.max_lots_per_order,
            max_listed_shares_percent = excluded.max_listed_shares_percent,
            updated_at = now()
          `,
          [profile.id]
        );
        continue; // lewati logika loop standar untuk board lain
      }
      // === AKHIR BLOK KHUSUS DERIVATIVES ===

      await pool.query(
        `
        INSERT INTO lot_size_rules (profile_id, instrument_type, lot_size, effective_date)
        VALUES ($1, 'stock', 100, CURRENT_DATE)
        ON CONFLICT (profile_id, instrument_type, effective_date) DO UPDATE SET
          lot_size = excluded.lot_size,
          updated_at = now()
        `,
        [profile.id]
      );
      await pool.query(
        `
        INSERT INTO tick_size_rules (profile_id, min_price, max_price, tick_size)
        VALUES
          ($1, 1, 199, 1),
          ($1, 200, 499, 2),
          ($1, 500, 1999, 5),
          ($1, 2000, 4999, 10),
          ($1, 5000, NULL, 25)
        ON CONFLICT (profile_id, min_price, max_price) DO UPDATE SET
          tick_size = excluded.tick_size,
          updated_at = now()
        `,
        [profile.id]
      );
      const arb = profile.board === "watchlist" ? 0.10 : 0.15;
      await pool.query(
        `
        INSERT INTO price_band_rules (profile_id, min_reference_price, max_reference_price, ara_percent, arb_percent, min_price)
        VALUES
          ($1, 1, 200, 0.35, $2, 1),
          ($1, 201, 5000, 0.25, $2, 1),
          ($1, 5001, NULL, 0.20, $2, 1)
        ON CONFLICT (profile_id, min_reference_price, max_reference_price) DO UPDATE SET
          ara_percent = excluded.ara_percent,
          arb_percent = excluded.arb_percent,
          min_price = excluded.min_price,
          updated_at = now()
        `,
        [profile.id, arb]
      );
      await pool.query(
        `
        INSERT INTO auto_rejection_rules (profile_id, max_lots_per_order, max_listed_shares_percent)
        VALUES ($1, 50000, 0.05)
        ON CONFLICT (profile_id) DO UPDATE SET
          max_lots_per_order = excluded.max_lots_per_order,
          max_listed_shares_percent = excluded.max_listed_shares_percent,
          updated_at = now()
        `,
        [profile.id]
      );
    }

    // Session template: idempotent berdasarkan nama unik
    const sessionResult = await pool.query(`
      INSERT INTO session_templates (name, status, settlement_mode, settlement_delay_sessions, post_closing_enabled, is_active)
      VALUES ('Mandala Regular Session MVP', 'closed', 'end_of_session', 0, true, true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    // Jika sudah ada (ON CONFLICT DO NOTHING), ambil id yang existing
    const sessionId = sessionResult.rows[0]?.id ?? (
      await pool.query(`SELECT id FROM session_templates WHERE name = 'Mandala Regular Session MVP'`)
    ).rows[0]?.id;
    if (sessionId) {
      await pool.query(
        `
        INSERT INTO session_segments (template_id, sequence, status, duration_seconds, allow_order_entry, allow_cancel_amend)
        VALUES
          ($1, 1, 'pre_open', 300, true, true),
          ($1, 2, 'opening_auction', 60, true, false),
          ($1, 3, 'continuous', 1800, true, true),
          ($1, 4, 'pre_close', 180, true, true),
          ($1, 5, 'non_cancellation', 60, true, false),
          ($1, 6, 'closing_auction', 60, true, false),
          ($1, 7, 'post_closing', 300, true, false),
          ($1, 8, 'closed', 0, false, false)
        ON CONFLICT (template_id, sequence) DO UPDATE SET
          status = excluded.status,
          duration_seconds = excluded.duration_seconds,
          allow_order_entry = excluded.allow_order_entry,
          allow_cancel_amend = excluded.allow_cancel_amend,
          updated_at = now()
        `,
        [sessionId]
      );
    }

    await pool.query(`
      INSERT INTO fee_schedules (
        name, broker_buy_rate, broker_sell_rate, exchange_fee_rate, clearing_fee_rate,
        settlement_fee_rate, guarantee_fund_rate, vat_rate, sell_tax_rate, minimum_fee, effective_date, is_active
      )
      VALUES ('Indonesia-like MVP Fee Schedule', 0.0015, 0.0025, 0.00018, 0.00009, 0.00003, 0.00001, 0.11, 0.001, 0, CURRENT_DATE, true)
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      INSERT INTO market_indices (code, name, base_value, last_value)
      VALUES ('MDX', 'Mandala Composite Index', 1000, 1000)
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      WITH active AS (
        SELECT symbol, count(*) OVER () AS component_count
        FROM listed_securities
        WHERE status = 'listed'
      )
      INSERT INTO index_compositions (index_code, version, effective_at, methodology, components, total_weight, is_active, created_by)
      SELECT 'MDX', 1, now(), 'float_adjusted_market_cap',
        jsonb_agg(jsonb_build_object(
          'symbol', symbol,
          'weight', to_char(1.0 / component_count, 'FM0.000000')
        ) ORDER BY symbol),
        1.000000, true, 'seed'
      FROM active
      HAVING count(*) > 0
      ON CONFLICT (index_code, version) DO NOTHING
    `);

    await pool.query(`
      INSERT INTO financial_reports (issuer_id, period, period_end_date, revenue, net_income, assets, liabilities, equity, eps, book_value_per_share, dividend_payout, ratios, source)
      SELECT i.id, 'FY2025', '2025-12-31',
        CASE i.code WHEN 'MNDL' THEN 1800000000000 WHEN 'NUSA' THEN 2500000000000 ELSE 1600000000000 END,
        CASE i.code WHEN 'MNDL' THEN 240000000000 WHEN 'NUSA' THEN 300000000000 ELSE 180000000000 END,
        CASE i.code WHEN 'MNDL' THEN 4200000000000 WHEN 'NUSA' THEN 3800000000000 ELSE 5100000000000 END,
        CASE i.code WHEN 'MNDL' THEN 1700000000000 WHEN 'NUSA' THEN 1200000000000 ELSE 2600000000000 END,
        CASE i.code WHEN 'MNDL' THEN 2500000000000 WHEN 'NUSA' THEN 2600000000000 ELSE 2500000000000 END,
        0, 0, 0.25, '{}'::jsonb, 'seed'
      FROM issuers i
      ON CONFLICT (issuer_id, period) DO NOTHING
    `);

    await pool.query("COMMIT");
    console.log("BEI seed data completed");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
