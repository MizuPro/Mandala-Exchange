import { db } from "./db/db.js";
import { users, broker_accounts, securities_positions, ledger_movements, cash_balances } from "./db/schema.js";
import { eq, and } from "drizzle-orm";
import { createBrokerAccount, setupRDNForUser } from "./services/account-service.js";
import { beiClient } from "./services/bei-client.js";
import { hashPassword } from "./lib/password.js";
import * as dotenv from "dotenv";

dotenv.config();

// Konstanta 100 Lot = 100 * 100 lembar = 10.000 lembar
const TARGET_LOTS = 100;
const SHARES_PER_LOT = 100;
const TARGET_SHARES = TARGET_LOTS * SHARES_PER_LOT; // 10,000 lembar
const INITIAL_CASH = "1000000000"; // 1 Miliar Rupiah (dalam string numeric)
const PASSWORD_PLAIN = "mik123456";

interface SecurityInfo {
  symbol: string;
  referencePrice: string;
}

async function main() {
  const email = process.argv[2] || "dev_user_mandala@mandala.com";
  console.log(`Starting development account and share allocation for email: ${email}`);

  // Generate dynamic password hash yang valid
  const validHash = hashPassword(PASSWORD_PLAIN);

  // 1. Dapatkan atau buat user
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.log(`User ${email} not found. Creating user...`);
    [user] = await db.insert(users).values({
      email,
      password_hash: validHash,
      status: "verified"
    }).returning();
    console.log(`User created with ID: ${user.id}`);
  } else {
    console.log(`User found with ID: ${user.id}, Status: ${user.status}. Updating password hash to ensure it is valid...`);
    await db.update(users).set({ 
      status: "verified",
      password_hash: validHash
    }).where(eq(users.id, user.id));
  }

  // 2. Dapatkan atau buat broker account
  let [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
  if (!account) {
    console.log("Broker account not found. Creating broker account...");
    const rdnData = await setupRDNForUser(email, "HUMAN");
    account = await createBrokerAccount(user.id, rdnData, "HUMAN");
    console.log(`Broker account created with ID: ${account.id}`);
  } else {
    console.log(`Broker account found with ID: ${account.id}`);
  }

  // 3. Dapatkan list saham dari BEI
  let activeSecurities: SecurityInfo[] = [];
  try {
    console.log("Fetching listed securities from BEI API...");
    const securities = await beiClient.getListedSecurities();
    activeSecurities = securities.map((s: any) => ({
      symbol: s.symbol,
      referencePrice: s.reference_price || "0"
    }));
  } catch (err: any) {
    console.log("Failed to fetch from BEI API, falling back to default symbols (BARA, MNDL, NUSA)...", err.message);
    activeSecurities = [
      { symbol: "BARA", referencePrice: "188.00" },
      { symbol: "MNDL", referencePrice: "320.00" },
      { symbol: "NUSA", referencePrice: "740.00" }
    ];
  }

  console.log(`Found ${activeSecurities.length} active securities to grant:`, activeSecurities.map(s => s.symbol).join(", "));

  // 4. Lakukan alokasi saham dan kas dalam sebuah transaksi database tunggal
  await db.transaction(async (tx) => {
    // A. Alokasikan Saldo Kas
    console.log(`Allocating initial cash of Rp ${Number(INITIAL_CASH).toLocaleString('id-ID')}...`);
    const [existingCash] = await tx.select()
      .from(cash_balances)
      .where(eq(cash_balances.broker_account_id, account.id))
      .limit(1);

    if (existingCash) {
      console.log(`Existing cash balance found. Setting available to Rp ${Number(INITIAL_CASH).toLocaleString('id-ID')}.`);
      await tx.update(cash_balances)
        .set({
          available: INITIAL_CASH,
          reserved: "0",
          pending: "0",
          updated_at: new Date()
        })
        .where(eq(cash_balances.id, existingCash.id));
    } else {
      console.log("No existing cash balance record. Creating one.");
      await tx.insert(cash_balances)
        .values({
          broker_account_id: account.id,
          available: INITIAL_CASH,
          reserved: "0",
          pending: "0"
        });
    }

    // Catat mutasi kas di ledger
    await tx.insert(ledger_movements)
      .values({
        broker_account_id: account.id,
        asset_type: "CASH",
        symbol: null,
        amount: INITIAL_CASH,
        balance_after: INITIAL_CASH,
        reference_type: "DEPOSIT",
        reference_id: `DEV_GRANT_CASH_${Date.now()}`
      });

    // B. Alokasikan Saham
    for (const security of activeSecurities) {
      console.log(`Allocating ${TARGET_LOTS} lots (${TARGET_SHARES} shares) of ${security.symbol} (avg price: ${security.referencePrice})...`);

      // Cek apakah posisi saham sudah ada
      const [existingPos] = await tx.select()
        .from(securities_positions)
        .where(
          and(
            eq(securities_positions.broker_account_id, account.id),
            eq(securities_positions.symbol, security.symbol)
          )
        )
        .limit(1);

      if (existingPos) {
        console.log(`Existing position found for ${security.symbol}. Updating to ${TARGET_SHARES} shares.`);
        await tx.update(securities_positions)
          .set({
            available: TARGET_SHARES,
            reserved: 0,
            pending: 0,
            average_price: security.referencePrice,
            updated_at: new Date()
          })
          .where(eq(securities_positions.id, existingPos.id));
      } else {
        console.log(`No existing position found for ${security.symbol}. Inserting new position.`);
        await tx.insert(securities_positions)
          .values({
            broker_account_id: account.id,
            symbol: security.symbol,
            available: TARGET_SHARES,
            reserved: 0,
            pending: 0,
            average_price: security.referencePrice,
            realized_pl: "0",
            unrealized_pl: "0"
          });
      }

      // Catat mutasi saham di ledger
      await tx.insert(ledger_movements)
        .values({
          broker_account_id: account.id,
          asset_type: "SECURITIES",
          symbol: security.symbol,
          amount: TARGET_SHARES.toString(),
          balance_after: TARGET_SHARES.toString(),
          reference_type: "DEPOSIT",
          reference_id: `DEV_GRANT_${security.symbol}_${Date.now()}`
        });
    }
  });

  console.log("Development account creation and share/cash allocation completed successfully!");
  process.exit(0);
}

main().catch(err => {
  console.error("Error during execution:", err);
  process.exit(1);
});
