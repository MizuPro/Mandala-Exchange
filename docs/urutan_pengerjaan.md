# Urutan Pengerjaan Mandala Exchange

Dokumen ini menjelaskan urutan pengerjaan yang disarankan untuk menyelesaikan MVP Mandala Exchange secara end-to-end, lalu daftar pekerjaan lanjutan setelah MVP selesai.

## Target Akhir MVP

MVP dianggap selesai jika pemain bisa melakukan alur trading simulasi lengkap:

1. Sekuritas menyediakan akun, cash, portfolio, dan order entry.
2. MATS menerima order, memvalidasi aturan pasar dari BEI, melakukan matching, dan menghasilkan trade.
3. BEI menerima trade resmi dari MATS, menyimpan trade, membuat settlement, dan mencatat custody ledger.
4. Sekuritas membaca status settlement/custody dari BEI dan memperbarui tampilan portfolio.
5. Frontend Sekuritas bisa dipakai pemain untuk melihat market, submit order, memantau order, dan melihat portfolio.

## Tahap 1: MATS MVP (SELESAI)

### Tujuan

Membangun MATS sebagai matching engine yang terpisah dari BEI dan Sekuritas. MATS bertanggung jawab atas order book, validasi aturan pasar, matching, dan pengiriman trade resmi ke BEI.

### Pekerjaan Utama

1. Inisialisasi MATS Service dengan Go sesuai `docs/MATS/MATS_MAIN_PLAN.md`.
2. Buat struktur dasar service: config, logger, HTTP server, router, health check, dan service auth.
3. Buat database PostgreSQL untuk event order, trade, session, dan recovery log.
4. Implement sync data dari BEI:
   - `GET /v1/integration/mats/rules`
   - `GET /v1/integration/mats/securities`
   - `GET /v1/integration/mats/sessions/active`
   - `GET /v1/brokers/:code/validate`
5. Implement order gateway internal:
   - place order
   - amend order
   - cancel order
   - order status
6. Implement order book per symbol dengan price-time priority.
7. Implement matching sederhana untuk limit order:
   - partial fill
   - full fill
   - remaining open quantity
   - reject reason
8. Implement validasi order dari rules BEI:
   - symbol listed/suspended
   - market/session status
   - tick size/fraksi harga
   - lot size
   - ARA/ARB/price band
   - auto rejection volume
9. Generate trade event dari match.
10. Kirim trade final ke BEI:
   - `POST /v1/trades/capture`
   - wajib idempotency key
11. Implement market summary sederhana dan kirim ke BEI:
   - `POST /v1/market-summaries`

### Kriteria Selesai

- MATS bisa mengambil rules dan securities dari BEI.
- MATS bisa menerima buy/sell order.
- MATS bisa match order sesuai price-time priority.
- MATS bisa menghasilkan trade.
- Trade berhasil tersimpan di BEI melalui `POST /v1/trades/capture`.
- Order reject punya alasan yang jelas.

## Tahap 2: Integration Test BEI-MATS (SELESAI)

### Tujuan

Membuktikan boundary BEI dan MATS benar sebelum Sekuritas dibangun. Tahap ini penting supaya masalah aturan pasar, trade capture, dan idempotency ditemukan lebih awal.

### Pekerjaan Utama

1. Jalankan BEI dengan database seed.
2. Jalankan MATS dengan konfigurasi token service `mats`.
3. Buat skenario test integrasi:
   - BEI punya 3 saham seed.
   - MATS sync rules dari BEI.
   - MATS sync securities dari BEI.
   - MATS menerima order buy dan sell untuk symbol yang sama.
   - MATS melakukan matching.
   - MATS mengirim trade ke BEI.
   - BEI menyimpan trade resmi.
4. Test idempotency:
   - kirim trade yang sama dua kali ke BEI.
   - pastikan BEI tidak membuat duplikasi.
5. Test reject rule:
   - harga tidak sesuai tick
   - harga di luar price band
   - symbol suspended
   - broker tidak valid
6. Buat dokumentasi payload contoh untuk MATS -> BEI.

### Kriteria Selesai

- BEI dan MATS bisa berjalan bersamaan secara lokal.
- Trade dari MATS masuk ke BEI.
- Retry trade tidak membuat data ganda.
- Rules dari BEI benar-benar dipakai MATS untuk validasi.
- Minimal ada test/script yang bisa mengulang skenario integrasi.

## Tahap 3: Sekuritas Backend MVP (SELESAI)

### Tujuan

Membangun backend Mandala Sekuritas sebagai gateway resmi pemain. Pemain tidak boleh langsung mengirim order ke MATS atau BEI.

### Pekerjaan Utama

1. Inisialisasi Sekuritas Backend dengan Node.js + Fastify + TypeScript.
2. Buat database Sekuritas untuk:
   - user
   - broker account
   - cash ledger
   - portfolio position
   - order
   - order status history
   - trade/fill mapping
   - leaderboard dasar
3. Implement auth user:
   - register
   - login
   - email verification untuk user manusia
   - bot account flag untuk akun bot
4. Implement broker account:
   - satu user punya satu broker account pada MVP
   - SID/SRE/RDN simulation reference
   - status active/suspended
5. Implement cash management:
   - available cash
   - reserved cash
   - pending cash
   - cash movement ledger
6. Implement portfolio:
   - available shares
   - reserved shares
   - pending shares
   - average price
   - realized/unrealized P/L
7. Implement order flow:
   - buy order reserve cash
   - sell order reserve shares
   - send order ke MATS
   - receive accepted/rejected/fill/cancel/expired status
   - release reservation saat reject/cancel/expired
8. Integrasi BEI untuk read data:
   - listed securities
   - issuer profile
   - fundamentals
   - special notation
   - fee schedule
   - corporate action
   - settlement/custody summary
9. Implement fee simulation:
   - broker fee
   - exchange fee
   - clearing fee
   - settlement fee
   - VAT
   - sell tax
10. Implement reconciliation sederhana:
   - compare portfolio Sekuritas dengan custody summary BEI.

### Kriteria Selesai

- User bisa punya cash dan portfolio.
- Buy order hanya bisa dikirim jika cash cukup.
- Sell order hanya bisa dikirim jika shares cukup.
- Order dikirim ke MATS, bukan langsung ke BEI.
- Status order dari MATS memperbarui order Sekuritas.
- Sekuritas bisa membaca data saham/rules/fee dari BEI.
- Sekuritas bisa membaca custody/settlement summary dari BEI.

## Tahap 4: End-to-End Trading Flow (SELESAI)

### Tujuan

Menggabungkan BEI, MATS, dan Sekuritas menjadi satu alur trading yang bisa diuji dari awal sampai akhir.

### Pekerjaan Utama

1. Jalankan ketiga service:
   - BEI
   - MATS
   - Sekuritas Backend
2. Siapkan seed end-to-end:
   - emiten dan saham di BEI
   - rules dan fee schedule di BEI
   - user/player di Sekuritas
   - cash awal di Sekuritas
   - posisi saham awal jika dibutuhkan untuk seller
3. Test alur buy/sell:
   - player A submit buy order via Sekuritas
   - player B submit sell order via Sekuritas
   - Sekuritas melakukan reservation
   - MATS menerima order
   - MATS matching order
   - MATS mengirim trade ke BEI
   - BEI menyimpan trade resmi
4. Test settlement:
   - BEI membuat settlement batch
   - BEI proses settlement
   - BEI membuat custody ledger entries
   - Sekuritas membaca settlement/custody summary
   - Sekuritas memperbarui pending/available position
5. Test reconciliation:
   - portfolio Sekuritas dibandingkan dengan custody BEI
   - mismatch ditampilkan sebagai error/reconciliation issue
6. Test failure/retry:
   - retry trade capture
   - retry order status update
   - service restart sederhana

### Kriteria Selesai

- Satu trade bisa berjalan dari Sekuritas -> MATS -> BEI.
- Settlement bisa diproses dan custody ledger BEI berubah.
- Sekuritas bisa menampilkan portfolio setelah settlement.
- Data trade dan settlement bisa dilaporkan.
- Alur bisa diulang dengan seed/reset lokal.

## Tahap 5: Frontend Sekuritas MVP (SELESAI)

### Tujuan

Membuat aplikasi utama yang dipakai pemain untuk trading simulasi. Frontend dibuat setelah backend flow stabil agar UI tidak dibangun di atas kontrak API yang masih sering berubah.

### Pekerjaan Utama

1. Inisialisasi frontend React + Vite.
2. Implement halaman auth:
   - register
   - login
   - email verification state
3. Implement dashboard utama:
   - cash balance
   - portfolio summary
   - order summary
   - market summary
4. Implement market view:
   - daftar saham
   - harga terakhir
   - board/status/special notation
   - ARA/ARB dan tick size
   - fundamental ringkas
5. Implement order ticket:
   - buy/sell
   - symbol
   - price
   - lot/quantity
   - fee estimate
   - validation error
6. Implement order list:
   - accepted
   - rejected
   - open
   - partially filled
   - filled
   - cancelled
   - expired
7. Implement portfolio:
   - available shares
   - reserved shares
   - pending shares
   - average price
   - realized/unrealized P/L
8. Implement company analysis:
   - profile emiten
   - financial report
   - ratios
   - announcement
   - corporate action
9. Implement settlement status:
   - matched trade
   - pending settlement
   - settled position
10. Implement basic realtime/polling:
   - order status
   - market data
   - portfolio refresh

### Kriteria Selesai

- Player bisa login.
- Player bisa melihat market.
- Player bisa submit buy/sell order.
- Player bisa melihat order status.
- Player bisa melihat portfolio.
- Player bisa melihat settlement status.
- Frontend memakai Sekuritas Backend sebagai gateway order, bukan langsung ke MATS/BEI untuk transaksi.

## Setelah MVP: Production Hardening

MVP selesai bukan berarti production-ready. Setelah lima tahap di atas selesai, pekerjaan berikutnya adalah hardening agar sistem aman, stabil, dan layak dipakai lebih banyak user.

## 1. Security Hardening

1. Ganti semua token development.
2. Simpan token production di secret manager/platform environment.
3. Pisahkan token per environment:
   - local
   - staging
   - production
4. Tambahkan token rotation procedure.
5. Tambahkan rate limiting untuk endpoint sensitif.
6. Batasi CORS hanya ke domain frontend yang valid.
7. Tambahkan request size limit.
8. Tambahkan audit log untuk semua operasi admin penting.
9. Review permission scope antar service.
10. Pastikan frontend tidak pernah menyimpan token internal BEI/MATS.

## 2. Database & Migration Hardening

1. Gunakan migration versioning yang lebih matang.
2. Tambahkan rollback strategy.
3. Buat backup dan restore procedure.
4. Tambahkan index untuk query penting.
5. Review constraint data:
   - unique key
   - foreign key
   - idempotency key
   - ledger integrity
6. Tambahkan seed/reset script khusus development.
7. Pisahkan seed demo dan migration production.

## 3. Testing & Quality

1. Tambahkan integration test lintas service:
   - BEI-MATS
   - MATS-Sekuritas
   - Sekuritas-BEI
   - end-to-end full trading flow
2. Tambahkan test untuk race condition:
   - double order
   - double reservation
   - double settlement
   - duplicate trade capture
3. Tambahkan test corporate action:
   - dividend
   - stock split
   - reverse split
   - bonus share
   - rights issue
   - warrant
4. Tambahkan load test simulasi:
   - banyak bot
   - banyak order
   - banyak market data subscriber
5. Tambahkan CI pipeline:
   - install
   - lint
   - typecheck
   - test
   - build
   - audit

## 4. Observability

1. Structured logging dengan correlation id.
2. Metrics per service:
   - request count
   - error count
   - latency
   - order count
   - trade count
   - settlement duration
3. Health check yang lebih lengkap:
   - database
   - external service dependency
   - queue jika nanti dipakai
4. Error reporting.
5. Dashboard monitoring.
6. Alert untuk error kritis:
   - trade capture gagal
   - settlement gagal
   - reconciliation mismatch
   - database unavailable

## 5. Deployment

1. Tentukan target deployment:
   - VPS
   - Railway/Render/Fly
   - Docker Compose self-hosted
   - Kubernetes jika nanti perlu
2. Buat Dockerfile untuk tiap service.
3. Buat environment staging.
4. Buat deployment checklist.
5. Setup Cloudflare Tunnel/Access untuk internal API.
6. Setup domain dan HTTPS.
7. Setup database production.
8. Setup backup otomatis.
9. Setup log retention.
10. Setup rollback deployment.

## 6. Business Logic Hardening

1. Perkuat settlement model:
   - netting broker
   - netting investor
   - batch reconciliation
2. Perkuat custody ledger:
   - reversal entry
   - adjustment entry
   - ledger balance validation
3. Perkuat fee/tax calculation:
   - rounding
   - minimum fee
   - fee breakdown per order/trade
4. Perkuat corporate action:
   - fractional share handling
   - record date eligibility
   - payment date
   - entitlement calculation
5. Perkuat market session:
   - opening auction
   - closing auction
   - non-cancellation period
   - trading halt
   - post-closing
6. Perkuat surveillance:
   - wash trade detection
   - bot dominance
   - cancellation rate
   - unusual volume
   - consecutive ARA/ARB

## 7. UX & Admin Tooling

1. Buat admin dashboard BEI: (V2 - Parsial/Dalam Pengerjaan)
   - emiten
   - saham
   - rules
   - fee schedule
   - session
   - settlement
   - corporate action
   - surveillance alerts
2. Buat admin dashboard Sekuritas: (V2 - Parsial/Dalam Pengerjaan)
   - user
   - broker account
   - cash adjustment
   - order monitoring
   - reconciliation
3. Polish frontend trading:
   - loading state
   - error state
   - empty state
   - responsive layout
   - realtime updates
4. Tambahkan dokumentasi operator:
   - cara start session
   - cara suspend saham
   - cara proses settlement
   - cara menjalankan corporate action
   - cara reset simulasi

## Rekomendasi Urutan Setelah Dokumen Ini

1. ~~Kerjakan MATS MVP.~~ (Selesai)
2. ~~Buat integration test BEI-MATS.~~ (Selesai)
3. ~~Kerjakan Sekuritas Backend MVP.~~ (Selesai)
4. ~~Jalankan end-to-end trading flow.~~ (Selesai)
5. ~~Kerjakan Frontend Sekuritas MVP.~~ (Selesai)
6. Masuk ke Tahap V2: Automation (Session Runner, Circuit Breaker), Admin UI, dan Penyelarasan Skema OpenAPI (Selesai/Ongoing).
7. Lanjutkan ke Production Hardening.
