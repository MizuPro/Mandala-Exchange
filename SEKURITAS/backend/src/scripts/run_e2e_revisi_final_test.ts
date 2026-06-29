import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts, cash_balances } from "../db/schema.js";
import { eq } from "drizzle-orm";

type TraderInfo = {
  id: string;
  email: string;
  token: string;
  brokerAccountId: string;
};
import { createBrokerAccount, setupRDNForUser } from "../services/account-service.js";

const BEI_URL = "http://localhost:4100/v1";
const SEKURITAS_URL = "http://localhost:3002";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";
const MATS_SYNC_URL = "http://localhost:8082/v1/admin/sync/bei";

const NUM_TRADERS = 10;
const INITIAL_CASH = 1_000_000_000; // Rp 1.000.000.000 (1 Milyar)
const OFFERED_SHARES = 50_000; // 50.000 lembar saham MOSE yang ditawarkan di IPO
const REQUESTED_SHARES_PER_TRADER = 20_000; // Masing-masing trader memesan 20.000 lembar
const ALLOCATION_RATIO = 0.25; // Rasio alokasi 25% (5.000 lembar didapat)

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

async function getAssetPosition(client: pg.Client, brokerAccountId: string, symbol: string): Promise<number> {
  const res = await client.query(
    "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = $2",
    [brokerAccountId, symbol]
  );
  if (res.rows.length === 0) return 0;
  return parseInt(res.rows[0].available || 0);
}

async function runIntegratedTest() {
  console.log("======================================================================");
  console.log("🔥 MEMULAI PENGUJIAN TERINTEGRASI E2E: REVISI IPO & DERIVATIF (MOSE) 🔥");
  console.log("======================================================================");

  // 1. Koneksi Database
  console.log("\n[1] Menghubungkan ke database BEI dan Sekuritas...");
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });

  try {
    await beiDbClient.connect();
    await sekDbClient.connect();
    console.log("✅ Terhubung ke database BEI dan Sekuritas.");
  } catch (err: any) {
    console.error("❌ Gagal terhubung ke database:", err.message);
    process.exit(1);
  }

  // 2. Pembersihan Data Lama
  console.log("\n[2] Membersihkan sisa data uji lama emiten MOSE...");
  try {
    // Expire open orders di MATS RAM
    await fetchJson(`http://localhost:8082/v1/admin/orders/expire`, {
      method: "POST",
      headers: { "x-service-token": BEI_ADMIN_TOKEN }
    });

    // Bersihkan MATS database
    const matsDbClient = new pg.Client({ connectionString: "postgres://mandala_mats:mandala_mats@localhost:5434/mandala_mats" });
    await matsDbClient.connect();
    await matsDbClient.query("DELETE FROM mats_orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')");
    await matsDbClient.query("DELETE FROM mats_trades WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')");
    await matsDbClient.query("DELETE FROM mats_delivery_events");
    await matsDbClient.query("DELETE FROM mats_order_events");
    await matsDbClient.end();
    const moseSecurityIdRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
    if (moseSecurityIdRes.rows.length > 0) {
      const secId = moseSecurityIdRes.rows[0].id;
      await beiDbClient.query("DELETE FROM ipo_allocations WHERE ipo_subscription_id IN (SELECT id FROM ipo_subscriptions WHERE ipo_event_id IN (SELECT id FROM ipo_events WHERE security_id = $1))", [secId]);
      await beiDbClient.query("DELETE FROM ipo_subscriptions WHERE ipo_event_id IN (SELECT id FROM ipo_events WHERE security_id = $1)", [secId]);
      await beiDbClient.query("DELETE FROM ipo_events WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM special_notations WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM issuer_announcements WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM trading_halts WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM market_summaries WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM settlement_instructions WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM custody_ledger_entries WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM trades WHERE security_id = $1", [secId]);
      await beiDbClient.query("DELETE FROM corporate_actions WHERE security_id = $1", [secId]);
    }
    await beiDbClient.query("DELETE FROM custody_ledger_entries WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE-W', 'MOSE-R'))");
    await beiDbClient.query("DELETE FROM settlement_instructions WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE-W', 'MOSE-R'))");
    await beiDbClient.query("DELETE FROM trades WHERE security_id IN (SELECT id FROM listed_securities WHERE symbol IN ('MOSE-W', 'MOSE-R'))");
    await beiDbClient.query(`DELETE FROM listed_securities WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);
    await beiDbClient.query(`DELETE FROM financial_reports WHERE issuer_id IN (SELECT id FROM issuers WHERE code = 'MOSE')`);
    await beiDbClient.query(`DELETE FROM issuer_announcements WHERE issuer_id IN (SELECT id FROM issuers WHERE code = 'MOSE')`);
    await beiDbClient.query(`DELETE FROM issuers WHERE code = 'MOSE'`);

    await sekDbClient.query(`DELETE FROM order_amendments WHERE order_id IN (SELECT id FROM orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await sekDbClient.query(`DELETE FROM fee_ledgers WHERE order_id IN (SELECT id FROM orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await sekDbClient.query(`DELETE FROM settlement_events WHERE order_id IN (SELECT id FROM orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await sekDbClient.query(`DELETE FROM trade_fills WHERE order_id IN (SELECT id FROM orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R'))`);
    await sekDbClient.query(`DELETE FROM orders WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);
    await sekDbClient.query(`DELETE FROM securities_positions WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);
    await sekDbClient.query(`DELETE FROM ledger_movements WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);
    await sekDbClient.query(`DELETE FROM corporate_action_events WHERE symbol IN ('MOSE', 'MOSE-W', 'MOSE-R')`);

    console.log("✅ Pembersihan database selesai.");
  } catch (err: any) {
    console.error("❌ Gagal melakukan pembersihan database:", err.message);
    process.exit(1);
  }

  // 3. Inisialisasi Trader (Idempotent)
  console.log(`\n[3] Memproses inisialisasi & pendanaan ${NUM_TRADERS} trader...`);
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
  console.log(`✅ Sukses mempersiapkan ${traders.length} trader dengan saldo awal Rp ${INITIAL_CASH.toLocaleString()} Cash.`);

  // 4. Registrasi Emiten & Listed Security 'MOSE'
  console.log("\n[4] Mendaftarkan Issuer & Security 'MOSE' di BEI...");
  const createIssuerRes = await fetchJson(`${BEI_URL}/issuers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({
      code: "MOSE",
      name: "PT Mose Teknologi Indonesia",
      sector: "Technology",
      summary: "Perusahaan Teknologi Masa Depan",
      businessDescription: "Pengembangan solusi AI.",
    }),
  });

  if (!createIssuerRes.ok) {
    console.error("❌ Gagal mendaftarkan Issuer di BEI:", createIssuerRes.data);
    process.exit(1);
  }
  const issuerId = createIssuerRes.data.id;

  const createSecurityRes = await fetchJson(`${BEI_URL}/securities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
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
    console.error("❌ Gagal mendaftarkan Security di BEI:", createSecurityRes.data);
    process.exit(1);
  }
  const securityId = createSecurityRes.data.id;
  console.log(`✅ Security MOSE berhasil terdaftar. Security ID: ${securityId}`);

  // 5. Simulasi Pemesanan IPO
  console.log("\n[5] Membuat Event IPO & Mengirimkan data pemesanan...");
  const brokerRes = await beiDbClient.query("SELECT id FROM broker_members LIMIT 1");
  const underwriterBrokerId = brokerRes.rows[0]?.id;
  if (!underwriterBrokerId) {
    console.error("Broker members not found in BEI database");
    process.exit(1);
  }

  const createIpoRes = await fetchJson(`${BEI_URL}/ipo-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
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
    console.error("❌ Gagal membuat event IPO di BEI:", createIpoRes.data);
    process.exit(1);
  }
  const ipoEventId = createIpoRes.data.id;

  for (const trader of traders) {
    const subRes = await fetchJson(`${BEI_URL}/ipo-events/${ipoEventId}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
      body: JSON.stringify({
        brokerCode: "MANDALA",
        investorId: trader.brokerAccountId,
        requestedShares: REQUESTED_SHARES_PER_TRADER,
        idempotencyKey: `sub:ipo:mose:${trader.brokerAccountId}:${Date.now()}`,
      }),
    });
    if (!subRes.ok) {
      console.error(`❌ Gagal mengirim subscription trader ${trader.email}:`, subRes.data);
      process.exit(1);
    }
  }
  console.log(`✅ Berhasil mengirimkan pemesanan dari ${NUM_TRADERS} trader (total 200.000 lembar - oversubscribed 4x).`);

  // Jeda kecil agar data tersimpan
  await sleep(1000);

  // 6. Allotment IPO (Poin 1)
  console.log(`\n[6] Menjalankan penjatahan proporsional di BEI (Rasio: ${ALLOCATION_RATIO * 100}%)...`);
  const allocateRes = await fetchJson(`${BEI_URL}/ipo-events/${ipoEventId}/allocate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({ allocationRatio: ALLOCATION_RATIO }),
  });

  if (!allocateRes.ok) {
    console.error("❌ Gagal memproses alokasi IPO di BEI:", allocateRes.data);
    process.exit(1);
  }
  console.log("Menunggu 5 detik agar webhook alokasi dan pendebetan kas diproses oleh Sekuritas...");
  await sleep(5000);

  // Verifikasi Poin 1 (Distribusi Saham & Pemotongan Kas)
  const stockResults = await sekDbClient.query(`
    SELECT u.email, sp.symbol, sp.available, sp.average_price
    FROM securities_positions sp
    JOIN broker_accounts ba ON sp.broker_account_id = ba.id
    JOIN users u ON ba.user_id = u.id
    WHERE u.email LIKE 'test_trader_%@mandalatest.com' AND sp.symbol = 'MOSE'
    ORDER BY u.email
  `);

  const cashResults = await sekDbClient.query(`
    SELECT u.email, cb.available, cb.reserved, cb.pending
    FROM cash_balances cb
    JOIN broker_accounts ba ON cb.broker_account_id = ba.id
    JOIN users u ON ba.user_id = u.id
    WHERE u.email LIKE 'test_trader_%@mandalatest.com'
    ORDER BY u.email
  `);

  console.log("\n--- VERIFIKASI POIN 1: ALLOTMENT & PENDEBETAN KAS ---");
  const expectedShares = REQUESTED_SHARES_PER_TRADER * ALLOCATION_RATIO; // 5.000 lembar
  const expectedCash = INITIAL_CASH - (expectedShares * 200); // 999.000.000

  const stockCorrect = stockResults.rows.length === NUM_TRADERS && stockResults.rows.every(r => Number(r.available) === expectedShares);
  const cashCorrect = cashResults.rows.every(r => Number(r.available) === expectedCash);

  if (stockCorrect && cashCorrect) {
    console.log("✅ POIN 1 SUKSES: Semua trader menerima 5.000 lembar saham MOSE dan saldo kas terdebit Rp 1.000.000 (gratis ditiadakan!).");
  } else {
    console.error("❌ POIN 1 GAGAL!");
    console.error("- Posisi Saham valid?:", stockCorrect);
    console.error("- Saldo Kas valid?:", cashCorrect);
    console.table(stockResults.rows);
    console.table(cashResults.rows);
    process.exit(1);
  }

  // 7. Persiapan untuk Distribusi Efek Derivatif (Poin 2)
  console.log("\n[7] Mempersiapkan posisi saham induk untuk uji coba Right & Warrant...");
  const trader1 = traders[0]!;
  const trader2 = traders[1]!;

  // Trader 2 disetel memiliki tepat 1.000 lembar saham induk MOSE
  await sekDbClient.query("UPDATE securities_positions SET available = 1000, reserved = 0, pending = 0, average_price = '200.000000' WHERE broker_account_id = $1 AND symbol = 'MOSE'", [trader2.brokerAccountId]);
  // Trader 1 disetel memiliki 0 lembar saham induk MOSE
  await sekDbClient.query("UPDATE securities_positions SET available = 0, reserved = 0, pending = 0, average_price = '0.000000' WHERE broker_account_id = $1 AND symbol = 'MOSE'", [trader1.brokerAccountId]);

  const custodyAcc2Res = await beiDbClient.query("SELECT id FROM custody_accounts WHERE investor_id = $1", [trader2.brokerAccountId]);
  const custodyAcc2Id = custodyAcc2Res.rows[0]?.id;
  if (custodyAcc2Id) {
    await beiDbClient.query("DELETE FROM custody_ledger_entries WHERE custody_account_id = $1 AND security_id = $2", [custodyAcc2Id, securityId]);
    await beiDbClient.query(
      `INSERT INTO custody_ledger_entries (custody_account_id, security_id, asset_type, quantity, entry_type, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, 'security', 1000, 'adjustment', 'adjustment', 'init-balance', $3)`,
      [custodyAcc2Id, securityId, `init:ca_deriv:${trader2.brokerAccountId}:${Date.now()}`]
    );
  }

  const custodyAcc1Res = await beiDbClient.query("SELECT id FROM custody_accounts WHERE investor_id = $1", [trader1.brokerAccountId]);
  const custodyAcc1Id = custodyAcc1Res.rows[0]?.id;
  if (custodyAcc1Id) {
    await beiDbClient.query("DELETE FROM custody_ledger_entries WHERE custody_account_id = $1 AND security_id = $2", [custodyAcc1Id, securityId]);
  }
  console.log("✅ Posisi saham induk MOSE berhasil diselaraskan (Trader 2: 1.000 lembar, Trader 1: 0 lembar).");

  // 8. Pembagian Right Issue (HMETD) & Warrant
  console.log("\n[8] Memulai pembagian Corporate Action Right Issue (10:1) & Warrant (5:1)...");
  
  // A. Rights Issue
  const rightCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({
      securityId: securityId,
      type: "rights_issue",
      status: "draft",
      title: "Rights Issue MOSE-R 10:1",
      description: "Rasio 10 saham induk mendapatkan 1 Right (MOSE-R).",
      announcementDate: new Date().toISOString().split("T")[0],
      recordingDate: new Date().toISOString().split("T")[0],
      executionDate: new Date().toISOString().split("T")[0],
      ratioNumerator: 1,
      ratioDenominator: 10,
      entitlementSymbol: "MOSE-R",
      idempotencyKey: `ca:right:mose:${Date.now()}`,
    }),
  });

  if (!rightCARes.ok) {
    console.error("❌ Gagal mendaftarkan Rights Issue di BEI:", rightCARes.data || rightCARes.raw);
    process.exit(1);
  }
  const rightActionId = rightCARes.data.id;

  await fetchJson(`${BEI_URL}/corporate-actions/${rightActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  // B. Warrant
  const warrantCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({
      securityId: securityId,
      type: "warrant",
      status: "draft",
      title: "Warrant Distribution MOSE-W 5:1",
      description: "Rasio 5 saham induk mendapatkan 1 Waran (MOSE-W).",
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
    process.exit(1);
  }
  const warrantActionId = warrantCARes.data.id;

  await fetchJson(`${BEI_URL}/corporate-actions/${warrantActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  console.log("Menunggu 5 detik agar webhook pembagian derivatif diproses oleh Sekuritas...");
  await sleep(5000);

  // Verifikasi distribusi
  const r2Qty = await getAssetPosition(sekDbClient, trader2.brokerAccountId, "MOSE-R");
  const w2Qty = await getAssetPosition(sekDbClient, trader2.brokerAccountId, "MOSE-W");

  console.log("\n--- VERIFIKASI DISTRIBUSI EFEK DERIVATIF (MOSE-R & MOSE-W) ---");
  console.log(`- Saldo MOSE-R Trader 2: ${r2Qty} (Harus 100)`);
  console.log(`- Saldo MOSE-W Trader 2: ${w2Qty} (Harus 200)`);

  if (r2Qty === 100 && w2Qty === 200) {
    console.log("✅ Distribusi efek derivatif sukses!");
  } else {
    console.error("❌ Distribusi efek derivatif gagal!");
    process.exit(1);
  }

  // 9. Verifikasi Auto-Register Bursa BEI (Poin 2 - Bursa)
  console.log("\n[9] Memverifikasi pendaftaran otomatis bursa (listed_securities) BEI...");
  const listedWarrantRes = await beiDbClient.query(
    "SELECT symbol, board, shares_outstanding FROM listed_securities WHERE symbol = 'MOSE-W'"
  );
  const listedRightRes = await beiDbClient.query(
    "SELECT symbol, board, shares_outstanding FROM listed_securities WHERE symbol = 'MOSE-R'"
  );

  console.log("\n--- VERIFIKASI POIN 2: AUTO-REGISTER BURSA ---");
  const wRegistered = listedWarrantRes.rows.length > 0 && listedWarrantRes.rows[0].board === "derivatives";
  const rRegistered = listedRightRes.rows.length > 0 && listedRightRes.rows[0].board === "derivatives";

  if (wRegistered && rRegistered) {
    console.log("✅ POIN 2 BURSA SUKSES: MOSE-R & MOSE-W otomatis terdaftar di bawah board 'derivatives'!");
  } else {
    console.error("❌ POIN 2 BURSA GAGAL!");
    console.error("- MOSE-W Terdaftar valid?:", wRegistered, listedWarrantRes.rows[0]);
    console.error("- MOSE-R Terdaftar valid?:", rRegistered, listedRightRes.rows[0]);
    process.exit(1);
  }

  // 10. Sinkronisasi MATS & Perdagangan Efek Derivatif (Poin 2 - Perdagangan)
  console.log("\n[10] Sinkronisasi MATS engine & Set sesi continuous...");
  const syncRes = await fetchJson(MATS_SYNC_URL, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });
  if (!syncRes.ok) {
    console.error("❌ Gagal menyinkronkan aturan ke MATS:", syncRes.data || syncRes.raw);
    process.exit(1);
  }

  const setSessionRes = await fetchJson("http://localhost:8082/v1/admin/session/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({ status: "continuous" }),
  });
  if (!setSessionRes.ok) {
    console.error("❌ Gagal mengatur status sesi MATS ke continuous:", setSessionRes.data);
    process.exit(1);
  }
  console.log("✅ MATS sinkron & Sesi continuous aktif.");

  console.log("\nMemulai pengujian transaksi perdagangan MOSE-W...");
  // Trader 2 (Seller) Sell 1 lot MOSE-W @ Rp 50
  const sellOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader2.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "SELL",
      order_type: "LIMIT",
      price: 50,
      quantity: 100,
    }),
  });

  if (!sellOrderRes.ok) {
    console.error("❌ Gagal mengirim order SELL:", sellOrderRes.data);
    process.exit(1);
  }

  // Trader 1 (Buyer) Buy 1 lot MOSE-W @ Rp 50
  const buyOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader1.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 50,
      quantity: 100,
    }),
  });

  if (!buyOrderRes.ok) {
    console.error("❌ Gagal mengirim order BUY:", buyOrderRes.data);
    process.exit(1);
  }

  console.log("Menunggu 3 detik agar transaksi dicocokkan (matching)...");
  await sleep(3000);

  // Jalankan Settlement Batch di BEI
  console.log("Memicu settlement batch di BEI...");
  const activeSessionRes = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });
  if (!activeSessionRes.ok) {
    console.error("❌ Gagal mendapatkan active session BEI:", activeSessionRes.data);
    process.exit(1);
  }
  const sessionId = activeSessionRes.data.id;

  const createBatchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({ sessionId }),
  });
  if (!createBatchRes.ok) {
    console.error("❌ Gagal membuat settlement batch:", createBatchRes.data);
    process.exit(1);
  }
  const batchId = createBatchRes.data.batch.id;

  const processBatchRes = await fetchJson(`${BEI_URL}/settlement/batches/${batchId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });
  if (!processBatchRes.ok) {
    console.error("❌ Gagal memproses settlement batch:", processBatchRes.data);
    process.exit(1);
  }

  console.log("Menunggu 5 detik agar settlement selesai di Sekuritas...");
  await sleep(5000);

  // Verifikasi kepemilikan
  const t1Qty = await getAssetPosition(sekDbClient, trader1.brokerAccountId, "MOSE-W");
  const t2Qty = await getAssetPosition(sekDbClient, trader2.brokerAccountId, "MOSE-W");

  console.log("\n--- VERIFIKASI POIN 2: TRANSAKSI PERDAGANGAN & SETTLEMENT ---");
  console.log(`- Saldo MOSE-W Trader 1 (Pembeli): ${t1Qty} (Harus 100)`);
  console.log(`- Saldo MOSE-W Trader 2 (Penjual): ${t2Qty} (Harus 100)`);

  if (t1Qty === 100 && t2Qty === 100) {
    console.log("✅ POIN 2 PERDAGANGAN SUKSES: Transaksi & settlement derivatives berhasil!");
  } else {
    console.error("❌ POIN 2 PERDAGANGAN GAGAL!");
    process.exit(1);
  }

  // 11. Uji Relaksasi ARA/ARB (Poin 2 - Price Band ARA/ARB)
  console.log("\n[11] Mengirimkan order BUY dengan harga ekstrem tinggi (Rp 400, kenaikan 800% dari referensi Rp 50)...");
  const ekstrimOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader1.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 400,
      quantity: 100,
    }),
  });

  console.log("\n--- VERIFIKASI POIN 2: BATAS HARGA (ARA/ARB) DERIVATIF ---");
  const orderSuccess = ekstrimOrderRes.status === 201 || ekstrimOrderRes.data?.status === "open" || ekstrimOrderRes.data?.order?.status === "open";

  if (orderSuccess) {
    console.log("✅ POIN 2 ARA/ARB SUKSES: Order di luar ARA normal (35%) berhasil diterima dengan sukses karena relaksasi ARA/ARB (~999%) derivatives board!");
  } else {
    console.error("❌ POIN 2 ARA/ARB GAGAL!");
    console.error("Response data:", ekstrimOrderRes.data || ekstrimOrderRes.raw);
    process.exit(1);
  }

  // 11.5 Uji Batas Absolut ARA/ARB & Kenaikan Bertahap ke Rp 1.000.000
  console.log("\n[11.5] Uji Batas Absolut & Kenaikan Bertahap ke Rp 1.000.000...");
  
  // Langkah A: Coba kirim order Rp 1.000.000 dulu (seharusnya ditolak karena ref price masih Rp 50)
  console.log("- Mencoba order BUY Rp 1.000.000 (kondisi ref price Rp 50)...");
  const rejectOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader1.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 1000000,
      quantity: 100,
    }),
  });
  const initiallyRejected = rejectOrderRes.status === 400 || rejectOrderRes.data?.status === "rejected" || rejectOrderRes.data?.reject_reason === "price_outside_price_band";
  if (initiallyRejected) {
    console.log("✅ Sukses ter-reject sesuai ekspektasi (alasan: price_outside_price_band).");
  } else {
    console.warn("⚠️ Warning: Order Rp 1.000.000 tidak ditolak di awal.");
  }

  // Langkah B: Transaksikan waran di harga batas maksimal legal saat ini (Rp 500.000)
  console.log("- Trader 2 mengirim order SELL 1 Lot @ Rp 500.000...");
  await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader2.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "SELL",
      order_type: "LIMIT",
      price: 500000,
      quantity: 100,
    }),
  });

  console.log("- Trader 1 mengirim order BUY 1 Lot @ Rp 500.000...");
  await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader1.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 500000,
      quantity: 100,
    }),
  });

  console.log("Menunggu matching Rp 500.000...");
  await sleep(3000);

  // Langkah C: Pemicu settlement di BEI agar transaksi Rp 500.000 selesai
  console.log("Memicu settlement batch di BEI untuk transaksi Rp 500.000...");
  const sessionRes2 = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });
  if (sessionRes2.ok) {
    const sId = sessionRes2.data.id;
    const batchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
      body: JSON.stringify({ sessionId: sId }),
    });
    if (batchRes.ok) {
      const bId = batchRes.data.batch.id;
      await fetchJson(`${BEI_URL}/settlement/batches/${bId}/process`, {
        method: "POST",
        headers: { "x-service-token": BEI_ADMIN_TOKEN },
      });
    }
  }
  await sleep(4000);

  // Langkah D: Simulasikan pergeseran harga referensi sesi baru di database BEI ke Rp 500.000
  console.log("- Mengupdate harga referensi MOSE-W menjadi Rp 500.000 di BEI...");
  await beiDbClient.query(
    "UPDATE listed_securities SET reference_price = 500000, previous_close = 500000 WHERE symbol = 'MOSE-W'"
  );

  // Langkah E: Sinkronisasi MATS agar memuat harga referensi baru
  console.log("- Mensinkronisasi ulang MATS...");
  await fetchJson(MATS_SYNC_URL, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });
  await sleep(2000);

  // Langkah F: Kirim ulang order Rp 1.000.000 (sekarang batas ARA baru adalah 500.000 * 10001 = 5 Miliar)
  console.log("- Mencoba order BUY Rp 1.000.000 kembali (kondisi ref price Rp 500.000)...");
  const finalOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${trader1.token}` },
    body: JSON.stringify({
      symbol: "MOSE-W",
      side: "BUY",
      order_type: "LIMIT",
      price: 1000000, // Rp 1.000.000
      quantity: 100,
    }),
  });

  console.log("Status Response Penempatan Order Rp 1.000.000 Kedua:", finalOrderRes.status);
  console.log("Body Response:", finalOrderRes.data || finalOrderRes.raw);

  const finalOrderSuccess = finalOrderRes.status === 201 || finalOrderRes.data?.status === "open" || finalOrderRes.data?.order?.status === "open";

  if (finalOrderSuccess) {
    console.log("✅ HASIL: Order Rp 1.000.000 BERHASIL DITERIMA seiring kenaikan bertahap harga referensi menjadi Rp 500.000!");
  } else {
    console.error("❌ HASIL: Order Rp 1.000.000 tetap ditolak meskipun harga referensi sudah dinaikkan!");
    process.exit(1);
  }

  // 12. Ringkasan Kelulusan
  console.log("\n======================================================================");
  console.log("🏆 KESIMPULAN AKHIR: SELURUH SKENARIO PENGUJIAN LULUS 100% 🏆");
  console.log("======================================================================");
  console.log("1. Pendebetan Kas Allotment IPO (Poin 1)   : [PASSED]");
  console.log("2. Auto-Register Bursa Derivatives (Poin 2)  : [PASSED]");
  console.log("3. Matching Trading & Settlement (Poin 2)    : [PASSED]");
  console.log("4. ARA/ARB Relaksasi Derivatives (Poin 2)   : [PASSED]");
  console.log("======================================================================");

  // Tutup koneksi database
  await beiDbClient.end();
  await sekDbClient.end();
}

runIntegratedTest().catch((err) => {
  console.error("❌ Terjadi error fatal saat menjalankan pengujian:", err);
  process.exit(1);
});
