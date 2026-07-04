import pg from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas",
  });

  await client.connect();
  console.log("Connected to database:", client.database);

  try {
    const res = await client.query(`
      SELECT 
        id, 
        broker_account_id, 
        symbol, 
        side, 
        price, 
        original_quantity, 
        status, 
        reject_reason, 
        created_at 
      FROM orders 
      ORDER BY created_at DESC 
      LIMIT 50
    `);

    console.log("Last 10 rejected orders:");
    console.table(res.rows);
  } catch (err) {
    console.error("Error running query:", err);
  } finally {
    await client.end();
  }
}

main();
