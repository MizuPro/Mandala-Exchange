import crypto from "node:crypto";
import { bot_account_events, broker_accounts } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

export async function appendBotAccountEventTx(tx: any, input: {
  brokerAccountId: string;
  eventType: string;
  entityId: string;
  entityVersion: number;
  correlationId?: string;
  payload?: Record<string, unknown>;
}) {
  const [account] = await tx.select({ accountType: broker_accounts.account_type })
    .from(broker_accounts)
    .where(eq(broker_accounts.id, input.brokerAccountId))
    .limit(1);
  if (account?.accountType !== "BOT") return;
  const sequenceResult = await tx.execute(sql`
    UPDATE bot_event_sequence_counter
    SET value = value + 1
    WHERE id = 1
    RETURNING value
  `);
  const sequence = Number(sequenceResult.rows?.[0]?.value);
  if (!Number.isSafeInteger(sequence)) throw new Error("BOT event sequence exhausted safe integer range");
  await tx.insert(bot_account_events).values({
    sequence,
    broker_account_id: input.brokerAccountId,
    event_type: input.eventType,
    entity_id: input.entityId,
    entity_version: input.entityVersion,
    correlation_id: input.correlationId || crypto.randomUUID(),
    payload: input.payload || {},
  }).onConflictDoNothing();
}
