import crypto from "node:crypto";
import { createApp } from "../app.js";
import { closeDatabase } from "../db/db.js";

async function main() {
  const app = await createApp();
  const botToken = process.env.BOT_SERVICE_TOKEN!;
  const externalId = `partial-${Date.now()}`;
  const provision = await app.inject({
    method: "POST", url: "/api/v1/internal/bots/provision",
    headers: { "x-service-token": botToken, "idempotency-key": crypto.randomUUID() },
    payload: { bots: [{ external_bot_id: externalId, email: `${externalId}@bot.internal`, tier: "retail", strategy: "noise_trader" }] }
  });
  const accountId = JSON.parse(provision.body).results?.[0]?.account_id;
  if (provision.statusCode !== 200 || !accountId) throw new Error(provision.body);
  const runId = crypto.randomUUID();
  const key = `partial-${runId}`;
  const payload = { genesis_run_id: runId, accounts: [{ external_bot_id: externalId, account_id: accountId, cash_idr: 123, positions: [] }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/genesis",
      headers: { "x-service-token": botToken, "idempotency-key": key }, payload,
    });
    const body = JSON.parse(response.body);
    if (response.statusCode !== 503 || body.error?.code !== "GENESIS_PARTIAL_FAILURE") throw new Error(response.body);
  }
  const snapshot = await app.inject({
    method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
    headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
  });
  if (JSON.parse(snapshot.body).accounts?.[0]?.cash?.available_idr !== "123") throw new Error(`Cash duplicated after partial retry: ${snapshot.body}`);
  console.log("GENESIS PARTIAL FAILURE RETRY TEST PASSED");
  await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
