import pg from "pg";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

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

async function getAssetPosition(client: pg.Client, brokerAccountId: string, symbol: string): Promise<number> {
  const res = await client.query(
    "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = $2",
    [brokerAccountId, symbol]
  );
  if (res.rows.length === 0) return 0;
  return parseInt(res.rows[0].available || 0);
}

async function runRightsWarrantTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E DISTRIBUSI RIGHT & WARAN (MOSE) 🚀");
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

  // 2. Setup Trader 1
  console.log("\n[2] Mempersiapkan data Trader 1...");
  const email = "test_trader_1@mandalatest.com";
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.error(`❌ Trader ${email} tidak ditemukan.`);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const [brokerAccount] = await db
    .select()
    .from(broker_accounts)
    .where(eq(broker_accounts.user_id, user.id))
    .limit(1);

  if (!brokerAccount) {
    console.error(`❌ Broker Account untuk ${email} tidak ditemukan.`);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const brokerAccountId = brokerAccount.id;
  console.log(`✅ Trader 1 teridentifikasi. Account ID: ${brokerAccountId}`);

  // Dapatkan Security ID untuk MOSE di BEI
  const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
  if (secRes.rows.length === 0) {
    console.error("❌ Emiten MOSE belum terdaftar di BEI.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const moseSecurityId = secRes.rows[0].id;

  // 3. Pastikan Trader 1 memiliki tepat 1.000 lembar saham induk MOSE
  console.log("\n[3] Memverifikasi & menyetel kepemilikan saham induk MOSE ke tepat 1.000 lembar...");
  try {
    // Paksa 1.000 lembar di Sekuritas
    await sekDbClient.query(
      "UPDATE securities_positions SET available = 1000, reserved = 0, pending = 0, average_price = '200.000000', updated_at = NOW() WHERE broker_account_id = $1 AND symbol = 'MOSE'",
      [brokerAccountId]
    );

    // Dapatkan custody_account_id di BEI berdasarkan investor_id (brokerAccountId)
    const custodyAccRes = await beiDbClient.query(
      "SELECT id FROM custody_accounts WHERE investor_id = $1",
      [brokerAccountId]
    );
    const custodyAccId = custodyAccRes.rows[0]?.id;

    if (!custodyAccId) {
      throw new Error(`Custody Account di BEI tidak ditemukan untuk investor_id: ${brokerAccountId}`);
    }

    // Hapus entri MOSE lama di BEI agar tidak menumpuk
    await beiDbClient.query(
      "DELETE FROM custody_ledger_entries WHERE custody_account_id = $1 AND security_id = $2",
      [custodyAccId, moseSecurityId]
    );
    // Tambahkan saldo 1.000 lembar
    await beiDbClient.query(
      `INSERT INTO custody_ledger_entries (custody_account_id, security_id, asset_type, quantity, entry_type, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, 'security', 1000, 'adjustment', 'adjustment', 'init-balance', $3)`,
      [custodyAccId, moseSecurityId, `init:rights_test:${brokerAccountId}:${Date.now()}`]
    );
    console.log(`✅ Saham Induk MOSE: ${await getAssetPosition(sekDbClient, brokerAccountId, "MOSE")} lembar.`);
  } catch (err: any) {
    console.error("❌ Gagal menyetel posisi awal saham induk:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // 4. Bersihkan data Right & Waran lama milik trader agar steril
  try {
    await sekDbClient.query(
      "DELETE FROM securities_positions WHERE broker_account_id = $1 AND symbol IN ('MOSE-R', 'MOSE-W')",
      [brokerAccountId]
    );
  } catch (err: any) {
    console.warn("⚠️ Gagal mensterilkan posisi right/waran lama:", err.message);
  }

  // 5. Jalankan Pembagian Right Issue (HMETD) - Rasio 10:1
  console.log("\n[5] Mendaftarkan Corporate Action: Rights Issue (Rasio 10:1) di BEI...");
  const rightCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      securityId: moseSecurityId,
      type: "rights_issue",
      status: "draft",
      title: "Rights Issue MOSE-R 10:1",
      description: "Penerbitan hak memesan efek terlebih dahulu dengan rasio 10 saham induk mendapatkan 1 Right (MOSE-R).",
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
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const rightActionId = rightCARes.data.id;
  console.log(`✅ Rights Issue terdaftar. Action ID: ${rightActionId}`);

  console.log(`Memicu pemrosesan Rights Issue (Action ID: ${rightActionId})...`);
  const processRightRes = await fetchJson(`${BEI_URL}/corporate-actions/${rightActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processRightRes.ok) {
    console.error("❌ Gagal memproses Rights Issue di BEI:", processRightRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Webhook Rights Issue dikirim ke Sekuritas.");
  console.log("Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  const rightQty = await getAssetPosition(sekDbClient, brokerAccountId, "MOSE-R");
  console.log("\n=== VALIDASI DISTRIBUSI RIGHT (HMETD) ===");
  console.log(`Posisi MOSE-R di Portofolio: ${rightQty} lembar.`);
  if (rightQty === 100) {
    console.log("✅ SUKSES: Nasabah menerima tepat 100 lembar MOSE-R (10% dari 1.000 lembar).");
  } else {
    console.error(`❌ GAGAL: Jumlah MOSE-R salah! Terdeteksi: ${rightQty}`);
  }

  // 6. Jalankan Pembagian Waran (Warrant) - Rasio 5:1
  console.log("\n[6] Mendaftarkan Corporate Action: Warrant Distribution (Rasio 5:1) di BEI...");
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
  console.log(`✅ Warrant terdaftar. Action ID: ${warrantActionId}`);

  console.log(`Memicu pemrosesan Warrant (Action ID: ${warrantActionId})...`);
  const processWarrantRes = await fetchJson(`${BEI_URL}/corporate-actions/${warrantActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processWarrantRes.ok) {
    console.error("❌ Gagal memproses Warrant di BEI:", processWarrantRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Webhook Warrant dikirim ke Sekuritas.");
  console.log("Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  const warrantQty = await getAssetPosition(sekDbClient, brokerAccountId, "MOSE-W");
  console.log("\n=== VALIDASI DISTRIBUSI WARAN ===");
  console.log(`Posisi MOSE-W di Portofolio: ${warrantQty} lembar.`);
  if (warrantQty === 200) {
    console.log("✅ SUKSES: Nasabah menerima tepat 200 lembar MOSE-W (20% dari 1.000 lembar).");
  } else {
    console.error(`❌ GAGAL: Jumlah MOSE-W salah! Terdeteksi: ${warrantQty}`);
  }

  // 7. Ringkasan Akhir Portofolio
  console.log("\n======================================================================");
  console.log("📊 RINGKASAN PORTOFOLIO EFEK HASIL DISTRIBUSI RIGHT & WARAN 📊");
  console.log("======================================================================");
  console.table([
    {
      "Nama Aset": "Saham Induk (MOSE)",
      "Jumlah Kuantitas": await getAssetPosition(sekDbClient, brokerAccountId, "MOSE"),
      Status: "Aktif",
    },
    {
      "Nama Aset": "HMETD (MOSE-R)",
      "Jumlah Kuantitas": rightQty,
      Status: rightQty === 100 ? "✅ SUKSES (+100)" : "❌ ERROR",
    },
    {
      "Nama Aset": "Waran (MOSE-W)",
      "Jumlah Kuantitas": warrantQty,
      Status: warrantQty === 200 ? "✅ SUKSES (+200)" : "❌ ERROR",
    },
  ]);

  await sekDbClient.end();
  await beiDbClient.end();
  console.log("\n🏁 PENGUJIAN DISTRIBUSI RIGHT & WARAN SELESAI! 🏁");
  console.log("======================================================================");
}

runRightsWarrantTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian Rights & Warrant:", err);
  process.exit(1);
});
