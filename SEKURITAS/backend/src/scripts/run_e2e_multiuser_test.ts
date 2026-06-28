import { db } from "../db/db.js";
import { users, broker_accounts, cash_balances, securities_positions, ledger_movements } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { createBrokerAccount, setupRDNForUser } from "../services/account-service.js";
import { beiClient } from "../services/bei-client.js";
import { hashPassword } from "../lib/password.js";
import { signUserToken } from "../lib/auth.js";
import crypto from "crypto";

const SEKURITAS_URL = "http://localhost:3002";
const BEI_URL = "http://localhost:4100/v1";
const MATS_URL = "http://localhost:8082/v1";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";
const MATS_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";

const NUM_TRADERS = 10;
const INITIAL_CASH = 1_000_000_000; // Rp 1.000.000.000 (1 Milyar)
const INITIAL_SHARES = 10_000; // 10.000 lembar (100 Lot) per emiten
const TOTAL_ORDERS_TO_PLACE = 120; // Total order acak yang akan dipasang

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

interface SecurityInfo {
  symbol: string;
  referencePrice: string;
}

async function runE2ETest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI MULTI-USER END-TO-END TRADING FLOW TEST (DEV MODE) 🚀");
  console.log("======================================================================");

  // 1. Force Sync MATS rules dari BEI
  console.log("\n[1] Menyelaraskan aturan BEI ke MATS Service...");
  const syncRes = await fetchJson(`${MATS_URL}/admin/sync/bei`, {
    method: "POST",
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });
  console.log("Sync MATS Status:", syncRes.ok ? "SUKSES" : "GAGAL", syncRes.data || syncRes.raw);
  if (!syncRes.ok) {
    console.error("Gagal sinkronisasi aturan BEI ke MATS. Pengujian dibatalkan.");
    process.exit(1);
  }

  // 2. Ambil daftar emiten aktif dari BEI
  console.log("\n[2] Mengambil daftar emiten saham aktif dari BEI...");
  let activeSecurities: SecurityInfo[] = [];
  try {
    const securities = await beiClient.getListedSecurities();
    activeSecurities = securities.map((s: any) => ({
      symbol: s.symbol,
      referencePrice: s.reference_price || "100.00",
    }));
  } catch (err: any) {
    console.log("⚠️ Gagal mengambil dari BEI API, menggunakan emiten fallback (BARA, MNDL, NUSA)...", err.message);
    activeSecurities = [
      { symbol: "BARA", referencePrice: "190.00" },
      { symbol: "MNDL", referencePrice: "320.00" },
      { symbol: "NUSA", referencePrice: "740.00" },
    ];
  }
  console.log(`Emiten aktif ditemukan (${activeSecurities.length}):`, activeSecurities.map((s) => `${s.symbol} (@${s.referencePrice})`).join(", "));

  // 3. Setup 10 Trader Baru (atau pastikan sudah ada dan terverifikasi)
  console.log(`\n[3] Memproses inisialisasi & verifikasi ${NUM_TRADERS} trader baru...`);
  const traders: TraderInfo[] = [];
  const dummyPasswordHash = "scrypt$6223b1fd8dd6632a80d54f7ebc7f85dd$aa81ce30a559bdbde8a7c2f52844897103fe75ac4e48380a82ff3bf2a3f497194ace71b7a6d7d1f80999043eead88e29228de22589fc7ea4eac6bd8020610e7c"; // password: 'mik123456'

  for (let i = 1; i <= NUM_TRADERS; i++) {
    const email = `test_trader_${i}@mandalatest.com`;
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      console.log(`- Mendaftarkan trader baru: ${email}`);
      [user] = await db.insert(users).values({
        email,
        password_hash: dummyPasswordHash,
        status: "verified",
      }).returning();
    } else {
      if (user.status !== "verified") {
        await db.update(users).set({ status: "verified" }).where(eq(users.id, user.id));
      }
    }

    let [brokerAccount] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAccount) {
      const rdnData = await setupRDNForUser(email, "HUMAN");
      brokerAccount = await createBrokerAccount(user.id, rdnData, "HUMAN");
    }

    const token = signUserToken(user.id);
    traders.push({
      id: user.id,
      email,
      token,
      brokerAccountId: brokerAccount.id,
    });
  }
  console.log(`Sukses setup ${traders.length} trader.`);

  // 4. Alokasi Saldo Cash & Saldo Saham (Seeding)
  console.log("\n[4] Mengalokasikan dana cash & saldo saham awal secara langsung ke DB...");
  await db.transaction(async (tx) => {
    for (const trader of traders) {
      // a. Set Saldo Cash
      const [cash] = await tx.select().from(cash_balances).where(eq(cash_balances.broker_account_id, trader.brokerAccountId)).limit(1);
      const newAvailableStr = INITIAL_CASH.toFixed(6);

      if (cash) {
        await tx.update(cash_balances)
          .set({ available: newAvailableStr, reserved: "0.000000", pending: "0.000000", updated_at: new Date() })
          .where(eq(cash_balances.id, cash.id));
      } else {
        await tx.insert(cash_balances).values({
          broker_account_id: trader.brokerAccountId,
          available: newAvailableStr,
          reserved: "0.000000",
          pending: "0.000000",
        });
      }

      await tx.insert(ledger_movements).values({
        broker_account_id: trader.brokerAccountId,
        asset_type: "CASH",
        amount: INITIAL_CASH.toFixed(6),
        balance_after: newAvailableStr,
        reference_type: "DEPOSIT",
        reference_id: `E2E_CASH_INIT_${Date.now()}`,
      });

      // b. Set Saldo Saham untuk seluruh emiten aktif
      for (const security of activeSecurities) {
        const [pos] = await tx.select().from(securities_positions)
          .where(and(eq(securities_positions.broker_account_id, trader.brokerAccountId), eq(securities_positions.symbol, security.symbol)))
          .limit(1);

        if (pos) {
          await tx.update(securities_positions)
            .set({
              available: INITIAL_SHARES,
              reserved: 0,
              pending: 0,
              average_price: security.referencePrice,
              updated_at: new Date(),
            })
            .where(eq(securities_positions.id, pos.id));
        } else {
          await tx.insert(securities_positions).values({
            broker_account_id: trader.brokerAccountId,
            symbol: security.symbol,
            available: INITIAL_SHARES,
            reserved: 0,
            pending: 0,
            average_price: security.referencePrice,
            realized_pl: "0.000000",
            unrealized_pl: "0.000000",
          });
        }

        await tx.insert(ledger_movements).values({
          broker_account_id: trader.brokerAccountId,
          asset_type: "SECURITIES",
          symbol: security.symbol,
          amount: INITIAL_SHARES.toString(),
          balance_after: INITIAL_SHARES.toString(),
          reference_type: "DEPOSIT",
          reference_id: `E2E_SEC_INIT_${security.symbol}_${Date.now()}`,
        });
      }
    }
  });
  console.log(`Sukses melakukan seeding:`);
  console.log(`- Masing-masing trader mendapat Rp ${INITIAL_CASH.toLocaleString()} Cash.`);
  console.log(`- Masing-masing trader mendapat ${INITIAL_SHARES.toLocaleString()} lembar (100 Lot) untuk setiap emiten.`);

  // 5. Jalankan Simulasi Trading Konkuren (Stress Test)
  console.log(`\n[5] Menjalankan simulasi perdagangan acak secara konkuren...`);
  console.log(`Akan mengirim total ${TOTAL_ORDERS_TO_PLACE} order dengan jeda acak antar order...`);

  let successCount = 0;
  let failCount = 0;
  const pendingRequests: Promise<any>[] = [];

  const sides = ["buy", "sell"];

  for (let step = 1; step <= TOTAL_ORDERS_TO_PLACE; step++) {
    // Pilih trader secara acak
    const trader = traders[Math.floor(Math.random() * traders.length)]!;
    // Pilih emiten secara acak
    const security = activeSecurities[Math.floor(Math.random() * activeSecurities.length)]!;
    // Pilih side secara acak
    const side = sides[Math.floor(Math.random() * sides.length)]!;
    
    // Tentukan harga order limit di sekitar harga referensi (referensi ± 5%)
    const refPrice = parseFloat(security.referencePrice);
    const deviation = refPrice * 0.05; // 5%
    const minPrice = Math.max(1, Math.floor(refPrice - deviation));
    const maxPrice = Math.floor(refPrice + deviation);
    
    // Acak harga integer bulat
    let price = minPrice + Math.floor(Math.random() * (maxPrice - minPrice + 1));
    // Bulatkan ke kelipatan terdekat (misal kelipatan 1, atau 2 untuk harga kecil)
    price = Math.round(price);

    // Kuantitas acak: 1 - 5 lot (100 - 500 lembar)
    const quantity = (1 + Math.floor(Math.random() * 5)) * 100;

    // Persiapkan request order
    const requestPromise = (async () => {
      const payload = {
        symbol: security.symbol,
        side: side,
        order_type: "limit",
        price: price,
        quantity: quantity,
      };

      const res = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${trader.token}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        successCount++;
        // console.log(`[Order ${step}] SUCCESS | ${trader.email} | ${side.toUpperCase()} ${security.symbol} | Qty: ${quantity} @ ${price}`);
      } else {
        failCount++;
        console.warn(`❌ [Order ${step}] FAILED  | ${trader.email} | ${side.toUpperCase()} ${security.symbol} | Qty: ${quantity} @ ${price} | Error:`, res.data?.error || res.raw);
      }
    })();

    pendingRequests.push(requestPromise);
    
    // Jeda acak 20ms - 80ms sebelum pemicuan order berikutnya
    await sleep(20 + Math.floor(Math.random() * 60));
  }

  // Tunggu semua request HTTP order selesai dikirim dan direspon oleh Sekuritas backend
  await Promise.allSettled(pendingRequests);
  console.log(`\nSimulasi penempatan order selesai.`);
  console.log(`- Order berhasil diterima oleh Sekuritas API: ${successCount}`);
  console.log(`- Order ditolak/gagal: ${failCount}`);

  // 6. Tunggu matching engine memproses
  console.log("\n[6] Menunggu 6 detik agar MATS memproses transaksi & mendistribusikan webhook hasil matching...");
  await sleep(6000);

  // 7. Jalankan Settlement di BEI untuk memfinalisasi perdagangan
  console.log("\n[7] Mencari session aktif di BEI untuk settlement...");
  const sessionRes = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!sessionRes.ok) {
    console.error("Gagal mendapatkan session aktif dari BEI. Settlement tidak dapat dipicu.", sessionRes.data);
    process.exit(1);
  }
  const sessionId = sessionRes.data.id;
  console.log(`Session ID aktif BEI: ${sessionId}`);

  console.log("\n[8] Membuat Settlement Batch baru di BEI...");
  const createBatchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({ sessionId }),
  });

  if (!createBatchRes.ok) {
    console.error("Gagal membuat settlement batch di BEI:", createBatchRes.data);
    process.exit(1);
  }
  const batchId = createBatchRes.data.batch.id;
  console.log(`Settlement Batch berhasil dibuat. Batch ID: ${batchId}`);

  console.log(`\n[9] Menjalankan pemrosesan Settlement Batch (ID: ${batchId})...`);
  const processBatchRes = await fetchJson(`${BEI_URL}/settlement/batches/${batchId}/process`, {
    method: "POST",
    headers: {
      "x-service-token": BEI_ADMIN_TOKEN,
    },
  });

  if (!processBatchRes.ok) {
    console.error("Gagal memproses settlement batch di BEI:", processBatchRes.data);
    process.exit(1);
  }
  console.log("Settlement Batch berhasil diproses. Status:", processBatchRes.data.batch?.status || "SUKSES");

  console.log("\nMenunggu 4 detik agar update settlement tersinkronisasi penuh ke database Sekuritas...");
  await sleep(4000);

  // 8. Verifikasi Database
  console.log("\n[10] Menghubungkan ke DB Sekuritas untuk verifikasi kepemilikan akhir...");
  try {
    const traderIds = traders.map((t) => t.id);
    
    // Query cash balance terkini
    const cashResults = await db.execute(
      `SELECT u.email, cb.available, cb.reserved, cb.pending
       FROM cash_balances cb
       JOIN broker_accounts ba ON cb.broker_account_id = ba.id
       JOIN users u ON ba.user_id = u.id
       WHERE u.email LIKE 'test_trader_%@mandalatest.com'
       ORDER BY u.email`
    );

    // Query posisi saham terkini (hanya tampilkan yang available-nya berubah dari 10.000 lembar untuk menandakan terjadi transaksi)
    const stockResults = await db.execute(
      `SELECT u.email, sp.symbol, sp.available, sp.reserved, sp.pending, sp.average_price
       FROM securities_positions sp
       JOIN broker_accounts ba ON sp.broker_account_id = ba.id
       JOIN users u ON ba.user_id = u.id
       WHERE u.email LIKE 'test_trader_%@mandalatest.com' AND sp.available != 10000
       ORDER BY u.email, sp.symbol`
    );

    console.log("\n=== SALDO CASH AKHIR TRADER ===");
    console.table(cashResults.rows);

    console.log("\n=== POSISI SAHAM AKHIR TRADER YANG TERJADI PERUBAHAN (TER-MATCH & SETTLED) ===");
    if (stockResults.rows.length === 0) {
      console.log("(Tidak ada saham yang berubah. Mungkin tidak ada transaksi yang ter-match karena rentang harga yang kurang cocok atau tidak ada order silang)");
    } else {
      console.table(stockResults.rows);
    }

    // Tampilkan statistik order dari database
    const orderStats = await db.execute(
      `SELECT status, count(*) as count 
       FROM orders 
       WHERE broker_account_id IN (
         SELECT id FROM broker_accounts WHERE user_id IN (${traderIds.map((id) => `'${id}'`).join(",")})
       )
       GROUP BY status`
    );
    console.log("\n=== STATISTIK STATUS ORDER TRADER DI DATABASE ===");
    console.table(orderStats.rows);

  } catch (err: any) {
    console.error("Gagal melakukan verifikasi database:", err.message);
  }

  console.log("\n======================================================================");
  console.log("🏁 MULTI-USER END-TO-END TRADING FLOW TEST SELESAI DENGAN SUKSES! 🏁");
  console.log("======================================================================");
}

runE2ETest().catch((err) => {
  console.error("Terjadi error saat menjalankan pengujian E2E:", err);
  process.exit(1);
});
