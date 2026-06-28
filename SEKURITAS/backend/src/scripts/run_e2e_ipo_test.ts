import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts, cash_balances } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createBrokerAccount, setupRDNForUser } from "../services/account-service.js";

const BEI_URL = "http://localhost:4100/v1";
const SEKURITAS_URL = "http://localhost:3002";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";

const NUM_TRADERS = 10;
const INITIAL_CASH = 1_000_000_000; // Rp 1.000.000.000 (1 Milyar)
const OFFERED_SHARES = 50_000; // 50.000 lembar saham MOSE yang ditawarkan di IPO
const REQUESTED_SHARES_PER_TRADER = 20_000; // Masing-masing trader memesan 20.000 lembar (Total 200.000 lembar - oversubscribed 4x)
const ALLOCATION_RATIO = 0.25; // Rasio alokasi 25% (20.000 * 0.25 = 5.000 lembar yang didapat)

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

async function runIPOTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN IPO EMITEN BARU 'MOSE' & ALLOTMENT PROPORSIONAL 🚀");
  console.log("======================================================================");

  // 1. Koneksi Database dan Pembersihan Data Uji Lama (Idempotensi)
  console.log("\n[1] Menghubungkan ke database untuk pembersihan data uji lama...");
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });

  try {
    await beiDbClient.connect();
    await sekDbClient.connect();

    console.log("- Membersihkan data emiten MOSE di BEI database...");
    await beiDbClient.query(`DELETE FROM market_summaries WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM trading_halts WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM settlement_instructions WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM custody_ledger_entries WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM trades WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM corporate_actions WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM issuer_announcements WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM special_notations WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM ipo_allocations WHERE ipo_subscription_id IN (SELECT id FROM ipo_subscriptions WHERE ipo_event_id IN (SELECT id FROM ipo_events WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))))`);
    await beiDbClient.query(`DELETE FROM ipo_subscriptions WHERE ipo_event_id IN (SELECT id FROM ipo_events WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')))`);
    await beiDbClient.query(`DELETE FROM ipo_events WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await beiDbClient.query(`DELETE FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);
    await beiDbClient.query(`DELETE FROM financial_reports WHERE issuer_id IN (SELECT id FROM issuers WHERE code = 'MOSE')`);
    await beiDbClient.query(`DELETE FROM issuer_announcements WHERE issuer_id IN (SELECT id FROM issuers WHERE code = 'MOSE')`);
    await beiDbClient.query(`DELETE FROM issuers WHERE code = 'MOSE'`);

    console.log("- Membersihkan data portofolio MOSE di Sekuritas database...");
    await sekDbClient.query(`DELETE FROM securities_positions WHERE symbol = 'MOSE'`);
    await sekDbClient.query(`DELETE FROM ledger_movements WHERE symbol = 'MOSE'`);
    await sekDbClient.query(`DELETE FROM corporate_action_events WHERE symbol = 'MOSE'`);

    console.log("Pembersihan database selesai.");
  } catch (err: any) {
    console.error("Gagal melakukan pembersihan database:", err.message);
    process.exit(1);
  }

  // 2. Registrasi 10 Trader (atau pastikan sudah ada dan memiliki modal)
  console.log(`\n[2] Memproses inisialisasi & pendanaan ${NUM_TRADERS} trader...`);
  const traders: TraderInfo[] = [];
  const dummyPasswordHash = "scrypt$6223b1fd8dd6632a80d54f7ebc7f85dd$aa81ce30a559bdbde8a7c2f52844897103fe75ac4e48380a82ff3bf2a3f497194ace71b7a6d7d1f80999043eead88e29228de22589fc7ea4eac6bd8020610e7c"; // password: 'mik123456'

  for (let i = 1; i <= NUM_TRADERS; i++) {
    const email = `test_trader_${i}@mandalatest.com`;
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      [user] = await db.insert(users).values({
        email,
        password_hash: dummyPasswordHash,
        status: "verified",
      }).returning();
    }

    let [brokerAccount] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user.id)).limit(1);
    if (!brokerAccount) {
      const rdnData = await setupRDNForUser(email, "HUMAN");
      brokerAccount = await createBrokerAccount(user.id, rdnData, "HUMAN");
    }

    // Set available cash ke 1 Milyar Rupiah agar cukup membeli IPO
    await db.update(cash_balances)
      .set({ available: INITIAL_CASH.toFixed(6), reserved: "0.000000", pending: "0.000000", updated_at: new Date() })
      .where(eq(cash_balances.broker_account_id, brokerAccount.id));

    const token = signUserToken(user.id);
    traders.push({
      id: user.id,
      email,
      token,
      brokerAccountId: brokerAccount.id,
    });
  }
  console.log(`Sukses mempersiapkan ${traders.length} trader dengan saldo masing-masing Rp ${INITIAL_CASH.toLocaleString()} Cash.`);

  // 3. Registrasi Issuer MOSE di BEI
  console.log("\n[3] Mendaftarkan Issuer baru 'MOSE' di BEI...");
  const createIssuerRes = await fetchJson(`${BEI_URL}/issuers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      code: "MOSE",
      name: "PT Mose Teknologi Indonesia",
      sector: "Technology",
      summary: "Perusahaan Teknologi Masa Depan",
      businessDescription: "Pengembangan solusi AI dan komputasi awan terintegrasi.",
    }),
  });

  if (!createIssuerRes.ok) {
    console.error("Gagal mendaftarkan Issuer di BEI:", createIssuerRes.data);
    process.exit(1);
  }
  const issuerId = createIssuerRes.data.id;
  console.log(`Issuer MOSE berhasil terdaftar. Issuer ID: ${issuerId}`);

  // 4. Registrasi Security MOSE di BEI
  console.log("\n[4] Mendaftarkan listed security 'MOSE' di BEI...");
  const createSecurityRes = await fetchJson(`${BEI_URL}/securities`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      issuerId: issuerId,
      symbol: "MOSE",
      name: "PT Mose Teknologi Indonesia",
      board: "main",
      sector: "Technology",
      sharesOutstanding: 100_000_000,
      ipoPrice: 200,
      referencePrice: 200,
      previousClose: 200,
      status: "listed",
      marketMechanism: "regular",
    }),
  });

  if (!createSecurityRes.ok) {
    console.error("Gagal mendaftarkan Security di BEI:", createSecurityRes.data);
    process.exit(1);
  }
  const securityId = createSecurityRes.data.id;
  console.log(`Security MOSE berhasil terdaftar. Security ID: ${securityId}`);

  // 5. Membuat Event IPO baru di BEI
  console.log("\n[5] Membuat Event IPO baru untuk emiten MOSE di BEI...");
  const brokerRes = await beiDbClient.query("SELECT id FROM broker_members LIMIT 1");
  const underwriterBrokerId = brokerRes.rows[0]?.id;
  if (!underwriterBrokerId) {
    console.error("Broker members not found in BEI database");
    process.exit(1);
  }

  const createIpoRes = await fetchJson(`${BEI_URL}/ipo-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      issuerId: issuerId,
      securityId: securityId,
      offeredShares: OFFERED_SHARES,
      offeringPrice: 200,
      status: "subscription",
      underwriterBrokerId: underwriterBrokerId,
    }),
  });

  if (!createIpoRes.ok) {
    console.error("Gagal membuat event IPO di BEI:", createIpoRes.data);
    process.exit(1);
  }
  const ipoEventId = createIpoRes.data.id;
  console.log(`Event IPO MOSE berhasil dibuat. IPO Event ID: ${ipoEventId}`);

  // 6. Mengirimkan Pemesanan (Subscription) dari 10 Trader
  console.log("\n[6] Mengirimkan data pemesanan (subscription) dari 10 trader...");
  console.log(`- Masing-masing trader memesan ${REQUESTED_SHARES_PER_TRADER.toLocaleString()} lembar saham MOSE.`);
  console.log(`- Akumulasi total pemesanan: ${(NUM_TRADERS * REQUESTED_SHARES_PER_TRADER).toLocaleString()} lembar (Suplai ditawarkan: ${OFFERED_SHARES.toLocaleString()}).`);
  console.log(`- Status: Oversubscribed 400%`);

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]!;
    const subRes = await fetchJson(`${BEI_URL}/ipo-events/${ipoEventId}/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-token": BEI_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        brokerCode: "MANDALA",
        investorId: trader.brokerAccountId,
        requestedShares: REQUESTED_SHARES_PER_TRADER,
        idempotencyKey: `sub:ipo:mose:${trader.brokerAccountId}:${Date.now()}`,
      }),
    });

    if (!subRes.ok) {
      console.error(`- Gagal mengirim subscription trader ${trader.email}:`, subRes.data);
      process.exit(1);
    }
    console.log(`- Subscription trader ${trader.email}: ACCEPTED`);
  }

  // Jeda kecil agar data tersimpan di DB BEI
  await sleep(1000);

  // 7. Menjalankan Alokasi / Penjatahan Saham IPO
  console.log(`\n[7] Menjalankan penjatahan proporsional di BEI (Rasio: ${ALLOCATION_RATIO * 100}%)...`);
  const allocateRes = await fetchJson(`${BEI_URL}/ipo-events/${ipoEventId}/allocate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      allocationRatio: ALLOCATION_RATIO,
    }),
  });

  if (!allocateRes.ok) {
    console.error("Gagal memproses alokasi IPO di BEI:", allocateRes.data);
    process.exit(1);
  }
  console.log("Proses alokasi/allotment di BEI selesai. Daftar penjatahan dibuat.");

  // 8. Menunggu Webhook
  console.log("\n[8] Menunggu 5 detik agar webhook alokasi dikirim dari BEI dan diproses oleh Sekuritas...");
  await sleep(5000);

  // 9. Verifikasi Portofolio Akhir di Database Sekuritas
  console.log("\n[9] Menghubungkan ke database Sekuritas untuk verifikasi kepemilikan saham akhir...");
  try {
    // Ambil posisi saham MOSE terkini
    const stockResults = await sekDbClient.query(`
      SELECT u.email, sp.symbol, sp.available, sp.reserved, sp.pending, sp.average_price
      FROM securities_positions sp
      JOIN broker_accounts ba ON sp.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE u.email LIKE 'test_trader_%@mandalatest.com' AND sp.symbol = 'MOSE'
      ORDER BY u.email
    `);

    console.log("\n=== POSISI SAHAM MOSE HASIL ALOKASI IPO ===");
    if (stockResults.rows.length === 0) {
      console.log("❌ EROR: Tidak ada data posisi saham MOSE yang ditemukan di portofolio trader Sekuritas!");
    } else {
      console.table(stockResults.rows);
      
      const expectedShares = REQUESTED_SHARES_PER_TRADER * ALLOCATION_RATIO;
      const allCorrect = stockResults.rows.every((row) => Number(row.available) === expectedShares);
      if (allCorrect) {
        console.log(`\n✅ SUKSES: Semua trader menerima tepat ${expectedShares.toLocaleString()} lembar saham MOSE sesuai rasio alokasi proporsional 25%!`);
      } else {
        console.warn("\n⚠️ WARNING: Terjadi selisih jumlah distribusi saham pada portofolio trader.");
      }
    }

    // Ambil cash balance terkini untuk melihat dampak terhadap cash
    const cashResults = await sekDbClient.query(`
      SELECT u.email, cb.available, cb.reserved, cb.pending
      FROM cash_balances cb
      JOIN broker_accounts ba ON cb.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE u.email LIKE 'test_trader_%@mandalatest.com'
      ORDER BY u.email
    `);

    console.log("\n=== SALDO CASH AKHIR TRADER ===");
    console.table(cashResults.rows);

    const expectedCash = INITIAL_CASH - (REQUESTED_SHARES_PER_TRADER * ALLOCATION_RATIO * 200); // 1.000.000.000 - 5.000 * 200 = Rp 999.000.000
    const cashCorrect = cashResults.rows.every((row) => Number(row.available) === expectedCash);
    if (cashCorrect) {
      console.log(`\n✅ SUKSES: Semua trader mengalami pendebetan saldo kas tepat sebesar Rp ${(INITIAL_CASH - expectedCash).toLocaleString()} (sisa: Rp ${expectedCash.toLocaleString()}) untuk pembayaran alokasi saham IPO!`);
    } else {
      console.error("\n❌ EROR: Saldo kas akhir trader salah! Tidak didebit secara benar.");
    }

  } catch (err: any) {
    console.error("Gagal melakukan verifikasi database Sekuritas:", err.message);
  } finally {
    // Tutup koneksi client pg
    await beiDbClient.end();
    await sekDbClient.end();
  }

  console.log("\n======================================================================");
  console.log("🏁 PENGUJIAN IPO EMITEN BARU 'MOSE' SELESAI! 🏁");
  console.log("======================================================================");
}

runIPOTest().catch((err) => {
  console.error("Terjadi error fatal saat menjalankan pengujian IPO E2E:", err);
  process.exit(1);
});
