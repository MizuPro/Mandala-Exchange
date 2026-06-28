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

async function runSuspensionTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E SUSPENSI SAHAM & RESUME TRADING (MOSE) 🚀");
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

  // 3. Pastikan status MOSE di bursa adalah 'listed' awal
  console.log("\n[3] Mempersiapkan status MOSE agar aktif ('listed')...");
  try {
    await beiDbClient.query(
      "UPDATE listed_securities SET status = 'listed', suspended_reason = NULL WHERE symbol = 'MOSE'"
    );
    // Hapus suspensi aktif dari notation jika ada
    const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
    if (secRes.rows.length > 0) {
      await beiDbClient.query(
        "UPDATE special_notations SET is_active = false WHERE security_id = $1 AND type = 'suspend'",
        [secRes.rows[0].id]
      );
    }
    console.log("✅ Saham MOSE di-set status 'listed'.");
  } catch (err: any) {
    console.error("❌ Gagal menyetel status MOSE ke listed:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // Tunggu agar MATS sinkron (1-2 detik)
  await sleep(2000);

  // 4. Kirim Order Limit BUY Awal (Sukses)
  console.log("\n[4] Mengirim order BUY Limit awal (10 Lot @ Rp 200) saat bursa aktif...");
  
  const placeOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
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
      quantity: 1000,
    }),
  });

  if (!placeOrderRes.ok) {
    console.error("❌ Gagal menempatkan order awal:", placeOrderRes.data || placeOrderRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const orderId1 = placeOrderRes.data.id;
  console.log(`✅ Order awal sukses terkirim. ID: ${orderId1}`);

  // 5. Trigger Suspensi Saham MOSE via API BEI
  console.log("\n[5] Mensuspensi saham MOSE melalui API Admin BEI...");
  const suspendRes = await fetchJson(`${BEI_URL}/securities/MOSE/suspend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      reason: "Suspensi E2E Market Surveillance Testing"
    }),
  });

  if (!suspendRes.ok) {
    console.error("❌ Gagal mensuspensi saham MOSE:", suspendRes.data || suspendRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  console.log("✅ Saham MOSE sukses disuspend oleh BEI.");
  console.log("Menunggu 3 detik agar sinkronisasi suspensi selesai...");
  await sleep(3000);

  // 6. Mengirim order BUY limit baru saat saham disuspend (Harus Ditolak & Saldo Rollback)
  console.log("\n[6] Mengirim order BUY Limit baru (10 Lot @ Rp 200) saat disuspend...");
  const cashBeforeSuspendedOrder = await getCashBalance(sekDbClient, brokerAccountId);

  const placeOrderSuspendedRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
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
      quantity: 1000,
    }),
  });

  console.log("Status Response Penempatan Order:", placeOrderSuspendedRes.status);
  console.log("Body Response:", placeOrderSuspendedRes.data || placeOrderSuspendedRes.raw);

  const cashAfterSuspendedOrder = await getCashBalance(sekDbClient, brokerAccountId);

  console.log("\n=== VALIDASI SUSPENSI (PENOLAKAN ORDER) ===");
  const isRejected = (placeOrderSuspendedRes.data?.status === "rejected" || placeOrderSuspendedRes.data?.order?.status === "rejected");
  
  if (isRejected) {
    console.log(`✅ SUKSES: Order ditolak dengan status 'rejected'! Alasan: ${placeOrderSuspendedRes.data?.reject_reason || placeOrderSuspendedRes.data?.order?.reject_reason}`);
  } else {
    console.error("❌ GAGAL: Order tidak ditolak dengan status 'rejected'!");
  }

  const isRollbackSuccess = parseFloat(cashBeforeSuspendedOrder.available) === parseFloat(cashAfterSuspendedOrder.available) &&
    parseFloat(cashBeforeSuspendedOrder.reserved) === parseFloat(cashAfterSuspendedOrder.reserved);

  if (isRollbackSuccess) {
    console.log("✅ SUKSES: Saldo kas nasabah di-rollback utuh (tidak ada dana yang tertahan)!");
  } else {
    console.error("❌ GAGAL: Saldo kas nasabah tidak pulih atau ada dana yang tersangkut!");
    console.log(`Sebelum Order: Available=${cashBeforeSuspendedOrder.available}, Reserved=${cashBeforeSuspendedOrder.reserved}`);
    console.log(`Setelah Order: Available=${cashAfterSuspendedOrder.available}, Reserved=${cashAfterSuspendedOrder.reserved}`);
  }

  // 7. Memicu Resume Trading Saham MOSE via API BEI
  console.log("\n[7] Mencabut suspensi saham MOSE melalui API Admin BEI...");
  const resumeRes = await fetchJson(`${BEI_URL}/securities/MOSE/resume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-token": BEI_ADMIN_TOKEN,
    },
    body: JSON.stringify({}),
  });

  if (!resumeRes.ok) {
    console.error("❌ Gagal mencabut suspensi saham MOSE:", resumeRes.data || resumeRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  console.log("✅ Suspensi saham MOSE sukses dicabut (Resume Trading).");
  console.log("Menunggu 3 detik agar sinkronisasi resume selesai...");
  await sleep(3000);

  // 8. Menguji pengiriman order baru setelah resume (Harus Sukses)
  console.log("\n[8] Mengirim order BUY Limit baru (10 Lot @ Rp 200) setelah resume...");
  const placeOrderAfterResumeRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
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
      quantity: 1000,
    }),
  });

  console.log("\n=== VALIDASI RESUME (PENERIMAAN ORDER) ===");
  let orderId2 = "";
  if (placeOrderAfterResumeRes.ok) {
    orderId2 = placeOrderAfterResumeRes.data.id;
    console.log(`✅ SUKSES: Order berhasil diterima kembali setelah resume. ID: ${orderId2}`);
  } else {
    console.error("❌ GAGAL: Order ditolak setelah resume:", placeOrderAfterResumeRes.data || placeOrderAfterResumeRes.raw);
  }

  // Bersihkan data testing & batalkan order-order yang open agar tidak menumpuk
  console.log("\n[9] Membersihkan data order testing...");
  try {
    if (orderId1) {
      await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${orderId1}/cancel`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
    }
    if (orderId2) {
      await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${orderId2}/cancel`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
    }
    console.log("✅ Data order dibersihkan.");
  } catch (err: any) {
    console.warn("⚠️ Gagal membersihkan order testing:", err.message);
  }

  // Selesai
  await sekDbClient.end();
  await beiDbClient.end();
  
  console.log("\n======================================================================");
  console.log("📊 RINGKASAN HASIL PENGUJIAN SUSPENSI & RESUME SAHAM 📊");
  console.log("======================================================================");
  console.table([
    { Skenario: "Order Beli Awal (Bursa Aktif)", Hasil: placeOrderRes.ok ? "✅ SUKSES (Order Open)" : "❌ GAGAL" },
    { Skenario: "Order Beli Baru (Bursa Suspended)", Hasil: isRejected ? "✅ SUKSES (Ditolak Bursa)" : "❌ GAGAL" },
    { Skenario: "Rollback Saldo Kas Pasca Penolakan", Hasil: isRollbackSuccess ? "✅ SUKSES (Kembali Utuh)" : "❌ GAGAL" },
    { Skenario: "Order Beli Baru (Bursa Resume)", Hasil: placeOrderAfterResumeRes.ok ? "✅ SUKSES (Order Open)" : "❌ GAGAL" }
  ]);
  
  console.log("🏁 PENGUJIAN SELESAI! 🏁");
  console.log("======================================================================");
}

runSuspensionTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian Suspensi & Resume:", err);
  process.exit(1);
});
