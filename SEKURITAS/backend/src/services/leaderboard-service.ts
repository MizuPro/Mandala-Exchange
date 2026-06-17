import { desc, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { broker_accounts, cash_balances, leaderboard_snapshots, securities_positions, users } from "../db/schema.js";
import { beiClient } from "./bei-client.js";

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function lastPricesFromBEI(sessionId?: string): Promise<Map<string, number>> {
  if (!sessionId) return new Map<string, number>();
  try {
    const report = await beiClient.getMarketSummaryReport(sessionId);
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    return new Map<string, number>(rows.map((row: any) => [String(row.symbol || "").toUpperCase(), toNumber(row.last || row.close || row.reference_price)]));
  } catch {
    return new Map<string, number>();
  }
}

export async function calculateLeaderboard(sessionId?: string, persistSnapshot = false) {
  const prices = await lastPricesFromBEI(sessionId);
  const accounts = await db
    .select({
      broker_account_id: broker_accounts.id,
      user_id: broker_accounts.user_id,
      email: users.email,
      account_type: broker_accounts.account_type,
      status: broker_accounts.status,
    })
    .from(broker_accounts)
    .innerJoin(users, eq(broker_accounts.user_id, users.id));

  const rankings = [];
  for (const account of accounts) {
    const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, account.broker_account_id)).limit(1);
    const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, account.broker_account_id));

    const cashValue = toNumber(cash?.available) + toNumber(cash?.reserved) + toNumber(cash?.pending);
    let portfolioValue = 0;
    let costBasis = 0;
    let unrealizedPl = 0;
    let realizedPl = 0;

    for (const position of positions) {
      const quantity = Number(position.available || 0) + Number(position.reserved || 0) + Number(position.pending || 0);
      const averagePrice = toNumber(position.average_price);
      const lastPrice = prices.get(position.symbol.toUpperCase()) || averagePrice;
      const value = quantity * lastPrice;
      portfolioValue += value;
      costBasis += quantity * averagePrice;
      unrealizedPl += quantity * (lastPrice - averagePrice);
      realizedPl += toNumber(position.realized_pl);
    }

    const nav = cashValue + portfolioValue;
    const totalReturn = realizedPl + unrealizedPl;
    const investedBasis = Math.max(costBasis + cashValue - totalReturn, 1);
    const returnPct = totalReturn / investedBasis;

    rankings.push({
      rank: 0,
      broker_account_id: account.broker_account_id,
      display_name: account.email.replace(/@.*/, ""),
      account_type: account.account_type,
      status: account.status,
      nav,
      cash: cashValue,
      portfolio_value: portfolioValue,
      realized_pl: realizedPl,
      unrealized_pl: unrealizedPl,
      return_pct: returnPct,
      positions: positions.length,
    });

    if (persistSnapshot) {
      await db.insert(leaderboard_snapshots).values({
        broker_account_id: account.broker_account_id,
        nav: nav.toFixed(6),
        return_pct: returnPct.toFixed(8),
        realized_pl: realizedPl.toFixed(6),
        snapshot_date: new Date(),
      });
    }
  }

  rankings.sort((a, b) => b.nav - a.nav || b.return_pct - a.return_pct);
  rankings.forEach((row, index) => {
    row.rank = index + 1;
  });

  return {
    as_of: new Date().toISOString(),
    session_id: sessionId || null,
    rankings,
  };
}

export async function latestLeaderboardSnapshots(limit = 100) {
  return db.select().from(leaderboard_snapshots).orderBy(desc(leaderboard_snapshots.snapshot_date)).limit(limit);
}
