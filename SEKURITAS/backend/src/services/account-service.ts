import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { users, broker_accounts, sid_references, sre_references, rdn_references, cash_balances, email_verifications, withdrawal_bank_accounts } from "../db/schema.js";
import crypto from "crypto";
import { env } from "../config/env.js";

type PrimaryBankAccount = {
  bankCode?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
};

type BrokerSetupData = {
  rdnNumber: string;
  sid: string;
  sre: string;
  primaryBankAccount?: PrimaryBankAccount | null;
};

export async function setupRDNForUser(email: string, accountType: "HUMAN" | "BOT" = "HUMAN") {
  const sidSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  const sreSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  const sid = `IDD${sidSuffix}`;
  const sre = `SRE${sreSuffix}`;
  let rdnNumber = "";
  let primaryBankAccount: PrimaryBankAccount | null = null;

  if (accountType === "HUMAN" && env.financeMode === "rdn" && env.bankMandalaUrl && env.bankMandalaApiKey) {
    // 1. Fetch kependudukan data
    const kepRes = await fetch(`${env.bankMandalaUrl}/api/b2b/kependudukan?email=${encodeURIComponent(email)}`, {
      headers: { "x-api-key": env.bankMandalaApiKey }
    });

    if (!kepRes.ok) {
      throw new Error(`Data kependudukan tidak ditemukan atau belum terverifikasi di Bank Mandala CB untuk email ${email}. Silakan verifikasi KYC di aplikasi Bank Mandala terlebih dahulu.`);
    }

    const kepData = (await kepRes.json()).data;
    primaryBankAccount = kepData?.primaryBankAccount || null;

    // 2. Register RDN
    const rdnRes = await fetch(`${env.bankMandalaUrl}/api/b2b/accounts/rdn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        "x-api-key": env.bankMandalaApiKey
      },
      body: JSON.stringify({
        userId: kepData.userId,
        name: kepData.fullName,
        nik: kepData.nik,
        sid,
        sre
      })
    });

    if (!rdnRes.ok) {
      throw new Error("Gagal membuat rekening RDN di Bank Mandala CB.");
    }

    const rdnData = (await rdnRes.json()).data;
    rdnNumber = rdnData.accountNumber;
  } else {
    // Simulator mode or BOT
    const rdnSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    rdnNumber = `RDN${rdnSuffix}`;
  }

  return { rdnNumber, sid, sre, primaryBankAccount };
}

export async function createBrokerAccount(
  userId: string, 
  rdnData: BrokerSetupData, 
  accountType: "HUMAN" | "BOT" = "HUMAN"
) {
  return await db.transaction(async (tx) => {
    // Create broker account
    const [account] = await tx.insert(broker_accounts).values({
      user_id: userId,
      account_type: accountType,
      status: "ACTIVE"
    }).returning();

    await tx.insert(sid_references).values({
      broker_account_id: account.id,
      sid: rdnData.sid
    });

    await tx.insert(sre_references).values({
      broker_account_id: account.id,
      sre: rdnData.sre
    });

    await tx.insert(rdn_references).values({
      broker_account_id: account.id,
      rdn: rdnData.rdnNumber
    });

    const bankAccount = rdnData.primaryBankAccount;
    if (bankAccount?.accountNumber && bankAccount?.accountHolderName) {
      await tx.insert(withdrawal_bank_accounts).values({
        broker_account_id: account.id,
        bank_code: bankAccount.bankCode || "MANDALA",
        bank_name: bankAccount.bankName || "Bank Mandala",
        account_number: String(bankAccount.accountNumber).replace(/\D/g, ""),
        account_holder_name: bankAccount.accountHolderName,
        status: "verified",
        source: "bank_mandala",
        is_primary: true,
      });
    }

    // Initialize cash balance
    await tx.insert(cash_balances).values({
      broker_account_id: account.id,
      available: "0",
      reserved: "0",
      pending: "0"
    });

    return account;
  });
}
