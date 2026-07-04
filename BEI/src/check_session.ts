import pg from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei",
  });

  await client.connect();
  console.log("Connected to BEI database:", client.database);

  try {
    const res = await client.query(`
      SELECT 
        si.id, 
        si.virtual_day_index, 
        si.status, 
        si.current_segment_sequence, 
        si.updated_at,
        st.name AS template_name
      FROM session_instances si
      JOIN session_templates st ON st.id = si.session_template_id
      ORDER BY si.virtual_day_index DESC, si.updated_at DESC
      LIMIT 5
    `);

    console.log("Session Instances:");
    console.table(res.rows);

    const segments = await client.query(`
      SELECT sequence, status, duration_seconds, allow_order_entry, allow_cancel_amend
      FROM session_segments
      WHERE template_id = (SELECT session_template_id FROM session_instances ORDER BY virtual_day_index DESC LIMIT 1)
      ORDER BY sequence
    `);
    console.log("Session Template Segments:");
    console.table(segments.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.end();
  }
}

main();
