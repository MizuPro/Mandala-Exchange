# Product Requirements Document (PRD) - BEI Service

## 1. Pendahuluan
- **Latar Belakang**: Mandala Exchange membutuhkan layanan pusat yang berperan sebagai otoritas pasar, pengelola data emiten, aturan perdagangan, corporate action, settlement, dan custody ledger. Pada versi sebelumnya seluruh tanggung jawab ini bercampur dengan sekuritas dan matching engine sehingga bug sulit dilacak dan batas domain tidak jelas.
- **Tujuan**: Membangun BEI Service sebagai market authority internal untuk simulasi bursa saham Mandala Exchange. Layanan ini menjadi sumber kebenaran untuk data saham, aturan pasar, settlement, kepemilikan efek, IPO, dividen, laporan keuangan, dan data administrasi pasar.
- **Target Pengguna**: Admin game/simulasi, BEI operator, MATS Service, Mandala Sekuritas, dan sistem bot secara tidak langsung melalui data pasar dan aturan yang diterbitkan.

## 2. Fitur Utama (Core Features)
- Market Authority: BEI Service mengelola konfigurasi pasar, status perdagangan, daftar broker anggota bursa, daftar emiten, daftar saham, dan aturan global yang harus dipatuhi MATS dan Sekuritas.
- Master Data Emiten: Admin dapat membuat, mengubah, menonaktifkan, dan melihat profil perusahaan tercatat seperti nama perusahaan, kode saham, sektor, papan pencatatan, jumlah saham beredar, harga IPO, status listed/suspended/delisted, dan ringkasan bisnis.
- Special Notation dan Board Monitoring: BEI Service dapat memberi notasi/status khusus pada emiten atau saham, misalnya watchlist/pemantauan khusus, suspend, delisting risk, unusual condition, atau catatan admin lain. Notasi ini harus tersedia untuk Sekuritas dan MATS.
- Issuer Disclosure dan Announcement: BEI Service menyediakan modul pengumuman emiten seperti laporan keuangan, keterbukaan informasi, berita material, jadwal RUPS, jadwal dividen, jadwal rights issue, dan event IPO. Untuk MVP, konten dapat dibuat manual oleh admin atau generator.
- Data Fundamental Perusahaan: Admin dapat menginput laporan keuangan sederhana seperti pendapatan, laba bersih, aset, liabilitas, ekuitas, EPS, book value, dividend payout, dan periode laporan. Data ini dipakai pemain untuk analisis saham.
- Trading Rules Management: Admin dapat mengatur lot size, tick size/fraksi harga, ARA/ARB, auto rejection volume, batas harga harian, reference price, jam/sesi perdagangan, non-cancellation period, post-closing rule, settlement mode, settlement delay per sesi, aturan suspend, trading halt, dan fee/levy/tax dasar.
- BEI-like Price Band: BEI Service menyimpan preset aturan price band yang meniru konsep Bursa Efek Indonesia. Untuk saham papan utama/pengembangan/ekonomi baru, ARA dapat dibuat bertingkat berdasarkan reference price, sedangkan ARB dibuat configurable dengan preset 15%. Untuk papan akselerasi/watchlist/pemantauan khusus, sistem harus mendukung aturan berbeda seperti batas persentase khusus dan call auction.
- Fraksi Harga: BEI Service menyimpan tabel fraksi harga berdasarkan rentang harga. Preset awal mengikuti konsep BEI dengan satuan perubahan harga berdasarkan price tier. MATS menggunakan aturan ini untuk menolak harga order yang tidak sesuai tick.
- Lot Size: BEI Service menyimpan lot size per instrument. Preset awal untuk saham adalah 1 lot = 100 lembar, tetapi tetap configurable untuk kebutuhan simulasi.
- Auto Rejection Volume: BEI Service menyimpan aturan batas volume order, misalnya batas maksimum lot atau persentase tertentu dari jumlah efek tercatat. MATS menggunakan aturan ini untuk reject order yang terlalu besar.
- Papan Pencatatan dan Mekanisme Pasar: BEI Service mendukung board seperti Utama, Pengembangan, Akselerasi, Ekonomi Baru, dan Pemantauan Khusus secara konseptual. MVP harus mendukung minimal papan umum dan status pemantauan khusus agar aturan ARA/ARB/call auction bisa berbeda per board.
- Market Segment: BEI Service mendukung konsep pasar reguler, pasar tunai, dan pasar negosiasi. MVP fokus pada pasar reguler simulasi, tetapi schema dan rule model tidak boleh menutup kemungkinan pasar tunai/negosiasi di fase berikutnya.
- Reference Price Management: BEI Service menentukan reference price yang dipakai untuk ARA/ARB, misalnya previous close, harga IPO/listing, opening price, atau harga penyesuaian setelah corporate action.
- Session Template: BEI Service menyimpan template sesi seperti pre-opening, opening auction, continuous market, pre-closing, random closing, non-cancellation period, post-closing, dan closed. Durasi tetap custom sesuai gameplay.
- Index dan Market Summary: BEI Service menghitung indeks/market summary simulasi seperti market index, sector index, total value, volume, frequency, top gainers, top losers, most active, dan market capitalization. Data ini dipakai untuk dashboard, leaderboard, dan circuit breaker.
- Trading Halt dan Suspend: BEI Service mendukung konfigurasi penghentian sementara perdagangan. Untuk simulasi, admin dapat mengaktifkan circuit breaker berdasarkan penurunan indeks/game market index atau manual suspend/resume per symbol.
- Fee, Levy, dan Tax Model: BEI Service menyimpan model biaya transaksi yang configurable. Preset realistis Indonesia harus memisahkan broker commission, biaya transaksi bursa/levy, biaya kliring, biaya penyelesaian, dana jaminan jika dipakai, PPN, dan PPh final transaksi jual. Field awal yang disiapkan: broker_buy_rate, broker_sell_rate, exchange_fee_rate, clearing_fee_rate, settlement_fee_rate, guarantee_fund_rate, vat_rate, sell_tax_rate, minimum_fee, dan effective_date.
- Realistic Indonesia Fee Preset: Untuk simulasi BEI-like, sistem menyediakan preset awal yang dapat diedit admin: biaya transaksi bursa/BEI, KPEI clearing, KSEI settlement, dana jaminan bila dipakai, PPN sebagai rate configurable, dan PPh final jual 0,1% dari nilai bruto transaksi jual. Broker commission tetap configurable karena tiap sekuritas bisa berbeda.
- Broker Member Registry: BEI Service menyimpan daftar sekuritas anggota bursa. Untuk MVP hanya ada satu broker aktif yaitu Mandala Sekuritas, tetapi struktur data harus mendukung lebih dari satu sekuritas.
- IPO Management: Admin dapat membuat event IPO, menentukan emiten, jumlah saham ditawarkan, harga penawaran, periode bookbuilding/subscription, jadwal listing, alokasi investor, dan status IPO. Implementasi awal boleh sederhana dan manual.
- Corporate Action: Admin dapat membuat event dividen tunai, stock split, reverse split, bonus share, rights issue/HMETD, dan warrant sebagai bagian dari MVP. Implementasi awal boleh sederhana, tetapi setiap corporate action harus memengaruhi ledger/position secara benar.
- Trade Capture: BEI Service menerima trade final dari MATS secara idempotent. Trade ini menjadi dasar untuk clearing, settlement, reporting, dan custody movement.
- Clearing Simulation: BEI Service menghitung kewajiban bersih broker dan investor berdasarkan trade matched. Untuk MVP, clearing boleh dilakukan per trade terlebih dahulu, lalu dapat dikembangkan menjadi netting per broker/per sesi.
- Settlement Engine: BEI Service memproses settlement berdasarkan konfigurasi admin. Mode yang wajib didukung adalah configurable settlement, dengan default end-of-session. Opsi yang dirancang: instant, end-of-session, T+1 session, dan T+N session. Pada MVP, settlement failure tidak perlu disimulasikan; semua settlement yang valid harus berhasil dan tercatat konsisten.
- Settlement Instruction Model: BEI Service menyimpan instruksi settlement konseptual seperti DVP/RVP/FOP untuk membedakan settlement dengan pembayaran, penerimaan dengan pembayaran, dan transfer efek tanpa pembayaran. MVP boleh menyederhanakan eksekusinya, tetapi tipe instruksi harus tercatat.
- Custody Ledger: BEI Service menjadi sumber kebenaran kepemilikan efek final. Perubahan kepemilikan saham dicatat sebagai ledger entry, bukan hanya overwrite posisi akhir.
- SID, SRE, dan RDN Simulation: BEI Service menyediakan konsep identitas investor dan rekening seperti SID, Sub Rekening Efek/SRE, dan Rekening Dana Nasabah/RDN secara simulasi. Data detail akun tetap dikelola Sekuritas, tetapi BEI menyimpan referensi untuk custody dan settlement.
- Settlement Position State: Sistem membedakan available, reserved, pending, dan settled position agar transaksi matched tidak langsung dianggap final sebelum settlement.
- Reporting dan Audit: BEI Service menyediakan laporan emiten, trade resmi, settlement batch, corporate action, custody movement, broker obligation, dan audit log perubahan admin.
- Surveillance Dasar: Sistem mendeteksi sinyal sederhana seperti lonjakan harga ekstrem, ARA/ARB beruntun, volume tidak normal, wash-trade sederhana, order/trade dari bot yang terlalu dominan, cancellation rate tinggi, dan aktivitas transaksi tidak biasa. Fitur ini tidak wajib lengkap di MVP awal.
- Integration API: BEI Service menyediakan REST API untuk MATS dan Sekuritas. API internal harus mendukung idempotency key, service authentication, dan audit trail.
- Admin Dashboard Backend: BEI Service harus menyediakan API untuk dashboard admin. Frontend admin tidak perlu dihosting melalui Cloudflare Tunnel pada tahap awal.
- Financial Data Generator: Laporan keuangan perusahaan dapat dibuat manual oleh admin atau digenerate otomatis oleh sistem. Generator harus bisa menghasilkan data yang masuk akal untuk gameplay, misalnya pendapatan, laba, aset, liabilitas, ekuitas, EPS, pertumbuhan, dan skenario naik/turun.

## 3. Persyaratan Non-Fungsional
- Tech Stack: BEI Service menggunakan Node.js + Fastify + TypeScript agar ringan, cepat dibuat, dan konsisten dengan ekosistem backend Sekuritas. Query layer disarankan memakai Drizzle ORM atau Kysely agar tetap type-safe tanpa overhead besar.
- Database: BEI Service menggunakan PostgreSQL yang dijalankan via Docker/Docker Compose untuk local/self-hosted deployment.
- Keamanan: API internal dilindungi authentication aplikasi dan dapat ditempatkan di belakang Cloudflare Access. Komunikasi backend-to-backend menggunakan service credential/token.
- Konsistensi Data: Trade capture, settlement, custody ledger, dan corporate action harus idempotent agar retry tidak membuat data ganda.
- Auditability: Semua aksi admin yang mengubah data penting harus dicatat dengan actor, timestamp, before/after value, dan alasan perubahan jika tersedia.
- Integritas Ledger: Custody ledger harus append-only secara konsep. Koreksi dilakukan melalui reversal/adjustment entry, bukan menghapus riwayat.
- Reliabilitas: Jika MATS atau Sekuritas gagal menerima update, BEI Service tetap menyimpan event resmi dan menyediakan endpoint retry/reconciliation.
- Skalabilitas MVP: Sistem tidak ditargetkan untuk volume bursa nyata, tetapi harus cukup stabil untuk beberapa pemain, banyak bot, dan banyak saham simulasi.
- Observability: Setiap batch settlement, corporate action, dan trade import harus punya status, error message, dan log yang mudah ditelusuri.
- Deployability: BEI Service dapat berjalan di laptop lokal dan diekspos via Cloudflare Tunnel untuk domain internal.
- Containerization: Database BEI wajib dapat dijalankan dari Docker Compose agar setup lokal, backup, dan reset data simulasi lebih mudah.
- Data Ownership: Data final emiten, trading rules, settlement, dan custody berada di BEI Service. MATS menyimpan data operasional perdagangan, Sekuritas menyimpan data akun dan tampilan portfolio.

## 4. Kriteria Penerimaan (Acceptance Criteria)
- Admin dapat membuat minimal 3 emiten dan saham tercatat lengkap dengan data profil dan ringkasan fundamental.
- Admin dapat mengatur sesi perdagangan custom, settlement mode, settlement delay, tick size, lot size, ARA/ARB, auto rejection volume, dan batas harga berbasis reference price.
- Admin dapat mengatur session template, non-cancellation period, post-closing rule, market-wide halt, dan symbol suspend/resume.
- BEI Service dapat membuat special notation/watchlist untuk saham dan mengirimkannya ke MATS/Sekuritas.
- BEI Service dapat mendaftarkan Mandala Sekuritas sebagai broker aktif.
- BEI Service dapat menerima trade dari MATS dengan idempotency key tanpa membuat duplikasi saat request dikirim ulang.
- BEI Service dapat membuat settlement batch pada akhir sesi dan memproses perpindahan cash/saham secara konseptual.
- Custody ledger mencatat setiap perubahan kepemilikan saham akibat settlement, IPO allocation, dan dividen.
- Sekuritas dapat mengambil data listed securities, trading rules, corporate action, settlement status, dan custody/position summary melalui API.
- BEI Service dapat menghasilkan laporan trade, settlement, dan corporate action untuk satu sesi simulasi.
- Admin dapat menjalankan event dividen tunai, stock split, reverse split, bonus share, rights issue/HMETD, dan warrant sederhana, lalu sistem menghasilkan ledger/position adjustment yang benar.
- Sistem mampu membedakan trade matched dari MATS dan trade settled dari BEI.
- BEI Service dapat menerbitkan fee/tax schedule yang dipakai Sekuritas untuk menghitung biaya transaksi sejak order/trade pertama.
- BEI Service dapat menyediakan data laporan keuangan manual dan hasil generator otomatis.
- BEI Service dapat menghasilkan market summary dan index sederhana untuk satu sesi simulasi.
- BEI Service dapat menyimpan SID/SRE/RDN simulation reference dan settlement instruction type.

## 5. Pertanyaan / Asumsi Terbuka
- Asumsi: Settlement default adalah end-of-session, tetapi admin dapat mengubah ke instant, T+1 session, atau T+N session.
- Asumsi: Untuk MVP, clearing dilakukan lebih sederhana per investor/per trade sebelum dikembangkan ke netting broker.
- Asumsi: Data emiten, IPO, dan corporate action diinput manual oleh admin dulu.
- Asumsi: Laporan keuangan dapat diedit manual dan juga dapat dibuat melalui generator otomatis.
- Asumsi: Mandala Sekuritas adalah satu-satunya broker aktif pada MVP, tetapi schema harus mendukung banyak broker.
- Asumsi: Admin dashboard akan dibuat nanti, tetapi BEI Service harus menyiapkan API admin sejak awal.
- Keputusan: Fee, levy, dan pajak dibuat realistis mengikuti struktur pasar Indonesia, tetapi semua angka harus configurable agar mudah disesuaikan jika aturan berubah.
- Keputusan: Corporate action selain dividen masuk MVP, minimal stock split, reverse split, bonus share, rights issue/HMETD, dan warrant dengan implementasi sederhana.
- Keputusan: Settlement failure tidak disimulasikan pada MVP. Targetnya adalah settlement yang valid benar-benar sukses dan mudah direkonsiliasi.
- Keputusan: BEI Service perlu menyimpan rule preset ARA/ARB, fraksi harga, auto rejection volume, dan trading halt/circuit breaker.
- Keputusan: Formula biaya mengikuti struktur pasar Indonesia secara komponen, bukan satu angka flat. Semua rate disimpan di fee schedule agar bisa diubah admin ketika aturan atau desain gameplay berubah.
- Keputusan: Price band mengikuti model BEI-like berbasis reference price, board, dan rentang harga, bukan persentase flat untuk semua saham.
- Asumsi: Full periodic call auction untuk Papan Pemantauan Khusus disiapkan di rule/schema, tetapi implement penuh dapat dilakukan setelah regular market stabil.
