# Bug Fixing Log - End-to-End Trading Flow

**Tanggal:** 2026-06-18
**Modul/Fitur:** End-to-End Trading Flow
**Mode Analisis:** deep
**Dikerjakan oleh:** Agent + User

---

## Masalah yang Ditemukan

### 1. Settlement Bisa Tidak Pernah Ter-trigger Setelah Finality Barrier Gagal Sementara
- **File:** `MATS/internal/session/daemon.go`, `MATS/internal/events/dispatcher.go`, `MATS/internal/persistence/store.go`, `BEI/src/routes/rules.ts`
- **Deskripsi:** Saat sesi ditutup, BEI dapat menolak settlement karena trade capture belum lengkap. Sebelumnya retry close-session MATS bisa habis lebih cepat daripada retry delivery trade, sehingga trade akhirnya tercapture tetapi settlement tidak otomatis dipicu lagi. Jika `CountSessionTrades` gagal, ada risiko close-session dikirim tanpa finality metadata.
- **Severity:** Critical

### 2. BEI Menganggap Settlement Webhook Sukses Walau SEKURITAS Mengembalikan Deferred 202
- **File:** `BEI/src/services/sekuritas-webhook.ts`, `BEI/src/routes/settlement.ts`, `SEKURITAS/backend/src/routes/bei-webhooks.ts`, `SEKURITAS/backend/src/services/settlement-service.ts`
- **Deskripsi:** SEKURITAS dapat mengembalikan HTTP 202 dengan status domain `deferred` ketika settlement diterima tetapi dependency order/fill belum siap. BEI sebelumnya melihat semua HTTP 2xx sebagai sukses dan menandai notifikasi settlement sebagai `sent`.
- **Severity:** High

### 3. `submit_unknown` SEKURITAS Belum Direkonsiliasi Otomatis dan Bisa Salah Release
- **File:** `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/services/mats-client.ts`, `SEKURITAS/backend/src/app.ts`, `SEKURITAS/backend/src/routes/orders.ts`, `SEKURITAS/frontend/src/store/useStore.ts`, `SEKURITAS/frontend/src/components/OrderEntry.tsx`
- **Deskripsi:** Order yang gagal submit karena transport error masuk `submit_unknown` dan mengunci reservasi sampai endpoint admin dijalankan. Setelah auto-reconcile ditambahkan, ditemukan risiko lanjutan: reservasi bisa dilepas saat MATS sedang down/server error, bukan hanya saat MATS benar-benar menolak atau tidak mengenal order.
- **Severity:** High

### 4. BEI Trade Capture Memakai State Saat Capture, Bukan State Saat Trade Terjadi
- **File:** `BEI/src/routes/trades.ts`, `MATS/internal/events/dispatcher.go`, `MATS/internal/bei/client.go`
- **Deskripsi:** Trade MATS yang valid saat matching bisa ditolak BEI jika saham atau broker berubah status sebelum event async `trade_final` diterima BEI. Ini membuat official trade capture dan settlement gagal walaupun execution awal valid.
- **Severity:** High

---

## Solusi yang Dikerjakan

### 1. Settlement Bisa Tidak Pernah Ter-trigger Setelah Finality Barrier Gagal Sementara
- **Perubahan yang Dilakukan:** Close-session settlement trigger dipindahkan ke delivery event durable `session_closed_finality`. MATS menghitung `expectedTradeCount` sebelum menerbitkan event finality dan tidak lagi fallback mengirim close-session tanpa finality. Event finality tidak masuk `dead` walaupun retry gagal; status tetap `pending` sampai BEI menerima finality. Saat trade capture berhasil, MATS membangunkan finality event yang masih `pending` atau sudah telanjur `dead`.
- **File yang Dimodifikasi:** `MATS/internal/session/daemon.go`, `MATS/internal/session/controller.go`, `MATS/internal/events/dispatcher.go`, `MATS/internal/persistence/store.go`, `MATS/internal/persistence/memory.go`, `MATS/internal/bei/client.go`, `BEI/src/routes/rules.ts`
- **Catatan:** BEI juga menyimpan metadata alasan blokir settlement saat captured trade count belum memenuhi `expectedTradeCount`.

### 2. BEI Menganggap Settlement Webhook Sukses Walau SEKURITAS Mengembalikan Deferred 202
- **Perubahan yang Dilakukan:** `postSekuritasWebhook` sekarang membaca body response dan membedakan `deferred` dari sukses final. `settlement_batches.notification_status` dapat diisi `deferred`, bukan langsung `sent`. BEI menambahkan retry job untuk batch dengan `notification_status` `deferred` atau `failed`.
- **File yang Dimodifikasi:** `BEI/src/services/sekuritas-webhook.ts`, `BEI/src/routes/settlement.ts`
- **Catatan:** Settlement ledger BEI tetap bisa `settled`, tetapi status notifikasi ke broker dipisahkan agar rekonsiliasi tidak salah membaca settlement broker sebagai selesai.

### 3. `submit_unknown` SEKURITAS Belum Direkonsiliasi Otomatis dan Bisa Salah Release
- **Perubahan yang Dilakukan:** Backend SEKURITAS menjalankan auto-reconcile berkala untuk order `submit_unknown`, dengan guard agar tidak overlap dalam satu process dan cleanup interval saat app close. Route place order sekarang mengembalikan HTTP 202 dengan order lokal `submit_unknown` untuk transport unknown, sehingga frontend menampilkan state menunggu konfirmasi. `MatsClientError` ditambahkan agar reconcile dapat membedakan respons definitif dari MATS dengan error transport/server/auth. Reservasi hanya dilepas setelah grace period jika MATS memberi error definitif seperti not found, conflict idempotency, invalid, required, validation, atau rejected.
- **File yang Dimodifikasi:** `SEKURITAS/backend/src/app.ts`, `SEKURITAS/backend/src/routes/orders.ts`, `SEKURITAS/backend/src/services/order-service.ts`, `SEKURITAS/backend/src/services/mats-client.ts`, `SEKURITAS/frontend/src/store/useStore.ts`, `SEKURITAS/frontend/src/components/OrderEntry.tsx`
- **Catatan:** Pada error 5xx, 401, 403, 408, 429, atau error non-HTTP, order tetap `submit_unknown` karena MATS masih mungkin sudah menerima order.

### 4. BEI Trade Capture Memakai State Saat Capture, Bukan State Saat Trade Terjadi
- **Perubahan yang Dilakukan:** Payload trade capture MATS menambahkan snapshot state sederhana (`sessionState`, `securityStatus`, `buyBrokerState`, `sellBrokerState`). BEI tidak lagi menolak trade hanya karena current state security/broker berubah setelah match; validasi capture difokuskan ke keberadaan entity dan snapshot state saat match.
- **File yang Dimodifikasi:** `MATS/internal/bei/client.go`, `MATS/internal/events/dispatcher.go`, `BEI/src/routes/trades.ts`
- **Catatan:** Snapshot saat ini masih sederhana dan statis dari sisi MATS. Untuk audit yang lebih kuat, versi berikutnya sebaiknya memakai rule/session snapshot id yang benar-benar berasal dari cache/rule saat matching.

---

## Pelajaran yang Dipetik

1. Finality signal dalam sistem asynchronous harus durable dan retry sampai sukses; jangan samakan event finality dengan event notifikasi biasa yang boleh masuk dead-letter.
2. HTTP 2xx tidak selalu berarti sukses domain. Response seperti `202 deferred` harus dimodelkan sebagai state bisnis yang berbeda dari `sent` atau `processed`.
3. Status `unknown` tidak boleh diselesaikan dengan asumsi ketika dependency sedang unreachable. Release reservasi hanya aman setelah ada bukti definitif dari sistem tujuan.
4. Worker otomatis harus punya guard terhadap overlap dan lifecycle cleanup agar tidak menambah race condition baru saat aplikasi dibuat ulang atau dites.
5. Validasi event async harus melihat konteks saat event terjadi, bukan hanya state terbaru saat event diterima.
6. Regression test untuk race condition distributed flow perlu dibuat eksplisit; test build hijau belum cukup membuktikan skenario retry, deferred, dan unreachable sudah aman.

---

## Verifikasi

- `MATS`: `go test ./...` lulus, 19 tests.
- `BEI`: `npm test -- --run` lulus, 6 tests.
- `BEI`: `npm run build` lulus.
- `SEKURITAS/backend`: `npm test -- --run` lulus, 8 tests.
- `SEKURITAS/backend`: `npm run build` lulus.
- `SEKURITAS/frontend`: `npm run build` lulus.
