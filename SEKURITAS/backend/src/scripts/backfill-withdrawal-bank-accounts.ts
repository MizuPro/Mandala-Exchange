import "dotenv/config";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

type KependudukanResponse = {
  success?: boolean;
  data?: {
    primaryBankAccount?: {
      bankCode?: string | null;
      bankName?: string | null;
      accountNumber?: string | null;
      accountHolderName?: string | null;
    } | null;
  };
};

type CandidateRow = {
  user_id: string;
  email: string;
  broker_account_id: string;
};

function assertProductionOnly() {
  if (!env.isProduction || env.financeMode !== "rdn") {
    throw new Error("Backfill rekening penarikan hanya boleh dijalankan di production dengan FINANCE_MODE=rdn.");
  }
  if (!env.bankMandalaUrl || !env.bankMandalaApiKey) {
    throw new Error("BANK_MANDALA_URL dan BANK_MANDALA_API_KEY wajib tersedia untuk backfill.");
  }
}

async function fetchPrimaryBankAccount(email: string) {
  const response = await fetch(`${env.bankMandalaUrl}/api/b2b/kependudukan?email=${encodeURIComponent(email)}`, {
    headers: { "x-api-key": env.bankMandalaApiKey || "" },
  });

  if (!response.ok) {
    return { found: false, reason: `kyc_http_${response.status}` };
  }

  const payload = await response.json() as KependudukanResponse;
  const bankAccount = payload.data?.primaryBankAccount;
  const accountNumber = String(bankAccount?.accountNumber || "").replace(/\D/g, "");
  const accountHolderName = String(bankAccount?.accountHolderName || "").trim();

  if (!accountNumber || !accountHolderName) {
    return { found: false, reason: "primary_bank_account_missing" };
  }

  return {
    found: true,
    bankAccount: {
      bankCode: bankAccount?.bankCode || "MANDALA",
      bankName: bankAccount?.bankName || "Bank Mandala",
      accountNumber,
      accountHolderName,
    },
  };
}

async function main() {
  assertProductionOnly();

  const pool = new Pool({ connectionString: env.databaseUrl });
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const candidates = await pool.query<CandidateRow>(`
      SELECT u.id AS user_id, u.email, ba.id AS broker_account_id
      FROM users u
      INNER JOIN broker_accounts ba ON ba.user_id = u.id
      LEFT JOIN withdrawal_bank_accounts wba
        ON wba.broker_account_id = ba.id
        AND wba.is_primary = true
      WHERE ba.account_type = 'HUMAN'
        AND wba.id IS NULL
      ORDER BY u.email
    `);

    console.log(`[Backfill] Kandidat akun lama tanpa rekening penarikan: ${candidates.rowCount}`);

    for (const row of candidates.rows) {
      try {
        const result = await fetchPrimaryBankAccount(row.email);
        if (!result.found || !result.bankAccount) {
          skipped += 1;
          console.log(`[Backfill] Skip ${row.email}: ${result.reason}`);
          continue;
        }

        await pool.query(`
          INSERT INTO withdrawal_bank_accounts (
            broker_account_id,
            bank_code,
            bank_name,
            account_number,
            account_holder_name,
            status,
            source,
            is_primary,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'verified', 'bank_mandala', true, now())
        `, [
          row.broker_account_id,
          result.bankAccount.bankCode,
          result.bankAccount.bankName,
          result.bankAccount.accountNumber,
          result.bankAccount.accountHolderName,
        ]);

        inserted += 1;
        console.log(`[Backfill] Inserted rekening penarikan untuk ${row.email}`);
      } catch (error: any) {
        failed += 1;
        console.log(`[Backfill] Failed ${row.email}: ${error.message || "unknown_error"}`);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`[Backfill] Selesai. inserted=${inserted}, skipped=${skipped}, failed=${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[Backfill] Fatal", error);
  process.exitCode = 1;
});
