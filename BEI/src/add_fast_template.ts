import pg from "pg";
import { config } from "./config.js";

async function main() {
  console.log("Starting creation of Fast 5-Min Trading Session Template...");
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL || "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  try {
    await pool.query("BEGIN");

    // 1. Menonaktifkan template sesi yang sedang aktif saat ini
    console.log("Deactivating current active session templates...");
    await pool.query("UPDATE session_templates SET is_active = false WHERE is_active = true");

    // Hapus data lama jika ada untuk menghindari unique constraint violation
    console.log("Cleaning up old 'Mandala Fast 5-Min Session' template and segments...");
    await pool.query("DELETE FROM session_segments WHERE template_id IN (SELECT id FROM session_templates WHERE name = 'Mandala Fast 5-Min Session')");
    await pool.query("DELETE FROM session_templates WHERE name = 'Mandala Fast 5-Min Session'");

    // 2. Memasukkan template sesi baru
    console.log("Inserting new session template: 'Mandala Fast 5-Min Session'...");
    const templateRes = await pool.query(`
      INSERT INTO session_templates (name, status, settlement_mode, settlement_delay_sessions, post_closing_enabled, is_active)
      VALUES ('Mandala Fast 5-Min Session', 'closed', 'end_of_session', 0, true, true)
      RETURNING id
    `);
    const templateId = templateRes.rows[0].id;
    console.log(`Created template with ID: ${templateId}`);

    // 3. Memasukkan 8 segmen perdagangan bursa untuk template baru
    console.log("Inserting 8 session segments with total duration of 300 seconds (5 minutes)...");
    
    // Rincian segmen:
    // 1. pre_open: 20s
    // 2. opening_auction: 10s
    // 3. continuous: 210s (3.5 menit)
    // 4. pre_close: 15s
    // 5. non_cancellation: 10s
    // 6. closing_auction: 10s
    // 7. post_closing: 25s
    // 8. closed: 0s
    const segments = [
      { sequence: 1, status: "pre_open", duration: 20, allowEntry: true, allowCancel: true },
      { sequence: 2, status: "opening_auction", duration: 10, allowEntry: true, allowCancel: false },
      { sequence: 3, status: "continuous", duration: 210, allowEntry: true, allowCancel: true },
      { sequence: 4, status: "pre_close", duration: 15, allowEntry: true, allowCancel: true },
      { sequence: 5, status: "non_cancellation", duration: 10, allowEntry: true, allowCancel: false },
      { sequence: 6, status: "closing_auction", duration: 10, allowEntry: true, allowCancel: false },
      { sequence: 7, status: "post_closing", duration: 25, allowEntry: true, allowCancel: false },
      { sequence: 8, status: "closed", duration: 30, allowEntry: false, allowCancel: false }
    ];

    for (const seg of segments) {
      await pool.query(`
        INSERT INTO session_segments (template_id, sequence, status, duration_seconds, allow_order_entry, allow_cancel_amend)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [templateId, seg.sequence, seg.status, seg.duration, seg.allowEntry, seg.allowCancel]);
      console.log(`- Inserted segment ${seg.sequence}: ${seg.status} (${seg.duration}s)`);
    }

    await pool.query("COMMIT");
    console.log("Successfully created Fast 5-Min Trading Session Template!");
  } catch (err: any) {
    await pool.query("ROLLBACK");
    console.error("Failed to create session template:", err.message);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
