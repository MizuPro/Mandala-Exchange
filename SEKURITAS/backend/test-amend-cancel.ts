import { db } from "./src/db/db.js";
import { broker_accounts, orders } from "./src/db/schema.js";
import { placeOrder, amendOrder, cancelOrder } from "./src/services/order-service.js";
import jwt from "jsonwebtoken";
import { env } from "./src/config/env.js";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const [brokerAcc] = await db.select().from(broker_accounts).limit(1);
  const userId = brokerAcc.user_id;

  console.log("1. Placing order...");
  const order = await placeOrder(userId, "BBCA", "buy", 10000, 100, "limit");
  console.log("Order placed:", order.id);

  await sleep(1000); // wait for webhook

  console.log("2. Amending order...");
  await amendOrder(userId, order.id, 9900, 100);
  console.log("Order amended.");

  await sleep(1000); // wait for webhook

  console.log("3. Cancelling order...");
  try {
    const res = await fetch(`http://localhost:3002/api/v1/orders/${order.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${jwt.sign({ user_id: userId }, env.jwtSecret)}` }
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
  } catch (err: any) {
    console.error("Failed to cancel:", err.message);
  }
  process.exit(0);
}

run();
