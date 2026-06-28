import pg from "pg";

const BEI_URL = "http://localhost:4100/v1";
const BEI_ADMIN_TOKEN = "local-admin-service-token-2026-change-me";
const DIVIDEND_PER_SHARE = 50; // Pembagian dividen Rp 50 per lembar saham MOSE
const EXPECTED_DIVIDEND_GAIN = 5000 * DIVIDEND_PER_SHARE; // 5.000 lembar * Rp 50 = Rp 250.000

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

interface CashBalanceInfo {
  email: string;
  available: string;
  reserved: string;
  pending: string;
}

async function runDividendTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN DIVIDEN TUNAI E2E (EMITEN MOSE) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas dan BEI
  console.log("\n[1] Menghubungkan ke database Sekuritas dan BEI...");
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  try {
    await sekDbClient.connect();
    await beiDbClient.connect();
  } catch (err: any) {
    console.error("Gagal menghubungkan ke database:", err.message);
    process.exit(1);
  }

  // 2. Ambil data cash awal trader di Sekuritas
  console.log("\n[2] Mengambil saldo cash awal trader dari database Sekuritas...");
  let initialCashBalances: CashBalanceInfo[] = [];
  try {
    const res = await sekDbClient.query(`
      SELECT u.email, cb.available, cb.reserved, cb.pending
      FROM cash_balances cb
      JOIN broker_accounts ba ON cb.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE u.email LIKE 'test_trader_%@mandalatest.com'
      ORDER BY u.email
    `);
    initialCashBalances = res.rows;
    console.table(initialCashBalances);
  } catch (err: any) {
    console.error("Gagal mengambil cash balance awal:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // 3. Cek kepemilikan saham MOSE di BEI (custody)
  console.log("\n[3] Memverifikasi kepemilikan saham MOSE trader di database BEI...");
  let moseSecurityId = "";
  try {
    // Ambil securityId untuk MOSE
    const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
    if (secRes.rows.length === 0) {
      console.error("❌ EROR: Emiten MOSE belum terdaftar di BEI. Jalankan pengujian IPO terlebih dahulu!");
      await sekDbClient.end();
      await beiDbClient.end();
      process.exit(1);
    }
    moseSecurityId = secRes.rows[0].id;
    console.log(`Emiten MOSE ditemukan. Security ID: ${moseSecurityId}`);

    // Tampilkan total kepemilikan
    const custodyRes = await beiDbClient.query(`
      SELECT ca.investor_id, ca.sid, ca.sre, SUM(cle.quantity) AS quantity
      FROM custody_ledger_entries cle
      JOIN custody_accounts ca ON ca.id = cle.custody_account_id
      WHERE cle.security_id = $1 AND cle.asset_type = 'security'
      GROUP BY ca.investor_id, ca.sid, ca.sre
      HAVING SUM(cle.quantity) > 0
    `, [moseSecurityId]);

    console.log("Catatan Kepemilikan Efek MOSE di BEI (Custody Ledger):");
    console.table(custodyRes.rows);

  } catch (err: any) {
    console.error("Gagal memeriksa kepemilikan saham di BEI:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // 4. Daftarkan Corporate Action Dividen di BEI
  console.log(`\n[4] Mendaftarkan Corporate Action dividen tunai Rp ${DIVIDEND_PER_SHARE}/lembar di BEI...`);
  const caRes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      securityId: moseSecurityId,
      type: "cash_dividend",
      status: "draft",
      title: "Dividen Tunai MOSE Buku 2026",
      description: `Pembagian dividen tunai emiten MOSE sebesar Rp ${DIVIDEND_PER_SHARE} per lembar saham.`,
      announcementDate: new Date().toISOString().split("T")[0],
      recordingDate: new Date().toISOString().split("T")[0],
      executionDate: new Date().toISOString().split("T")[0],
      cashAmountPerShare: DIVIDEND_PER_SHARE,
      idempotencyKey: `ca:div:mose:${Date.now()}`,
    }),
  });

  if (!caRes.ok) {
    console.error("Gagal mendaftarkan Corporate Action di BEI:", caRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const actionId = caRes.data.id;
  console.log(`Corporate Action berhasil dibuat. Action ID: ${actionId}`);

  // 5. Memicu eksekusi/proses pembagian Dividen di BEI
  console.log(`\n[5] Memicu eksekusi pemrosesan dividen tunai (Action ID: ${actionId})...`);
  const processRes = await fetchJson(`${BEI_URL}/corporate-actions/${actionId}/process`, {
    method: "POST",
    headers: {
      "x-service-token": BEI_ADMIN_TOKEN,
    },
  });

  if (!processRes.ok) {
    console.error("Gagal memproses eksekusi dividen di BEI:", processRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("Eksekusi pemrosesan dividen di BEI selesai. Webhook dikirim ke Sekuritas.");

  // 6. Tunggu Webhook mengalir
  console.log("\n[6] Menunggu 5 detik agar webhook dividen diproses penuh oleh Sekuritas...");
  await sleep(5000);

  // 7. Ambil data cash akhir dan verifikasi selisih saldo di Sekuritas
  console.log("\n[7] Menghubungkan ke database Sekuritas untuk verifikasi saldo cash akhir...");
  try {
    const res = await sekDbClient.query(`
      SELECT u.email, cb.available, cb.reserved, cb.pending
      FROM cash_balances cb
      JOIN broker_accounts ba ON cb.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE u.email LIKE 'test_trader_%@mandalatest.com'
      ORDER BY u.email
    `);
    const finalCashBalances: CashBalanceInfo[] = res.rows;

    console.log("\n=== PERBANDINGAN SALDO CASH SEBELUM & SESUDAH DIVIDEN ===");
    const comparisonTable = initialCashBalances.map((initial) => {
      const final = finalCashBalances.find((f) => f.email === initial.email)!;
      const initialVal = parseFloat(initial.available);
      const finalVal = parseFloat(final.available);
      const gain = finalVal - initialVal;

      return {
        Email: initial.email,
        "Cash Awal": initialVal.toLocaleString("id-ID", { minimumFractionDigits: 2 }),
        "Cash Akhir": finalVal.toLocaleString("id-ID", { minimumFractionDigits: 2 }),
        "Kenaikan (Gain)": gain.toLocaleString("id-ID", { minimumFractionDigits: 2 }),
        Status: Math.abs(gain - EXPECTED_DIVIDEND_GAIN) < 0.01 ? "✅ SUKSES (+250K)" : `❌ SALAH (Gain: ${gain})`,
      };
    });

    console.table(comparisonTable);

    const allPassed = comparisonTable.every((row) => row.Status.startsWith("✅"));
    if (allPassed) {
      console.log(`\n🎉 SELESAI: Seluruh trader testing berhasil menerima dividen tunai MOSE tepat Rp ${EXPECTED_DIVIDEND_GAIN.toLocaleString()}!`);
    } else {
      console.error("\n❌ EROR: Ada kesalahan nominal dividen tunai yang diterima trader.");
    }

  } catch (err: any) {
    console.error("Gagal melakukan verifikasi saldo kas akhir:", err.message);
  } finally {
    await sekDbClient.end();
    await beiDbClient.end();
  }

  console.log("\n======================================================================");
  console.log("🏁 PENGUJIAN DIVIDEN TUNAI SELESAI! 🏁");
  console.log("======================================================================");
}

runDividendTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian dividen:", err);
  process.exit(1);
});
