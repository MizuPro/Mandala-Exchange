# Bug Fixing Log - End-to-End Trading Flow

**Tanggal:** 2026-06-17
**Modul/Fitur:** End-to-End Trading Flow
**Mode Analisis:** soft
**Dikerjakan oleh:** Agent + User

---

## Masalah yang Ditemukan

### 1. Retry Settlement BEI Bisa Double-Settle Sesi yang Sama
- **File:** `BEI/src/routes/settlement.ts`, `BEI/src/db/schema.ts`, `BEI/src/db/migrate.ts`
- **Deskripsi:** Settlement batch dibuat ulang untuk `session_id` yang sama. Idempotency instruction memakai `batch.id`, sehingga retry create/process settlement dapat menghasilkan instruction dan ledger baru untuk trade yang sama.
- **Severity:** Critical

### 2. Settlement SEKURITAS Bisa Hilang Jika BEI Datang Sebelum Fill MATS Lokal
- **File:** `SEKURITAS/backend/src/services/settlement-service.ts`, `SEKURITAS/backend/src/routes/bei-webhooks.ts`, `SEKURITAS/backend/src/db/schema.ts`
- **Deskripsi:** Settlement webhook yang tiba sebelum order/fill lokal siap hanya di-silent return, sementara route webhook tetap mengembalikan sukses. Akibatnya settlement detail bisa hilang permanen tanpa retry.
- **Severity:** Critical

### 3. Accepted Amend SEKURITAS Tidak Menyinkronkan Price dan Quantity Lokal
- **File:** `SEKURITAS/backend/src/services/order-service.ts`
- **Deskripsi:** Setelah MATS menerima amend, order lokal tidak selalu memperbarui `price`, `original_quantity`, `remaining_quantity`, dan `reserved_amount`. State lokal bisa berbeda dari MATS dan memengaruhi fill, cancel, expire, atau settlement berikutnya.
- **Severity:** High

### 4. Idempotency Amend/Cancel MATS Tidak Persisten Setelah Restart
- **File:** `MATS/internal/orders/service.go`, `MATS/internal/persistence/store.go`, `MATS/internal/persistence/memory.go`, `MATS/db/migrations/001_init.sql`
- **Deskripsi:** MATS hanya mengandalkan memory cache dan lookup `mats_orders.idempotency_key`, yang cocok untuk place order tetapi tidak untuk amend/cancel. Retry setelah restart dapat berubah menjadi error berbeda atau response tidak deterministik.
- **Severity:** High

---

## Solusi yang Dikerjakan

### 1. Retry Settlement BEI Bisa Double-Settle Sesi yang Sama
- **Perubahan yang Dilakukan:** Settlement batch dibuat idempotent per `session_id` dengan get-or-create. Idempotency key instruction dan webhook settlement dibuat stabil berbasis `sessionId` dan trade, bukan `batch.id` baru.
- **File yang Dimodifikasi:** `BEI/src/routes/settlement.ts`, `BEI/src/db/schema.ts`, `BEI/src/db/migrate.ts`
- **Catatan:** Menambahkan unique index `settlement_batches_session_uq`. Retry create settlement untuk session yang sama sekarang memakai batch lama.

### 2. Settlement SEKURITAS Bisa Hilang Jika BEI Datang Sebelum Fill MATS Lokal
- **Perubahan yang Dilakukan:** Menambahkan tabel `settlement_inbox` untuk menyimpan inbound settlement detail. `processSettlement` sekarang mengembalikan status eksplisit `processed`, `duplicate`, atau `deferred`; dependency yang belum siap ditandai `pending_dependency` dan dapat diproses ulang setelah webhook MATS masuk.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/db/schema.ts`, `SEKURITAS/backend/src/db/migrations/0004_settlement_inbox.sql`, `SEKURITAS/backend/src/services/settlement-service.ts`, `SEKURITAS/backend/src/routes/bei-webhooks.ts`, `SEKURITAS/backend/src/services/order-service.ts`
- **Catatan:** Route webhook BEI sekarang mengembalikan HTTP 202 jika ada settlement yang deferred, bukan selalu sukses kosong.

### 3. Accepted Amend SEKURITAS Tidak Menyinkronkan Price dan Quantity Lokal
- **Perubahan yang Dilakukan:** Payload internal dari response MATS sekarang membawa `price` dan `original_quantity`. `handleWebhookUpdate` menyimpan state amend accepted ke order lokal dan menghitung ulang `reserved_amount` berdasarkan price/remaining terbaru.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/services/order-service.ts`
- **Catatan:** Adjustment reserve buy/sell dibuat mengikuti hasil amend accepted agar tidak dobel release dan tidak menyimpan reserve lama.

### 4. Idempotency Amend/Cancel MATS Tidak Persisten Setelah Restart
- **Perubahan yang Dilakukan:** Menambahkan repository `mats_idempotency_records` di interface store, implementasi Postgres, dan MemoryStore. Amend/cancel sekarang menyimpan response dengan request hash, lalu retry dengan key sama mengembalikan response lama. Key sama dengan payload berbeda ditolak sebagai conflict.
- **File yang Dimodifikasi:** `MATS/internal/orders/service.go`, `MATS/internal/orders/service_test.go`, `MATS/internal/persistence/store.go`, `MATS/internal/persistence/memory.go`, `MATS/db/migrations/001_init.sql`, `MATS/db/migrations/002_idempotency_request_hash.sql`
- **Catatan:** Menambahkan test `TestServiceCancelIdempotencyPersistsAfterRestart` untuk memastikan retry cancel setelah restart tetap deterministik.

---

## Pelajaran yang Dipetik

1. Idempotency key harus stabil pada level domain event, bukan bergantung pada row baru seperti `batch.id` atau `instruction.id`.
2. Webhook async tidak boleh silent return saat dependency belum siap; payload harus dipersist ke inbox/outbox agar bisa retry.
3. State lokal broker harus mengikuti state authoritative dari MATS setelah amend accepted, termasuk harga, quantity, remaining, dan reservation.
4. Memory idempotency hanya cukup untuk retry dalam proses yang sama; operation penting seperti amend/cancel perlu persistent idempotency record.
5. Request hash wajib disimpan bersama idempotency key untuk mencegah key yang sama dipakai ulang dengan payload berbeda.
6. Smoke test hijau belum cukup untuk race condition lintas service; perlu test khusus untuk retry settlement, webhook out-of-order, dan amend accepted.
7. Auto-settlement BEI masih perlu desain recovery/retry operasional terpisah agar session closed tidak menutupi settlement notification yang gagal.

---

## Validasi

- `MATS`: `go test ./...` lulus, 18 tests.
- `SEKURITAS/backend`: `npm test -- --run` lulus, 8 tests.
- `SEKURITAS/backend`: `npm run build` lulus.
- `BEI`: `npm test -- --run` lulus, 6 tests.
- `BEI`: `npm run build` lulus.
