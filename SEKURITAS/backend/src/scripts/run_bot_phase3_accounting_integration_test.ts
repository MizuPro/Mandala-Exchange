import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";
import { createApp } from "../app.js";
import { closeDatabase } from "../db/db.js";
import { processSettlement } from "../services/settlement-service.js";
import { processCorporateAction } from "../services/corporate-action-service.js";

const serviceToken = process.env.BOT_SERVICE_TOKEN || "dev-bot-service-token-change-me-2026";
const databaseURL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas";

async function main() {
  const app = await createApp();
  const sql = new pg.Client({ connectionString: databaseURL });
  await sql.connect();
  try {
    const run = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const bots = ["seller", "buyer"].map(role => ({
      external_bot_id: `phase3-${role}-${run}`,
      email: `phase3-${role}-${run}@bot.local`,
      display_name: `Phase 3 ${role}`,
      tier: "retail",
      strategy: "noise_trader",
    }));
    const provision = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/provision",
      headers: { "x-service-token": serviceToken, "idempotency-key": `phase3-provision-${run}` },
      payload: { bots },
    });
    if (provision.statusCode !== 200) throw new Error(`provision: ${provision.body}`);
    const results = JSON.parse(provision.body).results;
    const seller = results[0], buyer = results[1];

    const tokensResponse = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/tokens",
      headers: { "x-service-token": serviceToken, "idempotency-key": `phase3-tokens-${run}` },
      payload: { account_ids: [seller.account_id, buyer.account_id] },
    });
    if (tokensResponse.statusCode !== 200) throw new Error(`tokens: ${tokensResponse.body}`);
    const tokenByAccount = new Map(JSON.parse(tokensResponse.body).tokens.map((item: any) => [item.account_id, item.token]));

    const genesis = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/genesis",
      headers: { "x-service-token": serviceToken, "idempotency-key": `phase3-genesis-${run}` },
      payload: {
        genesis_run_id: crypto.randomUUID(),
        accounts: [
          { external_bot_id: seller.external_bot_id, account_id: seller.account_id, cash_idr: 1_000_000, positions: [{ symbol: "BARA", quantity_shares: 1000, average_price_idr: 190 }] },
          { external_bot_id: buyer.external_bot_id, account_id: buyer.account_id, cash_idr: 100_000_000, positions: [] },
        ],
      },
    });
    if (genesis.statusCode !== 200) throw new Error(`genesis: ${genesis.body}`);

    const session = await fetch("http://127.0.0.1:8082/v1/admin/session/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" },
      body: JSON.stringify({ status: "continuous" }),
    });
    if (!session.ok) throw new Error(`MATS session: ${await session.text()}`);

    const place = async (account: any, side: "BUY" | "SELL", sequence: number) => {
      const response = await app.inject({
        method: "POST", url: "/api/v1/orders",
        headers: { authorization: `Bearer ${tokenByAccount.get(account.account_id)}` },
        payload: {
          client_order_id: `bot:${account.external_bot_id}:${crypto.randomUUID()}:${sequence}`,
          symbol: "BARA", side, order_type: "LIMIT", price: 190, quantity: 100,
        },
      });
      if (response.statusCode !== 201) throw new Error(`${side} order: ${response.body}`);
      return JSON.parse(response.body);
    };
    const sell = await place(seller, "SELL", 1);
    const buy = await place(buyer, "BUY", 1);

    let fills: any[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await sql.query(`
        SELECT tf.trade_id, tf.price, tf.quantity, o.mats_order_id, o.broker_account_id
        FROM trade_fills tf JOIN orders o ON o.id=tf.order_id
        WHERE o.id = ANY($1::uuid[]) ORDER BY o.id`, [[sell.id, buy.id]]);
      fills = result.rows;
      if (fills.length >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (fills.length < 1) throw new Error(`expected at least one real fill, got ${fills.length}`);

    for (const fill of fills) {
      const result = await processSettlement(fill.mats_order_id, {
        trade_id: fill.trade_id,
        idempotency_key: `phase3-settlement-${run}-${fill.broker_account_id}`,
        price: Number(fill.price),
        quantity: fill.quantity,
      });
      if (result.status !== "processed" && result.status !== "duplicate") throw new Error(`settlement: ${JSON.stringify(result)}`);
    }

    await processCorporateAction({
      event_id: `phase3-dividend-${run}`,
      action_type: "cash_dividend",
      symbol: "BARA",
      entitlements: [{ broker_account_id: buyer.account_id, asset_type: "cash", cash_amount: 1000 }],
    });

    const events = await sql.query(`
      SELECT event_type, payload FROM bot_account_events
      WHERE broker_account_id = ANY($1::uuid[])
        AND event_type IN ('settlement_completed','corporate_action_applied')`, [[seller.account_id, buyer.account_id]]);
    if (!events.rows.some(row => row.event_type === "settlement_completed" && row.payload?.account?.account_id)) {
      throw new Error("settlement event missing authoritative account snapshot");
    }
    if (!events.rows.some(row => row.event_type === "corporate_action_applied" && row.payload?.account?.account_id)) {
      throw new Error("corporate action event missing authoritative account snapshot");
    }
    console.log("PHASE 3 ACCOUNTING INTEGRATION PASSED");
  } finally {
    await sql.end();
    await app.close();
    await closeDatabase();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
