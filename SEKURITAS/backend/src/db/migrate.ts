import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

const databaseUrl = env.databaseUrl;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Sekuritas migrations");
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationsDir = path.join(currentDir, "migrations");

const pool = new Pool({ connectionString: databaseUrl });

async function ensureMigrationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sekuritas_schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations() {
  const result = await pool.query<{ filename: string }>(
    "SELECT filename FROM sekuritas_schema_migrations"
  );
  return new Set(result.rows.map((row) => row.filename));
}

async function reconcileLegacyBaseline() {
  const existing = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.broker_accounts') IS NOT NULL AS present"
  );
  if (!existing.rows[0]?.present) return;
  for (const filename of ["0000_initial_schema.sql", "0000_tranquil_dakota_north.sql"]) {
    await pool.query(
      "INSERT INTO sekuritas_schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [filename]
    );
  }
}

async function runMigration(filename: string) {
  const fullPath = path.join(migrationsDir, filename);
  const sql = await fs.readFile(fullPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO sekuritas_schema_migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
    console.log(`[Sekuritas DB] Applied ${filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await ensureMigrationTable();
  await reconcileLegacyBaseline();
  const applied = await appliedMigrations();
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[Sekuritas DB] Skipping ${file}`);
      continue;
    }
    await runMigration(file);
  }
}

main()
  .catch((error) => {
    console.error("[Sekuritas DB] Migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
