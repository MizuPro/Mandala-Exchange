import { eq, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { broker_accounts, cash_balances, ledger_movements } from "../db/schema.js";

function money(value: number) {
  return value.toFixed(6);
}

async function getBrokerAccount(userId: string) {
  const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  return account;
}

export async function depositSimulatorFunds(userId: string, amount: number) {
  return db.transaction(async (tx) => {
    const account = await getBrokerAccount(userId);
    if (!account) throw new Error("Broker account not found");

    const [updated] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} + ${money(amount)}` as any,
        updated_at: new Date(),
      })
      .where(eq(cash_balances.broker_account_id, account.id))
      .returning();

    if (!updated) throw new Error("Cash balance not found");

    await tx.insert(ledger_movements).values({
      broker_account_id: account.id,
      asset_type: "CASH",
      amount: money(amount),
      balance_after: updated.available,
      reference_type: "DEPOSIT",
      reference_id: "SIMULATOR",
    });

    return {
      cash: {
        available: updated.available,
        reserved: updated.reserved,
        pending: updated.pending,
      },
    };
  });
}

export async function withdrawSimulatorFunds(userId: string, amount: number) {
  return db.transaction(async (tx) => {
    const account = await getBrokerAccount(userId);
    if (!account) throw new Error("Broker account not found");

    const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.id)).limit(1);
    if (!cash) throw new Error("Cash balance not found");
    if (Number(cash.available) < amount) {
      const err = new Error("Insufficient cash balance");
      (err as any).statusCode = 400;
      throw err;
    }

    const [updated] = await tx
      .update(cash_balances)
      .set({
        available: sql`${cash_balances.available} - ${money(amount)}` as any,
        updated_at: new Date(),
      })
      .where(eq(cash_balances.id, cash.id))
      .returning();

    await tx.insert(ledger_movements).values({
      broker_account_id: account.id,
      asset_type: "CASH",
      amount: money(-amount),
      balance_after: updated.available,
      reference_type: "WITHDRAWAL",
      reference_id: "SIMULATOR",
    });

    return {
      cash: {
        available: updated.available,
        reserved: updated.reserved,
        pending: updated.pending,
      },
    };
  });
}
