import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SEKURITAS_URL = "http://localhost:3002";
const BEI_URL = "http://localhost:4100/v1";
const MATS_SYNC_URL = "http://localhost:8082/v1/admin/sync/bei";
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

interface CashBalance {
  available: string;
  reserved: string;
  pending: string;
}

async function getCashBalance(client: pg.Client, brokerAccountId: string): Promise<CashBalance> {
  const res = await client.query(
    "SELECT available, reserved, pending FROM cash_balances WHERE broker_account_id = $1",
    [brokerAccountId]
  );
  if (res.rows.length === 0) {
    throw new Error(`Cash balance not found for broker account: ${brokerAccountId}`);
  }
  return res.rows[0];
}

async function runAutoRejectionVolumeTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E BATAS VOLUME ORDER (AUTO REJECTION VOLUME) 🚀");
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

  // 2. Setup Otentikasi Trader 1
  console.log("\n[2] Mempersiapkan data otentikasi Trader 1...");
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

  const token = signUserToken(user.id);
  const brokerAccountId = brokerAccount.id;
  console.log(`✅ Otentikasi sukses. Broker Account ID: ${brokerAccountId}`);

  // Pastikan trader memiliki saldo yang cukup di database
  console.log("- Memastikan saldo kas trader cukup...");
  await sekDbClient.query(
    "UPDATE cash_balances SET available = 10000000.000000, reserved = 0.000000, pending = 0.000000 WHERE broker_account_id = $1",
    [brokerAccountId]
  );

  // 3. Dapatkan Profile Perdagangan Default di BEI
  console.log("\n[3] Mencari profile perdagangan regular di BEI...");
  const profileRes = await beiDbClient.query(
    "SELECT id FROM trading_rule_profiles WHERE board = 'main' AND market_segment = 'regular'"
  );
  let profileId = profileRes.rows[0]?.id;
  if (!profileId) {
    const defaultProfileRes = await beiDbClient.query("SELECT id FROM trading_rule_profiles LIMIT 1");
    profileId = defaultProfileRes.rows[0]?.id;
  }

  if (!profileId) {
    console.error("❌ Profile perdagangan tidak ditemukan di BEI database.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log(`✅ Profile perdagangan ID ditemukan: ${profileId}`);

  // Simpan nilai asli auto rejection rule untuk restore nanti
  const ruleRes = await beiDbClient.query(
    "SELECT id, max_lots_per_order, max_listed_shares_percent FROM auto_rejection_rules WHERE profile_id = $1",
    [profileId]
  );
  if (ruleRes.rows.length === 0) {
    console.error("❌ Auto Rejection Rule tidak ditemukan untuk profile tersebut.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const originalRuleId = ruleRes.rows[0].id;
  const originalMaxLots = ruleRes.rows[0].max_lots_per_order;
  const originalMaxPercent = ruleRes.rows[0].max_listed_shares_percent;
  console.log(`- Aturan asli: Max Lots = ${originalMaxLots}, Max Percent = ${originalMaxPercent}`);

  // 4. Update Aturan Bursa Menjadi Batas Rendah (10 Lot)
  console.log("\n[4] Memperbarui aturan auto rejection ke batas rendah (Max: 10 Lot)...");
  await beiDbClient.query(
    "UPDATE auto_rejection_rules SET max_lots_per_order = 10, max_listed_shares_percent = NULL WHERE id = $1",
    [originalRuleId]
  );
  console.log("✅ Aturan berhasil diperbarui di database BEI.");

  // Memicu sinkronisasi MATS
  console.log("- Memicu sinkronisasi aturan baru ke MATS engine...");
  const syncRes = await fetchJson(MATS_SYNC_URL, {
    method: "POST",
    headers: {
      "x-service-token": MATS_ADMIN_TOKEN,
    },
  });
  if (!syncRes.ok) {
    console.error("❌ Gagal menyinkronkan aturan ke MATS:", syncRes.data || syncRes.raw);
    // Restore dulu sebelum keluar
    await beiDbClient.query(
      "UPDATE auto_rejection_rules SET max_lots_per_order = $1, max_listed_shares_percent = $2 WHERE id = $3",
      [originalMaxLots, originalMaxPercent, originalRuleId]
    );
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Sinkronisasi MATS Sukses.");
  await sleep(2000); // Tunggu agar MATS mengaplikasikan cache baru

  let testSuccess = true;

  try {
    // 5. Uji Coba Order Melanggar Batas (11 Lot / 1.100 Lembar)
    console.log("\n[5] Uji Coba: Mengirim order BUY Limit melanggar batas (11 Lot @ Rp 200)...");
    const cashBeforeFailed = await getCashBalance(sekDbClient, brokerAccountId);

    const placeOrderFailedRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        symbol: "MOSE",
        side: "BUY",
        order_type: "LIMIT",
        price: 200,
        quantity: 1100, // 11 Lot
      }),
    });

    const cashAfterFailed = await getCashBalance(sekDbClient, brokerAccountId);

    console.log("Status Response Penempatan Order:", placeOrderFailedRes.status);
    console.log("Body Response:", placeOrderFailedRes.data || placeOrderFailedRes.raw);

    console.log("\n=== ASERSION: ORDER MELEBIHI BATAS VOLUME ===");
    const isRejected = (placeOrderFailedRes.data?.status === "rejected" || placeOrderFailedRes.data?.order?.status === "rejected");
    const rejectReason = placeOrderFailedRes.data?.reject_reason || placeOrderFailedRes.data?.order?.reject_reason;

    if (isRejected && rejectReason === "auto_rejection_volume") {
      console.log("✅ SUKSES: Order ditolak dengan alasan 'auto_rejection_volume'!");
    } else {
      console.error("❌ GAGAL: Order tidak ditolak atau alasan penolakan salah!");
      testSuccess = false;
    }

    console.log("\n=== ASERSION: ROLLBACK SALDO KAS NASABAH ===");
    console.log(`- Kas Sebelum Order: Available Rp ${Number(cashBeforeFailed.available).toLocaleString()} | Reserved Rp ${Number(cashBeforeFailed.reserved).toLocaleString()}`);
    console.log(`- Kas Setelah Order: Available Rp ${Number(cashAfterFailed.available).toLocaleString()} | Reserved Rp ${Number(cashAfterFailed.reserved).toLocaleString()}`);

    if (Number(cashBeforeFailed.available) === Number(cashAfterFailed.available) && Number(cashAfterFailed.reserved) === 0) {
      console.log("✅ SUKSES: Saldo kas trader di-rollback penuh dan tidak ada dana tersangkut.");
    } else {
      console.error("❌ GAGAL: Saldo kas trader tidak di-rollback!");
      testSuccess = false;
    }

    // 6. Uji Coba Order Memenuhi Batas (10 Lot / 1.000 Lembar)
    console.log("\n[6] Uji Coba: Mengirim order BUY Limit pas pada batas (10 Lot @ Rp 200)...");
    const placeOrderOkRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        symbol: "MOSE",
        side: "BUY",
        order_type: "LIMIT",
        price: 200,
        quantity: 1000, // 10 Lot
      }),
    });

    console.log("Status Response Penempatan Order:", placeOrderOkRes.status);
    console.log("Body Response:", placeOrderOkRes.data || placeOrderOkRes.raw);

    console.log("\n=== ASERSION: ORDER MEMENUHI BATAS VOLUME ===");
    const orderStatus = placeOrderOkRes.data?.status || placeOrderOkRes.data?.order?.status;
    if (orderStatus === "open" || placeOrderOkRes.status === 201) {
      console.log("✅ SUKSES: Order diterima dengan baik dan masuk ke antrean.");
    } else {
      console.error("❌ GAGAL: Order ditolak padahal nilainya pas pada batas!");
      testSuccess = false;
    }

  } catch (err: any) {
    console.error("❌ Terjadi error saat pengujian:", err.message);
    testSuccess = false;
  } finally {
    // 7. Kembalikan Aturan Bursa Asli (Teardown)
    console.log("\n[7] Mengembalikan aturan auto rejection bursa ke nilai semula (Restore)...");
    try {
      await beiDbClient.query(
        "UPDATE auto_rejection_rules SET max_lots_per_order = $1, max_listed_shares_percent = $2 WHERE id = $3",
        [originalMaxLots, originalMaxPercent, originalRuleId]
      );
      console.log("✅ Aturan berhasil dikembalikan di database BEI.");

      // Sync ulang MATS
      const restoreSyncRes = await fetchJson(MATS_SYNC_URL, {
        method: "POST",
        headers: {
          "x-service-token": MATS_ADMIN_TOKEN,
        },
      });
      if (restoreSyncRes.ok) {
        console.log("✅ Sinkronisasi ulang MATS Sukses.");
      } else {
        console.warn("⚠️ WARNING: Sinkronisasi ulang MATS gagal.");
      }
    } catch (err: any) {
      console.error("❌ Gagal mengembalikan aturan bursa:", err.message);
    }

    // Tutup koneksi database
    await sekDbClient.end();
    await beiDbClient.end();
  }

  console.log("\n======================================================================");
  if (testSuccess) {
    console.log("🏁 PENGUJIAN AUTO REJECTION VOLUME BERHASIL DENGAN 100% SUKSES! 🏁");
  } else {
    console.log("🏁 PENGUJIAN AUTO REJECTION VOLUME SELESAI DENGAN BEBERAPA KEGAGALAN! 🏁");
    process.exit(1);
  }
  console.log("======================================================================");
}

runAutoRejectionVolumeTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian:", err);
  process.exit(1);
});
