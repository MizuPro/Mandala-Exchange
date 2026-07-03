import { db } from "./db/db.js";
import { users, broker_accounts, securities_positions, cash_balances, ledger_movements } from "./db/schema.js";
import { eq } from "drizzle-orm";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const email = process.argv[2] || "dev_user_mandala@mandala.com";
  console.log(`=== VERIFYING DATABASE FOR EMAIL: ${email} ===`);

  // 1. Get User
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.error(`ERROR: User ${email} not found!`);
    process.exit(1);
  }
  console.log(`User Found: ID=${user.id}, Status=${user.status}, CreatedAt=${user.created_at}`);

  // 2. Get Broker Account
  const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
  if (!account) {
    console.error("ERROR: Broker account not found!");
    process.exit(1);
  }
  console.log(`Broker Account Found: ID=${account.id}, Type=${account.account_type}, Status=${account.status}`);

  // 3. Get Cash Balance
  const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.id)).limit(1);
  if (!cash) {
    console.log("Cash Balance: NOT FOUND");
  } else {
    console.log(`Cash Balance: Available=Rp ${Number(cash.available).toLocaleString('id-ID')}, Reserved=Rp ${Number(cash.reserved).toLocaleString('id-ID')}, Pending=Rp ${Number(cash.pending).toLocaleString('id-ID')}`);
  }

  // 4. Get Securities Positions
  const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, account.id));
  console.log(`\nSecurities Positions (${positions.length} rows):`);
  positions.forEach(pos => {
    console.log(`- Symbol: ${pos.symbol}, Available: ${pos.available} (Reserved: ${pos.reserved}, Pending: ${pos.pending}), AvgPrice: ${pos.average_price}`);
  });

  // 5. Get Ledger Movements
  const movements = await db.select().from(ledger_movements).where(eq(ledger_movements.broker_account_id, account.id));
  console.log(`\nLedger Movements (${movements.length} rows):`);
  movements.forEach(m => {
    console.log(`- AssetType: ${m.asset_type}, Symbol: ${m.symbol || 'CASH'}, Amount: ${m.amount}, BalanceAfter: ${m.balance_after}, RefType: ${m.reference_type}, RefID: ${m.reference_id}`);
  });

  process.exit(0);
}

main().catch(err => {
  console.error("Error during verification execution:", err);
  process.exit(1);
});
