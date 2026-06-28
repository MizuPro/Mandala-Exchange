import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SEKURITAS_URL = "http://localhost:3002";
const BEI_URL = "http://localhost:4100/v1";
const MATS_SYNC_URL = "http://localhost:8082/v1/admin/sync/bei";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";
const MATS_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, options: RequestInit = {}) {
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return { ok: res.ok, status: res.status, data: json };
    } catch {
      return { ok: res.ok, status: res.status, raw: text };
    }
  } catch (error: any) {
    return { ok: false, status: 500, error: error.message };
  }
}

interface TraderInfo {
  id: string;
  email: string;
  token: string;
  brokerAccountId: string;
}

async function runDerivativesTradingTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E PENDISTRIBUSIAN & PERDAGANGAN DERIVATIF (MOSE-W) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas dan BEI
  console.log("\n[1] Menghubungkan ke database Sekuritas dan BEI...");
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  try {
    await sekDbClient.connect();
    await beiDbClient.connect();
    console.log("✅ Terhubung ke database.");
  } catch (err: any) {
    console.error("❌ Gagal menghubungkan ke database:", err.message);
    process.exit(1);
  }

  // 2. Setup Trader 1 & Trader 2
  console.log("\n[2] Mempersiapkan otentikasi Trader 1 & Trader 2...");
  const traders: TraderInfo[] = [];
  const emails = ["test_trader_1@mandalatest.com", "test_trader_2@mandalatest.com"];

  for (const email of emails) {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      console.error(`❌ Trader ${email} tidak ditemukan.`);
      process.exit(1);
    }
    const [brokerAccount] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAccount) {
      console.error(`❌ Broker Account untuk ${email} tidak ditemukan.`);
      process.exit(1);
    }

    const token = signUserToken(user.id);
    traders.push({
      id: user.id,
      email,
      token,
      brokerAccountId: brokerAccount.id,
    });
  }

  const trader1 = traders[0]!;
  const trader2 = traders[1]!;
  console.log(`✅ Trader 1: ${trader1.email} (ID: ${trader1.brokerAccountId})`);
  console.log(`✅ Trader 2: ${trader2.email} (ID: ${trader2.brokerAccountId})`);

  // Pastikan kedua trader memiliki saldo kas RDN yang memadai (misal Rp 10.000.000)
  await sekDbClient.query(
    "UPDATE cash_balances SET available = 10000000.000000, reserved = 0.000000, pending = 0.000000 WHERE broker_account_id IN ($1, $2)",
    [trader1.brokerAccountId, trader2.brokerAccountId]
  );

  // 3. Persiapkan listed security MOSE di BEI
  console.log("\n[3] Memastikan saham induk MOSE terdaftar di BEI...");
  const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
  let moseSecurityId = secRes.rows[0]?.id;
  if (!moseSecurityId) {
    console.error("❌ Emiten MOSE belum terdaftar di BEI. Silakan jalankan pengujian IPO terlebih dahulu.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log(`✅ MOSE Security ID: ${moseSecurityId}`);

  // Serta set saham induk MOSE di portofolio trader 2 agar berhak atas Waran (misal 1.000 lembar)
  console.log("- Menyetel kepemilikan saham induk MOSE Trader 2 ke 1.000 lembar...");
  await sekDbClient.query(
    "UPDATE securities_positions SET available = 1000, reserved = 0, pending = 0, average_price = '200.000000' WHERE broker_account_id = $1 AND symbol = 'MOSE'",
    [trader2.brokerAccountId]
  );

  // Serta set saham induk MOSE di portofolio trader 1 ke 0 agar tidak berhak atas Waran
  console.log("- Menyetel kepemilikan saham induk MOSE Trader 1 ke 0 lembar...");
  await sekDbClient.query(
    "UPDATE securities_positions SET available = 0, reserved = 0, pending = 0, average_price = '0.000000' WHERE broker_account_id = $1 AND symbol = 'MOSE'",
    [trader1.brokerAccountId]
  );
  
  const custodyAccRes = await beiDbClient.query(
    "SELECT id FROM custody_accounts WHERE investor_id = $1",
    [trader2.brokerAccountId]
  );
  const custodyAccId = custodyAccRes.rows[0]?.id;
  if (custodyAccId) {
    await beiDbClient.query(
      "DELETE FROM custody_ledger_entries WHERE custody_account_id = $1 AND security_id = $2",
      [custodyAccId, moseSecurityId]
    );
    await beiDbClient.query(
      `INSERT INTO custody_ledger_entries (custody_account_id, security_id, asset_type, quantity, entry_type, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, 'security', 1000, 'adjustment', 'adjustment', 'init-balance', $3)`,
      [custodyAccId, moseSecurityId, `init:ca_deriv:${trader2.brokerAccountId}:${Date.now()}`]
    );
  }

  const custodyAcc1Res = await beiDbClient.query(
    "SELECT id FROM custody_accounts WHERE investor_id = $1",
    [trader1.brokerAccountId]
  );
  const custodyAcc1Id = custodyAcc1Res.rows[0]?.id;
  if (custodyAcc1Id) {
    await beiDbClient.query(
      "DELETE FROM custody_ledger_entries WHERE custody_account_id = $1 AND security_id = $2",
      [custodyAcc1Id, moseSecurityId]
    );
  }

  // Bersihkan data MOSE-W lama milik para trader agar steril
  await beiDbClient.query("DELETE FROM settlement_instructions WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol = 'MOSE-W')");
  await beiDbClient.query("DELETE FROM trades WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol = 'MOSE-W')");
  await beiDbClient.query("DELETE FROM listed_securities WHERE symbol = 'MOSE-W'");
  await beiDbClient.query("DELETE FROM corporate_actions WHERE security_id = $1 AND type = 'warrant'", [moseSecurityId]);
  await sekDbClient.query("DELETE FROM trade_fills WHERE order_id IN (SELECT id FROM orders WHERE symbol = 'MOSE-W')");
  await sekDbClient.query("DELETE FROM orders WHERE symbol = 'MOSE-W'");
  await sekDbClient.query("DELETE FROM securities_positions WHERE symbol = 'MOSE-W'");

  // 4. Memicu pembagian Waran via Corporate Action (Rasio 5:1)
  console.log("\n[4] Mendaftarkan Corporate Action: Warrant Distribution (Rasio 5:1) di BEI...");
  const warrantCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      securityId: moseSecurityId,
      type: "warrant",
      status: "draft",
      title: "Warrant Distribution MOSE-W 5:1",
      description: "Penerbitan waran dengan rasio 5 saham induk mendapatkan 1 Waran (MOSE-W).",
      announcementDate: new Date().toISOString().split("T")[0],
      recordingDate: new Date().toISOString().split("T")[0],
      executionDate: new Date().toISOString().split("T")[0],
      ratioNumerator: 1,
      ratioDenominator: 5,
      entitlementSymbol: "MOSE-W",
      idempotencyKey: `ca:warrant:mose:${Date.now()}`,
    }),
  });

  if (!warrantCARes.ok) {
    console.error("❌ Gagal mendaftarkan Warrant di BEI:", warrantCARes.data || warrantCARes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const warrantActionId = warrantCARes.data.id;
  console.log(`✅ Warrant Action terdaftar. ID: ${warrantActionId}`);

  console.log(`- Memproses pembagian Warrant...`);
  const processWarrantRes = await fetchJson(`${BEI_URL}/corporate-actions/${warrantActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processWarrantRes.ok) {
    console.error("❌ Gagal memproses pembagian Warrant di BEI:", processWarrantRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Webhook pembagian Warrant dikirim ke Sekuritas.");
  console.log("Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  // 5. ASERSION POIN 2: Verifikasi Auto-register listed_securities BEI
  console.log("\n[5] Verifikasi apakah simbol derivatif 'MOSE-W' otomatis terdaftar di listed_securities BEI...");
  const derivativeSecurityRes = await beiDbClient.query(
    "SELECT id, symbol, board, shares_outstanding FROM listed_securities WHERE symbol = 'MOSE-W'"
  );

  console.log("\n=== ASERSION: AUTO-REGISTER DERIVATIF DI BEI ===");
  if (derivativeSecurityRes.rows.length > 0) {
    const row = derivativeSecurityRes.rows[0];
    console.log(`✅ SUKSES: Simbol ${row.symbol} otomatis terdaftar.`);
    console.log(`- Board: ${row.board} (Harus 'derivatives')`);
    console.log(`- Shares Outstanding: ${row.shares_outstanding} (Jumlah total pembagian)`);

    if (row.board !== "derivatives") {
      console.error("❌ EROR: Board type salah! Terdaftar di:", row.board);
      process.exit(1);
    }
  } else {
    console.error("❌ EROR: Simbol 'MOSE-W' TIDAK terdaftar secara otomatis di BEI!");
    process.exit(1);
  }

  // 6. Sinkronisasi MATS
  console.log("\n[6] Memicu sinkronisasi MATS engine...");
  const syncRes = await fetchJson(MATS_SYNC_URL, {
    method: "POST",
    headers: { "x-service-token": MATS_ADMIN_TOKEN },
  });
  if (!syncRes.ok) {
    console.error("❌ Gagal menyinkronkan aturan ke MATS:", syncRes.data || syncRes.raw);
    process.exit(1);
  }
  console.log("✅ Sinkronisasi MATS Sukses. Menunggu 2 detik...");
  await sleep(2000);

  console.log("- Memastikan status sesi perdagangan MATS ke 'continuous'...");
  const setSessionRes = await fetchJson("http://localhost:8082/v1/admin/session/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": MATS_ADMIN_TOKEN,
    },
    body: JSON.stringify({ status: "continuous" }),
  });
  if (!setSessionRes.ok) {
    console.error("❌ Gagal mengatur status sesi MATS ke continuous:", setSessionRes.data || setSessionRes.raw);
    process.exit(1);
  }
  console.log("✅ Sesi MATS diatur ke continuous.");

  // 7. Pengujian Perdagangan MOSE-W
  console.log("\n[7] Uji Coba: Perdagangan Waran 'MOSE-W' antara Trader 1 & Trader 2...");
  
  // Trader 2 (memiliki 200 lembar MOSE-W dari pembagian) memasang SELL Limit 1 Lot (100 lembar) @ Rp 50
  console.log("- Trader 2 mengirim order SELL Limit (1 Lot / 100 lembar @ Rp 50)...");
  const sellOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${trader2.token}`,
    },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "SELL",
      order_type: "LIMIT",
      price: 50,
      quantity: 100,
    }),
  });

  if (!sellOrderRes.ok) {
    console.error("❌ Gagal mengirim order SELL:", sellOrderRes.data || sellOrderRes.raw);
    process.exit(1);
  }
  console.log(`✅ Order SELL terkirim. ID: ${sellOrderRes.data.id}`);

  // Trader 1 memasang BUY Limit 1 Lot (100 lembar) @ Rp 50
  console.log("- Trader 1 mengirim order BUY Limit (1 Lot / 100 lembar @ Rp 50)...");
  const buyOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${trader1.token}`,
    },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 50,
      quantity: 100,
    }),
  });

  if (!buyOrderRes.ok) {
    console.error("❌ Gagal mengirim order BUY:", buyOrderRes.data || buyOrderRes.raw);
    process.exit(1);
  }
  console.log(`✅ Order BUY terkirim. ID: ${buyOrderRes.data.id}`);

  console.log("Menunggu 3 detik agar transaksi dicocokkan (matching)...");
  await sleep(3000);

  // Memicu settlement batch di BEI agar status pending bergeser ke available
  console.log("\n[7.5] Mencari session aktif di BEI untuk settlement...");
  const sessionRes = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!sessionRes.ok) {
    console.error("❌ Gagal mendapatkan session aktif dari BEI.", sessionRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const sessionId = sessionRes.data.id;
  console.log(`Session ID aktif BEI untuk settlement: ${sessionId}`);

  console.log("Memicu Settlement Batch di BEI...");
  const createBatchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({ sessionId }),
  });

  if (!createBatchRes.ok) {
    console.error("❌ Gagal membuat settlement batch:", createBatchRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const batchId = createBatchRes.data.batch.id;
  console.log(`✅ Batch Settlement dibuat dengan ID: ${batchId}. Memicu pemrosesan batch...`);

  const processBatchRes = await fetchJson(`${BEI_URL}/settlement/batches/${batchId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processBatchRes.ok) {
    console.error("❌ Gagal memproses settlement batch:", processBatchRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  console.log("✅ Settlement batch diproses. Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  // Verifikasi matched portfolio positions
  const t1Pos = await sekDbClient.query(
    "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE-W'",
    [trader1.brokerAccountId]
  );
  const t2Pos = await sekDbClient.query(
    "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE-W'",
    [trader2.brokerAccountId]
  );

  console.log("\n=== ASERSION: PERDAGANGAN DERIVATIF (MOSE-W) ===");
  const t1Qty = Number(t1Pos.rows[0]?.available || 0);
  const t2Qty = Number(t2Pos.rows[0]?.available || 0);
  console.log(`- Saldo MOSE-W Trader 1 (Pembeli): ${t1Qty} lembar (Seharusnya 100)`);
  console.log(`- Saldo MOSE-W Trader 2 (Penjual): ${t2Qty} lembar (Seharusnya 100, karena awal 200 - 100)`);

  if (t1Qty === 100 && t2Qty === 100) {
    console.log("✅ SUKSES: Transaksi Waran MOSE-W berhasil dicocokkan & diselesaikan (settled)!");
  } else {
    console.error("❌ EROR: Transaksi Waran gagal dicocokkan!");
    process.exit(1);
  }

  // 8. Pengujian Batas ARA/ARB derivatives yang Sangat Longgar (~999%)
  console.log("\n[8] Uji Coba: Mengirim order BUY Limit bernilai ekstrim tinggi (Rp 400, kenaikan 800% dari ref: Rp 50)...");
  const ekstrimBuyRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${trader1.token}`,
    },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 400, // Rp 400
      quantity: 100,
    }),
  });

  console.log("Status Response Penempatan Order:", ekstrimBuyRes.status);
  console.log("Body Response:", ekstrimBuyRes.data || ekstrimBuyRes.raw);

  console.log("\n=== ASERSION: BATAS HARGA (ARA/ARB) DERIVATIF ===");
  const ekstrimStatus = ekstrimBuyRes.data?.status || ekstrimBuyRes.data?.order?.status;
  if (ekstrimStatus === "open" || ekstrimBuyRes.status === 201) {
    console.log("✅ SUKSES: Order di luar batas ARA standar (35%) diterima dengan sukses karena menggunakan price band derivatives (~999%)!");
  } else {
    console.error("❌ EROR: Order ditolak padahal rules derivatives membebaskan/melegakan price band!");
    process.exit(1);
  }

  await sekDbClient.end();
  await beiDbClient.end();
  console.log("\n======================================================================");
  console.log("🏁 PENGUJIAN PENDISTRIBUSIAN & PERDAGANGAN DERIVATIF BERHASIL 100%! 🏁");
  console.log("======================================================================");
}

runDerivativesTradingTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian:", err);
  process.exit(1);
});
