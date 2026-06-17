# Bug Fixing Log — End-to-End Trading Flow

**Tanggal:** 2026-06-17
**Modul/Fitur:** End-to-End Trading Flow
**Mode Analisis:** deep
**Dikerjakan oleh:** Gemini 3.1 Pro + User

---

## 🐛 Masalah yang Ditemukan

### 1. BEI Bisa Settlement Sebelum Semua Trade MATS Tercapture
- **File:** `MATS/internal/events/dispatcher.go`, `BEI/src/routes/rules.ts`
- **Deskripsi:** MATS mengirim `closed` session ke BEI, yang langsung mentrigger settlement di BEI tanpa memastikan seluruh trade dari MATS telah berhasil diterima/dicapture oleh BEI. Trade yang tertahan di outbox MATS tidak terhitung.
- **Severity:** Critical

### 2. Failure Auto-Settlement BEI Ditelan Silently
- **File:** `BEI/src/routes/rules.ts`, `MATS/internal/session/daemon.go`
- **Deskripsi:** `rules.ts` menangkap error di fungsi auto-settlement dan tidak melemparkannya kembali ke HTTP response. Akibatnya MATS melihat request "close session" sukses dan tidak me-retry padahal status di BEI masih menggantung.
- **Severity:** Critical

### 3. `submit_unknown` SEKURITAS Mengunci Reservasi Dana/Saham Permanen
- **File:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/frontend/src/components/OrderList.tsx`
- **Deskripsi:** Jika submit order ke MATS menghasilkan error, order ditandai `submit_unknown` tetapi tidak ada mekanisme untuk memastikan status pastinya. Hal ini mengunci reservasi selamanya.
- **Severity:** Critical

### 4. Settlement Webhook Diskip Tapi Batch Ditandai Notified
- **File:** `BEI/src/services/sekuritas-webhook.ts`, `BEI/src/routes/settlement.ts`
- **Deskripsi:** Saat webhook URL tidak di-set, `postSekuritasWebhook` me-return `{skipped: true}` tanpa error. Proses settlement menganggap notifikasi berhasil terkirim sehingga batch ditandai selesai (notified).
- **Severity:** Critical

### 5. Dead-Letter Delivery MATS Tidak Bisa Direplay
- **File:** `MATS/internal/events/dispatcher.go`, `MATS/internal/persistence/store.go`
- **Deskripsi:** Event penting (seperti trade) yang masuk ke dead-letter karena maksimum retry limit, terkunci permanen di database karena tidak ada kapabilitas admin untuk me-requeue (replay) event-event tersebut.
- **Severity:** High

---

## ✅ Solusi yang Dikerjakan

### 1. BEI Bisa Settlement Sebelum Semua Trade MATS Tercapture
- **Perubahan yang Dilakukan:** Menggunakan "finality barrier". Mengirim `expectedTradeCount` dari MATS setiap memanggil `closed` session. BEI lalu memvalidasi jumlah trade yang ada di databasenya melawan nilai ini; menolak settlement (throw error) bila trade belum sinkron, agar MATS me-retry kembali nanti.
- **File yang Dimodifikasi:** `MATS/internal/bei/client.go`, `MATS/internal/session/daemon.go`, `MATS/internal/session/controller.go`, `MATS/internal/orders/service.go`, `BEI/src/routes/rules.ts`.
- **Catatan:** Membutuhkan penambahan property `expectedTradeCount` ke antarmuka komunikasi MATS ↔ BEI.

### 2. Failure Auto-Settlement BEI Ditelan Silently
- **Perubahan yang Dilakukan:** Menghapus wrapper `try/catch` agar error bubble-up dan dikembalikan sebagai HTTP error dari `rules.ts`. Di MATS daemon, ditambahkan fungsi `syncSessionToBEIWithRetry` dengan exponential backoff retry.
- **File yang Dimodifikasi:** `BEI/src/routes/rules.ts`, `MATS/internal/session/daemon.go`.
- **Catatan:** -

### 3. `submit_unknown` SEKURITAS Mengunci Reservasi Dana/Saham Permanen
- **Perubahan yang Dilakukan:** Memisahkan error timeout transport (dipertahankan sebagai `submit_unknown`) dan error definitive dari MATS (400 validation, langsung dirollback). Ditambahkan juga fungsi otomatis `reconcileSubmitUnknownOrders` yang menembak ke MATS dengan Idempotency Key yang sama — sinkronkan jika ada di MATS, lepaskan/rollback reservasi bila MATS benar-benar tak kenal setelah 5 menit (Grace Period). Frontend dimodifikasi untuk menghapus tombol cancel pada status unknown.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/routes/admin.ts`, `SEKURITAS/frontend/src/components/OrderList.tsx`.
- **Catatan:** Integrasi mengandalkan fitur Idempotency dari backend MATS.

### 4. Settlement Webhook Diskip Tapi Batch Ditandai Notified
- **Perubahan yang Dilakukan:** Memastikan pengiriman throw error jika targetnya adalah `settlement` dan URL tidak disetup. Menambahkan validasi startup agar `SEKURITAS_SETTLEMENT_WEBHOOK_URL` mutlak required bila berada di production.
- **File yang Dimodifikasi:** `BEI/src/services/sekuritas-webhook.ts`, `BEI/src/config.ts`.
- **Catatan:** -

### 5. Dead-Letter Delivery MATS Tidak Bisa Direplay
- **Perubahan yang Dilakukan:** Menambahkan dukungan interface DB (`RequeueDeadDeliveryEvent`), handler `RequeueDeliveryEvent` dan endpoint admin `/admin/delivery-events/{eventId}/requeue` (termasuk batch `requeue-all`) untuk mengembalikan event `dead` menjadi `pending` agar di-pickup lagi oleh dispatcher.
- **File yang Dimodifikasi:** `MATS/internal/persistence/store.go`, `MATS/internal/persistence/memory.go`, `MATS/internal/api/handlers.go`, `MATS/internal/httpserver/router.go`, `MATS/internal/events/dispatcher_test.go`.
- **Catatan:** -

---

## 📚 Pelajaran yang Dipetik

1. **Selalu Propagasi Error ke Lapis Atas**: Handler HTTP untuk state yang terdistribusi secara asinkron (mis. perintah sinkronisasi `closed` ke `settlement`) harus meretur status gagal dengan jelas, bukan menelannya; agar komponen hulu mampu melakukan proses *Retry*.
2. **Fail-Fast pada Konfigurasi Sistem Kritis**: Jangan silent-skip dan mengasumsikan keberhasilan manakala URL webhook infrastruktur tak disediakan. Harus divalidasi ketat dan menahan start-up server (Fail-fast) di lingkungan produksi.
3. **Bangun Transisi State Menggunakan Finality Barrier**: Pada aliran asynchronous (contoh: trade yang ditransfer vs sinyal close session), hindari bahaya *race condition* dengan merajut "Batas Final" seperti melampirkan *Expected Item Count* untuk memvalidasi kelengkapan data sebelum pemrosesan diakhiri.
4. **Resiliensi Idempotensi Atas Status Unknown**: Saat transportasi pesan antara 2 ekosistem bermasalah/timeout, jangan membatalkan proses begitu saja (yang mungkin sebenarnya telah dikerjakan lawannya). Pertahankan sebagai status "Unknown", dan rekonsiliasi state via kunci idempoten (Idempotency Key).
5. **Kebutuhan Tooling Replay/Rekonsiliasi**: Implementasi pergerakan data asinkronus (outbox pattern / webhook / dead-letters) tidaklah tuntas tanpa tersedianya fungsionalitas admin endpoint atau jobs untuk menangani *Replay* event maupun rekonsiliasi data. Ketiadaannya berdampak fatal bila terjadi kebuntuan di masa lalu.
