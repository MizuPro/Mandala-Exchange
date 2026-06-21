import { db } from "../db/db.js";
import { withdrawal_requests, cash_balances, rdn_references, withdrawal_bank_accounts } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { env } from "../config/env.js";

export class BankAccountRequiredError extends Error {
  statusCode = 409;
  code = "bank_account_required";

  constructor(message = "Bank account required") {
    super(message);
    this.name = "BankAccountRequiredError";
  }
}

function isInvalidDestinationAccountError(message: string) {
  return /invalid\s+destination\s+account|destination\s+account/i.test(message);
}

async function failWithdrawalAndRefund(input: {
  brokerAccountId: string;
  requestId: string;
  amount: number;
  errorMessage: string;
  rejectDestinationAccountId?: string;
}) {
  await db.transaction(async (tx) => {
    const [balance] = await tx
      .select()
      .from(cash_balances)
      .where(eq(cash_balances.broker_account_id, input.brokerAccountId))
      .limit(1)
      .for("update");

    const newReserved = (parseFloat(balance.reserved) - input.amount).toFixed(2);
    const newAvailable = (parseFloat(balance.available) + input.amount).toFixed(2);

    await tx.update(cash_balances)
      .set({ reserved: newReserved, available: newAvailable, updated_at: new Date() })
      .where(eq(cash_balances.id, balance.id));

    await tx.update(withdrawal_requests)
      .set({ status: "failed", error_message: input.errorMessage, updated_at: new Date() })
      .where(eq(withdrawal_requests.id, input.requestId));

    if (input.rejectDestinationAccountId) {
      await tx.update(withdrawal_bank_accounts)
        .set({ status: "rejected", updated_at: new Date() })
        .where(eq(withdrawal_bank_accounts.id, input.rejectDestinationAccountId));
    }
  });
}

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

  const [destinationAccount] = await db
    .select()
    .from(withdrawal_bank_accounts)
    .where(and(
      eq(withdrawal_bank_accounts.broker_account_id, brokerAccountId),
      eq(withdrawal_bank_accounts.is_primary, true)
    ))
    .limit(1);

  if (!destinationAccount || destinationAccount.status !== "verified") {
    throw new BankAccountRequiredError("Rekening penarikan belum tersedia. Silakan lakukan pengkinian data rekening.");
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
      destination_bank_name: destinationAccount.bank_name,
      destination_account_number: destinationAccount.account_number,
      destination_account_holder_name: destinationAccount.account_holder_name,
    }).returning();

    return req;
  });

  // 3. Call Bank Mandala CB API asynchronously
  const idempotencyKey = requestRecord.id;
  let compensationApplied = false;

  try {
    const res = await fetch(`${env.bankMandalaUrl}/api/b2b/transfers/debit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.bankMandalaApiKey || ""
      },
      body: JSON.stringify({
        sourceAccountNumber: rdnRef.rdn,
        destinationAccountNumber: destinationAccount.account_number,
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
      const bankError = data.error || "Bank API error";
      const rejectDestinationAccountId = isInvalidDestinationAccountError(bankError) ? destinationAccount.id : undefined;

      await failWithdrawalAndRefund({
        brokerAccountId,
        requestId: requestRecord.id,
        amount,
        errorMessage: `Bank Error: ${bankError}`,
        rejectDestinationAccountId,
      });
      compensationApplied = true;

      if (rejectDestinationAccountId) {
        throw new BankAccountRequiredError("Rekening penarikan ditolak Bank Mandala. Silakan lakukan pengkinian data rekening.");
      }

      throw new Error(`Bank Error: ${bankError}`);
    }
  } catch (error: any) {
    if (compensationApplied) {
      throw error;
    }

    // Network or other error, mark as failed and refund
    await failWithdrawalAndRefund({
      brokerAccountId,
      requestId: requestRecord.id,
      amount,
      errorMessage: error.message,
    });
    throw error;
  }
}
