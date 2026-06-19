import { db } from "./db/db.js";
import { users, broker_accounts, securities_positions, ledger_movements } from "./db/schema.js";
import { eq, and } from "drizzle-orm";
import { createBrokerAccount } from "./services/account-service.js";
import { beiClient } from "./services/bei-client.js";
import * as dotenv from "dotenv";

dotenv.config();

// Konstanta 100 Lot = 100 * 100 lembar = 10.000 lembar
const TARGET_LOTS = 100;
const SHARES_PER_LOT = 100;
const TARGET_SHARES = TARGET_LOTS * SHARES_PER_LOT; // 10,000 lembar

interface SecurityInfo {
  symbol: string;
  referencePrice: string;
}

async function main() {
  const email = "mik@mik.com";
  console.log(`Starting development share allocation for: ${email}`);

  // 1. Dapatkan atau buat user mik@mik.com
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.log(`User ${email} not found. Creating user...`);
    // Hash password dummy 'mik123456' menggunakan algoritma default
    // Di auth.ts, hashPassword dipanggil dari "../lib/password.js"
    // Namun kita bisa buat user dengan password hash dummy yang valid
    // jika kita tidak mengimpor helper password secara langsung.
    // Tapi untuk meminimalkan error, mari kita buat user terverifikasi langsung
    const dummyHash = "scrypt$6223b1fd8dd6632a80d54f7ebc7f85dd$aa81ce30a559bdbde8a7c2f52844897103fe75ac4e48380a82ff3bf2a3f497194ace71b7a6d7d1f80999043eead88e29228de22589fc7ea4eac6bd8020610e7c";
    [user] = await db.insert(users).values({
      email,
      password_hash: dummyHash,
      status: "verified"
    }).returning();
    console.log(`User created with ID: ${user.id}`);
  } else {
    console.log(`User found with ID: ${user.id}, Status: ${user.status}`);
    if (user.status !== "verified") {
      console.log("Updating user status to 'verified'...");
      await db.update(users).set({ status: "verified" }).where(eq(users.id, user.id));
    }
  }

  // 2. Dapatkan atau buat broker account
  let [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
  if (!account) {
    console.log("Broker account not found. Creating broker account...");
    account = await createBrokerAccount(user.id, "HUMAN");
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

  // 4. Lakukan alokasi saham dalam sebuah transaksi
  await db.transaction(async (tx) => {
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

      // Catat mutasi ledger
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

  console.log("Share allocation transaction completed successfully!");
  process.exit(0);
}

main().catch(err => {
  console.error("Error during execution:", err);
  process.exit(1);
});
