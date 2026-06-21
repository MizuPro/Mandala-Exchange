import { db } from "./src/db/db.js";
import { broker_accounts, orders } from "./src/db/schema.js";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "./src/config/env.js";

async function run() {
  const [o] = await db.select().from(orders).where(eq(orders.id, '9fd08bf6-43e5-46fb-8fdd-2e06467804ad')).limit(1);
  if (!o) { console.log("Order not found"); process.exit(1); }
  
  const brokerAccRows = await db.execute(`SELECT user_id FROM broker_accounts WHERE id = '${o.broker_account_id}'`);
  const userId = (brokerAccRows.rows[0] as any).user_id;

  const token = jwt.sign({ user_id: userId }, env.jwtSecret, { expiresIn: '1h' });
  console.log("Generated Token");

  const res = await fetch(`http://localhost:3002/api/v1/orders/${o.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  console.log("Status:", res.status);
  console.log("Body:", await res.text());
  process.exit(0);
}
run();
