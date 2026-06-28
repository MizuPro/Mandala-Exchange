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

interface PositionInfo {
  available: number;
  reserved: number;
  pending: number;
  average_price: string;
}

async function getMosePosition(client: pg.Client, brokerAccountId: string): Promise<PositionInfo> {
  const res = await client.query(
    "SELECT available, reserved, pending, average_price FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE'",
    [brokerAccountId]
  );
  if (res.rows.length === 0) {
    return { available: 0, reserved: 0, pending: 0, average_price: "0" };
  }
  return {
    available: parseInt(res.rows[0].available || 0),
    reserved: parseInt(res.rows[0].reserved || 0),
    pending: parseInt(res.rows[0].pending || 0),
    average_price: res.rows[0].average_price || "0",
  };
}

async function runStockSplitTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E STOCK SPLIT & REVERSE SPLIT (MOSE) 🚀");
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

  // 3. Suntikkan posisi saham awal: 1.000 lembar MOSE @ Rp 200
  console.log("\n[3] Menyuntikkan posisi saham awal: 1.000 lembar MOSE @ Rp 200...");
  try {
    // Cari apakah posisi sudah ada
    const posRes = await sekDbClient.query(
      "SELECT id FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE'",
      [brokerAccountId]
    );

    if (posRes.rows.length > 0) {
      await sekDbClient.query(
        "UPDATE securities_positions SET available = 1000, reserved = 0, pending = 0, average_price = '200.000000', updated_at = NOW() WHERE broker_account_id = $1 AND symbol = 'MOSE'",
        [brokerAccountId]
      );
    } else {
      await sekDbClient.query(
        `INSERT INTO securities_positions (broker_account_id, symbol, available, reserved, pending, average_price, realized_pl, unrealized_pl)
         VALUES ($1, 'MOSE', 1000, 0, 0, '200.000000', 0, 0)`,
        [brokerAccountId]
      );
    }

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
      [custodyAccId, moseSecurityId, `init:split_test:${brokerAccountId}:${Date.now()}`]
    );

    console.log("✅ Berhasil menginisialisasi saldo awal.");
  } catch (err: any) {
    console.error("❌ Gagal inisialisasi saldo awal:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // Ambil data posisi awal
  const posInitial = await getMosePosition(sekDbClient, brokerAccountId);
  console.log("\nPosisi Awal:");
  console.table([{
    Symbol: "MOSE",
    Available: posInitial.available,
    "Avg Price": parseFloat(posInitial.average_price).toLocaleString("id-ID"),
    "Total Value": (posInitial.available * parseFloat(posInitial.average_price)).toLocaleString("id-ID"),
  }]);

  // 4. Jalankan Stock Split 1:5
  console.log("\n[4] Mendaftarkan Corporate Action: Stock Split (1:5) di BEI...");
  const splitCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      securityId: moseSecurityId,
      type: "stock_split",
      status: "draft",
      title: "Stock Split MOSE 1:5",
      description: "Pemecahan nilai nominal saham MOSE dengan rasio 1 banding 5.",
      announcementDate: new Date().toISOString().split("T")[0],
      recordingDate: new Date().toISOString().split("T")[0],
      executionDate: new Date().toISOString().split("T")[0],
      ratioNumerator: 5,
      ratioDenominator: 1,
      idempotencyKey: `ca:split:mose:${Date.now()}`,
    }),
  });

  if (!splitCARes.ok) {
    console.error("❌ Gagal mendaftarkan Stock Split di BEI:", splitCARes.data || splitCARes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const splitActionId = splitCARes.data.id;
  console.log(`✅ Stock Split terdaftar. Action ID: ${splitActionId}`);

  console.log(`Memicu pemrosesan Stock Split (Action ID: ${splitActionId})...`);
  const processSplitRes = await fetchJson(`${BEI_URL}/corporate-actions/${splitActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processSplitRes.ok) {
    console.error("❌ Gagal memproses Stock Split di BEI:", processSplitRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Webhook Stock Split dikirim ke Sekuritas.");
  console.log("Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  const posSplit = await getMosePosition(sekDbClient, brokerAccountId);
  console.log("\nPosisi Setelah Stock Split (1:5):");
  console.table([{
    Symbol: "MOSE",
    Available: posSplit.available,
    "Avg Price": parseFloat(posSplit.average_price).toLocaleString("id-ID"),
    "Total Value": (posSplit.available * parseFloat(posSplit.average_price)).toLocaleString("id-ID"),
  }]);

  // Validasi Stock Split: 5.000 lembar @ Rp 40
  console.log("\n=== VALIDASI STOCK SPLIT ===");
  if (posSplit.available === 5000 && parseFloat(posSplit.average_price) === 40) {
    console.log("✅ SUKSES: Jumlah lembar saham dikalikan 5 dan avg price dibagi 5 dengan tepat!");
  } else {
    console.error("❌ GAGAL: Kuantitas atau harga rata-rata setelah Stock Split salah!");
  }

  // 5. Jalankan Reverse Stock Split 5:1
  console.log("\n[5] Mendaftarkan Corporate Action: Reverse Stock Split (5:1) di BEI...");
  const reverseCARes = await fetchJson(`${BEI_URL}/corporate-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      securityId: moseSecurityId,
      type: "reverse_split",
      status: "draft",
      title: "Reverse Stock Split MOSE 5:1",
      description: "Penggabungan nilai nominal saham MOSE dengan rasio 5 banding 1.",
      announcementDate: new Date().toISOString().split("T")[0],
      recordingDate: new Date().toISOString().split("T")[0],
      executionDate: new Date().toISOString().split("T")[0],
      ratioNumerator: 1,
      ratioDenominator: 5,
      idempotencyKey: `ca:rev:mose:${Date.now()}`,
    }),
  });

  if (!reverseCARes.ok) {
    console.error("❌ Gagal mendaftarkan Reverse Stock Split di BEI:", reverseCARes.data || reverseCARes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const reverseActionId = reverseCARes.data.id;
  console.log(`✅ Reverse Stock Split terdaftar. Action ID: ${reverseActionId}`);

  console.log(`Memicu pemrosesan Reverse Stock Split (Action ID: ${reverseActionId})...`);
  const processReverseRes = await fetchJson(`${BEI_URL}/corporate-actions/${reverseActionId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processReverseRes.ok) {
    console.error("❌ Gagal memproses Reverse Stock Split di BEI:", processReverseRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Webhook Reverse Stock Split dikirim ke Sekuritas.");
  console.log("Menunggu 5 detik agar webhook selesai diproses...");
  await sleep(5000);

  const posReverse = await getMosePosition(sekDbClient, brokerAccountId);
  console.log("\nPosisi Setelah Reverse Stock Split (5:1):");
  console.table([{
    Symbol: "MOSE",
    Available: posReverse.available,
    "Avg Price": parseFloat(posReverse.average_price).toLocaleString("id-ID"),
    "Total Value": (posReverse.available * parseFloat(posReverse.average_price)).toLocaleString("id-ID"),
  }]);

  // Validasi Reverse Stock Split: kembali ke 1.000 lembar @ Rp 200
  console.log("\n=== VALIDASI REVERSE STOCK SPLIT ===");
  if (posReverse.available === 1000 && parseFloat(posReverse.average_price) === 200) {
    console.log("✅ SUKSES: Jumlah lembar saham dibagi 5 dan avg price dikalikan 5 kembali ke kondisi semula!");
  } else {
    console.error("❌ GAGAL: Kuantitas atau harga rata-rata setelah Reverse Stock Split salah!");
  }

  // 6. Ringkasan Akhir
  console.log("\n======================================================================");
  console.log("📊 RINGKASAN PERBANDINGAN STOCK SPLIT vs REVERSE STOCK SPLIT 📊");
  console.log("======================================================================");
  console.table([
    {
      Tahap: "1. Posisi Awal",
      Kuantitas: posInitial.available,
      "Average Price": parseFloat(posInitial.average_price).toLocaleString("id-ID"),
      "Total Value": (posInitial.available * parseFloat(posInitial.average_price)).toLocaleString("id-ID"),
    },
    {
      Tahap: "2. Post Stock Split (1:5)",
      Kuantitas: posSplit.available,
      "Average Price": parseFloat(posSplit.average_price).toLocaleString("id-ID"),
      "Total Value": (posSplit.available * parseFloat(posSplit.average_price)).toLocaleString("id-ID"),
    },
    {
      Tahap: "3. Post Reverse Split (5:1)",
      Kuantitas: posReverse.available,
      "Average Price": parseFloat(posReverse.average_price).toLocaleString("id-ID"),
      "Total Value": (posReverse.available * parseFloat(posReverse.average_price)).toLocaleString("id-ID"),
    },
  ]);

  await sekDbClient.end();
  await beiDbClient.end();
  console.log("\n🏁 PENGUJIAN STOCK SPLIT & REVERSE SPLIT SELESAI! 🏁");
  console.log("======================================================================");
}

runStockSplitTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian Stock Split:", err);
  process.exit(1);
});
