import { db } from "./db/db.js";
import { users, broker_accounts, securities_positions } from "./db/schema.js";
import { eq } from "drizzle-orm";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const email = "mik@mik.com";
  console.log(`Checking portfolio for user: ${email}...`);
  
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.log("User not found!");
    process.exit(0);
  }
  
  console.log(`User found: ID = ${user.id}`);
  
  const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
  if (!account) {
    console.log("Broker account not found!");
    process.exit(0);
  }
  
  console.log(`Broker account found: ID = ${account.id}, Status = ${account.status}, Type = ${account.account_type}`);
  
  const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, account.id));
  console.log("Securities Positions:");
  console.log(JSON.stringify(positions, null, 2));
  
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
