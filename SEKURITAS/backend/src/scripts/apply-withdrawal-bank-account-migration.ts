import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
const filename = "0006_withdrawal_bank_accounts.sql";

if (!env.isProduction || env.financeMode !== "rdn") {
  throw new Error("Migration rekening penarikan ini hanya boleh dijalankan di production dengan FINANCE_MODE=rdn.");
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationPath = path.join(currentDir, "..", "db", "migrations", filename);
const pool = new Pool({ connectionString: env.databaseUrl });
const client = await pool.connect();

try {
  const sql = await fs.readFile(migrationPath, "utf8");
  await client.query("BEGIN");
  await client.query(sql);
  await client.query(`
    CREATE TABLE IF NOT EXISTS sekuritas_schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    INSERT INTO sekuritas_schema_migrations (filename)
    VALUES ($1)
    ON CONFLICT (filename) DO NOTHING
  `, [filename]);
  await client.query("COMMIT");
  console.log(`[Sekuritas DB] Applied ${filename}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
