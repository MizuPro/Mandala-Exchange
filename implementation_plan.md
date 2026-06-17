# Implementation Plan - Deep Bug Analyzer End-to-End Trading Flow

Target analisis: End-to-End Trading Flow lintas BEI, MATS, dan SEKURITAS.
Mode: deep.
Fokus: hanya bug krusial yang dapat mengganggu kelancaran flow trading end-to-end, bukan kosmetik atau hardening kecil.

## Ringkasan Temuan

Ditemukan 5 bug krusial yang masih bisa memutus flow utama:

1. Settlement BEI bisa dibuat sebelum semua trade MATS berhasil tercapture di BEI.
2. Failure auto-settlement BEI masih ditelan sehingga MATS menganggap close session sukses.
3. Order SEKURITAS yang gagal submit ke MATS masuk `submit_unknown` dan reservasi dana/saham bisa terkunci permanen.
4. Settlement webhook BEI ke SEKURITAS bisa diskip saat URL tidak dikonfigurasi tetapi batch tetap ditandai sukses/notified.
5. Dead-letter delivery MATS tidak punya mekanisme replay/recovery, sehingga event trade/order penting bisa hilang permanen dari flow.

---

## 1. Critical - BEI Bisa Settlement Sebelum Semua Trade MATS Tercapture

### Lokasi

- `MATS/internal/events/dispatcher.go:172-211`
- `MATS/internal/session/daemon.go:112-117`
- `BEI/src/routes/rules.ts:223-249`
- `BEI/src/routes/settlement.ts:23-35`

### Alur Bug

MATS mengirim trade ke BEI lewat delivery outbox. Jika delivery `trade_final` gagal sementara, event akan masuk status `pending` atau `dead`, bukan langsung blocking matching.

Saat session ditutup, MATS memanggil BEI `/integration/mats/sessions/active/status` dengan status `closed`. BEI langsung membuat dan memproses settlement batch dari isi tabel `trades` yang sudah tercapture saat itu.

Masalahnya, BEI hanya membaca trade yang sudah masuk ke tabel `trades`. Jika ada trade MATS yang masih pending/dead di outbox, trade tersebut tidak ikut settlement batch. End-to-end flow menjadi tidak lengkap: order sudah match di MATS, tetapi tidak pernah settle di BEI/SEKURITAS kecuali ada intervensi manual.

### Dampak

- Trade valid di MATS bisa tidak pernah masuk settlement BEI.
- SEKURITAS tidak menerima settlement untuk trade tersebut.
- Pending cash/securities di SEKURITAS bisa menggantung.
- Reconciliation antar MATS, BEI, dan SEKURITAS menjadi tidak konsisten.

### Rencana Perbaikan

1. Tambahkan barrier finalitas trade sebelum BEI memproses settlement.
2. Saat MATS menutup session, sertakan metadata final seperti `final_trade_sequence` atau `expected_trade_count` untuk session tersebut.
3. Di BEI, simpan metadata finalitas session dan validasi bahwa trade yang tercapture sudah lengkap sebelum settlement batch diproses.
4. Jika trade belum lengkap, jangan proses settlement. Tandai batch sebagai `pending` atau `processing_blocked` dengan alasan `waiting_for_trade_capture`.
5. Tambahkan job/endpoint retry yang memproses ulang settlement setelah trade capture yang tertunda berhasil masuk.
6. Tambahkan test integrasi: satu trade delivery ke BEI dibuat gagal/pending, session ditutup, BEI tidak boleh settle sampai trade tersebut tercapture.

---

## 2. Critical - Failure Auto-Settlement BEI Masih Ditelan

### Lokasi

- `BEI/src/routes/rules.ts:223-256`
- `MATS/internal/session/daemon.go:113-116`

### Alur Bug

Saat BEI menerima status session `closed`, BEI menjalankan auto-settlement di dalam `try/catch`. Jika create/process settlement gagal, error hanya di-log di `catch`, tetapi endpoint tetap bisa menyelesaikan request tanpa mengembalikan failure ke caller.

Di sisi MATS, `UpdateSessionStatus(..., closed)` hanya melihat response endpoint BEI. Jika BEI tidak mengembalikan error, MATS menganggap sinkronisasi close berhasil, padahal settlement gagal.

### Dampak

- Session terlihat sudah closed.
- Settlement bisa gagal tanpa sinyal kuat ke MATS.
- Operator/frontend melihat state session selesai, tetapi cash/securities belum terselesaikan.
- Retry otomatis tidak terjadi karena failure tidak dipropagasikan.

### Rencana Perbaikan

1. Ubah `BEI/src/routes/rules.ts` agar failure auto-settlement tidak ditelan.
2. Jika create/process settlement gagal, endpoint harus mengembalikan error eksplisit atau status yang menyatakan `settlement_trigger_failed`.
3. Simpan failure ke field batch/session audit agar bisa diretry.
4. Di MATS session daemon, tambahkan retry/backoff untuk update status session ke BEI, terutama saat transisi `closed`.
5. Tambahkan test BEI: mock process settlement gagal, endpoint status closed harus mengembalikan failure dan tidak mencatat auto-settlement sukses.

---

## 3. Critical - `submit_unknown` SEKURITAS Bisa Mengunci Reservasi Dana/Saham Permanen

### Lokasi

- `SEKURITAS/backend/src/services/order-service.ts:233-249`
- `SEKURITAS/backend/src/services/order-service.ts:271-278`
- `SEKURITAS/backend/src/services/order-service.ts:633-640`
- `SEKURITAS/frontend/src/components/OrderList.tsx:76`

### Alur Bug

SEKURITAS melakukan reservasi dana/saham lokal sebelum mengirim order ke MATS. Jika request ke MATS error, semua error diperlakukan sebagai `submit_unknown`.

Masalahnya, pada status ini tidak ada mekanisme reconcile yang memastikan apakah MATS benar-benar menerima order atau tidak. Jika MATS tidak menerima order, reservasi lokal tetap terkunci. User juga tidak bisa membatalkan order karena `cancelOrder` mensyaratkan `mats_order_id`, sementara order `submit_unknown` biasanya belum punya `mats_order_id`.

Frontend bahkan menampilkan tombol cancel untuk `submit_unknown`, tetapi backend akan menolak dengan `Order not yet accepted by MATS`.

### Dampak

- Cash buy order bisa terkunci di `reserved`.
- Saham sell order bisa terkunci di `reserved`.
- User tidak punya jalan normal untuk release reservasi.
- Flow trading berikutnya terganggu karena saldo/posisi terlihat tidak tersedia.

### Rencana Perbaikan

1. Bedakan error MATS menjadi:
   - definitive reject/pre-accept failure,
   - transport timeout/unknown,
   - accepted response dengan order snapshot.
2. Untuk definitive pre-accept failure, rollback reservasi dan tandai order `rejected` atau `submission_status=failed`.
3. Untuk transport unknown, buat mekanisme reconciliation berdasarkan `place_idempotency_key` atau `client_order_id`.
4. Tambahkan endpoint/job internal `reconcile submit_unknown`:
   - cek MATS by idempotency/client order,
   - jika ditemukan, apply snapshot ke order lokal,
   - jika tidak ditemukan setelah batas retry, release reservasi dan tandai `failed`.
5. Jangan tampilkan cancel sebagai aksi normal untuk `submit_unknown` sebelum backend mendukung cancel/reconcile status tersebut.
6. Tambahkan test: MATS timeout sebelum menerima order harus release setelah reconcile; MATS timeout setelah menerima order harus menyambungkan `mats_order_id` dan status lokal.

---

## 4. Critical - Settlement Webhook Bisa Diskip Tetapi Batch Ditandai Notified

### Lokasi

- `BEI/src/services/sekuritas-webhook.ts:10-13`
- `BEI/src/routes/settlement.ts:227-240`
- `BEI/src/config.ts:72-73`

### Alur Bug

`postSekuritasWebhook()` mengembalikan `{ skipped: true }` jika URL webhook SEKURITAS tidak dikonfigurasi. Namun caller di settlement process tidak membedakan `skipped` dari pengiriman sukses. Setelah fungsi tersebut return tanpa error, batch settlement bisa ditandai `notificationStatus: "sent"`.

Dalam kondisi konfigurasi tidak lengkap, BEI akan menganggap notifikasi settlement sudah terkirim, padahal SEKURITAS tidak pernah menerima settlement webhook.

### Dampak

- BEI batch terlihat settled dan notified.
- SEKURITAS tidak memindahkan pending cash/securities menjadi available.
- Tidak ada retry karena status sudah dianggap `sent`.
- End-to-end settlement berhenti diam-diam.

### Rencana Perbaikan

1. Untuk target `settlement`, jangan silent-skip jika URL webhook kosong.
2. Ubah `postSekuritasWebhook()` agar missing settlement URL melempar error atau mengembalikan status eksplisit yang tidak boleh dianggap sukses.
3. Di `settlement.ts`, hanya set `notificationStatus="sent"` jika response benar-benar terkirim.
4. Jika URL kosong, set `notificationStatus="failed"` atau `configuration_missing` dan simpan error.
5. Tambahkan validasi startup di production agar `SEKURITAS_SETTLEMENT_WEBHOOK_URL` wajib ada.
6. Tambahkan test BEI: settlement process dengan URL kosong tidak boleh menghasilkan `notificationStatus="sent"`.

---

## 5. High - Dead-Letter Delivery MATS Tidak Bisa Direplay

### Lokasi

- `MATS/internal/events/dispatcher.go:142-169`
- `MATS/internal/events/dispatcher.go:197-211`
- `MATS/internal/api/handlers.go:139-146`

### Alur Bug

Delivery event MATS dipindahkan ke status `dead` setelah melewati `MaxAttempts`. Saat ini endpoint API hanya bisa list delivery events. Tidak ada endpoint atau job untuk requeue/replay event `dead`.

Untuk event biasa ini mungkin hanya observability issue. Tetapi untuk End-to-End Trading Flow, event `trade_final` ke BEI dan `trade_fill/order_status` ke SEKURITAS adalah bagian utama dari state transition. Jika dead-letter tidak bisa direplay, trade atau fill bisa hilang permanen dari downstream.

### Dampak

- BEI bisa tidak pernah menerima trade capture.
- SEKURITAS bisa tidak pernah menerima fill/status order.
- Settlement bisa tertahan karena fill accounting lokal tidak pernah terjadi.
- Operator tidak punya recovery path selain manipulasi database/manual resend.

### Rencana Perbaikan

1. Tambahkan endpoint admin/service-token untuk requeue delivery event berdasarkan ID atau filter status `dead`.
2. Endpoint harus mengubah status `dead` menjadi `pending`, reset `last_error`, set `next_attempt_at=now`, dan opsional menaikkan `max_attempts`.
3. Tambahkan endpoint replay by `target/event_type/session/symbol` untuk operasi pemulihan batch.
4. Tambahkan audit log untuk setiap replay.
5. Tambahkan test: event yang sudah `dead` bisa direqueue dan dispatcher mengirim ulang event tersebut.

---

## Urutan Eksekusi yang Disarankan

1. Perbaiki bug nomor 4 lebih dulu karena paling kecil scope-nya dan langsung mencegah false-positive notified.
2. Perbaiki bug nomor 2 agar failure auto-settlement tidak lagi diam-diam.
3. Perbaiki bug nomor 5 untuk menyediakan recovery path delivery.
4. Perbaiki bug nomor 1 dengan finality barrier trade capture sebelum settlement.
5. Perbaiki bug nomor 3 dengan reconciliation `submit_unknown` dan release reservasi yang aman.

## Validasi Minimal Setelah Fix

1. `MATS`: `go test ./...`
2. `BEI`: `npm test -- --run` dan `npm run build`
3. `SEKURITAS/backend`: `npm test -- --run` dan `npm run build`
4. `SEKURITAS/frontend`: `npm run build`
5. Test manual end-to-end:
   - place buy/sell,
   - match trade,
   - paksa satu delivery gagal lalu replay,
   - close session,
   - settlement BEI terkirim ke SEKURITAS,
   - pending cash/securities berubah menjadi available.

## Status

request_feedback = true

Mohon konfirmasi sebelum implementasi. Plan ini menyentuh tiga ekosistem sekaligus dan membutuhkan perubahan kontrak kecil antar MATS, BEI, dan SEKURITAS.

## Kebutuhan Model

Plan ini sebaiknya dikerjakan oleh model yang lebih advanced daripada Gemini 3 Flash. Sebagian bug membutuhkan reasoning lintas service, idempotency, async delivery, dan settlement finality; Gemini 3 Flash berisiko melewatkan edge case atau membuat kontrak antar service tidak konsisten.
