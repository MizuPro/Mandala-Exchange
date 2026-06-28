import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SEKURITAS_URL = "http://localhost:3002";
const BEI_URL = "http://localhost:4100/v1";
const MATS_URL = "http://localhost:8082/v1";
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

async function runIEPTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E MEKANISME IEP & UNCROSS LELANG (MOSE) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas
  console.log("\n[1] Menghubungkan ke database Sekuritas...");
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  try {
    await sekDbClient.connect();
  } catch (err: any) {
    console.error("Gagal menghubungkan ke database Sekuritas:", err.message);
    process.exit(1);
  }

  // 2. Setup 10 Trader Testing
  console.log("\n[2] Mempersiapkan data otentikasi trader testing...");
  const traders: TraderInfo[] = [];
  for (let i = 1; i <= 10; i++) {
    const email = `test_trader_${i}@mandalatest.com`;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      console.error(`❌ Trader ${email} belum terdaftar. Jalankan test multi-user atau IPO terlebih dahulu.`);
      await sekDbClient.end();
      process.exit(1);
    }
    const [brokerAccount] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAccount) {
      console.error(`❌ Broker Account untuk ${email} tidak ditemukan.`);
      await sekDbClient.end();
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
  console.log(`Sukses memuat ${traders.length} trader.`);

  // 3. Bersihkan sisa order open MOSE lama agar lelang steril
  console.log("\n[3] Membersihkan order 'MOSE' yang masih 'open' di database Sekuritas...");
  try {
    const openOrdersRes = await sekDbClient.query(`
      SELECT o.id, u.id as user_id, o.symbol
      FROM orders o
      JOIN broker_accounts ba ON o.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE o.symbol = 'MOSE' AND o.status IN ('open', 'partially_filled')
    `);

    console.log(`Ditemukan ${openOrdersRes.rows.length} order MOSE yang open.`);
    for (const order of openOrdersRes.rows) {
      const trader = traders.find((t) => t.id === order.user_id)!;
      console.log(`- Membatalkan order ID: ${order.id} milik ${trader.email}`);
      const cancelRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${order.id}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${trader.token}`,
        },
      });
      if (!cancelRes.ok) {
        console.warn(`⚠️ Gagal membatalkan order ${order.id}:`, cancelRes.data);
      }
    }
    console.log("Order book MOSE steril.");
  } catch (err: any) {
    console.error("Gagal membersihkan order open lama:", err.message);
    await sekDbClient.end();
    process.exit(1);
  }

  // 4. Skenario Opening Auction (Pra-Pembukaan)
  console.log("\n[4] === MEMULAI SKENARIO OPENING AUCTION (PRA-PEMBUKAAN) ===");
  
  console.log("- Mengubah status sesi perdagangan MATS ke 'opening_auction'...");
  const setSessionOpenRes = await fetchJson(`${MATS_URL}/admin/session/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": MATS_ADMIN_TOKEN,
    },
    body: JSON.stringify({ status: "opening_auction" }),
  });
  if (!setSessionOpenRes.ok) {
    console.error("Gagal mengubah status sesi MATS ke opening_auction:", setSessionOpenRes.data || setSessionOpenRes.raw);
    await sekDbClient.end();
    process.exit(1);
  }
  console.log("Sesi MATS saat ini: opening_auction");

  console.log("- Memasang order bid & ask untuk kalkulasi lelang...");
  // Order 1: Trader 1 BUY 20 Lot (2.000 lembar) @ Rp 195
  // Order 2: Trader 2 BUY 40 Lot (4.000 lembar) @ Rp 200
  // Order 3: Trader 3 BUY 60 Lot (6.000 lembar) @ Rp 205
  // Order 4: Trader 4 SELL 30 Lot (3.000 lembar) @ Rp 198
  // Order 5: Trader 5 SELL 50 Lot (5.000 lembar) @ Rp 202
  // Order 6: Trader 6 SELL 20 Lot (2.000 lembar) @ Rp 205
  const ordersOpen = [
    { trader: traders[0]!, side: "buy", qty: 2000, price: 195 },
    { trader: traders[1]!, side: "buy", qty: 4000, price: 200 },
    { trader: traders[2]!, side: "buy", qty: 6000, price: 205 },
    { trader: traders[3]!, side: "sell", qty: 3000, price: 198 },
    { trader: traders[4]!, side: "sell", qty: 5000, price: 202 },
    { trader: traders[5]!, side: "sell", qty: 2000, price: 205 },
  ];

  for (let idx = 0; idx < ordersOpen.length; idx++) {
    const o = ordersOpen[idx]!;
    const res = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${o.trader.token}`,
      },
      body: JSON.stringify({
        symbol: "MOSE",
        side: o.side,
        order_type: "limit",
        price: o.price,
        quantity: o.qty,
      }),
    });
    if (res.ok) {
      console.log(`- Order ${idx+1}: ACCEPTED | ${o.trader.email} | ${o.side.toUpperCase()} ${o.qty} MOSE @ ${o.price}`);
    } else {
      console.error(`❌ Gagal mengirim order lelang pembukaan:`, res.data);
    }
  }

  // Jeda kecil agar MATS menghitung
  await sleep(1000);

  console.log("\n- Mengambil harga indikatif IEP & IEV lelang pembukaan...");
  const iepOpenRes = await fetchJson(`${MATS_URL}/admin/auction/MOSE/indicative`, {
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });

  if (!iepOpenRes.ok) {
    console.error("Gagal mengambil data IEP lelang pembukaan:", iepOpenRes.data);
  } else {
    console.log(`📈 Hasil Lelang Pembukaan:`);
    console.log(`- Indicative Equilibrium Price (IEP) : Rp ${iepOpenRes.data.price}`);
    console.log(`- Indicative Equilibrium Volume (IEV): ${iepOpenRes.data.volume} lembar (${iepOpenRes.data.volume / 100} Lot)`);
  }

  console.log("\n- Menjalankan uncross lelang pembukaan (matching order book)...");
  const uncrossOpenRes = await fetchJson(`${MATS_URL}/admin/auction/MOSE/uncross`, {
    method: "POST",
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });
  console.log("Uncross Open Status:", uncrossOpenRes.ok ? "SUKSES" : "GAGAL", uncrossOpenRes.data || uncrossOpenRes.raw);

  console.log("- Mengembalikan status sesi MATS ke 'continuous'...");
  await fetchJson(`${MATS_URL}/admin/session/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": MATS_ADMIN_TOKEN,
    },
    body: JSON.stringify({ status: "continuous" }),
  });

  // 5. Skenario Closing Auction (Pra-Penutupan)
  console.log("\n[5] === MEMULAI SKENARIO CLOSING AUCTION (PRA-PENUTUPAN) ===");
  
  console.log("- Mengubah status sesi perdagangan MATS ke 'closing_auction'...");
  const setSessionCloseRes = await fetchJson(`${MATS_URL}/admin/session/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": MATS_ADMIN_TOKEN,
    },
    body: JSON.stringify({ status: "closing_auction" }),
  });
  if (!setSessionCloseRes.ok) {
    console.error("Gagal mengubah status sesi MATS ke closing_auction:", setSessionCloseRes.data);
    await sekDbClient.end();
    process.exit(1);
  }
  console.log("Sesi MATS saat ini: closing_auction");

  console.log("- Memasang order bid & ask untuk lelang penutupan...");
  // Order 7: Trader 7 BUY 3.000 lembar @ Rp 200
  // Order 8: Trader 8 BUY 5.000 lembar @ Rp 202
  // Order 9: Trader 9 BUY 2.000 lembar @ Rp 204
  // Order 10: Trader 10 SELL 4.000 lembar @ Rp 198
  // Order 1: Trader 1 SELL 4.000 lembar @ Rp 201
  // Order 2: Trader 2 SELL 2.000 lembar @ Rp 203
  const ordersClose = [
    { trader: traders[6]!, side: "buy", qty: 3000, price: 200 },
    { trader: traders[7]!, side: "buy", qty: 5000, price: 202 },
    { trader: traders[8]!, side: "buy", qty: 2000, price: 204 },
    { trader: traders[9]!, side: "sell", qty: 4000, price: 198 },
    { trader: traders[0]!, side: "sell", qty: 4000, price: 201 },
    { trader: traders[1]!, side: "sell", qty: 2000, price: 203 },
  ];

  for (let idx = 0; idx < ordersClose.length; idx++) {
    const o = ordersClose[idx]!;
    const res = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${o.trader.token}`,
      },
      body: JSON.stringify({
        symbol: "MOSE",
        side: o.side,
        order_type: "limit",
        price: o.price,
        quantity: o.qty,
      }),
    });
    if (res.ok) {
      console.log(`- Order ${idx+7}: ACCEPTED | ${o.trader.email} | ${o.side.toUpperCase()} ${o.qty} MOSE @ ${o.price}`);
    } else {
      console.error(`❌ Gagal mengirim order lelang penutupan:`, res.data);
    }
  }

  // Jeda kecil agar MATS menghitung
  await sleep(1000);

  console.log("\n- Mengambil harga indikatif IEP & IEV lelang penutupan...");
  const iepCloseRes = await fetchJson(`${MATS_URL}/admin/auction/MOSE/indicative`, {
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });

  if (!iepCloseRes.ok) {
    console.error("Gagal mengambil data IEP lelang penutupan:", iepCloseRes.data);
  } else {
    console.log(`📈 Hasil Lelang Penutupan:`);
    console.log(`- Indicative Equilibrium Price (IEP) : Rp ${iepCloseRes.data.price}`);
    console.log(`- Indicative Equilibrium Volume (IEV): ${iepCloseRes.data.volume} lembar (${iepCloseRes.data.volume / 100} Lot)`);
  }

  console.log("\n- Menjalankan uncross lelang penutupan (matching order book)...");
  const uncrossCloseRes = await fetchJson(`${MATS_URL}/admin/auction/MOSE/uncross`, {
    method: "POST",
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });
  console.log("Uncross Close Status:", uncrossCloseRes.ok ? "SUKSES" : "GAGAL", uncrossCloseRes.data || uncrossCloseRes.raw);

  console.log("- Mengembalikan status sesi MATS ke 'continuous'...");
  await fetchJson(`${MATS_URL}/admin/session/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": MATS_ADMIN_TOKEN,
    },
    body: JSON.stringify({ status: "continuous" }),
  });

  // 6. Tunggu proses webhook hasil matching masuk ke Sekuritas
  console.log("\n[6] Menunggu 6 detik agar webhook matching diproses oleh Sekuritas...");
  await sleep(6000);

  // 7. Jalankan Settlement di BEI untuk memfinalisasi transaksi lelang
  console.log("\n[7] Mencari session aktif di BEI untuk settlement...");
  const sessionRes = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!sessionRes.ok) {
    console.error("Gagal mendapatkan session aktif dari BEI.", sessionRes.data);
    await sekDbClient.end();
    process.exit(1);
  }
  const sessionId = sessionRes.data.id;
  console.log(`Session ID aktif BEI: ${sessionId}`);

  console.log("\n[8] Memicu Settlement Batch di BEI...");
  const createBatchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({ sessionId }),
  });

  if (!createBatchRes.ok) {
    console.error("Gagal membuat settlement batch:", createBatchRes.data);
    await sekDbClient.end();
    process.exit(1);
  }
  const batchId = createBatchRes.data.batch.id;

  const processBatchRes = await fetchJson(`${BEI_URL}/settlement/batches/${batchId}/process`, {
    method: "POST",
    headers: {
      "x-service-token": BEI_ADMIN_TOKEN,
    },
  });

  if (!processBatchRes.ok) {
    console.error("Gagal memproses settlement batch:", processBatchRes.data);
    await sekDbClient.end();
    process.exit(1);
  }
  console.log("Settlement Batch berhasil diselesaikan.");

  console.log("\nMenunggu 4 detik agar settlement tersinkronisasi ke Sekuritas...");
  await sleep(4000);

  // 8. Verifikasi Akhir
  console.log("\n[9] Menghubungkan ke database Sekuritas untuk melihat hasil transaksi lelang...");
  try {
    const traderIds = traders.map((t) => t.id);
    
    // Tampilkan order hasil lelang pembukaan & penutupan di database
    const orderResults = await sekDbClient.query(`
      SELECT u.email, o.side, o.original_quantity, o.filled_quantity, o.price, o.status, o.created_at
      FROM orders o
      JOIN broker_accounts ba ON o.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE o.symbol = 'MOSE' AND o.created_at >= NOW() - INTERVAL '1 minute'
      ORDER BY o.created_at
    `);

    console.log("\n=== TRANSAKSI LELANG TRADER (MOSE) DI DATABASE SEKURITAS ===");
    console.table(orderResults.rows.map((row) => ({
      Email: row.email,
      Side: row.side.toUpperCase(),
      Qty: `${row.filled_quantity}/${row.original_quantity}`,
      Harga: row.price,
      Status: row.status.toUpperCase(),
      Waktu: new Date(row.created_at).toLocaleTimeString()
    })));

  } catch (err: any) {
    console.error("Gagal melakukan verifikasi database Sekuritas:", err.message);
  } finally {
    await sekDbClient.end();
  }

  console.log("\n======================================================================");
  console.log("🏁 PENGUJIAN IEP (OPEN & CLOSING SESSIONS) SELESAI DENGAN SUKSES! 🏁");
  console.log("======================================================================");
}

runIEPTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian IEP E2E:", err);
  process.exit(1);
});
