# Implementation Plan Bug Analyzer - SEKURITAS Frontend, Backend, MATS, dan BEI

Mode analisis: deep.
Target: `SEKURITAS` frontend/backend dan integrasi lintas layanan dengan `MATS` serta `BEI`.
request_feedback = true

## Status Implementasi

Status: sebagian besar bug prioritas sudah dikerjakan pada sesi ini.

Perubahan yang sudah diterapkan:
- Backend Sekuritas tidak lagi mengubah order menjadi `rejected` saat submit ke MATS gagal karena network/timeout; order masuk status lokal `submit_unknown` dan reservation tidak dilepas.
- Backend Sekuritas menyimpan metadata submission order, memproses fill berdasarkan `trade_id`, menerima event lewat `client_order_id` atau `mats_order_id`, dan tidak menggandakan accounting saat event cumulative dan trade fill datang terpisah.
- Backend Sekuritas memakai fee service berbasis fee schedule BEI dengan fallback lokal, bukan konstanta fee yang tersebar.
- Settlement Sekuritas sekarang mewajibkan `trade_id`, `idempotency_key`, `price`, dan `quantity`.
- Status `locked_non_cancellable` diperlakukan sebagai action status sementara, bukan status utama order.
- Route amend order Sekuritas ditambahkan dan UI OrderList bisa mengirim amend.
- MATS mengirim event `trade_fill` ke Sekuritas untuk sisi buy dan sell, serta WebSocket MATS dapat menerima token via query `access_token` untuk browser.
- BEI mengirim settlement webhook ke Sekuritas setelah batch settlement selesai, dengan detail per trade dan per sisi order.
- Frontend Sekuritas memiliki flow verify email, tidak langsung membawa user unverified ke dashboard trading, dan punya market WebSocket panel dasar.
- Test BEI contract guard yang sebelumnya timeout sudah dibuat memakai lifecycle app/DB yang deterministic.

Catatan sisa:
- Corporate action Sekuritas masih mengembalikan `501` secara eksplisit. Ini aman dari sukses palsu, tetapi pemrosesan penuh dividend/split/rights belum diimplementasikan.
- Reconciliation lengkap BEI custody vs portfolio Sekuritas, leaderboard, notification center, dan company analysis masih merupakan gap fitur PRD, bukan bug integrasi inti yang dibereskan di sesi ini.

## Ringkasan Validasi

Validasi yang sudah dijalankan:
- `SEKURITAS/backend`: `rtk npm run build` berhasil.
- `SEKURITAS/backend`: `rtk npm test -- --run` berhasil, 4 file test dan 8 test lulus.
- `SEKURITAS/frontend`: `rtk npm run build` berhasil.
- `MATS`: `rtk go test ./...` berhasil, 12 test lulus di 16 package.
- `BEI`: `rtk npm run build` berhasil.
- `BEI`: `rtk npm test -- --run` berhasil, 1 file test dan 6 test lulus.

Kesimpulan utama:
- Build Sekuritas dan MATS sudah sehat, tetapi integrasi finansial belum aman end-to-end.
- Bug paling berbahaya ada di boundary order submission, fill/trade detail, fee/reservation, settlement notification, dan UI yang belum memakai market data realtime.
- Beberapa hardening dari plan sebelumnya sudah ada, misalnya password `scrypt`, admin token, active-user middleware, service-token webhook, unique constraint, dan settlement event idempotency. Namun beberapa perbaikannya belum lengkap secara sistemik.

## Bug Kritis dan Rencana Perbaikan

### 1. Order bisa hidup di MATS tetapi dianggap rejected oleh Sekuritas saat timeout/network error

Lokasi:
- `SEKURITAS/backend/src/services/order-service.ts:73`
- `SEKURITAS/backend/src/services/order-service.ts:106`
- `SEKURITAS/backend/src/services/order-service.ts:123`
- `SEKURITAS/backend/src/services/order-service.ts:130`
- `SEKURITAS/backend/src/services/order-service.ts:151`
- `SEKURITAS/backend/src/services/order-service.ts:156`
- `SEKURITAS/backend/src/services/order-service.ts:261`
- `MATS/internal/orders/service.go:103`
- `MATS/internal/orders/service.go:466`

Masalah:
- Sekuritas melakukan reserve cash/saham, lalu mengirim order ke MATS.
- Jika request ke MATS timeout setelah MATS sebenarnya menerima order, Sekuritas memanggil `handleWebhookUpdate` dengan status `rejected`, melepas reservation, dan mengembalikan error ke UI.
- Jika webhook MATS datang belakangan, `handleWebhookUpdate` mengabaikan order terminal karena status lokal sudah `rejected`.
- Akibatnya ada order aktif/matched di MATS tanpa reservation cash/saham di Sekuritas.
- Idempotency key place dibuat random tetapi tidak disimpan di DB, sehingga retry aman ke MATS tidak mungkin dilakukan setelah proses gagal.

Langkah perbaikan:
1. Tambahkan kolom `submission_status`, `place_idempotency_key`, dan `last_submission_error` di `orders`.
2. Saat gagal network/timeout, jangan ubah order menjadi `rejected`; gunakan status lokal seperti `submit_unknown` atau `pending_submission`.
3. Simpan idempotency key dan buat worker/retry endpoint yang mengulang request MATS dengan idempotency key yang sama.
4. Jangan release reservation sampai MATS memberi status final `rejected/cancelled/expired/filled` yang valid.
5. Ubah guard terminal agar rejected lokal karena submit failure tidak memblokir event MATS yang valid.
6. Tambahkan test: MATS menerima order tetapi response timeout, lalu webhook accepted/filled datang belakangan.

### 2. Sekuritas tidak menerima detail trade aktual dari MATS, sehingga accounting fill dan settlement memakai limit price

Lokasi:
- `SEKURITAS/backend/src/services/order-service.ts:21`
- `SEKURITAS/backend/src/services/order-service.ts:120`
- `SEKURITAS/backend/src/services/order-service.ts:166`
- `SEKURITAS/backend/src/services/order-service.ts:173`
- `SEKURITAS/backend/src/routes/mats-webhooks.ts:6`
- `MATS/internal/events/dispatcher.go:64`
- `MATS/internal/events/dispatcher.go:80`
- `MATS/internal/events/dispatcher.go:287`
- `MATS/internal/domain/types.go:87`
- `MATS/docs/api-contracts.md:147`

Masalah:
- MATS memiliki `Trade` lengkap berisi `id`, `price`, `quantity`, buy/sell order id, account id, dan idempotency key.
- Event order status MATS ke Sekuritas hanya membawa cumulative `filled_quantity` dan `remaining_quantity`, tanpa `trade_id`, `price`, `quantity fill`, atau daftar trades.
- Response sinkron MATS pada place/amend dapat membawa `trades`, tetapi `matsOrderToWebhookPayload` membuang data tersebut.
- Sekuritas akhirnya memakai `payload.price || payload.average_price || order.price`, yang biasanya jatuh ke limit price.
- Partial fill di beberapa harga atau price improvement akan salah di cash pending, average price, realized P/L, dan settlement.

Langkah perbaikan:
1. Ubah kontrak MATS -> Sekuritas agar mengirim event `trade_fill` terpisah atau menambahkan `fills` pada `order_status`.
2. Isi minimal `trade_id`, `mats_order_id`, `client_order_id`, `side`, `price`, `quantity`, `occurred_at`, dan `idempotency_key`.
3. Di Sekuritas, proses fill per trade id, bukan dari selisih cumulative quantity saja.
4. Ubah `matsOrderToWebhookPayload` agar tidak membuang `trades` dari response sinkron MATS.
5. Update `mats-webhooks.ts` schema untuk menerima dan memvalidasi payload fill.
6. Tambahkan test partial fill dua harga berbeda dan replay trade id yang sama.

### 3. BEI tidak pernah mengirim settlement/corporate-action webhook ke Sekuritas

Lokasi:
- `SEKURITAS/backend/src/routes/bei-webhooks.ts:29`
- `SEKURITAS/backend/src/routes/bei-webhooks.ts:50`
- `SEKURITAS/backend/src/services/settlement-service.ts:37`
- `BEI/src/routes/settlement.ts:38`
- `BEI/src/routes/settlement.ts:96`
- `BEI/src/routes/settlement.ts:179`
- `BEI/src/routes/corporate-actions.ts:85`
- `BEI/.env.example:5`

Masalah:
- Sekuritas menyediakan endpoint BEI settlement dan corporate action webhook.
- BEI memproses settlement batch dan custody ledger, tetapi tidak punya konfigurasi URL Sekuritas, token outbound, atau HTTP dispatcher ke `/internal/webhook/bei/settlement`.
- Akibatnya pending cash/pending shares di Sekuritas tidak pernah otomatis menjadi available setelah settlement BEI.
- Corporate action di Sekuritas sengaja `501`, sementara BEI sudah punya proses corporate action ledger.

Langkah perbaikan:
1. Tambahkan config BEI: `SEKURITAS_SETTLEMENT_WEBHOOK_URL`, `SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL`, dan `BEI_TO_SEKURITAS_TOKEN`.
2. Setelah settlement batch `settled`, BEI harus mengirim detail per trade ke Sekuritas dengan `mats_order_id`, `mats_trade_id`, `price`, `quantity`, `side`, `idempotency_key`, dan timestamp.
3. Tambahkan delivery retry/dead-letter sederhana di BEI atau tabel delivery event seperti MATS.
4. Untuk corporate action, pilih salah satu: implement konsumsi aman di Sekuritas atau jangan expose klaim fitur selesai di UI/dokumen.
5. Tambahkan integration test BEI settlement process -> Sekuritas webhook fake.

### 4. Fee backend Sekuritas hardcoded dan bisa berbeda dari BEI/frontend

Lokasi:
- `SEKURITAS/backend/src/services/order-service.ts:10`
- `SEKURITAS/backend/src/services/order-service.ts:34`
- `SEKURITAS/backend/src/services/order-service.ts:98`
- `SEKURITAS/backend/src/services/order-service.ts:168`
- `SEKURITAS/backend/src/services/settlement-service.ts:11`
- `SEKURITAS/backend/src/services/settlement-service.ts:15`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx:44`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx:51`
- `BEI/src/routes/rules.ts:222`

Masalah:
- Frontend menghitung estimasi fee dari fee schedule BEI.
- Backend Sekuritas melakukan reservation memakai konstanta `0.0015`.
- Settlement backend memakai formula lain: broker fee, levy, VAT, dan WHT.
- Jika fee aktual lebih besar dari estimasi reserve, settlement BUY dapat mengurangi available cash dan menghasilkan saldo negatif.
- UI bisa menampilkan total required yang berbeda dari backend, sehingga order bisa gagal meskipun UI terlihat cukup, atau sebaliknya.

Langkah perbaikan:
1. Buat `fee-service` di backend Sekuritas yang mengambil dan cache fee schedule dari BEI.
2. Gunakan formula fee yang sama untuk UI estimate, reservation backend, fill pending, settlement, ledger, dan realized P/L.
3. Simpan snapshot fee rate pada order/fill agar audit tidak berubah saat fee schedule BEI diperbarui.
4. Tambahkan invariant DB/app: cash `available`, `reserved`, dan `pending` tidak boleh negatif.
5. Tambahkan test fee mismatch: frontend estimate, backend reserve, dan settlement harus menghasilkan angka sama.

### 5. Settlement idempotency masih rapuh untuk multi-fill dan payload tanpa trade id

Lokasi:
- `SEKURITAS/backend/src/services/settlement-service.ts:28`
- `SEKURITAS/backend/src/services/settlement-service.ts:42`
- `SEKURITAS/backend/src/services/settlement-service.ts:47`
- `SEKURITAS/backend/src/services/settlement-service.ts:49`
- `SEKURITAS/backend/src/services/settlement-service.ts:54`
- `SEKURITAS/backend/src/services/settlement-service.ts:70`
- `SEKURITAS/backend/src/routes/bei-webhooks.ts:6`

Masalah:
- Schema webhook mengizinkan settlement detail tanpa `trade_id`, `price`, dan `quantity`.
- Fallback idempotency key adalah `settlement:${matsOrderId}:${order.id}`, sehingga beberapa settlement untuk order yang sama dapat dianggap duplikat dan hanya yang pertama diproses.
- Jika BEI mengirim aggregate per order, Sekuritas tidak bisa membedakan fill mana yang sudah disettle.
- `Math.min(quantity, order.filled_quantity)` tidak mempertimbangkan quantity yang sudah disettle sebelumnya selain idempotency key.

Langkah perbaikan:
1. Jadikan `trade_id`, `price`, `quantity`, dan `idempotency_key` wajib untuk settlement detail.
2. Jika BEI ingin kirim aggregate, definisikan `settlement_batch_id` dan `settlement_line_id` unik per line.
3. Simpan `settled_quantity` per fill atau gunakan `settlement_events` per trade id.
4. Tolak payload settlement yang tidak cukup granular dengan 400, bukan silently fallback.
5. Tambahkan test dua trade pada satu order dan replay salah satu trade.

### 6. Status `locked_non_cancellable` diperlakukan seperti status order permanen

Lokasi:
- `SEKURITAS/backend/src/services/order-service.ts:137`
- `SEKURITAS/backend/src/services/order-service.ts:248`
- `SEKURITAS/frontend/src/components/OrderList.tsx:47`
- `MATS/internal/orders/service.go:195`
- `MATS/internal/orders/service.go:285`

Masalah:
- Saat cancel/amend ditolak karena non-cancellation period, MATS mengembalikan order dengan status `locked_non_cancellable`.
- Sekuritas menyimpan status itu sebagai status order utama.
- UI tidak mengizinkan cancel lagi karena `locked_non_cancellable` tidak masuk daftar `canCancel`.
- Status ini seharusnya event/reason sementara untuk request cancel/amend, bukan mengganti status order open/partial secara permanen.

Langkah perbaikan:
1. Bedakan `order.status` dan `last_action_status` atau `last_cancel_reject_reason`.
2. Jangan ubah order utama menjadi `locked_non_cancellable`; pertahankan `open/partially_filled/amended`.
3. Tampilkan badge non-cancellable berdasarkan session state dari MATS WebSocket, bukan status order terminal.
4. MATS sebaiknya publish rejection event eksplisit untuk action cancel/amend.
5. Tambahkan test cancel di non-cancellation period lalu setelah session berubah cancel dapat dicoba lagi.

### 7. Frontend belum terkoneksi ke MATS WebSocket dan belum menampilkan market data realtime

Lokasi:
- `SEKURITAS/frontend/src/store/useStore.ts:162`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:21`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:22`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx:95`
- `MATS/internal/httpserver/router.go:61`
- `MATS/internal/marketdata/ws.go:68`
- `MATS/docs/api-contracts.md:84`

Masalah:
- PRD mewajibkan frontend subscribe langsung ke WebSocket MATS untuk order book, trade tape, last price, session state, IEP/IEV, halt, special notation, dan market summary.
- Frontend saat ini hanya fetch BEI securities/fees via backend dan polling portfolio/order tiap 5 detik.
- Tidak ada config `VITE_MATS_WS_URL`, tidak ada token market-read, dan tidak ada komponen order book/ticker/session state.
- MATS WebSocket memerlukan `x-service-token`, tetapi browser WebSocket native tidak bisa mengirim header custom.

Langkah perbaikan:
1. Putuskan arsitektur market data browser: proxy WebSocket via backend Sekuritas atau gunakan token URL/subprotocol yang aman untuk public market read.
2. Tambahkan `VITE_MATS_WS_URL` hanya jika mekanisme auth browser-compatible sudah tersedia.
3. Implement store market data untuk `depth_snapshot`, `best_bid_ask`, `last_price`, `trade_tape`, `session_state`, `market_halt`, dan `heartbeat`.
4. Tambahkan UI market panel di Dashboard dan integrasikan symbol yang dipilih di OrderEntry.
5. Tambahkan reconnect/backoff dan fallback snapshot.

### 8. Flow register/verifikasi frontend rusak untuk user `unverified`

Lokasi:
- `SEKURITAS/backend/src/routes/auth.ts:30`
- `SEKURITAS/backend/src/routes/auth.ts:60`
- `SEKURITAS/backend/src/routes/auth.ts:65`
- `SEKURITAS/backend/src/routes/auth.ts:92`
- `SEKURITAS/frontend/src/pages/Login.tsx:23`
- `SEKURITAS/frontend/src/pages/Login.tsx:32`
- `SEKURITAS/frontend/src/App.tsx:6`
- `SEKURITAS/frontend/src/store/useStore.ts:86`
- `SEKURITAS/frontend/src/store/useStore.ts:145`

Masalah:
- Backend register membuat user `unverified` tetapi tetap mengembalikan JWT.
- Frontend langsung login dan masuk Dashboard.
- Dashboard memanggil portfolio/orders yang memakai `authenticateActiveUser`, lalu mendapat 403.
- Store hanya logout otomatis pada 401, bukan 403 unverified/suspended, sehingga user tertahan di Dashboard dengan error.
- Tidak ada halaman/komponen verify email.

Langkah perbaikan:
1. Setelah register, arahkan user ke halaman `VerifyEmail` atau tampilkan state `verification_required`.
2. Jangan masuk Dashboard sampai `user.is_verified === true`.
3. Tambahkan route `/verify-email` yang memanggil backend `/auth/verify-email`.
4. Store harus menangani 403 account state secara eksplisit, bukan dianggap error umum.
5. Di development boleh tampilkan `verification_token`, tetapi UI harus jelas memproses token tersebut.

### 9. Backend Sekuritas belum punya amend order route, padahal MATS client dan PRD membutuhkannya

Lokasi:
- `SEKURITAS/backend/src/services/mats-client.ts:41`
- `SEKURITAS/backend/src/routes/orders.ts:20`
- `SEKURITAS/backend/src/routes/orders.ts:37`
- `SEKURITAS/frontend/src/components/OrderList.tsx:47`
- `MATS/internal/api/handlers.go:85`

Masalah:
- `MatsClient.amendOrder` sudah ada.
- Backend Sekuritas tidak expose route amend dan tidak ada service untuk menghitung ulang reservation saat price/quantity berubah.
- Frontend tidak punya kontrol amend.
- PRD dan MATS mendukung amend, termasuk non-cancellation period.

Langkah perbaikan:
1. Tambahkan route `PATCH /api/v1/orders/:id` dengan Zod schema price/quantity.
2. Implement `amendOrder` di service Sekuritas dengan adjustment reservation atomik.
3. Persist `order_amendments` dengan idempotency key.
4. Proses response MATS dan webhook amend sama seperti status update lain.
5. Tambahkan UI amend di `OrderList` untuk order open/partial/amended.

### 10. BEI test contract guard timeout dan bisa menyembunyikan regresi auth

Lokasi:
- `BEI/test/contracts.test.ts:19`
- `BEI/src/app.ts:26`
- `BEI/src/lib/auth.ts:66`

Masalah:
- Test auth BEI yang harus memastikan request tanpa token mengembalikan 401 timeout.
- Log menunjukkan request mendapat 401, tetapi test tetap melebihi 5000 ms.
- Kemungkinan app/pool lifecycle atau `app.close()` tidak selesai bersih.
- Karena BEI adalah authority untuk MATS dan Sekuritas, test guard auth harus deterministik.

Langkah perbaikan:
1. Ubah test agar menggunakan `beforeAll/afterAll` shared app dan close sekali.
2. Pastikan pool DB/test dependency tidak membuat handle menggantung.
3. Tambahkan timeout eksplisit hanya jika memang perlu, tetapi akar masalah lifecycle tetap harus diselesaikan.
4. Jalankan `rtk npm test -- --run --detectOpenHandles` atau tool setara jika tersedia.

### 11. Config default MATS tidak cocok dengan port BEI lokal dan start-all tidak menjamin token tersedia

Lokasi:
- `MATS/internal/config/config.go:34`
- `MATS/.env.example:4`
- `SEKURITAS/backend/.env.example:6`
- `SEKURITAS/backend/.env.example:10`
- `BEI/.env.example:5`
- `start-all.bat:5`
- `start-all.bat:8`
- `start-all.bat:11`

Masalah:
- Default `BEIBaseURL` MATS adalah `http://localhost:3001/v1`, sedangkan BEI service lokal berjalan di port 4100.
- `.env.example` sudah benar, tetapi jika `.env` belum dibuat MATS sync BEI gagal dan order validation menolak karena rules unavailable.
- `start-all.bat` tidak memastikan `.env` tersedia, tidak menjalankan migration/seed, dan tidak menjelaskan mapping token antar service.

Langkah perbaikan:
1. Ubah default MATS `BEIBaseURL` ke `http://localhost:4100/v1`.
2. Tambahkan preflight script local yang memvalidasi `.env`, token scope, port, DB, migration, dan seed broker `MANDALA`.
3. Dokumentasikan token matrix: Sekuritas -> MATS, MATS -> Sekuritas, Sekuritas -> BEI, MATS -> BEI, BEI -> Sekuritas.
4. Update `start-all.bat` agar gagal cepat jika env penting masih placeholder.

### 12. Service/admin token bisa bypass di non-production ketika env kosong

Lokasi:
- `SEKURITAS/backend/src/lib/auth.ts:56`
- `SEKURITAS/backend/src/lib/auth.ts:68`
- `SEKURITAS/backend/src/routes/admin.ts:22`
- `SEKURITAS/backend/src/routes/mats-webhooks.ts:18`
- `SEKURITAS/backend/src/routes/bei-webhooks.ts:29`

Masalah:
- `requireServiceToken` dan `requireAdminToken` mengizinkan request jika token env kosong dan `NODE_ENV !== "production"`.
- Ini nyaman lokal, tetapi berbahaya jika dev/staging tunnel atau platform default domain terekspos.
- Endpoint admin deposit dan internal webhook tetap sensitif walaupun bukan production.

Langkah perbaikan:
1. Hapus bypass token kosong untuk endpoint mutasi finansial.
2. Jika ingin local convenience, gunakan env eksplisit `ALLOW_INSECURE_LOCAL_TOKENS=true` dan hanya untuk host localhost.
3. Tambahkan boot-time validation: production/staging harus punya `JWT_SECRET`, `ADMIN_TOKEN`, semua service token, dan token tidak boleh placeholder.
4. Tambahkan test request tanpa token pada admin deposit, MATS webhook, dan BEI webhook di semua environment profile.

## Bug / Gap Fungsional Frontend Sekuritas

### 13. Order list tidak realtime dari event MATS dan tidak sort terbaru

Lokasi:
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:22`
- `SEKURITAS/frontend/src/store/useStore.ts:154`
- `SEKURITAS/backend/src/routes/orders.ts:55`

Masalah:
- UI polling tiap 5 detik, bukan event-driven.
- Backend list order tidak memakai `ORDER BY created_at DESC`, sehingga "Recent Orders" bisa tidak benar.

Langkah perbaikan:
1. Tambahkan ordering backend `created_at DESC`.
2. Setelah WebSocket/Server-Sent Events tersedia, update order lokal saat event status masuk.

### 14. Market/company analysis, SID/SRE/RDN, settlement status, leaderboard, dan notifications belum ada

Lokasi:
- `SEKURITAS/backend/src/routes/market.ts:6`
- `SEKURITAS/backend/src/routes/portfolio.ts:10`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx:35`
- `docs/SEKURITAS/SEKURITAS_PRD.md`

Masalah:
- PRD meminta profil emiten, special notation, laporan keuangan, dividend/IPO/corporate action, SID/SRE/RDN, settlement status, leaderboard, dan notifikasi.
- Implementasi saat ini baru auth, portfolio ringkas, order entry, order list, securities datalist, dan fee estimate.

Langkah perbaikan:
1. Tambahkan endpoint backend proxy/cache untuk BEI fundamentals, announcements, corporate actions, settlement session, custody reconciliation, dan broker references.
2. Tambahkan halaman/panel frontend sesuai prioritas MVP: market detail, account references, settlement status, notifications, leaderboard.
3. Jangan expose fitur sebagai selesai sebelum kontrak BEI/Sekuritas lengkap.

## Urutan Eksekusi yang Disarankan

1. Perbaiki bug kritis order submission unknown state dan persist idempotency key.
2. Definisikan ulang kontrak fill MATS -> Sekuritas dan settlement BEI -> Sekuritas.
3. Samakan fee engine backend/frontend/BEI dan simpan fee snapshot per order/fill.
4. Buat settlement per trade yang wajib granular dan idempotent.
5. Ubah handling `locked_non_cancellable` menjadi action rejection sementara.
6. Implement BEI outbound webhook/retry ke Sekuritas.
7. Tambahkan WebSocket market data browser-compatible dan UI market panel.
8. Perbaiki flow register/verifikasi frontend.
9. Tambahkan amend order backend/frontend.
10. Bereskan config local, preflight token, dan BEI test timeout.
11. Tambahkan fitur PRD sisa secara bertahap: company analysis, SID/SRE/RDN, settlement view, notifications, leaderboard.

## Test Minimum Setelah Perbaikan

- Unit test Sekuritas order submission timeout: order tidak menjadi rejected dan reservation tidak dilepas.
- Integration test fake MATS: accepted -> partial fill price A -> partial fill price B -> filled.
- Integration test BEI settlement: replay settlement line tidak menggandakan ledger.
- Accounting test fee: frontend estimate = backend reserve = settlement fee basis.
- Browser test register unverified: user diarahkan ke verify flow dan tidak masuk dashboard trading.
- MATS integration test: trade generated dikirim ke BEI dan fill detail dikirim ke Sekuritas.
- BEI contract test: 401/403 guard tidak timeout dan app lifecycle clean.

## Apakah Bisa Dieksekusi oleh Gemini 3 Flash?

Sebagian kecil bisa dieksekusi oleh Gemini 3 Flash, terutama perubahan UI sederhana, ordering order list, route amend dasar, dan penambahan validasi schema.

Namun perbaikan utama sebaiknya dikerjakan oleh model yang lebih advanced karena menyentuh alur finansial lintas-service: idempotency order submission, fill per trade, settlement per trade, fee snapshot, retry/dead-letter, dan rekonsiliasi BEI/MATS/Sekuritas.
