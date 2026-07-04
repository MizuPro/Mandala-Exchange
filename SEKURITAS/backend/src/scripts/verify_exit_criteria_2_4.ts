import "dotenv/config";
import { createApp } from "../app.js";
import { closeDatabase } from "../db/db.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";

async function verifyExitCriteria() {
  console.log("==================================================");
  console.log("VERIFYING EXIT CRITERIA FASE 2.4 (EXIT CRITERIA 0)");
  console.log("==================================================");
  
  const app = await createApp();
  const botToken = process.env.BOT_SERVICE_TOKEN || "dev-bot-service-token-change-me-2026";
  const runUuid = Date.now();

  try {
    // 1. Membuat 10 akun BOT sekaligus secara batch
    console.log("\n1. Membuat 10 akun BOT...");
    const botTemplates = Array.from({ length: 10 }, (_, i) => ({
      external_bot_id: `bot-exit-test-${runUuid}-${i + 1}`,
      email: `bot-exit-test-${runUuid}-${i + 1}@bot.local`,
      tier: "retail",
      strategy: "noise"
    }));

    const provisionRes = await app.inject({
      method: "POST",
      url: "/bot/internal/provision",
      headers: { "x-service-token": botToken, "idempotency-key": crypto.randomUUID() },
      payload: { bots: botTemplates }
    });

    if (provisionRes.statusCode !== 200) {
      throw new Error(`Provision failed: ${provisionRes.body}`);
    }
    const provisionBody = JSON.parse(provisionRes.body);
    console.log("   -> Sukses! 10 Akun BOT berhasil dibuat.");

    // Extract Account IDs
    const accountIds = provisionBody.results.map((r: any) => r.account_id);

    // 2. Mengambil Token JWT untuk ke-10 BOT
    console.log("\n2. Mengambil operational token untuk 10 BOT...");
    const tokenRes = await app.inject({
      method: "POST",
      url: "/bot/internal/tokens",
      headers: { "x-service-token": botToken, "idempotency-key": crypto.randomUUID() },
      payload: { account_ids: accountIds }
    });

    if (tokenRes.statusCode !== 200) {
      throw new Error(`Token retrieval failed: ${tokenRes.body}`);
    }
    const tokenBody = JSON.parse(tokenRes.body);
    const botTokens = tokenBody.tokens.map((t: any) => t.token);
    console.log(`   -> Sukses! ${botTokens.length}/10 token berhasil diambil.`);

    // 3. Memberikan cash genesis ke 10 akun bot & beberapa saham genesis ke bot 1-5
    console.log("\n3. Seeding Cash Genesis & Saham MNDL/BARA...");
    const genesisRunId = crypto.randomUUID();
    const genesisAccounts = provisionBody.results.map((botResult: any, idx: number) => {
      // Bot 1-5 mendapatkan saham genesis, bot 6-10 hanya cash
      const positions = idx < 5 
        ? [
            { symbol: "MNDL", quantity_shares: 5000, average_price_idr: 316 },
            { symbol: "BARA", quantity_shares: 10000, average_price_idr: 190 }
          ]
        : [];
      
      return {
        external_bot_id: botResult.external_bot_id,
        account_id: botResult.account_id,
        cash_idr: 100000000, // Rp100,000,000
        positions
      };
    });

    const genesisRes = await app.inject({
      method: "POST",
      url: "/bot/internal/genesis",
      headers: { "x-service-token": botToken, "idempotency-key": `genesis-${genesisRunId}` },
      payload: {
        genesis_run_id: genesisRunId,
        accounts: genesisAccounts
      }
    });

    if (genesisRes.statusCode !== 200) {
      throw new Error(`Genesis seeding failed: ${genesisRes.body}`);
    }
    console.log("   -> Sukses! 10 BOT berhasil menerima Cash Genesis & Saham.");

    // 4. Verifikasi snapshot portfolio pasca-genesis
    console.log("\n4. Verifikasi saldo RDN dan kepemilikan saham...");
    const snapshotRes = await app.inject({
      method: "POST",
      url: "/bot/internal/portfolio-snapshot",
      headers: { "x-service-token": botToken },
      payload: { account_ids: accountIds }
    });

    if (snapshotRes.statusCode !== 200) {
      throw new Error(`Snapshot failed: ${snapshotRes.body}`);
    }
    const snapshotBody = JSON.parse(snapshotRes.body);
    
    // Verifikasi cash dan position
    snapshotBody.accounts.forEach((acc: any, idx: number) => {
      if (Number(acc.cash.available_idr) !== 100000000) {
        throw new Error(`Bot ${idx + 1} cash mismatch: ${acc.cash.available_idr}`);
      }
      if (idx < 5) {
        const mndl = acc.positions.find((p: any) => p.symbol === "MNDL");
        if (!mndl || mndl.available_shares !== 5000) {
          throw new Error(`Bot ${idx + 1} shares mismatch for MNDL`);
        }
      }
    });
    console.log("   -> Sukses! Saldo dan posisi terverifikasi benar.");

    // 5. Submit Order lewat Sekuritas & Matching di MATS
    console.log("\n5. Menjalankan skenario order matching (Bot 1 JUAL, Bot 6 BELI)...");
    
    // Pastikan session MATS active
    const matsSession = await fetch("http://127.0.0.1:8082/v1/admin/session/status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" },
      body: JSON.stringify({ status: "continuous" })
    });
    if (!matsSession.ok) throw new Error(`MATS session open failed: ${await matsSession.text()}`);

    // Clean orderbook
    await fetch("http://127.0.0.1:8082/v1/admin/orders/expire", {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": "dev-admin-service-token-change-me-2026" }
    });

    const bot1Token = tokenBody.tokens.find((t: any) => t.account_id === accountIds[0]).token; // Bot 1 (penjual)
    const bot6Token = tokenBody.tokens.find((t: any) => t.account_id === accountIds[5]).token; // Bot 6 (pembeli)

    // Bot 1 memasang order JUAL MNDL di harga 316
    const sellClientOrderId = `bot:bot-exit-test-${runUuid}-1:${crypto.randomUUID()}:1`;
    console.log("   -> Bot 1 mengirim Sell Limit MNDL @ 316...");
    const sellRes = await app.inject({
      method: "POST",
      url: "/bot/orders",
      headers: { authorization: `Bearer ${bot1Token}` },
      payload: {
        symbol: "MNDL",
        side: "SELL",
        order_type: "LIMIT",
        price: 316,
        quantity: 100, // 1 lot
        client_order_id: sellClientOrderId
      }
    });

    if (sellRes.statusCode !== 201) {
      throw new Error(`Sell order failed: ${sellRes.body}`);
    }

    // Bot 6 memasang order BELI MNDL di harga 316 (saling match)
    const buyClientOrderId = `bot:bot-exit-test-${runUuid}-6:${crypto.randomUUID()}:1`;
    console.log("   -> Bot 6 mengirim Buy Limit MNDL @ 316...");
    const buyRes = await app.inject({
      method: "POST",
      url: "/bot/orders",
      headers: { authorization: `Bearer ${bot6Token}` },
      payload: {
        symbol: "MNDL",
        side: "BUY",
        order_type: "LIMIT",
        price: 316,
        quantity: 100, // 1 lot
        client_order_id: buyClientOrderId
      }
    });

    if (buyRes.statusCode !== 201) {
      throw new Error(`Buy order failed: ${buyRes.body}`);
    }

    // Tunggu event processing & matching selesai
    console.log("   -> Menunggu matching engine...");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 6. Verifikasi portfolio terupdate dan tidak ada cash / position minus
    console.log("\n6. Verifikasi portfolio terupdate pasca-trade...");
    const finalSnapshotRes = await app.inject({
      method: "POST",
      url: "/bot/internal/portfolio-snapshot",
      headers: { "x-service-token": botToken },
      payload: { account_ids: [accountIds[0], accountIds[5]] }
    });

    const finalSnapshot = JSON.parse(finalSnapshotRes.body);
    const finalBot1 = finalSnapshot.accounts.find((a: any) => a.account_id === accountIds[0]);
    const finalBot6 = finalSnapshot.accounts.find((a: any) => a.account_id === accountIds[5]);

    // Bot 1 (penjual) MNDL berkurang 100 shares, cash pending bertambah
    const bot1Mndl = finalBot1.positions.find((p: any) => p.symbol === "MNDL");
    console.log(`   -> Bot 1 MNDL shares (available): ${bot1Mndl?.available_shares} (Mula-mula: 5000)`);
    console.log(`   -> Bot 1 Cash Balance (available): Rp ${finalBot1.cash.available_idr}`);
    console.log(`   -> Bot 1 Cash Balance (pending): Rp ${finalBot1.cash.pending_idr}`);

    // Bot 6 (pembeli) MNDL bertambah 100 shares di pending, cash berkurang
    const bot6Mndl = finalBot6.positions.find((p: any) => p.symbol === "MNDL");
    console.log(`   -> Bot 6 MNDL shares (pending): ${bot6Mndl?.pending_shares} (Mula-mula: 0)`);
    console.log(`   -> Bot 6 Cash Balance (available): Rp ${finalBot6.cash.available_idr}`);

    if (!bot1Mndl || bot1Mndl.available_shares !== 4900) {
      throw new Error("Bot 1 shares did not update correctly after match");
    }
    if (Number(finalBot1.cash.pending_idr) <= 0) {
      throw new Error("Bot 1 pending cash did not increase after match");
    }
    if (!bot6Mndl || bot6Mndl.pending_shares !== 100) {
      throw new Error("Bot 6 pending shares did not update correctly after match");
    }
    if (Number(finalBot6.cash.available_idr) >= 100000000) {
      throw new Error("Bot 6 available cash did not decrease after match");
    }

    console.log("\n==================================================");
    console.log("VERIFIKASI EXIT CRITERIA FASE 0 BERHASIL 100%!");
    console.log("==================================================");

  } catch (err) {
    console.error("VERIFIKASI GAGAL:", err);
    process.exit(1);
  } finally {
    await app.close();
    await closeDatabase();
  }
}

verifyExitCriteria();
