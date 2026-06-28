import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SEKURITAS_URL = "http://localhost:3002";
const BEI_URL = "http://localhost:4100/v1";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";

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

interface TraderState {
  email: string;
  availableCash: string;
  reservedCash: string;
  pendingCash: string;
  availableShares: number;
  reservedShares: number;
  pendingShares: number;
}

async function getTraderState(
  sekClient: pg.Client,
  brokerAccountId: string,
  email: string
): Promise<TraderState> {
  const cashRes = await sekClient.query(
    "SELECT available, reserved, pending FROM cash_balances WHERE broker_account_id = $1",
    [brokerAccountId]
  );
  const shareRes = await sekClient.query(
    "SELECT available, reserved, pending FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE'",
    [brokerAccountId]
  );

  const cash = cashRes.rows[0] || { available: "0", reserved: "0", pending: "0" };
  const share = shareRes.rows[0] || { available: 0, reserved: 0, pending: 0 };

  return {
    email,
    availableCash: cash.available,
    reservedCash: cash.reserved,
    pendingCash: cash.pending,
    availableShares: parseInt(share.available || 0),
    reservedShares: parseInt(share.reserved || 0),
    pendingShares: parseInt(share.pending || 0),
  };
}

async function runMarketOrderT2Test() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E MARKET ORDER & SETTLEMENT T+2 (MOSE) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas dan BEI
  console.log("\n[1] Menghubungkan ke database Sekuritas dan BEI...");
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  try {
    await sekDbClient.connect();
    await beiDbClient.connect();
    console.log("✅ Terhubung ke kedua database.");
  } catch (err: any) {
    console.error("❌ Gagal menghubungkan ke database:", err.message);
    process.exit(1);
  }

  // 2. Setup Otentikasi Trader 1 & Trader 2
  console.log("\n[2] Mempersiapkan data otentikasi trader...");
  const email1 = "test_trader_1@mandalatest.com"; // Pembeli
  const email2 = "test_trader_2@mandalatest.com"; // Penjual

  const [user1] = await db.select().from(users).where(eq(users.email, email1)).limit(1);
  const [user2] = await db.select().from(users).where(eq(users.email, email2)).limit(1);

  if (!user1 || !user2) {
    console.error("❌ Salah satu trader tidak ditemukan di database.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const [acc1] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user1.id)).limit(1);
  const [acc2] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user2.id)).limit(1);

  if (!acc1 || !acc2) {
    console.error("❌ Akun broker trader tidak ditemukan.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const token1 = signUserToken(user1.id);
  const token2 = signUserToken(user2.id);

  console.log(`✅ Trader 1 (Pembeli): ${email1} | Acc: ${acc1.id}`);
  console.log(`✅ Trader 2 (Penjual): ${email2} | Acc: ${acc2.id}`);

  // 3. Bersihkan orderbook MOSE agar steril
  console.log("\n[3] Membersihkan order 'MOSE' yang masih open...");
  try {
    const openOrders = await sekDbClient.query(`
      SELECT o.id, u.id as user_id, u.email
      FROM orders o
      JOIN broker_accounts ba ON o.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE o.symbol = 'MOSE' AND o.status IN ('open', 'partially_filled')
    `);

    for (const order of openOrders.rows) {
      console.log(`- Membatalkan order ID: ${order.id} milik ${order.email}`);
      const tkn = order.user_id === user1.id ? token1 : token2;
      await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${order.id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${tkn}` },
      });
    }
  } catch (err: any) {
    console.warn("⚠️ Peringatan saat membersihkan orderbook:", err.message);
  }

  // 4. Pastikan Penjual (Trader 2) memiliki saham MOSE yang cukup
  console.log("\n[4] Memastikan Penjual (Trader 2) memiliki minimal 1.000 lembar saham MOSE...");
  let moseSecurityId = "";
  try {
    const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
    if (secRes.rows.length === 0) {
      console.error("❌ Emiten MOSE belum terdaftar di BEI.");
      await sekDbClient.end();
      await beiDbClient.end();
      process.exit(1);
    }
    moseSecurityId = secRes.rows[0].id;

    // Cek di DB Sekuritas
    const sekPosRes = await sekDbClient.query(
      "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE'",
      [acc2.id]
    );
    const sekQty = sekPosRes.rows[0] ? parseInt(sekPosRes.rows[0].available) : 0;

    if (sekQty < 1000) {
      console.log(`Saham MOSE Trader 2 di Sekuritas (${sekQty}) tidak cukup. Menambahkan 10.000 lembar...`);

      // Dapatkan SRE dan SID Trader 2
      const sidRes = await sekDbClient.query("SELECT sid FROM sid_references WHERE broker_account_id = $1", [acc2.id]);
      const sreRes = await sekDbClient.query("SELECT sre FROM sre_references WHERE broker_account_id = $1", [acc2.id]);
      const sid = sidRes.rows[0]?.sid;
      const sre = sreRes.rows[0]?.sre;

      if (!sid || !sre) {
        throw new Error("SID atau SRE untuk Trader 2 tidak ditemukan.");
      }

      // Dapatkan custody_account_id di BEI
      const custodyAccRes = await beiDbClient.query(
        "SELECT id FROM custody_accounts WHERE sid = $1 AND sre = $2",
        [sid, sre]
      );
      const custodyAccId = custodyAccRes.rows[0]?.id;

      if (!custodyAccId) {
        throw new Error("Custody Account di BEI tidak ditemukan.");
      }

      // Suntik saham di BEI
      await beiDbClient.query(
        `INSERT INTO custody_ledger_entries (custody_account_id, security_id, asset_type, quantity, idempotency_key)
         VALUES ($1, $2, 'security', 10000, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [custodyAccId, moseSecurityId, `grant:market_test:${acc2.id}:${Date.now()}`]
      );

      // Suntik saham di Sekuritas
      if (sekPosRes.rows.length > 0) {
        await sekDbClient.query(
          "UPDATE securities_positions SET available = available + 10000 WHERE broker_account_id = $1 AND symbol = 'MOSE'",
          [acc2.id]
        );
      } else {
        await sekDbClient.query(
          `INSERT INTO securities_positions (broker_account_id, symbol, available, reserved, pending, average_price, realized_pl, unrealized_pl)
           VALUES ($1, 'MOSE', 10000, 0, 0, '200.000000', 0, 0)`,
          [acc2.id]
        );
      }

      console.log("✅ Berhasil menambahkan 10.000 lembar saham MOSE untuk Trader 2.");
    } else {
      console.log(`✅ Trader 2 memiliki saham MOSE yang cukup (${sekQty} lembar).`);
    }
  } catch (err: any) {
    console.error("❌ Gagal memverifikasi/menambah saham Trader 2:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // 5. Catat State Awal
  const stateInitial1 = await getTraderState(sekDbClient, acc1.id, email1);
  const stateInitial2 = await getTraderState(sekDbClient, acc2.id, email2);

  console.log("\n[5] State Portofolio Awal:");
  console.log("Trader 1 (Pembeli):");
  console.table([stateInitial1]);
  console.log("Trader 2 (Penjual):");
  console.table([stateInitial2]);

  // 6. Jalankan Transaksi Market Order (T+0)
  console.log("\n[6] Mengirim order SELL Limit (10 Lot @ Rp 210) dari Trader 2 (Penjual)...");
  const sellRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token2}` },
    body: JSON.stringify({
      symbol: "MOSE",
      side: "SELL",
      order_type: "LIMIT",
      price: 210,
      quantity: 1000, // 10 Lot
    }),
  });

  if (!sellRes.ok) {
    console.error("❌ Gagal menempatkan order SELL:", sellRes.data || sellRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const sellOrderId = sellRes.data.id;
  console.log(`✅ Order SELL Limit terpasang. ID: ${sellOrderId}`);

  console.log("Menunggu 2 detik agar order masuk orderbook...");
  await sleep(2000);

  console.log("\nMengirim order BUY Market (15 Lot / 1.500 lembar) dari Trader 1 (Pembeli)...");
  const buyRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token1}` },
    body: JSON.stringify({
      symbol: "MOSE",
      side: "BUY",
      order_type: "MARKET",
      quantity: 1500, // 15 Lot (lebih besar 5 Lot dari antrean Sell Limit)
    }),
  });

  if (!buyRes.ok) {
    console.error("❌ Gagal menempatkan order BUY MARKET:", buyRes.data || buyRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const buyOrderId = buyRes.data.id;
  console.log(`✅ Order BUY Market terpasang. ID: ${buyOrderId}`);

  console.log("Menunggu 3 detik agar pencocokan order (matching) diproses oleh MATS...");
  await sleep(3000);

  // 7. Ambil State T+0 (Pasca Matching, Sebelum Settlement)
  console.log("\n[7] Mengambil data status order dan saldo pasca transaksi (T+0)...");
  const orderBuyT0 = await sekDbClient.query("SELECT status, filled_quantity, original_quantity FROM orders WHERE id = $1", [buyOrderId]);
  const orderSellT0 = await sekDbClient.query("SELECT status, filled_quantity, original_quantity FROM orders WHERE id = $1", [sellOrderId]);

  console.log("Status Order di Database Sekuritas (T+0):");
  console.table([
    {
      Order: "BUY Market (Trader 1)",
      Qty: `${orderBuyT0.rows[0]?.filled_quantity}/${orderBuyT0.rows[0]?.original_quantity}`,
      Status: orderBuyT0.rows[0]?.status,
    },
    {
      Order: "SELL Limit (Trader 2)",
      Qty: `${orderSellT0.rows[0]?.filled_quantity}/${orderSellT0.rows[0]?.original_quantity}`,
      Status: orderSellT0.rows[0]?.status,
    },
  ]);

  const stateT0_1 = await getTraderState(sekDbClient, acc1.id, email1);
  const stateT0_2 = await getTraderState(sekDbClient, acc2.id, email2);

  console.log("\nSaldo Kas & Saham pada T+0 (Post-Match):");
  console.log("Trader 1 (Pembeli):");
  console.table([stateT0_1]);
  console.log("Trader 2 (Penjual):");
  console.table([stateT0_2]);

  // Validasi Sifat FAK (Fill & Kill) pada Order Market:
  // Kuantitas match harus 1000 lembar (10 Lot) dan sisa 500 lembar di-kill.
  // Saldo reserved cash untuk Pembeli harus kembali menjadi 0 setelah sisa order dibatalkan.
  console.log("\n=== VALIDASI MEKANISME MARKET ORDER & FAK (T+0) ===");
  if (parseInt(orderBuyT0.rows[0]?.filled_quantity) === 1000) {
    console.log("✅ Order MARKET berhasil match sebagian (10 Lot) sesuai dengan antrean terbaik.");
  } else {
    console.error(`❌ Jumlah match tidak sesuai! Terisi: ${orderBuyT0.rows[0]?.filled_quantity}`);
  }

  if (parseFloat(stateT0_1.reservedCash) === 0) {
    console.log("✅ Saldo Reserved Cash Pembeli kembali menjadi 0 (sisa 5 Lot di-kill dan dana dibebaskan).");
  } else {
    console.error(`❌ Saldo Reserved Cash Pembeli tidak nol! Nilai: ${stateT0_1.reservedCash}`);
  }

  // Validasi T+0 Penundaan Transfer Efek/Uang:
  console.log("\n=== VALIDASI SIKLUS PENDING T+0 ===");
  if (stateT0_1.availableShares === stateInitial1.availableShares && stateT0_1.pendingShares === 1000) {
    console.log("✅ T+0 Pembeli: Saham available belum bertambah, saham masuk di status PENDING.");
  } else {
    console.error("❌ T+0 Pembeli: Saham salah! Available:", stateT0_1.availableShares, "Pending:", stateT0_1.pendingShares);
  }

  const diffCashT0_2 = parseFloat(stateT0_2.availableCash) - parseFloat(stateInitial2.availableCash);
  if (Math.abs(diffCashT0_2) < 0.01 && parseFloat(stateT0_2.pendingCash) > 0) {
    console.log("✅ T+0 Penjual: Uang hasil jual belum bertambah di available, melainkan ditahan di PENDING.");
  } else {
    console.error("❌ T+0 Penjual: Perubahan kas available/pending salah! Available delta:", diffCashT0_2, "Pending:", stateT0_2.pendingCash);
  }

  // 8. Jalankan Settlement di BEI (Simulasi T+2)
  console.log("\n[8] Mencari session aktif di BEI untuk settlement...");
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
  console.log(`Session ID aktif BEI: ${sessionId}`);

  console.log("\nMemicu Settlement Batch di BEI...");
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
  console.log(`Batch ID dibuat: ${batchId}. Memproses batch...`);

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
  console.log("✅ Settlement Batch berhasil diselesaikan di BEI.");

  console.log("Menunggu 5 detik agar status settlement tersinkronisasi ke Sekuritas...");
  await sleep(5000);

  // 9. Ambil State T+2 (Pasca Settlement)
  console.log("\n[9] Mengambil data saldo akhir pasca settlement (T+2)...");
  const stateT2_1 = await getTraderState(sekDbClient, acc1.id, email1);
  const stateT2_2 = await getTraderState(sekDbClient, acc2.id, email2);

  console.log("Saldo Kas & Saham pada T+2 (Post-Settlement):");
  console.log("Trader 1 (Pembeli):");
  console.table([stateT2_1]);
  console.log("Trader 2 (Penjual):");
  console.table([stateT2_2]);

  console.log("\n=== VALIDASI FINAL SIKLUS SETTLEMENT T+2 ===");
  if (stateT2_1.pendingShares === 0 && stateT2_1.availableShares === stateInitial1.availableShares + 1000) {
    console.log("✅ T+2 Pembeli: Saham pending didebit menjadi 0, dan saham tersedia (available) bertambah 1.000 lembar.");
  } else {
    console.error("❌ T+2 Pembeli: Pembukuan transfer saham salah!");
  }

  const diffCashT2_2 = parseFloat(stateT2_2.availableCash) - parseFloat(stateInitial2.availableCash);
  if (parseFloat(stateT2_2.pendingCash) === 0 && diffCashT2_2 > 0) {
    console.log(`✅ T+2 Penjual: Kas pending dicairkan menjadi 0, dan kas tersedia (available) bertambah Rp ${diffCashT2_2.toLocaleString("id-ID")}.`);
  } else {
    console.error("❌ T+2 Penjual: Pembukuan transfer kas hasil jual salah!");
  }

  // 10. Ringkasan Perbandingan Kas & Saham di Semua Tahap
  console.log("\n======================================================================");
  console.log("📊 RINGKASAN PERBANDINGAN PENGUJIAN MARKET ORDER & SETTLEMENT T+2 📊");
  console.log("======================================================================");
  console.log("TRADER 1 (BUYER):");
  console.table([
    {
      Tahap: "Awal",
      "Available Cash": parseFloat(stateInitial1.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateInitial1.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateInitial1.availableShares,
      "Pending Shares": stateInitial1.pendingShares,
    },
    {
      Tahap: "T+0 (Post-Match)",
      "Available Cash": parseFloat(stateT0_1.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateT0_1.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateT0_1.availableShares,
      "Pending Shares": stateT0_1.pendingShares,
    },
    {
      Tahap: "T+2 (Settlement)",
      "Available Cash": parseFloat(stateT2_1.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateT2_1.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateT2_1.availableShares,
      "Pending Shares": stateT2_1.pendingShares,
    },
  ]);

  console.log("TRADER 2 (SELLER):");
  console.table([
    {
      Tahap: "Awal",
      "Available Cash": parseFloat(stateInitial2.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateInitial2.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateInitial2.availableShares,
      "Pending Shares": stateInitial2.pendingShares,
    },
    {
      Tahap: "T+0 (Post-Match)",
      "Available Cash": parseFloat(stateT0_2.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateT0_2.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateT0_2.availableShares,
      "Pending Shares": stateT0_2.pendingShares,
    },
    {
      Tahap: "T+2 (Settlement)",
      "Available Cash": parseFloat(stateT2_2.availableCash).toLocaleString("id-ID"),
      "Pending Cash": parseFloat(stateT2_2.pendingCash).toLocaleString("id-ID"),
      "Available Shares": stateT2_2.availableShares,
      "Pending Shares": stateT2_2.pendingShares,
    },
  ]);

  await sekDbClient.end();
  await beiDbClient.end();
  console.log("\n🏁 PENGUJIAN MARKET ORDER & T+2 SELESAI! 🏁");
  console.log("======================================================================");
}

runMarketOrderT2Test().catch((err) => {
  console.error("Terjadi error fatal saat pengujian market order & T+2:", err);
  process.exit(1);
});
