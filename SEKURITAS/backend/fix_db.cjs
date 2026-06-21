const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://mandala_sekuritas_prod:prod_sekuritasdb_3e684dff893d4ff7@localhost:5532/mandala_sekuritas_prod'
});
async function main() {
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "withdrawal_requests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "broker_account_id" uuid NOT NULL REFERENCES "broker_accounts"("id") ON DELETE no action ON UPDATE no action,
        "amount" numeric(20, 2) NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        "processed_at" timestamp
      );
    `);
    console.log('withdrawal_requests created');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS "settlement_inbox" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "payload" jsonb NOT NULL,
        "error_message" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log('settlement_inbox created');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS "settlement_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "trade_id" uuid NOT NULL,
        "settlement_date" timestamp NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log('settlement_events created');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
        "title" text NOT NULL,
        "message" text NOT NULL,
        "type" text NOT NULL,
        "read" boolean DEFAULT false NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log('notifications created');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS "corporate_action_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "symbol" text NOT NULL,
        "type" text NOT NULL,
        "ex_date" timestamp NOT NULL,
        "payment_date" timestamp NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log('corporate_action_events created');
    
  } catch(e) {
    console.error(e);
  } finally {
    await client.end();
  }
}
main();
