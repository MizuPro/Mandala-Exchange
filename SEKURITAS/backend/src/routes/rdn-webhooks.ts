import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/db.js";
import { rdn_references, cash_balances, ledger_movements, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { env } from "../config/env.js";

interface RdnDepositPayload {
  event: string;
  rdn: string;
  amount: string;
  transactionId: string;
  timestamp: string;
}

export default async function rdnWebhookRoutes(fastify: FastifyInstance) {
  fastify.post("/rdn-deposit", async (request: FastifyRequest<{ Body: RdnDepositPayload }>, reply: FastifyReply) => {
    // Only enabled in production + RDN mode
    if (env.financeMode !== "rdn" || !env.webhookSecret) {
      return reply.status(404).send({ error: "Webhook not enabled or configured" });
    }

    const signature = request.headers["x-webhook-signature"] as string;
    if (!signature) {
      return reply.status(401).send({ error: "Missing signature" });
    }

    // Verify HMAC signature
    const expectedSignature = crypto.createHmac('sha256', env.webhookSecret)
      .update(JSON.stringify(request.body))
      .digest('hex');

    if (signature !== expectedSignature) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const { rdn, amount, transactionId } = request.body;

    const [rdnRef] = await db.select().from(rdn_references).where(eq(rdn_references.rdn, rdn)).limit(1);
    if (!rdnRef) {
      return reply.status(404).send({ error: "RDN not found" });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return reply.status(400).send({ error: "Invalid amount" });
    }

    // Idempotency check: check if transactionId already processed
    const [existingLedger] = await db.select().from(ledger_movements).where(eq(ledger_movements.reference_id, transactionId)).limit(1);
    if (existingLedger) {
      return reply.send({ success: true, message: "Already processed" });
    }

    await db.transaction(async (tx) => {
      // Get cash balance with lock
      const [balance] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, rdnRef.broker_account_id)).limit(1).for("update");
      
      const newAvailable = (parseFloat(balance.available) + numericAmount).toFixed(2);
      
      // Update balance
      await tx.update(cash_balances)
        .set({ available: newAvailable, updated_at: new Date() })
        .where(eq(cash_balances.id, balance.id));
      
      // Insert ledger movement
      await tx.insert(ledger_movements).values({
        broker_account_id: rdnRef.broker_account_id,
        asset_type: "CASH",
        amount: numericAmount.toFixed(2),
        balance_after: newAvailable,
        reference_type: "DEPOSIT",
        reference_id: transactionId,
      });
    });

    return reply.send({ success: true });
  });
}
