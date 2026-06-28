import pg from "pg";
import { signUserToken } from "../lib/auth.js";
import { db } from "../db/db.js";
import { users, broker_accounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SEKURITAS_URL = "http://localhost:3002";

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

async function runAmendCancelTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E AMEND & CANCEL ORDER (EMITEN MOSE) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas
  console.log("\n[1] Menghubungkan ke database Sekuritas...");
  const sekDbClient = new pg.Client({
    connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas",
  });
  
  try {
    await sekDbClient.connect();
    console.log("✅ Terhubung ke database Sekuritas.");
  } catch (err: any) {
    console.error("❌ Gagal menghubungkan ke database Sekuritas:", err.message);
    process.exit(1);
  }

  // 2. Setup Otentikasi Trader 1
  console.log("\n[2] Mempersiapkan data otentikasi Trader 1...");
  const email = "test_trader_1@mandalatest.com";
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.error(`❌ Trader ${email} tidak ditemukan di database.`);
    await sekDbClient.end();
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
    process.exit(1);
  }

  const token = signUserToken(user.id);
  const brokerAccountId = brokerAccount.id;
  console.log(`✅ Otentikasi sukses. Broker Account ID: ${brokerAccountId}`);

  // 3. Catat saldo kas awal
  const initialCash = await getCashBalance(sekDbClient, brokerAccountId);
  console.log("\n[3] Saldo Kas Awal:");
  console.table([{
    Tahap: "Awal",
    Available: parseFloat(initialCash.available).toLocaleString("id-ID"),
    Reserved: parseFloat(initialCash.reserved).toLocaleString("id-ID"),
    Pending: parseFloat(initialCash.pending).toLocaleString("id-ID"),
  }]);

  // 4. Kirim Order BUY limit awal: MOSE @ Rp 190 sebanyak 20 Lot (2000 lembar)
  console.log("\n[4] Mengirim order BUY Limit: 20 Lot MOSE @ Rp 190...");
  const orderQty = 2000;
  const orderPrice1 = 190;

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
      price: orderPrice1,
      quantity: orderQty,
    }),
  });

  if (!placeOrderRes.ok) {
    console.error("❌ Gagal menempatkan order BUY:", placeOrderRes.data || placeOrderRes.raw);
    await sekDbClient.end();
    process.exit(1);
  }

  const orderId = placeOrderRes.data.id;
  console.log(`✅ Order BUY berhasil dipasang. Order ID: ${orderId}`);

  // Tunggu webhook terproses agar reserved cash terupdate
  console.log("Menunggu 2 detik agar status order ter-update oleh MATS/Sekuritas...");
  await sleep(2000);

  const postOrderCash = await getCashBalance(sekDbClient, brokerAccountId);
  console.log("\nSaldo Kas Setelah Kirim Order:");
  console.table([{
    Tahap: "Setelah Kirim Order",
    Available: parseFloat(postOrderCash.available).toLocaleString("id-ID"),
    Reserved: parseFloat(postOrderCash.reserved).toLocaleString("id-ID"),
    Pending: parseFloat(postOrderCash.pending).toLocaleString("id-ID"),
  }]);

  // Verifikasi pengurangan available dan penambahan reserved
  const diffReservedPostOrder = parseFloat(postOrderCash.reserved) - parseFloat(initialCash.reserved);
  console.log(`Selisih Dana di Reserved: Rp ${diffReservedPostOrder.toLocaleString("id-ID")}`);
  if (diffReservedPostOrder > 0) {
    console.log("✅ Uang berhasil dibekukan ke reserved.");
  } else {
    console.error("❌ Gagal membekukan uang ke reserved!");
  }

  // 5. Jalankan Amend Order: Ubah harga menjadi Rp 180 (Lebih murah Rp 10)
  console.log("\n[5] Melakukan Amend Order: Ubah harga ke Rp 180...");
  const orderPrice2 = 180;

  const amendOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${orderId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      price: orderPrice2,
    }),
  });

  if (!amendOrderRes.ok) {
    console.error("❌ Gagal melakukan Amend Order:", amendOrderRes.data || amendOrderRes.raw);
    await sekDbClient.end();
    process.exit(1);
  }

  console.log("✅ Permintaan Amend dikirim.");
  console.log("Menunggu 2 detik agar status amend selesai di-update...");
  await sleep(2000);

  const postAmendCash = await getCashBalance(sekDbClient, brokerAccountId);
  console.log("\nSaldo Kas Setelah Amend Order:");
  console.table([{
    Tahap: "Setelah Amend",
    Available: parseFloat(postAmendCash.available).toLocaleString("id-ID"),
    Reserved: parseFloat(postAmendCash.reserved).toLocaleString("id-ID"),
    Pending: parseFloat(postAmendCash.pending).toLocaleString("id-ID"),
  }]);

  // Verifikasi pengembalian selisih dana ke available (available bertambah, reserved berkurang)
  const diffReservedAmend = parseFloat(postOrderCash.reserved) - parseFloat(postAmendCash.reserved);
  console.log(`Selisih Dana Dibebaskan dari Reserved: Rp ${diffReservedAmend.toLocaleString("id-ID")}`);
  if (diffReservedAmend > 0) {
    console.log("✅ Selisih dana amend berhasil dikembalikan ke Available.");
  } else {
    console.error("❌ Selisih dana amend gagal dikembalikan!");
  }

  // 6. Jalankan Cancel Order
  console.log("\n[6] Melakukan Cancel Order...");
  const cancelOrderRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${orderId}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!cancelOrderRes.ok) {
    console.error("❌ Gagal membatalkan order:", cancelOrderRes.data || cancelOrderRes.raw);
    await sekDbClient.end();
    process.exit(1);
  }

  console.log("✅ Permintaan Cancel dikirim.");
  console.log("Menunggu 2 detik agar status pembatalan selesai di-update...");
  await sleep(2000);

  const postCancelCash = await getCashBalance(sekDbClient, brokerAccountId);
  console.log("\nSaldo Kas Setelah Cancel Order:");
  console.table([{
    Tahap: "Setelah Cancel",
    Available: parseFloat(postCancelCash.available).toLocaleString("id-ID"),
    Reserved: parseFloat(postCancelCash.reserved).toLocaleString("id-ID"),
    Pending: parseFloat(postCancelCash.pending).toLocaleString("id-ID"),
  }]);

  // Verifikasi pembebasan 100% sisa reserved cash kembali ke available
  const diffReservedCancel = parseFloat(postAmendCash.reserved) - parseFloat(postCancelCash.reserved);
  console.log(`Selisih Dana Dibebaskan dari Reserved saat Cancel: Rp ${diffReservedCancel.toLocaleString("id-ID")}`);
  if (Math.abs(parseFloat(postCancelCash.reserved) - parseFloat(initialCash.reserved)) < 0.01) {
    console.log("✅ Saldo reserved kembali ke kondisi awal.");
  } else {
    console.warn("⚠️ Perhatian: Ada sedikit sisa selisih saldo reserved. Pastikan tidak ada order open lain yang berjalan.");
  }

  // 7. Tabel Ringkasan Komparasi Perubahan Kas
  console.log("\n======================================================================");
  console.log("📊 RINGKASAN PERBANDINGAN SALDO KAS PENGUJIAN AMEND & CANCEL 📊");
  console.log("======================================================================");
  console.table([
    {
      Tahap: "1. Saldo Awal",
      Available: parseFloat(initialCash.available).toLocaleString("id-ID"),
      Reserved: parseFloat(initialCash.reserved).toLocaleString("id-ID"),
      Pending: parseFloat(initialCash.pending).toLocaleString("id-ID"),
    },
    {
      Tahap: "2. Setelah Order (20 Lot @ Rp 190)",
      Available: parseFloat(postOrderCash.available).toLocaleString("id-ID"),
      Reserved: parseFloat(postOrderCash.reserved).toLocaleString("id-ID"),
      Pending: parseFloat(postOrderCash.pending).toLocaleString("id-ID"),
    },
    {
      Tahap: "3. Setelah Amend (Rp 190 -> Rp 180)",
      Available: parseFloat(postAmendCash.available).toLocaleString("id-ID"),
      Reserved: parseFloat(postAmendCash.reserved).toLocaleString("id-ID"),
      Pending: parseFloat(postAmendCash.pending).toLocaleString("id-ID"),
    },
    {
      Tahap: "4. Setelah Cancel Order",
      Available: parseFloat(postCancelCash.available).toLocaleString("id-ID"),
      Reserved: parseFloat(postCancelCash.reserved).toLocaleString("id-ID"),
      Pending: parseFloat(postCancelCash.pending).toLocaleString("id-ID"),
    },
  ]);

  // Akhiri koneksi DB
  await sekDbClient.end();
  console.log("\n🏁 PENGUJIAN AMEND & CANCEL ORDER SELESAI! 🏁");
  console.log("======================================================================");
}

runAmendCancelTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian amend & cancel:", err);
  process.exit(1);
});
