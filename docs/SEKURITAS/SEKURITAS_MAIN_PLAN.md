# Main Implementation Plan - Mandala Sekuritas

## Fase 1: Kontrak Produk & Integrasi
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 1.1: Tetapkan flow utama player: register, email verification, login, deposit awal, lihat market, place/amend/cancel order, lihat portfolio, settlement, leaderboard.
  - [x] Task 1.2: Definisikan contract API ke MATS untuk place/amend/cancel order dan order status.
  - [x] Task 1.3: Definisikan contract API ke BEI untuk listed securities, special notation, issuer announcement, rules, ARA/ARB, fraksi harga, fee/tax schedule, corporate action, settlement, dan company profile.
  - [x] Task 1.4: Definisikan struktur WebSocket market data dari MATS untuk frontend.
- **Catatan**: Order harus selalu lewat backend Sekuritas.

## Fase 2: Inisialisasi Backend Sekuritas
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 2.1: Buat struktur backend Mandala Sekuritas dengan Node.js + Fastify + TypeScript.
  - [x] Task 2.2: Konfigurasi NeonDB/Neon Postgres, migration, environment variable, dan auth dasar.
  - [x] Task 2.3: Buat entity user, email_verification, broker_account, sid_reference, sre_reference, rdn_reference, cash_balance, securities_position, order, order_amendment, trade_fill, fee_ledger, leaderboard_snapshot, dan ledger movement.
  - [x] Task 2.4: Siapkan health check, logging, dan service client untuk MATS/BEI.
- **Catatan**: Backend akan dihosting di Heroku pada target deployment.

## Fase 2B: Inisialisasi Frontend Sekuritas
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 2B.1: Buat struktur frontend Mandala Sekuritas dengan React + Vite.
  - [x] Task 2B.2: Konfigurasi routing, state management dasar, API client, dan WebSocket client.
  - [x] Task 2B.3: Siapkan environment variable untuk backend Sekuritas dan market data MATS.
  - [x] Task 2B.4: Siapkan build/deploy target ke Vercel.
- **Catatan**: Fase ini bisa berjalan setelah kontrak API dasar tersedia.

## Fase 3: User, Broker Account & Cash
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 3.1: Implement register/login player.
  - [x] Task 3.2: Otomatis buat satu broker account untuk setiap user baru.
  - [x] Task 3.3: Implement email verification wajib untuk player manusia sebelum trading.
  - [x] Task 3.4: Implement bot account flag yang tidak memerlukan email verification.
  - [x] Task 3.5: Generate SID/SRE/RDN simulation reference untuk setiap broker account.
  - [x] Task 3.6: Implement cash state: available, reserved, pending.
  - [x] Task 3.7: Implement cash movement ledger.
  - [x] Task 3.8: Implement admin seed/deposit modal awal.
- **Catatan**: Email verification wajib untuk player asli, tetapi tidak berlaku untuk BOT.

## Fase 4: Portfolio & Securities Position
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 4.1: Implement position state: available shares, reserved shares, pending shares.
  - [x] Task 4.2: Implement position movement ledger.
  - [x] Task 4.3: Hitung average price, realized P/L, dan unrealized P/L sederhana.
  - [x] Task 4.4: Implement portfolio summary API.
- **Catatan**: Harga realtime untuk unrealized P/L dapat diambil dari MATS market data atau snapshot lokal.

## Fase 5: Order Entry & Reservation
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 5.1: Implement endpoint create buy order.
  - [x] Task 5.2: Implement endpoint create sell order.
  - [x] Task 5.3: Validasi available cash untuk buy dan available shares untuk sell.
  - [x] Task 5.4: Ambil fee/tax estimate dari fee schedule BEI dan masukkan biaya ke buying power.
  - [x] Task 5.5: Tampilkan estimasi ARA/ARB, fraksi harga, dan status symbol sebelum order dikirim.
  - [x] Task 5.6: Implement reservation cash/shares secara atomik.
  - [x] Task 5.7: Implement amend order untuk open order dan update reservation delta jika harga/quantity berubah.
  - [x] Task 5.8: Implement cancel order dan release reservation jika order belum filled.
  - [x] Task 5.9: Implement handling locked_non_cancellable dari MATS saat non-cancellation period.
  - [x] Task 5.10: Implement expired order handling dari MATS dan release reservation.
- **Catatan**: Ini area risiko utama agar player tidak bisa double-spend.

## Fase 6: Integrasi MATS Order Flow
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 6.1: Kirim place/amend/cancel order valid ke MATS melalui REST API.
  - [x] Task 6.2: Simpan mapping client_order_id dan mats_order_id.
  - [x] Task 6.3: Proses response accepted/rejected dari MATS.
  - [x] Task 6.4: Proses order status update: amended, partial fill, filled, cancelled, rejected, expired, locked_non_cancellable.
  - [x] Task 6.5: Tambahkan idempotency dan retry policy.
- **Catatan**: Jika MATS reject, reservation harus dikembalikan.

## Fase 7: Settlement & BEI Sync
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 7.1: Proses trade fill menjadi pending cash/shares.
  - [x] Task 7.2: Terima settlement completed dari BEI.
  - [x] Task 7.3: Ubah pending cash/shares menjadi available setelah settlement.
  - [x] Task 7.4: Hitung dan catat broker fee, levy, clearing fee, settlement fee, guarantee fund jika dipakai, PPN, dan PPh jual pada trade/cash ledger.
  - [x] Task 7.5: Implement reconciliation endpoint dengan BEI custody summary, SID/SRE/RDN reference, dan settlement instruction.
  - [x] Task 7.6: Tampilkan settlement status dan biaya transaksi ke player.
- **Catatan**: Default settlement adalah end-of-session sesuai BEI config.

## Fase 8: Data Emiten, IPO & Corporate Action
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 8.1: Ambil listed securities, special notation, issuer announcement, dan company profile dari BEI.
  - [x] Task 8.2: Tampilkan laporan keuangan, rasio dasar, dan pengumuman emiten.
  - [x] Task 8.3: Tampilkan event IPO dan izinkan player ikut subscription jika BEI sudah mendukung.
  - [x] Task 8.4: Tampilkan dividen, stock split, reverse split, bonus share, rights issue/HMETD, warrant, dan corporate action lain dari BEI.
  - [x] Task 8.5: Proses notifikasi dividend received, IPO allocation, dan corporate action adjustment.
  - [x] Task 8.6: Pastikan corporate action memperbarui tampilan portfolio sesuai settlement/ledger dari BEI.
- **Catatan**: Fitur IPO bisa dibuat setelah BEI API tersedia.

## Fase 9: Frontend Mandala Sekuritas
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 9.1: Buat layout aplikasi trading: market watch, full depth order book, market summary, order ticket, portfolio, orders, trades, company profile, issuer announcements, leaderboard.
  - [x] Task 9.2: Implement login/register dan session handling.
  - [x] Task 9.3: Integrasikan REST API backend Sekuritas untuk order/account/portfolio.
  - [x] Task 9.4: Integrasikan WebSocket MATS untuk market data publik.
  - [x] Task 9.5: Tampilkan state available/reserved/pending dengan jelas.
  - [x] Task 9.6: Tampilkan ARA/ARB, price band, fraksi harga, fee estimate, special notation, trading halt, non-cancellation indicator, dan reject reason di order ticket.
  - [x] Task 9.7: Tampilkan SID/SRE/RDN simulation reference pada profil akun.
  - [x] Task 9.8: Tampilkan leaderboard portfolio value, return, realized P/L, dan unrealized P/L.
- **Catatan**: Frontend akan dihosting di Vercel.

## Fase 10: Admin, Bot Compatibility & Deployment
- **Status**: [x] Selesai
- **Tugas**:
  - [x] Task 10.1: Pastikan API sekuritas fully compatible dengan bot trading player (API Key Auth, rate limit, endpoints konsisten).
  - [x] Task 10.2: Buat Admin Dashboard sederhana untuk manual review KYC/deposit SRE jika ada.
  - [x] Task 10.3: Setup Dockerfile dan CI/CD scripts untuk backend.
  - [x] Task 10.4: Deploy Backend ke cloud provider (Heroku).
  - [x] Task 10.5: Deploy Frontend ke Vercel.
  - [x] Task 10.6: Lakukan End-to-End Test (E2E) simulasi user deposit, buy order, sell order, dan withdrawal.
- **Catatan**: Endpoint API wajib didokumentasikan di `docs/API_CONTRACTS.md` agar mudah dipakai bot player.

***
**Status Keseluruhan**: [x] Selesai - MVP Mandala Sekuritas siap meluncur!
**Model AI Execution**: Bisa dieksekusi menggunakan **Gemini 2.5 Flash** (sebagian besar) dengan *context-awareness* tinggi, namun untuk *deep logic/race condition* sangat disarankan **Gemini 2.5 Pro/Advanced**.
