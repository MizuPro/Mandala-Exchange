import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { users, broker_accounts, sid_references, sre_references, rdn_references, cash_balances, email_verifications } from "../db/schema.js";
import crypto from "crypto";
import { env } from "../config/env.js";

export async function createBrokerAccount(userId: string, accountType: "HUMAN" | "BOT" = "HUMAN") {
  return await db.transaction(async (tx) => {
    // Create broker account
    const [account] = await tx.insert(broker_accounts).values({
      user_id: userId,
      account_type: accountType,
      status: "ACTIVE"
    }).returning();

    // Generate random simulation refs
    const sidSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const sreSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const rdnSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();

    await tx.insert(sid_references).values({
      broker_account_id: account.id,
      sid: `IDD${sidSuffix}`
    });

    await tx.insert(sre_references).values({
      broker_account_id: account.id,
      sre: `SRE${sreSuffix}`
    });

    if (env.isSimulatorFinance) {
      await tx.insert(rdn_references).values({
        broker_account_id: account.id,
        rdn: `RDN${rdnSuffix}`
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
