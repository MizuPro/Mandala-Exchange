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
        ($1, 'MNDL', 'Mandala Digital Infrastruktur Tbk', 'new_economy', 'Technology', 10000000000, 250, 320, 315, 'listed', 'regular', CURRENT_DATE),
        ($2, 'NUSA', 'Nusantara Consumer Goods Tbk', 'main', 'Consumer', 8000000000, 500, 740, 735, 'listed', 'regular', CURRENT_DATE),
        ($3, 'BARA', 'Bara Energi Mandiri Tbk', 'development', 'Energy', 12000000000, 150, 188, 190, 'listed', 'regular', CURRENT_DATE)
      ON CONFLICT (symbol) DO UPDATE SET reference_price = excluded.reference_price, previous_close = excluded.previous_close, updated_at = now()
      `,
      [issuerByCode.MNDL, issuerByCode.NUSA, issuerByCode.BARA]
    );

    await pool.query(`
      INSERT INTO trading_rule_profiles (name, board, market_segment, is_default)
      VALUES
        ('BEI-like Main Board Regular', 'main', 'regular', true),
        ('BEI-like Development Regular', 'development', 'regular', true),
        ('BEI-like New Economy Regular', 'new_economy', 'regular', true),
        ('Special Monitoring Call Auction Ready', 'watchlist', 'regular', true)
      ON CONFLICT DO NOTHING
    `);

    const profiles = await pool.query("SELECT id, board FROM trading_rule_profiles");
    for (const profile of profiles.rows) {
      await pool.query(
        `
        INSERT INTO lot_size_rules (profile_id, instrument_type, lot_size)
        VALUES ($1, 'stock', 100)
        ON CONFLICT DO NOTHING
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
        ON CONFLICT DO NOTHING
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
        ON CONFLICT DO NOTHING
        `,
        [profile.id, arb]
      );
      await pool.query(
        `
        INSERT INTO auto_rejection_rules (profile_id, max_lots_per_order, max_listed_shares_percent)
        VALUES ($1, 50000, 0.05)
        ON CONFLICT DO NOTHING
        `,
        [profile.id]
      );
    }

    const session = await pool.query(`
      INSERT INTO session_templates (name, status, settlement_mode, settlement_delay_sessions, post_closing_enabled, is_active)
      VALUES ('Mandala Regular Session MVP', 'closed', 'end_of_session', 0, true, true)
      RETURNING id
    `);
    const sessionId = session.rows[0]?.id;
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
        ON CONFLICT DO NOTHING
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
