import pg from "pg";

async function main() {
  console.log("Connecting to BEI database...");
  const client = new pg.Client({
    connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei",
  });
  await client.connect();

  console.log("\n--- FETCHING ALL CUSTODY ACCOUNTS ---");
  const accounts = await client.query("SELECT id, sid, sre, investor_id FROM custody_accounts LIMIT 15");
  console.log(JSON.stringify(accounts.rows, null, 2));

  await client.end();
}

main().catch(console.error);
