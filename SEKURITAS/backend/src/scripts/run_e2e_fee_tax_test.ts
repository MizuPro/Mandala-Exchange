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
  email: string;
  available: string;
  reserved: string;
  pending: string;
}

async function getTraderCash(client: pg.Client, brokerAccountId: string): Promise<CashBalance> {
  const res = await client.query(
    `SELECT u.email, cb.available, cb.reserved, cb.pending 
     FROM cash_balances cb 
     JOIN broker_accounts ba ON cb.broker_account_id = ba.id
     JOIN users u ON ba.user_id = u.id
     WHERE cb.broker_account_id = $1`,
    [brokerAccountId]
  );
  return res.rows[0];
}

async function runFeeTaxTest() {
  console.log("======================================================================");
  console.log("🚀 MEMULAI PENGUJIAN E2E FEE & PAJAK TRANSAKSI (EMITEN MOSE) 🚀");
  console.log("======================================================================");

  // 1. Hubungkan ke database Sekuritas dan BEI
  console.log("\n[1] Menghubungkan ke database Sekuritas dan BEI...");
  const sekDbClient = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas" });
  const beiDbClient = new pg.Client({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });

  try {
    await sekDbClient.connect();
    await beiDbClient.connect();
    console.log("✅ Terhubung ke kedua database.");
  } catch (err: any) {
    console.error("❌ Gagal menghubungkan ke database:", err.message);
    process.exit(1);
  }

  // 2. Setup Otentikasi Trader 1 & Trader 2
  console.log("\n[2] Mempersiapkan data otentikasi trader...");
  const email1 = "test_trader_1@mandalatest.com"; // Pembeli
  const email2 = "test_trader_2@mandalatest.com"; // Penjual

  const [user1] = await db.select().from(users).where(eq(users.email, email1)).limit(1);
  const [user2] = await db.select().from(users).where(eq(users.email, email2)).limit(1);

  if (!user1 || !user2) {
    console.error("❌ Salah satu trader tidak ditemukan di database.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const [acc1] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user1.id)).limit(1);
  const [acc2] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, user2.id)).limit(1);

  if (!acc1 || !acc2) {
    console.error("❌ Akun broker trader tidak ditemukan.");
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  const token1 = signUserToken(user1.id);
  const token2 = signUserToken(user2.id);

  console.log(`✅ Trader 1 (Pembeli): ${email1} | Acc: ${acc1.id}`);
  console.log(`✅ Trader 2 (Penjual): ${email2} | Acc: ${acc2.id}`);

  // 3. Bersihkan orderbook MOSE agar steril
  console.log("\n[3] Membersihkan order 'MOSE' yang masih open...");
  try {
    const openOrders = await sekDbClient.query(`
      SELECT o.id, u.id as user_id, u.email
      FROM orders o
      JOIN broker_accounts ba ON o.broker_account_id = ba.id
      JOIN users u ON ba.user_id = u.id
      WHERE o.symbol = 'MOSE' AND o.status IN ('open', 'partially_filled')
    `);

    for (const order of openOrders.rows) {
      console.log(`- Membatalkan order ID: ${order.id} milik ${order.email}`);
      const tkn = order.user_id === user1.id ? token1 : token2;
      await fetchJson(`${SEKURITAS_URL}/api/v1/orders/${order.id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${tkn}` },
      });
    }
  } catch (err: any) {
    console.warn("⚠️ Peringatan saat membersihkan orderbook:", err.message);
  }

  // 4. Pastikan Penjual (Trader 2) memiliki saham MOSE yang cukup
  console.log("\n[4] Memastikan Penjual (Trader 2) memiliki minimal 1.000 lembar saham MOSE...");
  let moseSecurityId = "";
  try {
    const secRes = await beiDbClient.query("SELECT id FROM listed_securities WHERE symbol = 'MOSE'");
    if (secRes.rows.length === 0) {
      console.error("❌ Emiten MOSE belum terdaftar di BEI.");
      await sekDbClient.end();
      await beiDbClient.end();
      process.exit(1);
    }
    moseSecurityId = secRes.rows[0].id;

    // Cek di DB Sekuritas
    const sekPosRes = await sekDbClient.query(
      "SELECT available FROM securities_positions WHERE broker_account_id = $1 AND symbol = 'MOSE'",
      [acc2.id]
    );
    const sekQty = sekPosRes.rows[0] ? parseInt(sekPosRes.rows[0].available) : 0;

    if (sekQty < 1000) {
      console.log(`Saham MOSE Trader 2 di Sekuritas (${sekQty}) tidak cukup. Menambahkan 10.000 lembar...`);

      // Dapatkan SRE dan SID Trader 2
      const sidRes = await sekDbClient.query("SELECT sid FROM sid_references WHERE broker_account_id = $1", [acc2.id]);
      const sreRes = await sekDbClient.query("SELECT sre FROM sre_references WHERE broker_account_id = $1", [acc2.id]);
      const sid = sidRes.rows[0]?.sid;
      const sre = sreRes.rows[0]?.sre;

      if (!sid || !sre) {
        throw new Error("SID atau SRE untuk Trader 2 tidak ditemukan.");
      }

      // Dapatkan custody_account_id di BEI
      const custodyAccRes = await beiDbClient.query(
        "SELECT id FROM custody_accounts WHERE sid = $1 AND sre = $2",
        [sid, sre]
      );
      const custodyAccId = custodyAccRes.rows[0]?.id;

      if (!custodyAccId) {
        throw new Error("Custody Account di BEI tidak ditemukan.");
      }

      // Suntik saham di BEI
      await beiDbClient.query(
        `INSERT INTO custody_ledger_entries (custody_account_id, security_id, asset_type, quantity, idempotency_key)
         VALUES ($1, $2, 'security', 10000, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [custodyAccId, moseSecurityId, `grant:fee_test:${acc2.id}:${Date.now()}`]
      );

      // Suntik saham di Sekuritas
      if (sekPosRes.rows.length > 0) {
        await sekDbClient.query(
          "UPDATE securities_positions SET available = available + 10000 WHERE broker_account_id = $1 AND symbol = 'MOSE'",
          [acc2.id]
        );
      } else {
        await sekDbClient.query(
          `INSERT INTO securities_positions (broker_account_id, symbol, available, reserved, pending, average_price, realized_pl, unrealized_pl)
           VALUES ($1, 'MOSE', 10000, 0, 0, '200.000000', 0, 0)`,
          [acc2.id]
        );
      }

      console.log("✅ Berhasil menambahkan 10.000 lembar saham MOSE untuk Trader 2.");
    } else {
      console.log(`✅ Trader 2 memiliki saham MOSE yang cukup (${sekQty} lembar).`);
    }
  } catch (err: any) {
    console.error("❌ Gagal memverifikasi/menambah saham Trader 2:", err.message);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }

  // 5. Catat saldo kas awal kedua trader
  const initialCash1 = await getTraderCash(sekDbClient, acc1.id);
  const initialCash2 = await getTraderCash(sekDbClient, acc2.id);

  console.log("\n[5] Saldo Kas Awal Trader:");
  console.table([
    {
      Trader: "Trader 1 (BUY)",
      Available: parseFloat(initialCash1.available).toLocaleString("id-ID"),
      Reserved: parseFloat(initialCash1.reserved).toLocaleString("id-ID"),
    },
    {
      Trader: "Trader 2 (SELL)",
      Available: parseFloat(initialCash2.available).toLocaleString("id-ID"),
      Reserved: parseFloat(initialCash2.reserved).toLocaleString("id-ID"),
    },
  ]);

  // 6. Jalankan Order Matching
  console.log("\n[6] Mengirim order SELL (10 Lot @ Rp 200) dari Trader 2...");
  const orderQty = 1000;
  const orderPrice = 200;

  const sellRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token2}` },
    body: JSON.stringify({ symbol: "MOSE", side: "SELL", order_type: "LIMIT", price: orderPrice, quantity: orderQty }),
  });

  if (!sellRes.ok) {
    console.error("❌ Gagal menempatkan order SELL:", sellRes.data || sellRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const sellOrderId = sellRes.data.id;
  console.log(`✅ Order SELL dipasang. Order ID: ${sellOrderId}`);

  console.log("\nMengirim order BUY (10 Lot @ Rp 200) dari Trader 1...");
  const buyRes = await fetchJson(`${SEKURITAS_URL}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token1}` },
    body: JSON.stringify({ symbol: "MOSE", side: "BUY", order_type: "LIMIT", price: orderPrice, quantity: orderQty }),
  });

  if (!buyRes.ok) {
    console.error("❌ Gagal menempatkan order BUY:", buyRes.data || buyRes.raw);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const buyOrderId = buyRes.data.id;
  console.log(`✅ Order BUY dipasang. Order ID: ${buyOrderId}`);

  console.log("Menunggu 3 detik agar transaksi dicocokkan (matching) oleh MATS...");
  await sleep(3000);

  // 7. Jalankan Settlement reguler di BEI
  console.log("\n[7] Mencari session aktif di BEI untuk settlement...");
  const sessionRes = await fetchJson(`${BEI_URL}/integration/mats/sessions/active`, {
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!sessionRes.ok) {
    console.error("❌ Gagal mendapatkan session aktif dari BEI.", sessionRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const sessionId = sessionRes.data.id;
  console.log(`Session ID aktif BEI: ${sessionId}`);

  console.log("\nMemicu Settlement Batch di BEI...");
  const createBatchRes = await fetchJson(`${BEI_URL}/settlement/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": BEI_ADMIN_TOKEN },
    body: JSON.stringify({ sessionId }),
  });

  if (!createBatchRes.ok) {
    console.error("❌ Gagal membuat settlement batch:", createBatchRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  const batchId = createBatchRes.data.batch.id;
  console.log(`Batch ID dibuat: ${batchId}. Memproses batch...`);

  const processBatchRes = await fetchJson(`${BEI_URL}/settlement/batches/${batchId}/process`, {
    method: "POST",
    headers: { "x-service-token": BEI_ADMIN_TOKEN },
  });

  if (!processBatchRes.ok) {
    console.error("❌ Gagal memproses settlement batch:", processBatchRes.data);
    await sekDbClient.end();
    await beiDbClient.end();
    process.exit(1);
  }
  console.log("✅ Settlement Batch berhasil diselesaikan di BEI.");

  console.log("Menunggu 5 detik agar status settlement tersinkronisasi ke Sekuritas...");
  await sleep(5000);

  // 8. Verifikasi saldo kas pasca-settlement
  const finalCash1 = await getTraderCash(sekDbClient, acc1.id);
  const finalCash2 = await getTraderCash(sekDbClient, acc2.id);

  const diffCash1 = parseFloat(finalCash1.available) - parseFloat(initialCash1.available);
  const diffCash2 = parseFloat(finalCash2.available) - parseFloat(initialCash2.available);

  // Target perubahan
  const targetDiff1 = -200395.0; // Terpotong Rp 200.395 (Broker 1.5%, Levy 0.031%, VAT 11%)
  const targetDiff2 = 199183.0;  // Bertambah Rp 199.183 (Broker 2.5%, Levy 0.031%, VAT 11%, WHT 0.1%)

  console.log("\n======================================================================");
  console.log("📊 PERBANDINGAN SALDO KAS SEBELUM & SESUDAH SETTLEMENT 📊");
  console.log("======================================================================");
  console.table([
    {
      Trader: "Trader 1 (BUY)",
      "Cash Awal": parseFloat(initialCash1.available).toLocaleString("id-ID"),
      "Cash Akhir": parseFloat(finalCash1.available).toLocaleString("id-ID"),
      Perubahan: diffCash1.toLocaleString("id-ID"),
      Target: targetDiff1.toLocaleString("id-ID"),
      Status: Math.abs(diffCash1 - targetDiff1) < 0.01 ? "✅ PAS (-200.395)" : `❌ SALAH (${diffCash1})`,
    },
    {
      Trader: "Trader 2 (SELL)",
      "Cash Awal": parseFloat(initialCash2.available).toLocaleString("id-ID"),
      "Cash Akhir": parseFloat(finalCash2.available).toLocaleString("id-ID"),
      Perubahan: diffCash2.toLocaleString("id-ID"),
      Target: targetDiff2.toLocaleString("id-ID"),
      Status: Math.abs(diffCash2 - targetDiff2) < 0.01 ? "✅ PAS (+199.183)" : `❌ SALAH (${diffCash2})`,
    },
  ]);

  // 9. Verifikasi catatan di fee_ledgers
  console.log("\n[9] Mengambil catatan fee di tabel 'fee_ledgers'...");
  try {
    const feeLedgersRes = await sekDbClient.query(
      `SELECT fl.fee_type, fl.amount, fl.description, u.email, o.side 
       FROM fee_ledgers fl
       JOIN orders o ON fl.order_id = o.id
       JOIN broker_accounts ba ON fl.broker_account_id = ba.id
       JOIN users u ON ba.user_id = u.id
       WHERE fl.order_id IN ($1, $2)
       ORDER BY o.side, fl.fee_type`,
      [buyOrderId, sellOrderId]
    );

    console.log("\n=== RINCIAN CATATAN FEE (FEE_LEDGERS) ===");
    console.table(feeLedgersRes.rows.map((row) => ({
      Email: row.email,
      Side: row.side.toUpperCase(),
      "Tipe Fee": row.fee_type,
      Nominal: parseFloat(row.amount).toLocaleString("id-ID"),
      Keterangan: row.description || "-",
    })));

    // Validasi nominal record fee
    const buyFees = feeLedgersRes.rows.filter((r) => r.side.toUpperCase() === "BUY");
    const sellFees = feeLedgersRes.rows.filter((r) => r.side.toUpperCase() === "SELL");

    const buyBroker = buyFees.find((f) => f.fee_type === "BROKER")?.amount;
    const buyLevy = buyFees.find((f) => f.fee_type === "LEVY_CLEARING")?.amount;
    const buyVat = buyFees.find((f) => f.fee_type === "VAT")?.amount;

    const sellBroker = sellFees.find((f) => f.fee_type === "BROKER")?.amount;
    const sellLevy = sellFees.find((f) => f.fee_type === "LEVY_CLEARING")?.amount;
    const sellVat = sellFees.find((f) => f.fee_type === "VAT")?.amount;
    const sellWht = sellFees.find((f) => f.fee_type === "WHT")?.amount;

    console.log("\n=== VALIDASI DETIL NOMINAL FEE ===");
    console.log(`- BUY Broker Fee (Rp 300): ${buyBroker === "300.000000" ? "✅ BENAR" : `❌ SALAH (${buyBroker})`}`);
    console.log(`- BUY Levy/Clearing (Rp 62): ${buyLevy === "62.000000" ? "✅ BENAR" : `❌ SALAH (${buyLevy})`}`);
    console.log(`- BUY VAT/PPN (Rp 33): ${buyVat === "33.000000" ? "✅ BENAR" : `❌ SALAH (${buyVat})`}`);
    console.log(`- SELL Broker Fee (Rp 500): ${sellBroker === "500.000000" ? "✅ BENAR" : `❌ SALAH (${sellBroker})`}`);
    console.log(`- SELL Levy/Clearing (Rp 62): ${sellLevy === "62.000000" ? "✅ BENAR" : `❌ SALAH (${sellLevy})`}`);
    console.log(`- SELL VAT/PPN (Rp 55): ${sellVat === "55.000000" ? "✅ BENAR" : `❌ SALAH (${sellVat})`}`);
    console.log(`- SELL PPh/Tax (Rp 200): ${sellWht === "200.000000" ? "✅ BENAR" : `❌ SALAH (${sellWht})`}`);

  } catch (err: any) {
    console.error("Gagal melakukan verifikasi fee_ledgers:", err.message);
  } finally {
    await sekDbClient.end();
    await beiDbClient.end();
  }

  console.log("\n======================================================================");
  console.log("🏁 PENGUJIAN FEE & PAJAK SELESAI! 🏁");
  console.log("======================================================================");
}

runFeeTaxTest().catch((err) => {
  console.error("Terjadi error fatal saat pengujian fee & pajak:", err);
  process.exit(1);
});
