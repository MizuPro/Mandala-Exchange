import { Client } from 'pg';
const client = new Client('postgresql://postgres:postgres@localhost:5432/mandala_sekuritas');
client.connect()
  .then(async () => {
    const res = await client.query("SELECT id FROM users WHERE email LIKE '%@bot.mandala.local'");
    const userIds = res.rows.map(r => `'${r.id}'`).join(',');
    if (userIds.length > 0) {
      await client.query(`DELETE FROM notifications WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM ledger_movements WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM cash_balances WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM securities_positions WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM trade_fills WHERE order_id IN (SELECT id FROM orders WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds})))`);
      await client.query(`DELETE FROM settlement_events WHERE order_id IN (SELECT id FROM orders WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds})))`);
      await client.query(`DELETE FROM settlement_inbox WHERE mats_order_id IN (SELECT mats_order_id FROM orders WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds})))`);
      await client.query(`DELETE FROM orders WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM sid_references WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM sre_references WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM rdn_references WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM fee_ledgers WHERE broker_account_id IN (SELECT id FROM broker_accounts WHERE user_id IN (${userIds}))`);
      await client.query(`DELETE FROM broker_accounts WHERE user_id IN (${userIds})`);
      await client.query(`DELETE FROM email_verifications WHERE user_id IN (${userIds})`);
      await client.query(`DELETE FROM users WHERE id IN (${userIds})`);
    }
    console.log('Bots cleared');
  })
  .then(() => client.end())
  .catch((err) => { console.error(err); client.end(); });
