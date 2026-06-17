# Bug Fixing Log - End-to-End Trading Flow

**Tanggal:** 2026-06-17
**Modul/Fitur:** End-to-End Trading Flow
**Mode Analisis:** deep
**Dikerjakan oleh:** Agent + User

---

## Masalah yang Ditemukan

### 1. Payload Trade Fill SEKURITAS Bisa Menimpa Harga Limit Order
- **File:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/routes/mats-webhooks.ts`, `MATS/internal/events/dispatcher.go`
- **Deskripsi:** Payload `trade_fill` dari MATS membawa `price` sebagai harga eksekusi, tetapi handler SEKURITAS ikut memakainya sebagai harga order. Akibatnya harga limit order bisa berubah menjadi harga eksekusi dan reserve remaining buy bisa salah.
- **Severity:** Critical

### 2. Settlement SEKURITAS Bisa Berjalan Tanpa Fill Accounting Lokal
- **File:** `SEKURITAS/backend/src/services/settlement-service.ts`, `SEKURITAS/backend/src/services/order-service.ts`
- **Deskripsi:** Settlement dapat diproses hanya berdasarkan `orders.filled_quantity` walaupun row `trade_fills` lokal belum ada. Jika settlement masuk sebelum fill accounting, reserved cash/shares bisa tetap terkunci.
- **Severity:** Critical

### 3. Event MATS yang Datang Terlambat Bisa Meregresi State Order SEKURITAS
- **File:** `MATS/internal/events/dispatcher.go`, `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/db/schema.ts`
- **Deskripsi:** Order status async dari MATS belum membawa sequence/version yang dipakai SEKURITAS untuk menolak event lama. Retry out-of-order dapat menurunkan status atau menaikkan remaining quantity.
- **Severity:** High

### 4. BEI Auto-Settlement Mengabaikan Failure Process/Notify
- **File:** `BEI/src/routes/rules.ts`, `BEI/src/routes/settlement.ts`, `BEI/src/db/schema.ts`
- **Deskripsi:** Auto-settlement saat session closed tidak mengecek hasil process batch secara lengkap dan tidak menyimpan status notifikasi broker. Settlement bisa terlihat sukses walaupun webhook ke SEKURITAS gagal.
- **Severity:** High

### 5. Async Order Status MATS Tidak Membawa Snapshot Harga dan Original Quantity
- **File:** `MATS/internal/events/dispatcher.go`, `SEKURITAS/backend/src/routes/mats-webhooks.ts`
- **Deskripsi:** Event order status async hanya membawa status/fill/remaining, sehingga recovery amend via event async tidak punya harga dan original quantity authoritative.
- **Severity:** Medium

### 6. Frontend Masih Mengizinkan Quantity yang Tidak Sesuai Lot Size
- **File:** `SEKURITAS/frontend/src/components/OrderEntry.tsx`, `SEKURITAS/frontend/src/components/OrderList.tsx`, `SEKURITAS/backend/src/services/order-service.ts`
- **Deskripsi:** UI dan backend SEKURITAS masih menerima quantity bebas, sementara MATS menolak quantity yang bukan kelipatan lot size.
- **Severity:** Medium

---

## Solusi yang Dikerjakan

### 1. Payload Trade Fill SEKURITAS Bisa Menimpa Harga Limit Order
- **Perubahan yang Dilakukan:** `handleWebhookUpdate` sekarang membedakan standalone `trade_fill` dari order snapshot. `fill.price` hanya dipakai untuk fill accounting, sedangkan `orders.price` hanya diupdate dari payload snapshot order/amend.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/routes/mats-webhooks.ts`
- **Catatan:** Perhitungan reserve remaining buy sekarang memakai harga order, bukan harga eksekusi fill.

### 2. Settlement SEKURITAS Bisa Berjalan Tanpa Fill Accounting Lokal
- **Perubahan yang Dilakukan:** Settlement sekarang defer dengan reason `waiting_for_fill_accounting` jika `trade_fills` untuk `(order_id, trade_id)` belum ada. Settlement service tidak lagi insert `trade_fills` sendiri.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/settlement-service.ts`
- **Catatan:** Settlement diproses setelah fill accounting lokal berhasil dan pending settlement diproses ulang oleh `processPendingSettlementsForOrder`.

### 3. Event MATS yang Datang Terlambat Bisa Meregresi State Order SEKURITAS
- **Perubahan yang Dilakukan:** Menambahkan `last_mats_event_sequence` ke order SEKURITAS dan migration `0005_order_event_sequence.sql`. Handler order menolak event dengan sequence lebih lama, serta menjaga transisi status/remaining tetap monotonic untuk sequence yang sama.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/db/schema.ts`, `SEKURITAS/backend/src/db/migrations/0005_order_event_sequence.sql`, `SEKURITAS/backend/src/services/order-service.ts`
- **Catatan:** Guard ini mencegah event lama seperti `open` menimpa `partially_filled` atau `amended`.

### 4. BEI Auto-Settlement Mengabaikan Failure Process/Notify
- **Perubahan yang Dilakukan:** Auto-settlement sekarang mengecek response process batch. Settlement batch menyimpan `notification_status`, `notification_attempts`, `last_notification_error`, dan `notified_at`; process settlement menandai notifikasi `sent` atau `failed`.
- **File yang Dimodifikasi:** `BEI/src/routes/rules.ts`, `BEI/src/routes/settlement.ts`, `BEI/src/db/schema.ts`, `BEI/src/db/migrate.ts`
- **Catatan:** Replay endpoint belum dibuat; status gagal sudah tersimpan agar bisa diretry lewat pekerjaan lanjutan.

### 5. Async Order Status MATS Tidak Membawa Snapshot Harga dan Original Quantity
- **Perubahan yang Dilakukan:** `OrderStatusPayload` MATS sekarang membawa `price`, `original_quantity`, dan `event_sequence`. Route webhook SEKURITAS menerima field baru ini.
- **File yang Dimodifikasi:** `MATS/internal/events/dispatcher.go`, `SEKURITAS/backend/src/routes/mats-webhooks.ts`
- **Catatan:** Ini membuat event async cukup lengkap untuk sinkronisasi order snapshot.

### 6. Frontend Masih Mengizinkan Quantity yang Tidak Sesuai Lot Size
- **Perubahan yang Dilakukan:** Backend SEKURITAS memvalidasi quantity sebagai kelipatan lot size default 100. Frontend order entry dan amend prompt memakai step/min 100 serta pesan validasi yang sesuai.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/frontend/src/components/OrderEntry.tsx`, `SEKURITAS/frontend/src/components/OrderList.tsx`
- **Catatan:** Lot size masih default `100` melalui `ORDER_LOT_SIZE`; integrasi dinamis dari rule BEI bisa menjadi peningkatan berikutnya.

---

## Pelajaran yang Dipetik

1. Payload event harus dipisahkan berdasarkan makna domain; `price` pada fill bukan hal yang sama dengan `price` pada order snapshot.
2. Settlement tidak boleh melewati tahap fill accounting lokal karena reserve/pending/available punya urutan state yang harus konsisten.
3. Event async lintas service wajib punya sequence/version agar consumer bisa menolak event lama dan menjaga state monotonic.
4. Status proses internal dan status notifikasi eksternal perlu dipisah; ledger settled tidak selalu berarti broker sudah menerima settlement.
5. Recovery async harus membawa snapshot data yang cukup, bukan hanya status ringkas.
6. Validasi UX harus konsisten dengan aturan matching engine agar order gagal bisa dicegah sebelum masuk MATS.
7. Smoke test hijau tidak menjamin race condition aman; test khusus out-of-order webhook dan retry settlement tetap perlu ditambahkan.

---

## Validasi

- `MATS`: `go test ./...` lulus, 18 tests.
- `SEKURITAS/backend`: `npm test -- --run` lulus, 8 tests.
- `SEKURITAS/backend`: `npm run build` lulus.
- `SEKURITAS/frontend`: `npm run build` lulus.
- `BEI`: `npm test -- --run` lulus, 6 tests.
- `BEI`: `npm run build` lulus.
