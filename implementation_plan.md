# Implementation Plan - Deep Bug Analyzer End-to-End Trading Flow

Target analisis: End-to-End Trading Flow lintas MATS, BEI, dan SEKURITAS.
Mode: deep.
Fokus: kelancaran flow user trading dari order entry, matching, trade capture, settlement, sampai portfolio user.

## Ringkasan

Kode saat ini sudah jauh lebih kuat dibanding log bug fixing sebelumnya:

- MATS sudah punya delivery outbox dan endpoint requeue dead-letter.
- BEI sudah tidak lagi silent-skip settlement webhook URL kosong.
- BEI auto-settlement sudah melempar error jika create/process batch gagal.
- SEKURITAS sudah punya settlement inbox dan guard untuk settlement yang datang sebelum fill accounting.
- Test/build utama lulus.

Namun masih ditemukan 4 bug flow yang bisa mengganggu end-to-end trading pada skenario failure, race condition, atau perubahan state pasar yang terjadi bersamaan dengan event async.

request_feedback = true

---

## 1. Critical - Settlement Bisa Tidak Pernah Ter-trigger Setelah Finality Barrier Gagal Sementara

### Lokasi

- `MATS/internal/session/daemon.go:137-168`
- `MATS/internal/session/daemon.go:98-120`
- `MATS/internal/events/dispatcher.go:142-169`
- `MATS/internal/events/dispatcher.go:301-308`
- `BEI/src/routes/rules.ts:217-241`

### Alur Bug

Saat sesi ditutup, MATS memanggil BEI `/integration/mats/sessions/active/status` dengan `status=closed` dan `expectedTradeCount`.

BEI menolak settlement jika jumlah trade yang sudah tercapture lebih kecil dari `expectedTradeCount`. Ini benar sebagai finality barrier.

Masalahnya, MATS hanya retry sinkronisasi close-session 3 kali dengan jeda pendek. Sementara delivery trade ke BEI memakai outbox dengan backoff terpisah. Jika trade capture baru berhasil setelah retry close-session habis, BEI sudah punya semua trade, tetapi tidak ada proses otomatis yang memanggil close-session lagi. Settlement tidak pernah otomatis dibuat/diproses.

Ada masalah tambahan: jika `CountSessionTrades` gagal, MATS fallback mengirim close-session tanpa finality metadata. Ini membuka kembali risiko settlement diproses dengan trade yang belum lengkap.

### Dampak

- Trade valid sudah match di MATS dan akhirnya tercapture di BEI, tetapi settlement tidak berjalan.
- Portfolio SEKURITAS tetap memiliki pending cash/shares.
- User melihat order filled, tetapi aset/cash final tidak masuk available.
- Butuh intervensi manual untuk close-session/settlement ulang.

### Rencana Perbaikan

1. Buat mekanisme durable untuk close-session settlement trigger, misalnya tabel/job `session_close_sync` atau delivery event khusus `session_closed_finality`.
2. Jangan berhenti setelah 3 retry pendek. Retry close-session sampai sukses atau sampai operator menandai failed secara eksplisit.
3. Saat trade delivery BEI berubah menjadi `delivered`, cek apakah session tersebut sudah closed dan close-sync masih pending; jika iya, trigger ulang close-sync.
4. Hapus fallback `UpdateSessionStatus` tanpa `expectedTradeCount` ketika `CountSessionTrades` gagal. Untuk status `closed`, count failure harus membuat close-sync retry, bukan bypass finality.
5. Di BEI, pertimbangkan menyimpan status `settlement_blocked_waiting_trade_capture` ketika finality belum terpenuhi agar operator bisa melihat alasan blokir.
6. Tambahkan test integrasi: satu trade capture tertunda lebih lama dari retry close-session, lalu berhasil. Settlement harus tetap ter-trigger otomatis setelah trade masuk.

---

## 2. High - BEI Menganggap Settlement Webhook Sukses Walau SEKURITAS Mengembalikan Deferred 202

### Lokasi

- `BEI/src/services/sekuritas-webhook.ts:19-33`
- `BEI/src/routes/settlement.ts:227-240`
- `SEKURITAS/backend/src/routes/bei-webhooks.ts:47-55`
- `SEKURITAS/backend/src/services/settlement-service.ts:97-107`

### Alur Bug

SEKURITAS mengembalikan HTTP 202 dengan payload `success: false` dan `status: "deferred"` jika settlement webhook diterima tetapi belum bisa diproses karena order/fill accounting belum siap.

BEI saat ini hanya mengecek `response.ok`. Karena 202 termasuk 2xx, BEI menandai `notificationStatus` sebagai `sent`, walaupun SEKURITAS secara domain belum menyelesaikan settlement detail tersebut.

### Dampak

- BEI batch terlihat sudah notified/sent.
- Detail settlement di SEKURITAS bisa masih `pending_dependency`.
- Jika dependency tidak pernah datang atau proses retry lokal gagal, BEI tidak punya sinyal kuat untuk retry notifikasi atau menandai batch sebagai deferred.
- Reconciliation antar BEI dan SEKURITAS bisa salah membaca status sebagai selesai.

### Rencana Perbaikan

1. Ubah `postSekuritasWebhook` agar membaca response body JSON untuk target `settlement`.
2. Perlakukan HTTP 202 atau body `success: false/status: deferred` sebagai status domain `deferred`, bukan `sent`.
3. Di `settlement_batches`, tambahkan atau gunakan status notifikasi yang lebih eksplisit, misalnya `pending`, `sent`, `deferred`, `failed`.
4. Jika response deferred, simpan detail deferred dan alasan terakhir ke `lastNotificationError` atau metadata terstruktur.
5. Tambahkan retry job BEI untuk settlement notification yang `deferred` atau `failed`.
6. Tambahkan test BEI: mock SEKURITAS response 202 deferred, endpoint process batch tidak boleh menandai notificationStatus `sent`.

---

## 3. High - `submit_unknown` SEKURITAS Belum Direkonsiliasi Otomatis

### Lokasi

- `SEKURITAS/backend/src/services/order-service.ts:271-324`
- `SEKURITAS/backend/src/services/order-service.ts:703-789`
- `SEKURITAS/backend/src/routes/admin.ts:97-105`
- `SEKURITAS/backend/src/app.ts:31-39`
- `SEKURITAS/frontend/src/store/useStore.ts:386-405`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:26-35`

### Alur Bug

Saat submit order ke MATS mengalami transport error yang tidak pasti, backend SEKURITAS menandai order sebagai `submit_unknown` dan mengunci reservasi. Fungsi `reconcileSubmitUnknownOrders` sudah ada, tetapi hanya diekspos melalui endpoint admin `/api/v1/admin/reconcile-orders`.

Tidak ada scheduler, background worker, atau pemanggilan otomatis dari server. Frontend hanya polling portfolio/orders, bukan trigger rekonsiliasi.

Selain itu, route order tetap mengembalikan error 400 ke frontend setelah order lokal dibuat sebagai `submit_unknown`. User menerima pesan "Failed to place order", padahal order sebenarnya mungkin diterima MATS dan sedang menunggu rekonsiliasi.

### Dampak

- Dana/saham user bisa tetap reserved sampai admin menjalankan endpoint manual.
- User flow berhenti di status tidak jelas.
- Jika MATS sebenarnya menerima order, user mungkin mengira order gagal padahal order aktif.
- Jika MATS tidak menerima order, reservasi baru dilepas setelah intervensi admin.

### Rencana Perbaikan

1. Jalankan `reconcileSubmitUnknownOrders` secara otomatis dari backend SEKURITAS, misalnya interval worker setiap 30-60 detik.
2. Pastikan worker aman untuk multi-instance, misalnya memakai row lock/status `reconciling` atau query idempotent.
3. Ubah response `placeOrder` untuk transport unknown: jangan selalu HTTP 400. Kembalikan order lokal dengan status `submit_unknown` dan HTTP 202 agar frontend bisa menampilkan state yang benar.
4. Frontend harus refresh orders/portfolio setelah response 202 dan menampilkan status unknown sebagai "menunggu konfirmasi", bukan gagal final.
5. Tambahkan test backend: order masuk unknown, worker dipanggil otomatis/manual, jika MATS mengembalikan idempotent existing order maka order lokal tersinkron; jika lewat grace period dan MATS tetap error not found maka reservasi dilepas.

---

## 4. High - BEI Trade Capture Memakai State Saat Capture, Bukan State Saat Trade Terjadi

### Lokasi

- `BEI/src/routes/trades.ts:31-43`
- `BEI/src/routes/issuers.ts:281-314`
- `BEI/src/routes/brokers.ts:36-64`
- `MATS/internal/events/dispatcher.go:225-246`

### Alur Bug

Trade di MATS sudah valid pada saat matching karena MATS memakai rules/cache BEI saat order diterima dan match terjadi.

Tetapi delivery trade ke BEI bersifat async. Jika sebelum event `trade_final` berhasil terkirim:

- saham di BEI berubah menjadi `suspended` atau `delisted`, atau
- broker berubah menjadi `suspended`/`inactive`,

maka `/trades/capture` akan menolak trade tersebut karena validasi memakai state BEI saat capture diterima, bukan state saat trade terjadi.

Trade yang sah secara execution-time bisa masuk dead-letter dan tidak pernah ikut settlement.

### Dampak

- User sudah mendapat fill dari MATS, tetapi BEI tidak mencatat official trade.
- Settlement final tidak terjadi untuk trade tersebut.
- Cash/shares user di SEKURITAS tetap pending.
- Operator perlu recovery manual walaupun trade awalnya valid.

### Rencana Perbaikan

1. Pisahkan validasi trade capture untuk final trade dari validasi order entry.
2. Untuk trade yang dikirim MATS, BEI harus memverifikasi integritas event dan idempotency, tetapi tidak boleh menolak hanya karena status security/broker berubah setelah `occurredAt`.
3. Simpan snapshot status/rule yang dipakai MATS saat matching ke payload trade, misalnya `rule_version`, `security_status_at_match`, `broker_status_at_match`, atau session/rule snapshot id.
4. Jika BEI tetap perlu menandai anomali, capture trade sebagai official lalu buat surveillance/reconciliation flag, bukan menolak settlement path.
5. Tambahkan test: trade terjadi saat symbol listed/broker active, lalu symbol/broker diubah sebelum delivery. BEI harus tetap capture trade dan settlement tetap berjalan.

---

## Verifikasi Yang Sudah Dilakukan

- `MATS`: `go test ./...` lulus, 19 tests.
- `BEI`: `npm test -- --run` lulus, 6 tests.
- `BEI`: `npm run build` lulus.
- `SEKURITAS/backend`: `npm test -- --run` lulus, 8 tests.
- `SEKURITAS/backend`: `npm run build` lulus.
- `SEKURITAS/frontend`: `npm run build` lulus.

## Catatan Eksekusi

Plan ini menyentuh alur distributed transaction/asynchronous delivery lintas tiga service. Bisa dieksekusi bertahap oleh Gemini 3 Flash jika scope dipotong per bug dan test sudah jelas. Untuk eksekusi sekaligus end-to-end, terutama desain durable close-session retry dan kontrak deferred settlement, disarankan memakai model yang lebih advanced karena butuh reasoning lintas service, idempotency, retry semantics, dan test integrasi.
