import "dotenv/config";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

type FailedWithdrawalRow = {
  id: string;
  broker_account_id: string;
  amount: string;
  destination_account_number: string | null;
  error_message: string | null;
};

if (!env.isProduction || env.financeMode !== "rdn") {
  throw new Error("Repair failed withdrawal refunds hanya boleh dijalankan di production dengan FINANCE_MODE=rdn.");
}

const pool = new Pool({ connectionString: env.databaseUrl });
let repaired = 0;
let markedRejected = 0;

try {
  const rows = await pool.query<FailedWithdrawalRow>(`
    SELECT id, broker_account_id, amount, destination_account_number, error_message
    FROM withdrawal_requests
    WHERE status = 'failed'
      AND error_message ILIKE 'Bank Error:%'
      AND error_message NOT ILIKE '%double_refund_repaired%'
    ORDER BY created_at
  `);

  console.log(`[Repair] Kandidat failed withdrawal double-refund: ${rows.rowCount}`);

  for (const row of rows.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(`
        SELECT id
        FROM cash_balances
        WHERE broker_account_id = $1
        FOR UPDATE
      `, [row.broker_account_id]);

      await client.query(`
        UPDATE cash_balances
        SET
          available = available - $2::numeric,
          reserved = reserved + $2::numeric,
          updated_at = now()
        WHERE broker_account_id = $1
      `, [row.broker_account_id, row.amount]);

      await client.query(`
        UPDATE withdrawal_requests
        SET error_message = error_message || ' [double_refund_repaired]',
            updated_at = now()
        WHERE id = $1
      `, [row.id]);

      if (/invalid\s+destination\s+account|destination\s+account/i.test(row.error_message || "") && row.destination_account_number) {
        const updateBank = await client.query(`
          UPDATE withdrawal_bank_accounts
          SET status = 'rejected',
              updated_at = now()
          WHERE broker_account_id = $1
            AND account_number = $2
            AND is_primary = true
        `, [row.broker_account_id, row.destination_account_number]);
        markedRejected += updateBank.rowCount || 0;
      }

      await client.query("COMMIT");
      repaired += 1;
      console.log(`[Repair] Repaired withdrawal ${row.id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}

console.log(`[Repair] Selesai. repaired=${repaired}, markedRejected=${markedRejected}`);
