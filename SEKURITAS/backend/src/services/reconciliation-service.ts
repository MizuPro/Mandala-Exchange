import { db } from "../db/db.js";
import { rdn_references, cash_balances } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";

export async function reconcileUserBalance(brokerAccountId: string) {
  if (env.financeMode !== "rdn" || !env.bankMandalaUrl || !env.bankMandalaApiKey) {
    return;
  }

  const [rdnRef] = await db.select().from(rdn_references).where(eq(rdn_references.broker_account_id, brokerAccountId)).limit(1);
  if (!rdnRef) return;

  const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAccountId)).limit(1);
  if (!cash) return;

  try {
    const response = await fetch(`${env.bankMandalaUrl}/api/b2b/accounts/rdn/${rdnRef.rdn}/balance`, {
      headers: { "x-api-key": env.bankMandalaApiKey || "" }
    });

    if (!response.ok) {
      console.error(`[Reconciliation] Failed to fetch bank balance for RDN ${rdnRef.rdn}: HTTP ${response.status}`);
      return;
    }

    const payload = await response.json() as any;
    if (!payload.success || !payload.data) {
      console.error(`[Reconciliation] Bank balance API returned success=false for RDN ${rdnRef.rdn}`);
      return;
    }

    const bankBalance = parseFloat(payload.data.balance);
    const localAvailable = parseFloat(cash.available);
    const localReserved = parseFloat(cash.reserved);

    const totalLocal = localAvailable + localReserved;
    // Jika selisih lebih dari Rp 0.01 (untuk menghindari floating-point issue)
    if (Math.abs(totalLocal - bankBalance) > 0.01) {
      const newAvailable = Math.max(0, bankBalance - localReserved).toFixed(2);
      
      await db.update(cash_balances)
        .set({
          available: newAvailable,
          updated_at: new Date()
        })
        .where(eq(cash_balances.id, cash.id));

      console.log(`[Reconciliation] Balance updated for BrokerAccount ${brokerAccountId} (RDN ${rdnRef.rdn}). Old Available: ${localAvailable}, New Available: ${newAvailable}, Reserved: ${localReserved}, Bank Balance: ${bankBalance}`);
    }
  } catch (err: any) {
    console.error(`[Reconciliation] Error calling Bank Mandala API for RDN ${rdnRef.rdn}:`, err.message);
  }
}

export async function reconcileAllUsers() {
  if (env.financeMode !== "rdn" || !env.bankMandalaUrl || !env.bankMandalaApiKey) {
    return;
  }

  console.log("[Reconciliation] Running RDN balance reconciliation job...");
  try {
    const allRdn = await db.select().from(rdn_references);
    for (const ref of allRdn) {
      try {
        await reconcileUserBalance(ref.broker_account_id);
      } catch (err: any) {
        console.error(`[Reconciliation] Error reconciling broker account ${ref.broker_account_id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error(`[Reconciliation] Error fetching RDN references:`, err.message);
  }
  console.log("[Reconciliation] RDN balance reconciliation job finished.");
}
