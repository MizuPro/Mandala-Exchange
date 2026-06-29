import { db } from "../db/db.js";
import { bot_ipo_subscriptions, cash_balances, securities_positions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

async function main() {
  const symbol = process.argv[2];
  if (!symbol) {
    console.error("Please provide a symbol. Usage: npx tsx simulate_bot_ipo_distribution.ts <SYMBOL>");
    process.exit(1);
  }

  console.log(`Starting IPO distribution simulation for BOT subscriptions on symbol: ${symbol}`);

  const subscriptions = await db.select().from(bot_ipo_subscriptions).where(
    and(
      eq(bot_ipo_subscriptions.symbol, symbol),
      eq(bot_ipo_subscriptions.status, "pending")
    )
  );

  console.log(`Found ${subscriptions.length} pending subscriptions.`);

  let successCount = 0;
  for (const sub of subscriptions) {
    try {
      await db.transaction(async (tx) => {
        // Find existing securities position or create one
        let [position] = await tx.select().from(securities_positions).where(
          and(
            eq(securities_positions.broker_account_id, sub.broker_account_id),
            eq(securities_positions.symbol, symbol)
          )
        ).limit(1);

        if (!position) {
          [position] = await tx.insert(securities_positions).values({
            broker_account_id: sub.broker_account_id,
            symbol,
            available: sub.quantity,
            reserved: 0,
            pending: 0,
            average_price: sub.price,
            realized_pl: "0",
            unrealized_pl: "0"
          }).returning();
        } else {
          // Weighted average price
          const oldQty = position.available + position.reserved + position.pending;
          const oldAvgPrice = Number(position.average_price);
          const newQty = sub.quantity;
          const newAvgPrice = Number(sub.price);
          
          const totalQty = oldQty + newQty;
          const avgPrice = totalQty > 0 ? ((oldQty * oldAvgPrice) + (newQty * newAvgPrice)) / totalQty : 0;

          await tx.update(securities_positions).set({
            available: position.available + sub.quantity,
            average_price: avgPrice.toString()
          }).where(eq(securities_positions.id, position.id));
        }

        // Deduct from reserved cash
        const [cash] = await tx.select().from(cash_balances).where(
          eq(cash_balances.broker_account_id, sub.broker_account_id)
        ).limit(1);

        if (cash) {
          const currentReserved = BigInt(cash.reserved);
          const deductAmount = BigInt(sub.total_amount);
          
          // Ensure we don't go below 0 for reserved (though it shouldn't happen if properly reserved)
          const newReserved = currentReserved >= deductAmount ? currentReserved - deductAmount : 0n;
          
          await tx.update(cash_balances).set({
            reserved: newReserved.toString()
          }).where(eq(cash_balances.id, cash.id));
        }

        // Update subscription status
        await tx.update(bot_ipo_subscriptions).set({
          status: "allocated"
        }).where(eq(bot_ipo_subscriptions.id, sub.id));
      });

      console.log(`- Allocated ${sub.quantity} shares of ${symbol} to account ${sub.broker_account_id}`);
      successCount++;
    } catch (err: any) {
      console.error(`- Failed to allocate for subscription ${sub.id}: ${err.message}`);
    }
  }

  console.log(`\nSimulation complete. Successfully distributed: ${successCount}/${subscriptions.length}`);
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
