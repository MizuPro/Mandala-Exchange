import { db } from "../db/db.js";
import { cash_balances, securities_positions, fee_ledgers, orders, ledger_movements, broker_accounts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { beiClient } from "./bei-client.js";

// Process settlement for a single trade/order
export async function processSettlement(matsOrderId: string, tradeDetails: any) {
  // In a real scenario, BEI sends settlement info mapping to SRE/SID/Trade.
  // For MVP, we'll map by mats_order_id.
  
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.mats_order_id, matsOrderId)).limit(1);
    if (!order) return; // Order not found, ignore or log

    const filledQty = order.filled_quantity;
    if (filledQty <= 0) return;

    const value = parseFloat(order.price) * filledQty;
    // Mock fees:
    const brokerFee = value * 0.0010; // 0.10%
    const levyFee = value * 0.00043;  // 0.043%
    const vatFee = brokerFee * 0.11;  // 11% of broker fee
    const whtFee = order.side === "SELL" ? value * 0.001 : 0; // 0.1% for sell

    const totalFee = brokerFee + levyFee + vatFee + whtFee;

    // Record Fees
    await tx.insert(fee_ledgers).values([
      { broker_account_id: order.broker_account_id, order_id: order.id, amount: brokerFee.toString(), fee_type: "BROKER" },
      { broker_account_id: order.broker_account_id, order_id: order.id, amount: levyFee.toString(), fee_type: "LEVY_CLEARING" },
      { broker_account_id: order.broker_account_id, order_id: order.id, amount: vatFee.toString(), fee_type: "VAT" },
      ...(whtFee > 0 ? [{ broker_account_id: order.broker_account_id, order_id: order.id, amount: whtFee.toString(), fee_type: "WHT" }] : [])
    ]);

    const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, order.broker_account_id)).limit(1);

    if (order.side === "BUY") {
      // Buyer: pending shares become available. Pending cash (which was deducted from reserved) is finalized.
      // Wait, in order-service.ts, BUY pending cash was created. We need to deduct it and subtract actual totalFee.
      const estimatedFee = value * 0.0015;
      const feeDiff = estimatedFee - totalFee; // usually positive, return to available cash

      const newAvailableCash = parseFloat(cash.available) + feeDiff;
      const newPendingCash = parseFloat(cash.pending) - (value + estimatedFee); // remove from pending

      await tx.update(cash_balances).set({
        available: newAvailableCash.toString(),
        pending: newPendingCash.toString(),
        updated_at: new Date()
      }).where(eq(cash_balances.id, cash.id));

      const [pos] = await tx.select().from(securities_positions)
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol))).limit(1);
      
      if (pos) {
        await tx.update(securities_positions).set({
          pending: pos.pending - filledQty,
          available: pos.available + filledQty,
          updated_at: new Date()
        }).where(eq(securities_positions.id, pos.id));
      }
    } else {
      // SELL: pending cash becomes available. (Seller already lost reserved shares during fill).
      // Pending cash was value - estimated fee.
      const estimatedFee = value * 0.0015;
      const actualNetGained = value - totalFee;
      
      const newAvailableCash = parseFloat(cash.available) + actualNetGained;
      const newPendingCash = parseFloat(cash.pending) - (value - estimatedFee);

      await tx.update(cash_balances).set({
        available: newAvailableCash.toString(),
        pending: newPendingCash.toString(),
        updated_at: new Date()
      }).where(eq(cash_balances.id, cash.id));
      
      // Update Realized P/L for seller
      const [pos] = await tx.select().from(securities_positions)
        .where(and(eq(securities_positions.broker_account_id, order.broker_account_id), eq(securities_positions.symbol, order.symbol))).limit(1);
        
      if (pos) {
        // Simple realized PL calc: (Sell Price - Avg Price) * Qty - Fees
        const avgPrice = parseFloat(pos.average_price);
        const pl = ((parseFloat(order.price) - avgPrice) * filledQty) - totalFee;
        
        await tx.update(securities_positions).set({
          realized_pl: (parseFloat(pos.realized_pl) + pl).toString(),
          updated_at: new Date()
        }).where(eq(securities_positions.id, pos.id));
      }
    }
  });
}
