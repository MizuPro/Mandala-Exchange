import "dotenv/config";
import { createApp } from "../app.js";
import { closeDatabase, db } from "../db/db.js";
import { broker_accounts, bot_metadata, cash_balances } from "../db/schema.js";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import WebSocket from "ws";
import jwt from "jsonwebtoken";

async function runValidation() {
  console.log("Starting BOT API Validation...");
  const app = await createApp();
  
  const botToken = process.env.BOT_SERVICE_TOKEN || "dev-bot-service-token-change-me-2026";

  try {
    const extBotId = `bot-test-${Date.now()}`;
    const email = `${extBotId}@bot.local`;
    const counterBotId = `${extBotId}-counterparty`;
    const counterEmail = `${counterBotId}@bot.local`;

    console.log("1. Testing POST /api/v1/internal/bots/provision");
    const provisionRes = await app.inject({
      method: "POST",
      url: "/api/v1/internal/bots/provision",
      headers: {
        "x-service-token": botToken,
        "idempotency-key": crypto.randomUUID()
      },
      payload: {
        bots: [
          {
            external_bot_id: extBotId,
            email: email,
            tier: "retail",
            strategy: "noise"
          },
          {
            external_bot_id: counterBotId,
            email: counterEmail,
            tier: "retail",
            strategy: "noise"
          }
        ]
      }
    });

    if (provisionRes.statusCode !== 200) {
      throw new Error(`Provision failed: ${provisionRes.body}`);
    }
    const provisionBody = JSON.parse(provisionRes.body);
    console.log("Provision OK:", provisionBody);
    const accountId = provisionBody.results[0].account_id;
    const counterAccountId = provisionBody.results[1].account_id;

    console.log("2. Testing POST /api/v1/internal/bots/tokens");
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/v1/internal/bots/tokens",
      headers: {
        "x-service-token": botToken,
        "idempotency-key": crypto.randomUUID()
      },
      payload: {
        account_ids: [accountId, counterAccountId]
      }
    });

    if (tokenRes.statusCode !== 200) {
      throw new Error(`Tokens failed: ${tokenRes.body}`);
    }
    const tokenBody = JSON.parse(tokenRes.body);
    console.log("Tokens OK:", { count: tokenBody.tokens?.length || 0, token_redacted: true });
    const primaryToken = tokenBody.tokens.find((entry: any) => entry.account_id === accountId)?.token;
    const counterToken = tokenBody.tokens.find((entry: any) => entry.account_id === counterAccountId)?.token;
    if (!primaryToken || !counterToken) throw new Error("BOT token response missing provisioned account");
    const decodedToken: any = jwt.decode(primaryToken);
    if (!decodedToken?.iat || !decodedToken?.exp || decodedToken.exp - decodedToken.iat !== 3600 || decodedToken.account_type !== "BOT") {
      throw new Error("BOT JWT is not scoped and short-lived as required");
    }

    console.log("3. Testing POST /api/v1/internal/bots/genesis");
    const genesisRunId = crypto.randomUUID();
    const genesisIdempotencyKey = `genesis-${genesisRunId}`;
    const genesisPayload = {
      genesis_run_id: genesisRunId,
      accounts: [
        {
          external_bot_id: extBotId,
          account_id: accountId,
          cash_idr: 100000000,
          positions: [
            { symbol: "BARA", quantity_shares: 1000, average_price_idr: 190 },
            { symbol: "NUSA", quantity_shares: 1000, average_price_idr: 735 }
          ]
        },
        {
          external_bot_id: counterBotId,
          account_id: counterAccountId,
          cash_idr: 100000000,
          positions: []
        }
      ]
    };
    const genesisRes = await app.inject({
      method: "POST",
      url: "/api/v1/internal/bots/genesis",
      headers: {
        "x-service-token": botToken,
        "idempotency-key": genesisIdempotencyKey
      },
      payload: genesisPayload
    });

    if (genesisRes.statusCode !== 200) {
      throw new Error(`Genesis failed: ${genesisRes.body}`);
    }
    console.log("Genesis OK:", JSON.parse(genesisRes.body));
    const genesisRetry = await app.inject({
      method: "POST",
      url: "/api/v1/internal/bots/genesis",
      headers: { "x-service-token": botToken, "idempotency-key": genesisIdempotencyKey },
      payload: genesisPayload,
    });
    const genesisRetryBody = JSON.parse(genesisRetry.body);
    const genesisBody = JSON.parse(genesisRes.body);
    if (genesisRetry.statusCode !== 200 ||
        genesisRetryBody.genesis_run_id !== genesisBody.genesis_run_id ||
        genesisRetryBody.payload_hash !== genesisBody.payload_hash ||
        genesisRetryBody.sekuritas_checkpoint !== genesisBody.sekuritas_checkpoint) {
      throw new Error(`Genesis idempotent retry failed: ${genesisRetry.body}`);
    }

    console.log("4. Testing POST /api/v1/internal/bots/portfolio-snapshot");
    const snapRes = await app.inject({
      method: "POST",
      url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: {
        "x-service-token": botToken,
        "idempotency-key": crypto.randomUUID()
      },
      payload: {
        account_ids: [accountId]
      }
    });

    if (snapRes.statusCode !== 200) {
      throw new Error(`Snapshot failed: ${snapRes.body}`);
    }
    const snapshotBody = JSON.parse(snapRes.body);
    if (Number(snapshotBody.accounts?.[0]?.cash?.available_idr) !== 100000000 ||
        snapshotBody.accounts?.[0]?.positions?.[0]?.symbol !== "BARA" ||
        snapshotBody.accounts?.[0]?.positions?.[0]?.available_shares !== 1000) {
      throw new Error(`Genesis snapshot reconciliation failed: ${snapRes.body}`);
    }
    console.log("Snapshot OK:", snapshotBody);
    const custodyResponse = await fetch(`${process.env.BEI_API_URL || "http://localhost:4100"}/v1/custody/accounts/MANDALA/${accountId}/summary`, {
      headers: { "x-service-token": process.env.BEI_SERVICE_TOKEN || "dev-sekuritas-to-bei-token-change-me-2026" }
    });
    const custodyBody: any = await custodyResponse.json();
    const custodyPosition = custodyBody.positions?.find((position: any) => position.symbol === "BARA");
    if (!custodyResponse.ok || Number(custodyPosition?.quantity || 0) !== 1000) {
      throw new Error(`BEI custody reconciliation failed: ${JSON.stringify(custodyBody)}`);
    }

    console.log("5. Testing stable BOT order idempotency and lookup");
    const matsSession = await fetch("http://127.0.0.1:8082/v1/admin/session/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" },
      body: JSON.stringify({ status: "continuous" })
    });
    if (!matsSession.ok) throw new Error(`Unable to open MATS session: ${await matsSession.text()}`);
    const clearBook = await fetch("http://127.0.0.1:8082/v1/admin/orders/expire", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" }
    });
    if (!clearBook.ok) throw new Error(`Unable to clear stale integration orders: ${await clearBook.text()}`);
    const stableClientOrderId = `bot:${extBotId}:${crypto.randomUUID()}:1`;
    const orderPayload = { client_order_id: stableClientOrderId, symbol: "BARA", side: "BUY", order_type: "LIMIT", price: 190, quantity: 100 };
    const placedOrder = await app.inject({
      method: "POST", url: "/api/v1/orders",
      headers: { authorization: `Bearer ${primaryToken}` }, payload: orderPayload
    });
    if (placedOrder.statusCode !== 201) throw new Error(`BOT order failed: ${placedOrder.body}`);
    const placedBody = JSON.parse(placedOrder.body);
    const retriedOrder = await app.inject({
      method: "POST", url: "/api/v1/orders",
      headers: { authorization: `Bearer ${primaryToken}` }, payload: orderPayload
    });
    if (retriedOrder.statusCode !== 201 || JSON.parse(retriedOrder.body).id !== placedBody.id) throw new Error(`BOT order idempotent retry failed: ${retriedOrder.body}`);
    const lookupOrder = await app.inject({
      method: "GET", url: `/api/v1/orders/by-client-id/${encodeURIComponent(stableClientOrderId)}`,
      headers: { authorization: `Bearer ${primaryToken}` }
    });
    if (lookupOrder.statusCode !== 200 || JSON.parse(lookupOrder.body).id !== placedBody.id) throw new Error(`BOT order lookup failed: ${lookupOrder.body}`);
    const terminalOrderStatuses = new Set(["filled", "cancelled", "rejected", "expired"]);
    if (!terminalOrderStatuses.has(String(placedBody.status || "").toLowerCase())) {
      const openSnapshot = await app.inject({
        method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
        headers: { "x-service-token": botToken },
        payload: { account_ids: [accountId], include_open_orders: true }
      });
      const openSnapshotBody = JSON.parse(openSnapshot.body);
      const authoritativeOpenOrder = openSnapshotBody.accounts?.[0]?.open_orders?.find(
        (order: any) => order.client_order_id === stableClientOrderId
      );
      if (openSnapshot.statusCode !== 200 || !authoritativeOpenOrder?.created_at) {
        throw new Error(`BOT open-order snapshot missing authoritative created_at: ${openSnapshot.body}`);
      }

      const cancelOrder = await app.inject({
        method: "DELETE", url: `/api/v1/orders/${placedBody.id}`,
        headers: { authorization: `Bearer ${primaryToken}` }
      });
      if (cancelOrder.statusCode !== 200) throw new Error(`BOT order cleanup failed: ${cancelOrder.body}`);

      const duplicateCancel = await app.inject({
        method: "DELETE", url: `/api/v1/orders/${placedBody.id}`,
        headers: { authorization: `Bearer ${primaryToken}` }
      });
      if (duplicateCancel.statusCode !== 200) {
        throw new Error(`BOT duplicate cancel was not idempotent: ${duplicateCancel.body}`);
      }

      const cancelledSnapshot = await app.inject({
        method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
        headers: { "x-service-token": botToken },
        payload: { account_ids: [accountId], include_open_orders: true }
      });
      const cancelledSnapshotBody = JSON.parse(cancelledSnapshot.body);
      const stillOpen = cancelledSnapshotBody.accounts?.[0]?.open_orders?.some(
        (order: any) => order.client_order_id === stableClientOrderId
      );
      if (cancelledSnapshot.statusCode !== 200 || stillOpen) {
        throw new Error(`BOT cancel did not reach authoritative terminal snapshot: ${cancelledSnapshot.body}`);
      }
      if (Number(cancelledSnapshotBody.accounts?.[0]?.cash?.reserved_idr || 0) !== 0) {
        throw new Error(`BOT cancel did not release cash reservation: ${cancelledSnapshot.body}`);
      }
    }

    console.log("5b. Testing partial-fill aging state and remaining-order cancel");
    const partialSellClientId = `bot:${extBotId}:${crypto.randomUUID()}:2`;
    const partialSell = await app.inject({
      method: "POST", url: "/api/v1/orders",
      headers: { authorization: `Bearer ${primaryToken}` },
      payload: {
        client_order_id: partialSellClientId, symbol: "NUSA", side: "SELL",
        order_type: "LIMIT", price: 735, quantity: 200
      }
    });
    if (partialSell.statusCode !== 201) throw new Error(`Partial-fill maker order failed: ${partialSell.body}`);
    const partialSellBody = JSON.parse(partialSell.body);

    const partialBuy = await app.inject({
      method: "POST", url: "/api/v1/orders",
      headers: { authorization: `Bearer ${counterToken}` },
      payload: {
        client_order_id: `bot:${counterBotId}:${crypto.randomUUID()}:1`,
        symbol: "NUSA", side: "BUY", order_type: "LIMIT", price: 735, quantity: 100
      }
    });
    if (partialBuy.statusCode !== 201) throw new Error(`Partial-fill taker order failed: ${partialBuy.body}`);

    const partialLookup = await app.inject({
      method: "GET", url: `/api/v1/orders/by-client-id/${encodeURIComponent(partialSellClientId)}`,
      headers: { authorization: `Bearer ${primaryToken}` }
    });
    const partialLookupBody = JSON.parse(partialLookup.body);
    if (partialLookup.statusCode !== 200 ||
        partialLookupBody.status !== "partially_filled" ||
        Number(partialLookupBody.filled_quantity) !== 100 ||
        Number(partialLookupBody.remaining_quantity) !== 100) {
      throw new Error(`Authoritative partial-fill state invalid: ${partialLookup.body}`);
    }

    const partialSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken },
      payload: { account_ids: [accountId], include_open_orders: true }
    });
    const partialSnapshotBody = JSON.parse(partialSnapshot.body);
    const partialOpenOrder = partialSnapshotBody.accounts?.[0]?.open_orders?.find(
      (order: any) => order.client_order_id === partialSellClientId
    );
    if (!partialOpenOrder?.created_at ||
        partialOpenOrder.status !== "partially_filled" ||
        Number(partialOpenOrder.filled_quantity_shares) !== 100) {
      throw new Error(`Partial open-order snapshot invalid: ${partialSnapshot.body}`);
    }

    const cancelPartial = await app.inject({
      method: "DELETE", url: `/api/v1/orders/${partialSellBody.id}`,
      headers: { authorization: `Bearer ${primaryToken}` }
    });
    if (cancelPartial.statusCode !== 200) throw new Error(`Partial remaining cancel failed: ${cancelPartial.body}`);

    const afterPartialCancel = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken },
      payload: { account_ids: [accountId], include_open_orders: true }
    });
    const afterPartialBody = JSON.parse(afterPartialCancel.body);
    if (afterPartialBody.accounts?.[0]?.open_orders?.some(
      (order: any) => order.client_order_id === partialSellClientId
    )) {
      throw new Error(`Partial order remained open after cancel: ${afterPartialCancel.body}`);
    }
    const partialPosition = afterPartialBody.accounts?.[0]?.positions?.find((position: any) => position.symbol === "NUSA");
    if (Number(partialPosition?.reserved_shares || 0) !== 0) {
      throw new Error(`Partial cancel did not release remaining share reservation: ${afterPartialCancel.body}`);
    }

    console.log("5c. Testing NCP cancel deferral and post-NCP recovery");
    const ncpClientOrderId = `bot:${extBotId}:${crypto.randomUUID()}:3`;
    const ncpOrder = await app.inject({
      method: "POST", url: "/api/v1/orders",
      headers: { authorization: `Bearer ${primaryToken}` },
      payload: {
        client_order_id: ncpClientOrderId, symbol: "NUSA", side: "BUY",
        order_type: "LIMIT", price: 735, quantity: 100
      }
    });
    if (ncpOrder.statusCode !== 201) throw new Error(`NCP fixture order failed: ${ncpOrder.body}`);
    const ncpOrderBody = JSON.parse(ncpOrder.body);
    const enterNcp = await fetch("http://127.0.0.1:8082/v1/admin/session/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" },
      body: JSON.stringify({ status: "non_cancellation" })
    });
    if (!enterNcp.ok) throw new Error(`Unable to enter NCP: ${await enterNcp.text()}`);
    const ncpCancel = await app.inject({
      method: "DELETE", url: `/api/v1/orders/${ncpOrderBody.id}`,
      headers: { authorization: `Bearer ${primaryToken}` }
    });
    if (ncpCancel.statusCode === 200) {
      throw new Error(`NCP cancel unexpectedly succeeded: ${ncpCancel.body}`);
    }
    const ncpSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken },
      payload: { account_ids: [accountId], include_open_orders: true }
    });
    const ncpSnapshotBody = JSON.parse(ncpSnapshot.body);
    if (!ncpSnapshotBody.accounts?.[0]?.open_orders?.some(
      (order: any) => order.client_order_id === ncpClientOrderId
    ) || Number(ncpSnapshotBody.accounts?.[0]?.cash?.reserved_idr || 0) <= 0) {
      throw new Error(`NCP order/reservation was not retained: ${ncpSnapshot.body}`);
    }
    const exitNcp = await fetch("http://127.0.0.1:8082/v1/admin/session/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" },
      body: JSON.stringify({ status: "continuous" })
    });
    if (!exitNcp.ok) throw new Error(`Unable to exit NCP: ${await exitNcp.text()}`);
    const postNcpCancel = await app.inject({
      method: "DELETE", url: `/api/v1/orders/${ncpOrderBody.id}`,
      headers: { authorization: `Bearer ${primaryToken}` }
    });
    if (postNcpCancel.statusCode !== 200) {
      throw new Error(`Post-NCP cancel failed: ${postNcpCancel.body}`);
    }

    console.log("6. Testing normative IPO reserve/cancel/allocation/refund/listing");
    const beiBase = process.env.BEI_API_URL || "http://localhost:4100";
    const beiAdminToken = "dev-admin-service-token-change-me-2026";
    const beiHeaders = { "content-type": "application/json", "x-service-token": beiAdminToken };
    const securities: any = await (await fetch(`${beiBase}/v1/public/securities`, { headers: { "x-service-token": process.env.BEI_SERVICE_TOKEN! } })).json();
    const security = securities.find((item: any) => item.symbol === "BARA");
    const brokers: any = await (await fetch(`${beiBase}/v1/brokers`, { headers: { "x-service-token": beiAdminToken } })).json();
    const broker = brokers.find((item: any) => item.code === "MANDALA");
    if (!security || !broker) throw new Error("IPO test prerequisites missing");
    const createIpo = async () => {
      const response = await fetch(`${beiBase}/v1/ipo-events`, {
        method: "POST", headers: beiHeaders,
        body: JSON.stringify({
          issuerId: security.issuer_id, securityId: security.id, offeredShares: 100000,
          offeringPrice: 100, subscriptionStart: new Date(Date.now() - 60_000).toISOString(),
          subscriptionEnd: new Date(Date.now() + 3_600_000).toISOString(),
          listingDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
          status: "subscription", underwriterBrokerId: broker.id,
          metadata: { subscription_lot_size: 100, version: 1 }
        })
      });
      const result: any = await response.json();
      if (!response.ok) throw new Error(`Create IPO failed: ${JSON.stringify(result)}`);
      return result;
    };
    const botJwt = primaryToken;
    const cancelledIpo = await createIpo();
    const cancelledSubscription = await app.inject({
      method: "POST", url: `/api/v1/ipo-events/${cancelledIpo.id}/subscriptions`,
      headers: { authorization: `Bearer ${botJwt}`, "idempotency-key": crypto.randomUUID() },
      payload: { requested_shares: 1000 }
    });
    if (cancelledSubscription.statusCode !== 200) throw new Error(cancelledSubscription.body);
    const cancelledBody = JSON.parse(cancelledSubscription.body);
    const cancelResponse = await app.inject({
      method: "POST", url: `/api/v1/ipo-events/${cancelledIpo.id}/subscriptions/${cancelledBody.subscription_id}/cancel`,
      headers: { authorization: `Bearer ${botJwt}` }
    });
    if (cancelResponse.statusCode !== 200) throw new Error(`IPO cancel failed: ${cancelResponse.body}`);

    const allocatedIpo = await createIpo();
    const allocatedSubscription = await app.inject({
      method: "POST", url: `/api/v1/ipo-events/${allocatedIpo.id}/subscriptions`,
      headers: { authorization: `Bearer ${botJwt}`, "idempotency-key": crypto.randomUUID() },
      payload: { requested_shares: 1000 }
    });
    if (allocatedSubscription.statusCode !== 200) throw new Error(allocatedSubscription.body);
    const allocateResponse = await fetch(`${beiBase}/v1/ipo-events/${allocatedIpo.id}/allocate`, {
      method: "POST", headers: beiHeaders, body: JSON.stringify({ allocationRatio: 0.25 })
    });
    if (!allocateResponse.ok) throw new Error(`IPO allocation failed: ${await allocateResponse.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const allocationSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
    });
    const allocationAccount = JSON.parse(allocationSnapshot.body).accounts[0];
    const allocationPosition = allocationAccount.positions.find((item: any) => item.symbol === "BARA");
    if (Number(allocationAccount.cash.available_idr) !== 99975000 || allocationPosition.pending_shares !== 250) {
      throw new Error(`IPO partial allocation/refund mismatch: ${allocationSnapshot.body}`);
    }
    const listResponse = await fetch(`${beiBase}/v1/ipo-events/${allocatedIpo.id}/list`, { method: "POST", headers: { "x-service-token": beiAdminToken } });
    if (!listResponse.ok) throw new Error(`IPO listing failed: ${await listResponse.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listingSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
    });
    const listedPosition = JSON.parse(listingSnapshot.body).accounts[0].positions.find((item: any) => item.symbol === "BARA");
    if (listedPosition.available_shares !== 1250 || listedPosition.pending_shares !== 0) {
      throw new Error(`IPO listing transition mismatch: ${listingSnapshot.body}`);
    }

    const zeroIpo = await createIpo();
    const zeroSubscription = await app.inject({
      method: "POST", url: `/api/v1/ipo-events/${zeroIpo.id}/subscriptions`,
      headers: { authorization: `Bearer ${botJwt}`, "idempotency-key": crypto.randomUUID() },
      payload: { requested_shares: 1000 }
    });
    if (zeroSubscription.statusCode !== 200) throw new Error(zeroSubscription.body);
    const zeroAllocation = await fetch(`${beiBase}/v1/ipo-events/${zeroIpo.id}/allocate`, {
      method: "POST", headers: beiHeaders, body: JSON.stringify({ allocationRatio: 0 })
    });
    if (!zeroAllocation.ok) throw new Error(`IPO zero allocation failed: ${await zeroAllocation.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const zeroSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
    });
    const zeroAccount = JSON.parse(zeroSnapshot.body).accounts[0];
    if (Number(zeroAccount.cash.available_idr) !== 99975000 || Number(zeroAccount.cash.reserved_idr) !== 0) {
      throw new Error(`IPO zero allocation refund mismatch: ${zeroSnapshot.body}`);
    }

    const reversalIpo = await createIpo();
    const reversalSubscription = await app.inject({
      method: "POST", url: `/api/v1/ipo-events/${reversalIpo.id}/subscriptions`,
      headers: { authorization: `Bearer ${botJwt}`, "idempotency-key": crypto.randomUUID() },
      payload: { requested_shares: 1000 }
    });
    if (reversalSubscription.statusCode !== 200) throw new Error(reversalSubscription.body);
    const reversalAllocation = await fetch(`${beiBase}/v1/ipo-events/${reversalIpo.id}/allocate`, {
      method: "POST", headers: beiHeaders, body: JSON.stringify({ allocationRatio: 0.25 })
    });
    if (!reversalAllocation.ok) throw new Error(`IPO reversal allocation failed: ${await reversalAllocation.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const duplicateAllocation = await fetch(`${beiBase}/v1/ipo-events/${reversalIpo.id}/allocate`, {
      method: "POST", headers: beiHeaders, body: JSON.stringify({ allocationRatio: 0.25 })
    });
    if (!duplicateAllocation.ok) throw new Error(`Duplicate allocation retry failed: ${await duplicateAllocation.text()}`);
    const reversalResponse = await fetch(`${beiBase}/v1/ipo-events/${reversalIpo.id}/cancel`, {
      method: "POST", headers: { "x-service-token": beiAdminToken }
    });
    if (!reversalResponse.ok) throw new Error(`IPO reversal failed: ${await reversalResponse.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reversalSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
    });
    const reversalAccount = JSON.parse(reversalSnapshot.body).accounts[0];
    const reversalPosition = reversalAccount.positions.find((item: any) => item.symbol === "BARA");
    if (Number(reversalAccount.cash.available_idr) !== 99975000 || reversalPosition.available_shares !== 1250 || reversalPosition.pending_shares !== 0) {
      throw new Error(`IPO exceptional reversal mismatch: ${reversalSnapshot.body}`);
    }
    const finalCustodyResponse = await fetch(`${beiBase}/v1/custody/accounts/MANDALA/${accountId}/summary`, {
      headers: { "x-service-token": process.env.BEI_SERVICE_TOKEN! }
    });
    const finalCustody: any = await finalCustodyResponse.json();
    const finalCustodyPosition = finalCustody.positions?.find((position: any) => position.symbol === "BARA" && position.asset_type === "security");
    if (!finalCustodyResponse.ok || Number(finalCustodyPosition?.quantity || 0) !== 1250) {
      throw new Error(`IPO custody reversal mismatch: ${JSON.stringify(finalCustody)}`);
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:3002/api/v1/internal/bots/events/ws?after_sequence=0", {
        headers: { "x-service-token": botToken }
      });
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("BOT account event replay timed out"));
      }, 5000);
      socket.once("message", (raw) => {
        clearTimeout(timeout);
        const event = JSON.parse(raw.toString());
        socket.close();
        if (!Number.isSafeInteger(event.sequence) || !event.event_id || !event.event_type) {
          reject(new Error(`Invalid BOT account event envelope: ${raw.toString()}`));
          return;
        }
        resolve();
      });
      socket.once("error", reject);
    });
    const failedGenesisRunId = crypto.randomUUID();
    const failedGenesisKey = `genesis-${failedGenesisRunId}`;
    const failedGenesisPayload = {
      genesis_run_id: failedGenesisRunId,
      accounts: [{
        external_bot_id: extBotId, account_id: accountId, cash_idr: 123,
        positions: [{ symbol: "INVALID", quantity_shares: 100, average_price_idr: 1 }]
      }]
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const failedGenesis = await app.inject({
        method: "POST", url: "/api/v1/internal/bots/genesis",
        headers: { "x-service-token": botToken, "idempotency-key": failedGenesisKey },
        payload: failedGenesisPayload,
      });
      if (failedGenesis.statusCode !== 400 || JSON.parse(failedGenesis.body).error?.code !== "VALIDATION_ERROR") {
        throw new Error(`Expected fail-closed genesis validation: ${failedGenesis.body}`);
      }
    }
    const partialFailureSnapshot = await app.inject({
      method: "POST", url: "/api/v1/internal/bots/portfolio-snapshot",
      headers: { "x-service-token": botToken }, payload: { account_ids: [accountId], include_open_orders: true }
    });
    if (Number(JSON.parse(partialFailureSnapshot.body).accounts[0].cash.available_idr) !== 99975000) {
      throw new Error(`Rejected genesis changed cash: ${partialFailureSnapshot.body}`);
    }

    console.log("ALL TESTS PASSED SUCCESSFULLY");
  } catch (err) {
    console.error("TEST FAILED:", err);
    process.exit(1);
  } finally {
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await closeDatabase();
  }
}

runValidation();
