import { db } from "./src/db/db.js";
import { orders } from "./src/db/schema.js";
import { desc } from "drizzle-orm";

async function run() {
  const [o] = await db.select().from(orders).orderBy(desc(orders.created_at)).limit(1);
  console.log(`Order ID: ${o.id}\nStatus: ${o.status}\nMATS ID: ${o.mats_order_id}`);
  process.exit(0);
}
run();
