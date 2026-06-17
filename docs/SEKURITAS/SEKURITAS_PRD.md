# Product Requirements Document (PRD) - Mandala Sekuritas

## 1. Pendahuluan
- **Latar Belakang**: Player tidak boleh berinteraksi langsung dengan MATS atau BEI untuk melakukan transaksi. Mandala Sekuritas dibutuhkan sebagai broker/gateway resmi yang mengelola akun player, saldo virtual, portfolio, order entry, validasi risiko, dan komunikasi dengan MATS/BEI.
- **Tujuan**: Membangun Sekuritas Service dan frontend Mandala Sekuritas sebagai aplikasi utama yang digunakan player untuk login, melihat market, menganalisis emiten, melakukan buy/sell, memantau order, dan melihat portfolio.
- **Target Pengguna**: Player manusia, admin/operator sekuritas, bot account secara konseptual, MATS Service, dan BEI Service.

## 2. Fitur Utama (Core Features)
- User Authentication: Player manusia dapat register/login ke Mandala Sekuritas dan wajib melewati email verification sebelum dapat trading. Bot account tidak memerlukan email verification, tetapi harus dibuat/diaktifkan oleh admin atau sistem yang berwenang. Setiap user memiliki tepat satu broker account pada MVP.
- Broker Account: Sistem membuat akun broker untuk setiap user dengan status active/suspended, cash account virtual, securities account, SID simulation, SRE simulation, RDN simulation, dan metadata player.
- Cash Management: Sistem menyimpan available cash, reserved cash, pending cash, dan cash movement ledger. Deposit awal dapat diberikan oleh admin atau seed data.
- Securities Portfolio: Sistem menyimpan available shares, reserved shares, pending shares, average price, realized P/L, unrealized P/L, dan position movement history.
- Order Entry: Player dapat membuat buy/sell order, amend order, dan cancel order melalui frontend. Order dikirim ke backend Sekuritas, bukan langsung ke MATS.
- Pre-Trade Validation: Sekuritas memvalidasi saldo cash untuk buy order, jumlah saham available untuk sell order, status akun, status market/symbol, minimum lot, fee/tax estimate, dan format order. Validasi ARA/ARB final tetap dilakukan MATS, tetapi Sekuritas harus bisa menampilkan estimasi price band dari rules BEI.
- Reservation System: Saat buy order dibuat, cash dipindahkan ke reserved cash. Saat sell order dibuat, saham dipindahkan ke reserved shares. Jika order cancel/reject/expired, reservation dikembalikan sesuai remaining quantity.
- Order Management System: Sekuritas menyimpan client order, mapping ke MATS order id, status order, fill quantity, remaining quantity, reject reason, amend history, cancel history, dan riwayat perubahan status.
- MATS Integration: Sekuritas mengirim place/amend/cancel order ke MATS melalui REST API internal dan menerima order/trade status update.
- BEI Integration: Sekuritas mengambil data listed securities, profile emiten, special notation, laporan keuangan, issuer announcement, trading rules, ARA/ARB, fraksi harga, fee/tax schedule, corporate action, settlement status, dan custody/position summary dari BEI.
- Settlement Handling: Saat trade matched, Sekuritas menandai cash/saham sebagai pending sesuai instruksi BEI. Saat settlement selesai, pending position berubah menjadi available atau cash final.
- Market Data UI: Frontend Mandala Sekuritas dapat subscribe langsung ke WebSocket MATS untuk data publik seperti last price, order book, trade tape, IEP, IEV, session state, non-cancellation indicator, trading halt status, special notation, dan market summary.
- Company Analysis View: Frontend menampilkan profil perusahaan, special notation, issuer announcement, laporan keuangan, rasio sederhana, dividen, IPO history, dan corporate action agar player dapat menganalisis saham.
- IPO Participation: Player dapat ikut subscription IPO melalui Sekuritas. Sekuritas meneruskan data ke BEI atau membaca event IPO dari BEI sesuai desain integrasi.
- Fee Simulation: Sekuritas menghitung broker fee, levy/biaya bursa, clearing fee, settlement fee, guarantee fund jika dipakai, PPN, dan PPh final jual berdasarkan fee schedule dari BEI. Fee wajib dicatat sejak MVP dan memengaruhi cash, buying power, realized P/L, dan leaderboard. Estimasi biaya harus muncul sebelum order dikirim agar player memahami total dana yang akan di-reserve.
- Notifications: Player menerima notifikasi order accepted, rejected, amended, partial fill, filled, cancelled, expired, locked_non_cancellable, settlement completed, dividend received, IPO allocation, issuer announcement, trading halt/resume, dan corporate action adjustment.
- Corporate Action Handling: Sekuritas menampilkan dan memproses dampak corporate action dari BEI seperti dividen, stock split, reverse split, bonus share, rights issue/HMETD, dan warrant sesuai ledger/settlement instruction.
- Leaderboard dan Ranking: Sekuritas menyediakan ranking player berdasarkan portfolio value, realized/unrealized P/L, return percentage, cash, dan optional ranking per session.
- Admin/Operator Sekuritas: Admin Sekuritas terpisah dari admin BEI. Admin Sekuritas dapat melihat akun player, memberi saldo awal, suspend akun, melihat order, melakukan reconciliation sederhana, mengatur status email verification jika diperlukan, dan memantau error integrasi.
- Bot Account Compatibility: Bot diperlakukan sebagai user/broker account khusus dengan flag bot, tetapi order flow tetap sama seperti player.

## 3. Persyaratan Non-Fungsional
- Tech Stack Frontend: Mandala Sekuritas frontend menggunakan React + Vite. TypeScript disarankan agar kontrak API, order state, dan portfolio state lebih aman.
- Tech Stack Backend: Mandala Sekuritas backend menggunakan Node.js + Fastify. TypeScript disarankan agar integrasi ke MATS dan BEI lebih mudah dijaga.
- Database: Mandala Sekuritas menggunakan NeonDB/Neon Postgres sebagai database utama untuk user, broker account, cash ledger, portfolio, order, fee, dan leaderboard.
- Security: Frontend menggunakan user authentication. Backend Sekuritas menggunakan JWT/session untuk player dan service token untuk komunikasi ke MATS/BEI.
- Separation of Concern: Sekuritas tidak melakukan matching order dan tidak menjadi sumber final kepemilikan efek. Matching milik MATS, custody final milik BEI.
- Consistency: Reservation cash/saham harus atomik agar player tidak bisa membeli melebihi saldo atau menjual saham yang sama dua kali.
- Idempotency: Place order, cancel order, status update, fill update, dan settlement update harus aman terhadap retry.
- Reconciliation: Sekuritas harus bisa membandingkan posisi lokal dengan custody/settlement summary dari BEI, termasuk referensi SID/SRE/RDN simulation.
- UX Realtime: Order status, market data, dan portfolio harus terasa realtime untuk sesi 5-10 menit.
- Deployability: Frontend dapat dihosting di Vercel, backend di Heroku, dan domain dikelola melalui Cloudflare.
- Access Control: Domain internal/API sensitif dapat dilindungi Cloudflare Access, tetapi backend tetap harus punya app-level auth karena domain bawaan platform mungkin masih aktif.
- Observability: Error dari MATS/BEI harus dicatat dengan correlation id agar mudah ditelusuri.
- Scalability MVP: Sistem harus cukup untuk beberapa player, banyak bot, banyak order per sesi, dan market data realtime ringan.

## 4. Kriteria Penerimaan (Acceptance Criteria)
- Player dapat register/login dan otomatis memiliki satu broker account di Mandala Sekuritas.
- Player manusia harus melakukan email verification sebelum dapat trading. Bot account tidak perlu email verification tetapi harus memiliki flag BOT dan dibuat melalui jalur admin/sistem.
- Player dapat melihat cash balance, portfolio, order list, trade history, dan settlement status.
- Player dapat melihat SID/SRE/RDN simulation reference pada profil akun.
- Buy order hanya bisa dikirim jika available cash cukup, lalu cash berpindah ke reserved cash.
- Sell order hanya bisa dikirim jika available shares cukup, lalu saham berpindah ke reserved shares.
- Sekuritas dapat mengirim place/amend/cancel order ke MATS dan menyimpan mapping client order id dengan MATS order id.
- Sekuritas dapat menerima status accepted, rejected, amended, partial fill, filled, cancelled, expired, locked_non_cancellable, dan memperbarui order state.
- Setelah trade matched, Sekuritas dapat membedakan posisi pending settlement dari posisi available.
- Setelah BEI mengirim settlement completed, Sekuritas memperbarui cash/portfolio player dengan benar.
- Frontend dapat menampilkan market data realtime dari MATS WebSocket.
- Frontend dapat menampilkan profil perusahaan, special notation, issuer announcement, laporan keuangan, dan dividen dari BEI.
- Frontend dapat menampilkan ARA/ARB, price band, fraksi harga, non-cancellation period, trading halt, dan status market/symbol agar player tahu kenapa order bisa ditolak atau tidak bisa dibatalkan.
- Fee transaksi memotong cash dan memengaruhi realized P/L sejak MVP.
- Leaderboard portfolio/P&L antar player tersedia.
- Admin dapat memberi modal awal dan melihat status akun/order player.
- Admin Sekuritas dan Admin BEI dipisahkan secara role/permission.
- Bot account dapat dibuat sebagai user khusus tanpa jalur order khusus.

## 5. Pertanyaan / Asumsi Terbuka
- Asumsi: Nama broker MVP adalah Mandala Sekuritas.
- Asumsi: Satu user hanya memiliki satu broker account pada MVP.
- Asumsi: Sistem disiapkan untuk multi-broker di masa depan, tetapi UI dan backend awal cukup untuk satu broker.
- Asumsi: Frontend market data boleh connect langsung ke MATS WebSocket, sedangkan order tetap wajib lewat backend Sekuritas.
- Asumsi: Deposit awal dan data saham awal dapat dibuat dari seed data yang nanti dibantu generate.
- Asumsi: Short selling dan margin trading tidak masuk MVP kecuali diputuskan lain.
- Keputusan: Player manusia perlu email verification, sedangkan BOT tidak perlu email verification.
- Keputusan: Leaderboard/ranking portfolio dan P/L antar player masuk MVP.
- Keputusan: Fee broker dan biaya transaksi dicatat sejak awal dan memengaruhi gameplay.
- Keputusan: Admin Sekuritas dipisahkan dari Admin BEI agar boundary operasional jelas.

## [V2 / Post-MVP] Fitur Terkini

- **OpenAPI Compliant Schema**: Backend dan Frontend Sekuritas kini telah di-refactor secara penuh agar mengikuti standar openapi.yaml. Variabel seperti quantity telah diganti menjadi original_quantity. Serta nilai tipe data enumerasi (seperti uy/sell, limit/market) kini ditulis dengan format lowercase (huruf kecil) murni di seluruh state, route, dan servis.
