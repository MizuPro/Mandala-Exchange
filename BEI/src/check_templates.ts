import pg from "pg";
import { config } from "./config.js";

async function main() {
  console.log("Checking session templates in BEI database...");
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL || "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });
  
  try {
    const res = await pool.query("SELECT id, name, status, settlement_mode, is_active, created_at FROM session_templates");
    console.log("Session Templates:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err: any) {
    console.error("Error querying BEI database:", err.message);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
