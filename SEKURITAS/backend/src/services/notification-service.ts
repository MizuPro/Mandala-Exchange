import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/db.js";
import { broker_accounts, notifications } from "../db/schema.js";

export type NotificationInput = {
  brokerAccountId: string;
  type: string;
  title: string;
  body: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export async function createNotification(input: NotificationInput) {
  return db.transaction((tx) => createNotificationTx(tx, input));
}

export async function createNotificationTx(tx: any, input: NotificationInput) {
  const [account] = await tx
    .select()
    .from(broker_accounts)
    .where(eq(broker_accounts.id, input.brokerAccountId))
    .limit(1);
  if (!account) return null;

  const [created] = await tx
    .insert(notifications)
    .values({
      user_id: account.user_id,
      broker_account_id: account.id,
      type: input.type,
      title: input.title,
      body: input.body,
      reference_type: input.referenceType,
      reference_id: input.referenceId,
      idempotency_key: input.idempotencyKey,
      metadata: input.metadata || {},
    })
    .onConflictDoNothing()
    .returning();

  return created || null;
}

export async function listNotifications(userId: string, unreadOnly = false, limit = 50) {
  const accounts = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId));
  const account = accounts[0];
  if (!account) return [];

  const conditions = [eq(notifications.broker_account_id, account.id)];
  if (unreadOnly) conditions.push(isNull(notifications.read_at));

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.created_at))
    .limit(limit);
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const [account] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  if (!account) throw new Error("Broker account not found");

  const [updated] = await db
    .update(notifications)
    .set({ read_at: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.broker_account_id, account.id)))
    .returning();
  if (!updated) throw new Error("Notification not found");
  return updated;
}
