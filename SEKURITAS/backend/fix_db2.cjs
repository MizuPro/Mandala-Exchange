const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://mandala_sekuritas_prod:prod_sekuritasdb_3e684dff893d4ff7@localhost:5532/mandala_sekuritas_prod'
});
async function main() {
  await client.connect();
  try {
    await client.query(`
      ALTER TABLE withdrawal_requests DROP COLUMN IF EXISTS processed_at;
      ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS bank_mandala_tx_id text;
      ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS error_message text;
    `);
    console.log('withdrawal_requests updated');
    
    await client.query(`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS idempotency_key text UNIQUE;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS broker_account_id uuid REFERENCES broker_accounts(id);
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamp;
    `);
    console.log('notifications updated');
    
  } catch(e) {
    console.error(e);
  } finally {
    await client.end();
  }
}
main();
