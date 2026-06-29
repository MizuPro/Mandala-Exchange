import WebSocket from "ws";
import { desc } from "drizzle-orm";
import { db, closeDatabase } from "../db/db.js";
import { bot_account_events, bot_metadata } from "../db/schema.js";
import { appendBotAccountEventTx } from "../services/bot-event-service.js";

async function main() {
  const [bot] = await db.select().from(bot_metadata).limit(1);
  if (!bot) throw new Error("BOT account required");
  const [latest] = await db.select({ sequence: bot_account_events.sequence }).from(bot_account_events).orderBy(desc(bot_account_events.sequence)).limit(1);
  const afterSequence = Number(latest?.sequence || 0);
  const blob = "x".repeat(32 * 1024);
  await db.transaction(async (tx) => {
    for (let index = 0; index < 320; index++) {
      await appendBotAccountEventTx(tx, {
        brokerAccountId: bot.broker_account_id,
        eventType: "slow_consumer_test",
        entityId: `slow-consumer:${Date.now()}:${index}`,
        entityVersion: 1,
        payload: { blob },
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:3002/api/v1/internal/bots/events/ws?after_sequence=${afterSequence}`, {
      headers: { "x-service-token": process.env.BOT_SERVICE_TOKEN! }
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("slow consumer was not disconnected"));
    }, 10_000);
    socket.once("open", () => {
      (socket as any)._socket.pause();
      setTimeout(() => (socket as any)._socket.resume(), 2500);
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      if (code !== 4008 || reason.toString() !== "slow_consumer") {
        reject(new Error(`unexpected close code=${code} reason=${reason.toString()}`));
        return;
      }
      resolve();
    });
    socket.once("error", reject);
  });
  console.log("SLOW CONSUMER DISCONNECT TEST PASSED");
  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
