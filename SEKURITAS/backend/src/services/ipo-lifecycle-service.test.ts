import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import {
  broker_accounts,
  cash_balances,
  ipo_investor_subscriptions,
  ipo_lifecycle_inbox,
  securities_positions,
  users
} from "../db/schema.js";
import { processIpoLifecycle } from "./ipo-lifecycle-service.js";
import { subscribeIpo } from "./ipo-subscription-service.js";

const createdUsers: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const userId of createdUsers.splice(0)) {
    const accounts = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId));
    for (const account of accounts) {
      const subscriptions = await db
        .select()
        .from(ipo_investor_subscriptions)
        .where(eq(ipo_investor_subscriptions.broker_account_id, account.id));
      for (const subscription of subscriptions) {
        await db.delete(ipo_lifecycle_inbox).where(eq(ipo_lifecycle_inbox.ipo_event_id, subscription.ipo_event_id));
      }
      await db.delete(securities_positions).where(eq(securities_positions.broker_account_id, account.id));
      await db.delete(ipo_investor_subscriptions).where(eq(ipo_investor_subscriptions.broker_account_id, account.id));
      await db.delete(cash_balances).where(eq(cash_balances.broker_account_id, account.id));
    }
    await db.delete(broker_accounts).where(eq(broker_accounts.user_id, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("IPO subscription accounting lifecycle", () => {
  it("reserves once and processes partial allocation/listing idempotently", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await db
      .insert(users)
      .values({ email: `ipo-${suffix}@example.test`, password_hash: "test", status: "verified" })
      .returning();
    createdUsers.push(user.id);
    const [account] = await db
      .insert(broker_accounts)
      .values({ user_id: user.id, account_type: "HUMAN", status: "ACTIVE" })
      .returning();
    await db.insert(cash_balances).values({
      broker_account_id: account.id,
      available: "100000",
      reserved: "0",
      pending: "0"
    });

    const ipoEventId = crypto.randomUUID();
    const beiSubscriptionId = crypto.randomUUID();
    const event = {
      id: ipoEventId,
      version: 2,
      symbol: "NEWC",
      status: "subscription",
      offering_price_idr: "200",
      subscription_lot_size: 100,
      subscription_start: new Date(Date.now() - 60_000).toISOString(),
      subscription_end: new Date(Date.now() + 60_000).toISOString()
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(event), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: beiSubscriptionId }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await subscribeIpo({
      identity: { accountId: account.id },
      ipoEventId,
      requestedShares: 200,
      idempotencyKey: `ipo-test-${suffix}`
    });
    expect(first.status).toBe("submitted_to_bei");
    const duplicate = await subscribeIpo({
      identity: { accountId: account.id },
      ipoEventId,
      requestedShares: 200,
      idempotencyKey: `ipo-test-${suffix}`
    });
    expect(duplicate.subscription_id).toBe(first.subscription_id);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    let [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.id));
    expect(String(cash.available)).toBe("60000");
    expect(String(cash.reserved)).toBe("40000");

    const allocationPayload = {
      event_id: `allocation-${suffix}`,
      idempotency_key: `allocation-${suffix}`,
      corporate_action_id: ipoEventId,
      action_type: "ipo_allocation",
      symbol: "NEWC",
      entitlements: [{ broker_account_id: account.id, asset_type: "security", quantity: 100 }]
    };
    await processIpoLifecycle(allocationPayload);
    await processIpoLifecycle(allocationPayload);

    [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.id));
    expect(String(cash.available)).toBe("80000");
    expect(String(cash.reserved)).toBe("0");
    let [position] = await db
      .select()
      .from(securities_positions)
      .where(and(eq(securities_positions.broker_account_id, account.id), eq(securities_positions.symbol, "NEWC")));
    expect(position.pending).toBe(100);
    expect(position.available).toBe(0);

    const listingPayload = {
      event_id: `listing-${suffix}`,
      idempotency_key: `listing-${suffix}`,
      corporate_action_id: ipoEventId,
      action_type: "ipo_listing",
      symbol: "NEWC",
      entitlements: []
    };
    await processIpoLifecycle(listingPayload);
    await processIpoLifecycle(listingPayload);
    [position] = await db
      .select()
      .from(securities_positions)
      .where(and(eq(securities_positions.broker_account_id, account.id), eq(securities_positions.symbol, "NEWC")));
    expect(position.pending).toBe(0);
    expect(position.available).toBe(100);

    const [subscription] = await db
      .select()
      .from(ipo_investor_subscriptions)
      .where(eq(ipo_investor_subscriptions.id, first.subscription_id));
    expect(subscription.status).toBe("settled");
    expect(subscription.allocated_shares).toBe(100);
    expect(String(subscription.actual_debit_idr)).toBe("20000");
  });

  it("serializes concurrent subscriptions so cash is reserved once", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await db
      .insert(users)
      .values({ email: `ipo-race-${suffix}@example.test`, password_hash: "test", status: "verified" })
      .returning();
    createdUsers.push(user.id);
    const [account] = await db
      .insert(broker_accounts)
      .values({ user_id: user.id, account_type: "HUMAN", status: "ACTIVE" })
      .returning();
    await db.insert(cash_balances).values({ broker_account_id: account.id, available: "50000", reserved: "0", pending: "0" });

    const ipoEventId = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({
          id: ipoEventId,
          version: 1,
          symbol: "RACE",
          status: "subscription",
          offering_price_idr: "200",
          subscription_lot_size: 100,
          subscription_start: new Date(Date.now() - 60_000).toISOString(),
          subscription_end: new Date(Date.now() + 60_000).toISOString()
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const results = await Promise.allSettled([
      subscribeIpo({ identity: { accountId: account.id }, ipoEventId, requestedShares: 100, idempotencyKey: `race-a-${suffix}` }),
      subscribeIpo({ identity: { accountId: account.id }, ipoEventId, requestedShares: 100, idempotencyKey: `race-b-${suffix}` })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.id));
    expect(String(cash.available)).toBe("30000");
    expect(String(cash.reserved)).toBe("20000");
    const subscriptions = await db
      .select()
      .from(ipo_investor_subscriptions)
      .where(eq(ipo_investor_subscriptions.broker_account_id, account.id));
    expect(subscriptions).toHaveLength(1);
  });
});
