import pg from "pg";

async function main() {
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  await sekDbClient.connect();
  await beiDbClient.connect();

  console.log("\n=== SEKURITAS: ORDERS FOR MOSE-W ===");
  const sekOrders = await sekDbClient.query("SELECT id, broker_account_id, side, order_type, price, original_quantity, remaining_quantity, filled_quantity, status, reject_reason FROM orders WHERE symbol = 'MOSE-W'");
  console.log(sekOrders.rows);

  console.log("\n=== BEI: TRADES FOR MOSE-W ===");
  const beiSec = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE-W'");
  if (beiSec.rows.length > 0) {
    const secId = beiSec.rows[0].id;
    const beiTrades = await beiDbClient.query("SELECT * FROM trades WHERE security_id = $1", [secId]);
    console.log(beiTrades.rows);
  } else {
    console.log("MOSE-W not found in BEI listed_securities");
  }

  await sekDbClient.end();
  await beiDbClient.end();
}

main().catch(console.error);
