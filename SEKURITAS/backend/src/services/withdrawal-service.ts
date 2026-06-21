import { db } from "../db/db.js";
import { withdrawal_requests, cash_balances, rdn_references, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { v4 as uuidv4 } from "uuid";

export async function requestWithdrawal(brokerAccountId: string, amount: number, description?: string) {
  if (amount <= 0) {
    throw new Error("Amount must be greater than 0");
  }

  // Simulator mode: auto complete
  if (env.financeMode !== "rdn" || !env.isProduction) {
    return await db.transaction(async (tx) => {
      const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1).for("update");
      
      if (parseFloat(balance.available) < amount) {
        throw new Error("Insufficient funds");
      }

      await tx.update(cash_balances)
        .set({ available: (parseFloat(balance.available) - amount).toFixed(2), updated_at: new Date() })
        .where(eq(cash_balances.id, balance.id));

      const [req] = await tx.insert(withdrawal_requests).values({
        broker_account_id: brokerAccountId,
        amount: amount.toString(),
        status: "completed",
      }).returning();

      return req;
    });
  }

  // RDN Mode
  // 1. Get RDN reference
  const [rdnRef] = await db.select().from(rdn_references).where(eq(rdn_references.broker_account_id, brokerAccountId)).limit(1);
  if (!rdnRef) {
    throw new Error("RDN reference not found");
  }

  // 2. Lock balance and insert pending request
  const requestRecord = await db.transaction(async (tx) => {
    const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1).for("update");
    
    if (parseFloat(balance.available) < amount) {
      throw new Error("Insufficient funds");
    }

    // Move to reserved
    const newAvailable = (parseFloat(balance.available) - amount).toFixed(2);
    const newReserved = (parseFloat(balance.reserved) + amount).toFixed(2);

    await tx.update(cash_balances)
      .set({ available: newAvailable, reserved: newReserved, updated_at: new Date() })
      .where(eq(cash_balances.id, balance.id));

    const [req] = await tx.insert(withdrawal_requests).values({
      broker_account_id: brokerAccountId,
      amount: amount.toString(),
      status: "pending",
    }).returning();

    return req;
  });

  // 3. Call Bank Mandala CB API asynchronously
  const idempotencyKey = requestRecord.id;

  try {
    const res = await fetch(`${env.bankMandalaUrl}/api/b2b/transfers/debit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.bankMandalaApiKey || ""
      },
      body: JSON.stringify({
        sourceAccountNumber: rdnRef.rdn,
        amount: amount.toString(),
        description: description || `Withdrawal from Sekuritas`,
        idempotencyKey
      })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      // Completed, reduce reserved
      await db.transaction(async (tx) => {
        const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1).for("update");
        const newReserved = (parseFloat(balance.reserved) - amount).toFixed(2);
        await tx.update(cash_balances).set({ reserved: newReserved, updated_at: new Date() }).where(eq(cash_balances.id, balance.id));
        await tx.update(withdrawal_requests).set({ status: "completed", bank_mandala_tx_id: data.data.transactionId, updated_at: new Date() }).where(eq(withdrawal_requests.id, requestRecord.id));
      });
      return { ...requestRecord, status: "completed", bank_mandala_tx_id: data.data.transactionId };
    } else {
      // Failed, restore reserved to available
      await db.transaction(async (tx) => {
        const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1).for("update");
        const newReserved = (parseFloat(balance.reserved) - amount).toFixed(2);
        const newAvailable = (parseFloat(balance.available) + amount).toFixed(2);
        await tx.update(cash_balances).set({ reserved: newReserved, available: newAvailable, updated_at: new Date() }).where(eq(cash_balances.id, balance.id));
        await tx.update(withdrawal_requests).set({ status: "failed", error_message: data.error || "Bank API error", updated_at: new Date() }).where(eq(withdrawal_requests.id, requestRecord.id));
      });
      throw new Error(`Bank Error: ${data.error || "Unknown Error"}`);
    }
  } catch (error: any) {
    // Network or other error, mark as failed and refund
    await db.transaction(async (tx) => {
      const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1).for("update");
      const newReserved = (parseFloat(balance.reserved) - amount).toFixed(2);
      const newAvailable = (parseFloat(balance.available) + amount).toFixed(2);
      await tx.update(cash_balances).set({ reserved: newReserved, available: newAvailable, updated_at: new Date() }).where(eq(cash_balances.id, balance.id));
      await tx.update(withdrawal_requests).set({ status: "failed", error_message: error.message, updated_at: new Date() }).where(eq(withdrawal_requests.id, requestRecord.id));
    });
    throw error;
  }
}
