import "dotenv/config";
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  console.log("Starting creation of Looping 1-Min Trading Session Template...");

  try {
    await pool.query("BEGIN");

    console.log("Deactivating current active session templates...");
    await pool.query("UPDATE session_templates SET is_active = false WHERE is_active = true");

    console.log("Cleaning up old 'Mandala Looping 1-Min Session' template and segments...");
    await pool.query("DELETE FROM session_segments WHERE template_id IN (SELECT id FROM session_templates WHERE name = 'Mandala Looping 1-Min Session')");
    await pool.query("DELETE FROM session_templates WHERE name = 'Mandala Looping 1-Min Session'");

    console.log("Inserting new session template: 'Mandala Looping 1-Min Session'...");
    const sessionResult = await pool.query(`
      INSERT INTO session_templates (name, status, settlement_mode, settlement_delay_sessions, post_closing_enabled, is_active)
      VALUES ('Mandala Looping 1-Min Session', 'closed', 'end_of_session', 0, true, true)
      RETURNING id
    `);
    
    const sessionId = sessionResult.rows[0]?.id;
    if (!sessionId) throw new Error("Failed to create session template");

    console.log(`Created template with ID: ${sessionId}`);
    console.log("Inserting 8 session segments with total duration of 60 seconds (1 minute)...");

    const segments = [
      { seq: 1, status: 'pre_open', dur: 3, order: true, cancel: true },
      { seq: 2, status: 'opening_auction', dur: 3, order: true, cancel: false },
      { seq: 3, status: 'continuous', dur: 36, order: true, cancel: true },
      { seq: 4, status: 'pre_close', dur: 3, order: true, cancel: true },
      { seq: 5, status: 'non_cancellation', dur: 3, order: true, cancel: false },
      { seq: 6, status: 'closing_auction', dur: 3, order: true, cancel: false },
      { seq: 7, status: 'post_closing', dur: 5, order: true, cancel: false },
      { seq: 8, status: 'closed', dur: 4, order: false, cancel: false }
    ];

    for (const seg of segments) {
      await pool.query(
        `
        INSERT INTO session_segments (template_id, sequence, status, duration_seconds, allow_order_entry, allow_cancel_amend)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [sessionId, seg.seq, seg.status, seg.dur, seg.order, seg.cancel]
      );
      console.log(`- Inserted segment ${seg.seq}: ${seg.status} (${seg.dur}s)`);
    }

    await pool.query("COMMIT");
    console.log("Successfully created and activated 'Mandala Looping 1-Min Session' Template!");
  } catch (err: any) {
    await pool.query("ROLLBACK");
    console.error("Failed to create session template:", err.message);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
