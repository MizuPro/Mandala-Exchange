# Product Requirements Document (PRD) - MATS Service

## 1. Pendahuluan
- **Latar Belakang**: Mandala Exchange membutuhkan mesin perdagangan terpisah dari BEI dan Sekuritas agar order book, matching, sesi perdagangan, IEP, dan market data dapat dikembangkan serta di-debug secara mandiri. Nama layanan ini adalah MATS, singkatan dari Mandala Automated Trading System.
- **Tujuan**: Membangun MATS Service sebagai exchange engine yang menerima order dari sekuritas, menjalankan aturan perdagangan, mencocokkan order, menghasilkan trade, dan mempublikasikan data pasar realtime.
- **Target Pengguna**: Mandala Sekuritas sebagai order gateway, BEI Service sebagai market authority dan penerima trade resmi, admin/operator pasar, player secara tidak langsung melalui aplikasi Sekuritas, dan bot secara tidak langsung melalui akun Sekuritas.

## 2. Fitur Utama (Core Features)
- Order Gateway API: MATS menerima order beli/jual, amend order, dan cancel order dari Sekuritas melalui REST API internal. Request harus membawa broker identifier, account identifier, symbol, side, price, quantity, order type, dan idempotency key.
- Order Validation: MATS memvalidasi status sesi, status saham, tick size/fraksi harga, lot size, ARA/ARB, price band, auto rejection volume, order quantity, board-specific rule, dan duplikasi request. Validasi saldo dan kepemilikan saham tetap tanggung jawab Sekuritas.
- ARA/ARB dan Price Band: MATS menghitung batas harga order dari reference price, board, dan rentang harga yang diberikan BEI. Untuk preset BEI-like, saham pada papan umum dapat memakai ARA bertingkat dan ARB configurable dengan default 15%, sedangkan papan akselerasi/watchlist/pemantauan khusus dapat memakai batas khusus.
- Auto Rejection Volume: MATS menolak order yang melebihi batas volume dari BEI, misalnya order di atas batas lot maksimum atau persentase tertentu dari listed shares.
- Order Book: MATS menyimpan order book per symbol dengan price-time priority. Buy order diprioritaskan dari harga tertinggi lalu waktu masuk; sell order dari harga terendah lalu waktu masuk. Market data harus dapat menyediakan full depth yang tersedia dalam batas ARA/ARB dan aturan symbol tersebut.
- Continuous Matching Engine: MATS mencocokkan order selama sesi continuous market. Sistem harus mendukung partial fill, full fill, cancel, reject, dan remaining open quantity.
- Market Session Engine: MATS menjalankan state sesi perdagangan berdasarkan konfigurasi dari BEI. State awal yang disarankan: CLOSED, PRE_OPEN, OPENING_AUCTION, CONTINUOUS, PRE_CLOSE, RANDOM_CLOSING, CLOSING_AUCTION, POST_CLOSE, NON_CANCELLATION, dan HALTED.
- Opening Auction: MATS mengumpulkan order pada fase opening auction tanpa langsung match continuous. Pada akhir auction, sistem menghitung IEP dan menjalankan matching auction.
- Closing Auction: MATS mengumpulkan order pada fase closing auction dan menghitung IEP sebagai dasar harga penutupan simulasi.
- Non-Cancellation Period: MATS mendukung periode tertentu pada pre-opening dan pre-closing ketika order yang sudah masuk tidak boleh dibatalkan atau diubah. Durasi dan kapan aktifnya ditentukan oleh BEI Service.
- Post-Closing Trading: MATS mendukung mode post-closing sederhana yang hanya memperbolehkan transaksi pada closing price jika fitur diaktifkan oleh BEI. Jika tidak diaktifkan, sesi langsung berakhir setelah closing auction.
- IEP dan IEV: MATS menghitung Indicative Equilibrium Price dan Indicative Equilibrium Volume. Algoritma awal disarankan: pilih harga yang memaksimalkan matched volume, lalu meminimalkan imbalance, lalu memilih harga terdekat ke reference price sebagai tie-break.
- Trade Generation: Setiap match menghasilkan trade event dengan trade id, sequence number, symbol, price, quantity, buy order id, sell order id, broker/account metadata, session id, dan timestamp.
- Order Status Event: MATS mengirim status order seperti accepted, rejected, open, amended, partially_filled, filled, cancelled, expired, dan locked_non_cancellable ke Sekuritas.
- Market Data Realtime: MATS menyediakan WebSocket untuk last price, trade tape, best bid/ask, depth/order book snapshot, session state, IEP, IEV, market halt status, special notation, dan daily/session statistics.
- Full Depth Market Data: MATS menyediakan full depth order book yang ada untuk player, bukan hanya top 5/top 10. Implementasi frontend boleh melakukan virtualized rendering agar UI tetap ringan.
- Trade Reporting ke BEI: MATS mengirim trade final ke BEI Service secara idempotent agar BEI dapat melakukan clearing, settlement, custody ledger, dan reporting.
- Replay dan Recovery: MATS menyimpan event order dan trade agar state order book dapat ditelusuri dan direkonstruksi saat debugging.
- Instrument Sync: MATS mengambil data listed securities, special notation, trading status, tick size, lot size, price band, board rule, session template, non-cancellation period, dan market halt rule dari BEI Service.
- Short Selling dan Margin Rule: MATS tidak mendukung short selling dan margin trading pada MVP. Semua sell order tetap dianggap regular sell dari kepemilikan available/reserved yang sudah divalidasi Sekuritas.
- Order Expiry: Semua order MVP adalah session/day order yang otomatis expired pada akhir sesi perdagangan. Order yang belum matched tidak carry over ke sesi berikutnya.
- Market Segment Scope: MVP fokus pada pasar reguler simulasi. Struktur harus cukup fleksibel untuk menambah pasar tunai, pasar negosiasi, atau full periodic call auction khusus di masa depan.
- Trading Halt Handling: MATS harus bisa menerima instruksi trading halt, resume, suspend symbol, atau market-wide halt dari BEI/admin dan menghentikan penerimaan/matching order sesuai state.
- Market Summary Feed: MATS menyediakan data dasar untuk BEI/Sekuritas seperti open, high, low, close, last, volume, value, frequency, dan top-of-book/full-depth summary per symbol.
- Admin Control API: Admin dapat start/stop session, pause/resume matching, suspend symbol secara operasional, dan melihat health/status engine. Sumber aturan final tetap BEI Service.

## 3. Persyaratan Non-Fungsional
- Tech Stack: MATS Service menggunakan Go untuk backend agar matching engine, session engine, dan WebSocket market data tetap ringan serta predictable. Dependency disarankan minimal, misalnya router ringan, `pgx` untuk PostgreSQL, dan library WebSocket yang stabil.
- Database: MATS menggunakan PostgreSQL via Docker/Docker Compose untuk menyimpan event order, trade, session, dan recovery log. Order book aktif tetap disimpan in-memory agar matching cepat.
- Deterministik: Matching engine harus menghasilkan hasil yang sama untuk urutan event yang sama.
- Idempotent: Place order, cancel order, dan trade reporting harus aman terhadap retry.
- Low Latency untuk Simulasi: Tidak perlu setara exchange nyata, tetapi harus responsif untuk sesi 5-10 menit, realtime UI, dan aktivitas bot.
- Concurrency Safety: Order book tidak boleh menghasilkan double match pada kondisi request bersamaan.
- Auditability: Setiap order dan trade harus punya sequence number dan timestamp untuk tracing.
- Separation of Concern: MATS tidak menyimpan password user, KYC, saldo cash final, custody ledger, IPO, atau dividen.
- Security: API internal hanya dapat dipanggil oleh layanan yang berwenang, terutama Sekuritas dan BEI. Jika diekspos via Cloudflare Tunnel, gunakan Cloudflare Access dan service token.
- Containerization: Database MATS wajib dapat dijalankan dari Docker Compose. Backend Go tetap bisa dijalankan langsung secara lokal atau dikemas ke container pada fase deployment.
- WebSocket Stability: Market data harus mendukung reconnect dan snapshot ulang.
- Error Handling: Reject reason harus jelas agar Sekuritas dapat menampilkan status yang benar.
- Data Retention: Order dan trade history minimal disimpan selama satu game/simulasi aktif untuk kebutuhan audit dan replay.

## 4. Kriteria Penerimaan (Acceptance Criteria)
- Sekuritas dapat mengirim limit buy/sell order ke MATS dan menerima order id serta status accepted/rejected.
- MATS dapat membuat order book per symbol dan mengurutkan order berdasarkan price-time priority.
- MATS dapat mencocokkan buy dan sell order pada harga yang valid, termasuk partial fill.
- MATS dapat mengirim order status update ke Sekuritas setelah accepted, partial fill, full fill, cancel, dan reject.
- MATS dapat menerima amend order selama order masih open dan bukan dalam non-cancellation period.
- MATS dapat mempublikasikan market data realtime melalui WebSocket.
- MATS dapat mempublikasikan full depth order book yang tersedia dalam batas ARA/ARB.
- MATS dapat menjalankan sesi custom dari BEI, termasuk opening auction, continuous market, closing auction, dan closed state.
- MATS dapat menjalankan non-cancellation period, random closing, post-closing optional, dan trading halt state sesuai konfigurasi BEI.
- MATS dapat menghitung IEP dan IEV pada opening/closing auction dengan algoritma yang terdokumentasi.
- MATS dapat mengirim trade event ke BEI secara idempotent.
- MATS dapat menolak order saat market closed, symbol suspended, harga tidak sesuai tick, harga keluar dari ARA/ARB/price band, volume order melewati batas auto rejection volume, atau rule board tidak terpenuhi.
- MATS otomatis meng-expire order yang masih open pada akhir sesi.
- MATS mengirim market summary per symbol untuk kebutuhan BEI dan frontend Sekuritas.
- MATS tidak mengizinkan short selling dan margin trading pada MVP.
- MATS dapat memulihkan atau minimal menelusuri event order/trade setelah error melalui event log.

## 5. Pertanyaan / Asumsi Terbuka
- Asumsi: Order type awal hanya limit order. Market order, stop order, dan advanced order dapat ditambahkan nanti.
- Asumsi: Validasi buying power dan share availability dilakukan Sekuritas, bukan MATS.
- Asumsi: Frontend Sekuritas boleh connect langsung ke WebSocket MATS untuk market data publik, tetapi order tetap lewat backend Sekuritas.
- Asumsi: MATS menyimpan order/trade operasional, sedangkan BEI menyimpan trade resmi untuk settlement dan reporting.
- Asumsi: IEP menggunakan algoritma sederhana yang cukup realistis, bukan implementasi lengkap semua aturan BEI.
- Keputusan: Kedalaman order book untuk player adalah full depth yang tersedia, dengan tetap tunduk pada ARA/ARB dan rule symbol.
- Keputusan: Short selling dan margin trading dilarang pada MVP dan disiapkan sebagai fitur masa depan.
- Keputusan: Order yang belum matched otomatis expired pada akhir sesi.
- Keputusan: Price band tidak dibuat satu persentase flat untuk semua saham. MATS menghitung batas harga dari reference price, board, dan rentang harga sesuai rule BEI-like yang diterbitkan BEI Service.
- Asumsi: Papan Pemantauan Khusus/full periodic call auction disiapkan di rule engine dan schema, tetapi implement penuh dilakukan setelah regular market stabil.

## [V2 / Post-MVP] Fitur Terkini

- **Admin UI (Control Panel)**: Antarmuka terpadu bagi administrator untuk memantau status engine, melihat log event, mengatur durasi sesi, men-trigger Uncross secara manual, dan memantau status suspend saham.
- **Automated Session Runner**: MATS kini diperlengkapi dengan daemon (Ticker) yang dapat membaca durasi duration_seconds setiap segmen sesi pasar, dan melakukan perpindahan fase status secara otomatis (tanpa intervensi manual).
- **Redis Pub/Sub Circuit Breaker**: Integrasi event-driven via Redis untuk merespon secara instan event suspend_symbol atau session_state dari BEI, lalu melakukan *market halt* pada level matching engine.

