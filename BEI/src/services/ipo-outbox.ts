import { and, asc, eq, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { ipoLifecycleOutbox } from "../db/schema.js";
import { postSekuritasWebhook } from "./sekuritas-webhook.js";

const MAX_BACKOFF_SECONDS = 300;

function retryAt(attempts: number) {
  const seconds = Math.min(MAX_BACKOFF_SECONDS, Math.max(1, 2 ** Math.min(attempts, 8)));
  return new Date(Date.now() + seconds * 1000);
}

export async function enqueueIpoLifecycleEvent(
  tx: any,
  input: {
    eventKey: string;
    ipoEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }
) {
  await tx
    .insert(ipoLifecycleOutbox)
    .values({
      eventKey: input.eventKey,
      ipoEventId: input.ipoEventId,
      eventType: input.eventType,
      payload: input.payload
    })
    .onConflictDoNothing();
}

export async function deliverPendingIpoLifecycleEvents(limit = 20) {
  const rows = await db
    .select()
    .from(ipoLifecycleOutbox)
    .where(
      and(
        or(eq(ipoLifecycleOutbox.status, "pending"), eq(ipoLifecycleOutbox.status, "failed")),
        lte(ipoLifecycleOutbox.nextAttemptAt, new Date())
      )
    )
    .orderBy(asc(ipoLifecycleOutbox.createdAt))
    .limit(limit);

  let delivered = 0;
  for (const row of rows) {
    const [claimed] = await db
      .update(ipoLifecycleOutbox)
      .set({
        status: "processing",
        attempts: row.attempts + 1,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(ipoLifecycleOutbox.id, row.id),
          or(eq(ipoLifecycleOutbox.status, "pending"), eq(ipoLifecycleOutbox.status, "failed"))
        )
      )
      .returning();
    if (!claimed) continue;

    try {
      const result = await postSekuritasWebhook("corporate_action", claimed.payload);
      if (result.skipped) {
        await db
          .update(ipoLifecycleOutbox)
          .set({
            status: "pending",
            nextAttemptAt: retryAt(claimed.attempts),
            lastError: result.reason || "Webhook target is not configured",
            updatedAt: new Date()
          })
          .where(eq(ipoLifecycleOutbox.id, claimed.id));
        continue;
      }
      if (result.deferred) {
        await db
          .update(ipoLifecycleOutbox)
          .set({
            status: "failed",
            nextAttemptAt: retryAt(claimed.attempts),
            lastError: result.reason || "Deferred by Sekuritas",
            updatedAt: new Date()
          })
          .where(eq(ipoLifecycleOutbox.id, claimed.id));
        continue;
      }
      await db
        .update(ipoLifecycleOutbox)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
          lastError: null,
          updatedAt: new Date()
        })
        .where(eq(ipoLifecycleOutbox.id, claimed.id));
      delivered += 1;
    } catch (error) {
      await db
        .update(ipoLifecycleOutbox)
        .set({
          status: "failed",
          nextAttemptAt: retryAt(claimed.attempts),
          lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
          updatedAt: new Date()
        })
        .where(eq(ipoLifecycleOutbox.id, claimed.id));
    }
  }
  return { scanned: rows.length, delivered };
}

export function startIpoOutboxWorker(log: { error: (value: unknown, message?: string) => void }, intervalMs = 5000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverPendingIpoLifecycleEvents();
    } catch (error) {
      log.error(error, "IPO lifecycle outbox delivery failed");
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
