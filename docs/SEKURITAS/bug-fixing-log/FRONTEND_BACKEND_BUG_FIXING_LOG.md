# Bug Fixing Log - Sekuritas Frontend dan Backend

Tanggal pengerjaan: 16 Juni 2026
Scope: `SEKURITAS/frontend`, `SEKURITAS/backend`, kontrak integrasi MATS/BEI, dan dokumentasi kontrak Sekuritas.

## Ringkasan

Perbaikan ini berawal dari analisis frontend Sekuritas, tetapi masalah yang ditemukan ternyata berada di boundary frontend-backend dan integrasi service-to-service. Frontend bisa build, namun beberapa alur utama tidak aman atau tidak akan berjalan end-to-end karena kontrak API, JWT, status order, service token, dan path integrasi tidak selaras dengan MATS/BEI.

Fokus perbaikan:
- Menyamakan kontrak auth frontend dan backend.
- Menyamakan JWT signing/verifying antar route.
- Memperbaiki client MATS/BEI agar memakai endpoint dan service token yang benar.
- Mengamankan webhook MATS ke Sekuritas.
- Menormalisasi status order lowercase dari MATS.
- Mengurangi risiko double-spend/double-sell pada reservation.
- Memperbaiki session hydration, loading state, dan error handling frontend.
- Menyelaraskan dokumentasi kontrak.

## Bug 1 - Response login/register tidak cocok dengan frontend

Lokasi terkait:
- `SEKURITAS/frontend/src/pages/Login.tsx`
- `SEKURITAS/frontend/src/store/useStore.ts`
- `SEKURITAS/backend/src/routes/auth.ts`

Masalah:
- Frontend mengharapkan response auth berbentuk `{ token, user }`.
- Backend login sebelumnya hanya mengembalikan `{ token, user_id }`.
- Backend register tidak mengembalikan token, tetapi frontend tetap mencoba login otomatis.
- Akibatnya token/user bisa undefined dan dashboard tidak punya data user.

Perbaikan:
- Backend login dan register sekarang mengembalikan `{ token, user }`.
- Ditambahkan validasi request auth dengan Zod.
- Ditambahkan guard frontend agar response auth invalid tidak disimpan.
- Ditambahkan endpoint `/api/v1/auth/me` untuk hydrate session setelah refresh.

Status:
- Selesai.

## Bug 2 - JWT secret fallback berbeda antar route

Lokasi terkait:
- `SEKURITAS/backend/src/routes/auth.ts`
- `SEKURITAS/backend/src/routes/orders.ts`
- `SEKURITAS/backend/src/routes/portfolio.ts`
- `SEKURITAS/backend/src/lib/auth.ts`

Masalah:
- Route auth menandatangani JWT dengan fallback berbeda dari route protected.
- Jika `JWT_SECRET` tidak diset, token login bisa langsung gagal dipakai untuk portfolio/order.

Perbaikan:
- Dibuat helper auth terpusat di `src/lib/auth.ts`.
- Signing dan verifying JWT memakai sumber secret yang sama.
- Route orders dan portfolio memakai `authenticateUser`.
- Production dibuat fail-fast jika `JWT_SECRET` kosong.

Status:
- Selesai.

## Bug 3 - Integrasi MATS memakai path, method, header, dan payload yang salah

Lokasi terkait:
- `SEKURITAS/backend/src/services/mats-client.ts`
- `SEKURITAS/backend/src/services/order-service.ts`
- `MATS/.env.example`

Masalah:
- Sekuritas memanggil `/api/v1/orders`, sementara MATS expose `/v1/orders`.
- Cancel memakai `DELETE`, sementara MATS memakai `POST /v1/orders/{orderId}/cancel`.
- Amend memakai `PUT`, sementara MATS memakai `PATCH`.
- Tidak ada `x-service-token`.
- Payload kurang `account_id`, `order_type`, dan `idempotency_key`.
- `time_in_force` dikirim padahal tidak ada di kontrak MATS.

Perbaikan:
- `MatsClient` diarahkan ke endpoint MATS aktual.
- Ditambahkan `x-service-token`.
- Ditambahkan idempotency key untuk place/cancel/amend.
- Place order mengirim `account_id`, `order_type: "limit"`, `side` lowercase, dan `idempotency_key`.
- `MATS/.env.example` diarahkan ke webhook Sekuritas yang baru.

Status:
- Selesai untuk place/cancel dan client amend.
- Logic amend reservation delta belum dibangun karena tidak ada endpoint amend Sekuritas di UI saat ini.

## Bug 4 - Response sinkron MATS diabaikan

Lokasi terkait:
- `SEKURITAS/backend/src/services/order-service.ts`

Masalah:
- Backend Sekuritas mengirim order ke MATS, tetapi response `matsRes.order` tidak diproses.
- Jika webhook belum terkirim, order lokal tetap `PENDING` dan tidak punya `mats_order_id`.
- Cancel bisa gagal karena order dianggap belum submit ke MATS.

Perbaikan:
- Setelah `matsClient.placeOrder`, response MATS langsung dinormalisasi dan diproses lewat `handleWebhookUpdate`.
- `mats_order_id`, status, filled quantity, remaining quantity, dan reject reason disimpan dari response sinkron.

Status:
- Selesai.

## Bug 5 - Status MATS lowercase tidak cocok dengan backend/frontend uppercase

Lokasi terkait:
- `SEKURITAS/backend/src/lib/order-status.ts`
- `SEKURITAS/backend/src/services/order-service.ts`
- `SEKURITAS/frontend/src/components/OrderList.tsx`
- `SEKURITAS/backend/src/db/schema.ts`

Masalah:
- MATS mengirim status seperti `accepted`, `rejected`, `partially_filled`, `cancelled`.
- Backend sebelumnya membandingkan status uppercase seperti `REJECTED`, `CANCELLED`, `PARTIAL_FILL`.
- Akibatnya reservation bisa tidak dilepas, fill tidak dipindahkan ke pending, dan tombol cancel tidak muncul.

Perbaikan:
- Dibuat normalizer status order di backend.
- Status internal diseragamkan ke lowercase.
- Frontend `OrderList` sekarang membaca status lowercase dan tetap menampilkan label user-friendly.
- Komentar schema disesuaikan agar tidak menyesatkan.

Status:
- Selesai.

## Bug 6 - Webhook MATS tidak aman

Lokasi terkait:
- `SEKURITAS/backend/src/routes/orders.ts`
- `SEKURITAS/backend/src/routes/mats-webhooks.ts`
- `SEKURITAS/backend/src/app.ts`

Masalah:
- Webhook lama berada di route orders dan auth dilewati memakai substring URL.
- Tidak ada validasi `x-service-token`.
- Payload order status bisa dipalsukan jika endpoint dapat diakses.

Perbaikan:
- Webhook MATS dipindah ke `/internal/mats/events`.
- Ditambahkan validasi `x-service-token` via `MATS_TO_SEKURITAS_TOKEN` atau `SEKURITAS_SERVICE_TOKEN`.
- Payload webhook divalidasi dengan Zod sebelum diproses.
- Route user orders tidak lagi punya bypass auth.

Status:
- Selesai.

## Bug 7 - Integrasi BEI memakai endpoint lama dan tidak mengirim service token

Lokasi terkait:
- `SEKURITAS/backend/src/services/bei-client.ts`
- `SEKURITAS/backend/src/routes/market.ts`
- `SEKURITAS/backend/.env.example`
- `docs/SEKURITAS/API_CONTRACTS.md`

Masalah:
- Sekuritas memanggil `/api/v1/issuers/securities` dan `/api/v1/rules/fees`.
- BEI aktual expose `/v1/public/securities` dan `/v1/public/fee-schedule`.
- BEI membutuhkan `x-service-token`.

Perbaikan:
- `BeiClient` diarahkan ke endpoint BEI aktual.
- Ditambahkan `BEI_SERVICE_TOKEN`.
- Error proxy market dibuat lebih informatif.
- Dokumentasi kontrak Sekuritas diperbarui.

Status:
- Selesai.

## Bug 8 - Validasi input order terlalu lemah

Lokasi terkait:
- `SEKURITAS/backend/src/routes/orders.ts`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx`

Masalah:
- Backend menerima `any`, lalu `parseFloat`/`parseInt` tanpa validasi lengkap.
- Frontend hanya mengandalkan input HTML.
- Symbol dibatasi `maxLength=4`, padahal kontrak backend dapat menerima symbol lebih panjang.

Perbaikan:
- Route create order memakai Zod untuk validasi `symbol`, `side`, `price`, dan `quantity`.
- Frontend memvalidasi angka positif integer sebelum submit.
- `maxLength` symbol frontend dinaikkan menjadi 12 agar selaras dengan backend.

Status:
- Selesai.

## Bug 9 - Quantity UI ambigu antara lot dan shares

Lokasi terkait:
- `SEKURITAS/frontend/src/components/OrderEntry.tsx`
- `SEKURITAS/backend/src/services/order-service.ts`

Masalah:
- UI menampilkan `Quantity (Lots)`, tetapi backend/MATS menerima `quantity` sebagai unit order langsung.
- Ini berisiko order 1 lot dikirim sebagai 1 share, atau sebaliknya.

Perbaikan:
- Label frontend diubah menjadi `Quantity (Shares)`.
- Backend meneruskan quantity apa adanya ke MATS.
- Konversi lot size belum dibuat karena perlu kontrak market rules yang lebih lengkap di UI.

Status:
- Selesai untuk menghilangkan ambiguitas UI.
- Konversi lot otomatis belum diterapkan.

## Bug 10 - Reservation cash/saham rentan race condition

Lokasi terkait:
- `SEKURITAS/backend/src/services/order-service.ts`

Masalah:
- Flow lama membaca saldo/posisi lalu update tanpa conditional update.
- Dua order paralel bisa membaca saldo yang sama dan menyebabkan overspend/double-sell.

Perbaikan:
- Reservation buy memakai conditional update `available >= totalRequired`.
- Reservation sell memakai conditional update `available >= quantity`.
- Jika update tidak mengembalikan row, order ditolak sebagai insufficient cash/shares.

Status:
- Selesai untuk proteksi dasar race condition.
- Test concurrency khusus belum ditambahkan.

## Bug 11 - Fill processing memakai status dan reservation yang tidak idempotent

Lokasi terkait:
- `SEKURITAS/backend/src/services/order-service.ts`

Masalah:
- Fill/reject/cancel sebelumnya bergantung pada status uppercase.
- Update terminal tidak selalu idempotent.
- Reservation release untuk reject/cancel/expired bisa gagal.

Perbaikan:
- `handleWebhookUpdate` sekarang:
  - Menolak proses ulang jika order sudah terminal.
  - Menghitung `freshlyFilledQty`.
  - Memindahkan reserved ke pending pada fill.
  - Melepas remaining reservation pada rejected/cancelled/expired.
  - Menyimpan status lowercase.

Status:
- Selesai.

Catatan:
- Harga fill masih memakai `average_price` dari payload jika ada, fallback ke limit price order.
- Akurasi penuh butuh MATS mengirim fill/execution price detail ke Sekuritas.

## Bug 12 - Frontend auth state hilang setelah refresh

Lokasi terkait:
- `SEKURITAS/frontend/src/App.tsx`
- `SEKURITAS/frontend/src/store/useStore.ts`

Masalah:
- Token dibaca dari localStorage, tetapi `user` tidak dihydrate.
- Dashboard email kosong setelah refresh.
- Jika token expired, app tidak otomatis logout.

Perbaikan:
- Ditambahkan `hydrateSession()`.
- App memanggil hydration saat mount.
- User disimpan di localStorage.
- Jika API mengembalikan 401, frontend logout dan membersihkan token.

Status:
- Selesai.

## Bug 13 - Loading dan error frontend terlalu global

Lokasi terkait:
- `SEKURITAS/frontend/src/store/useStore.ts`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx`
- `SEKURITAS/frontend/src/components/Portfolio.tsx`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx`

Masalah:
- Polling portfolio/orders memakai loading global yang juga memengaruhi form order.
- Error fetch orders hanya masuk console.
- Request polling bisa overlap.

Perbaikan:
- Loading dipisah menjadi `portfolioLoading`, `ordersLoading`, `orderActionLoading`, dan `marketLoading`.
- Ditambahkan guard agar fetch portfolio/orders tidak jalan paralel jika request sebelumnya belum selesai.
- Dashboard menampilkan error API non-blocking.

Status:
- Selesai.

## Bug 14 - Frontend belum memakai market reference/fee schedule

Lokasi terkait:
- `SEKURITAS/frontend/src/store/useStore.ts`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx`

Masalah:
- Order ticket memakai fee hardcoded.
- Symbol input tidak mengambil listed securities.
- Market proxy backend sudah ada, tetapi belum dipakai frontend.

Perbaikan:
- Frontend menambahkan `fetchMarketData()` untuk mengambil `/market/securities` dan `/market/fees`.
- Order ticket memakai datalist dari listed securities jika tersedia.
- Fee estimate memakai fee schedule BEI jika tersedia, fallback ke rate MVP.

Status:
- Selesai untuk reference data dan fee estimate.
- Full market watch, order book, dan WebSocket realtime belum dibangun.

## Bug 15 - Placeholder password rusak encoding

Lokasi terkait:
- `SEKURITAS/frontend/src/pages/Login.tsx`

Masalah:
- Placeholder password tampil mojibake.

Perbaikan:
- Placeholder diganti menjadi ASCII aman: `Password`.

Status:
- Selesai.

## File yang Ditambahkan

- `SEKURITAS/backend/src/lib/auth.ts`
- `SEKURITAS/backend/src/lib/order-status.ts`
- `SEKURITAS/backend/src/routes/mats-webhooks.ts`
- `implementation_plan.md`
- `docs/SEKURITAS/bug-fixing-log/FRONTEND_BACKEND_BUG_FIXING_LOG.md`

## File Utama yang Diubah

Backend:
- `SEKURITAS/backend/src/routes/auth.ts`
- `SEKURITAS/backend/src/routes/orders.ts`
- `SEKURITAS/backend/src/routes/portfolio.ts`
- `SEKURITAS/backend/src/routes/market.ts`
- `SEKURITAS/backend/src/app.ts`
- `SEKURITAS/backend/src/services/mats-client.ts`
- `SEKURITAS/backend/src/services/bei-client.ts`
- `SEKURITAS/backend/src/services/order-service.ts`
- `SEKURITAS/backend/src/db/schema.ts`
- `SEKURITAS/backend/.env.example`
- `SEKURITAS/backend/package.json`

Frontend:
- `SEKURITAS/frontend/src/App.tsx`
- `SEKURITAS/frontend/src/api/client.ts`
- `SEKURITAS/frontend/src/store/useStore.ts`
- `SEKURITAS/frontend/src/pages/Login.tsx`
- `SEKURITAS/frontend/src/pages/Dashboard.tsx`
- `SEKURITAS/frontend/src/components/OrderEntry.tsx`
- `SEKURITAS/frontend/src/components/OrderList.tsx`
- `SEKURITAS/frontend/src/components/Portfolio.tsx`

Kontrak/env:
- `MATS/.env.example`
- `docs/SEKURITAS/API_CONTRACTS.md`

## Verifikasi

Perintah yang dijalankan:

```powershell
rtk npm run build
```

Lokasi:
- `SEKURITAS/backend`
- `SEKURITAS/frontend`

Hasil:
- Backend build berhasil.
- Frontend build berhasil.

## Sisa Risiko / Belum Dikerjakan

1. Full akurasi harga eksekusi belum selesai jika MATS tidak mengirim fill price detail ke Sekuritas. Saat ini memakai `average_price` dari payload jika ada, fallback ke limit price.
2. Full realtime market data UI/WebSocket belum dibangun. Yang sudah ada baru plumbing market reference dan fee schedule.
3. Endpoint amend order Sekuritas dan reservation delta amend belum dibangun.
4. Test concurrency automated untuk reservation belum ditambahkan.
5. Flow email verification masih mode MVP auto-verified. Jika ingin production-like, perlu mengaktifkan status `unverified` untuk human user dan UI verifikasi email.

