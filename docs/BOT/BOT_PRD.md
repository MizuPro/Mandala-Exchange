# Product Requirements Document (PRD) - Bot Concept

## 1. Pendahuluan
- **Latar Belakang**: Mandala Exchange membutuhkan bot agar pasar tetap hidup, harga bergerak, order book memiliki likuiditas, dan gameplay terasa dinamis meskipun jumlah player manusia sedikit.
- **Tujuan**: Mendefinisikan konsep bot sebagai automated investor yang tunduk pada aturan yang sama dengan player. Bot tidak boleh bypass Sekuritas, MATS, settlement, atau aturan pasar.
- **Target Pengguna**: Admin game, developer strategy bot, player secara tidak langsung, Sekuritas Service, MATS Service, dan BEI Service.

## 2. Fitur Utama (Core Features)
- Bot sebagai User Sekuritas: Bot dibuat sebagai user/broker account khusus di Mandala Sekuritas dengan flag seperti account_type BOT atau is_bot true. Bot tidak membutuhkan email verification, tetapi harus dibuat/diaktifkan oleh admin atau sistem yang berwenang.
- Jalur Order Sama: Bot mengirim order lewat Sekuritas, lalu Sekuritas meneruskan order ke MATS. Bot tetap kena validasi saldo, validasi saham, ARA/ARB, fraksi harga, fee, reservation, order amendment/cancel rule, non-cancellation period, order expiry, order status, dan settlement.
- Bot Strategy Engine: Script/engine membaca market data, portfolio bot, fundamental emiten, session state, dan event pasar untuk menentukan order.
- Bot Identity dan Metadata: Setiap bot memiliki nama, strategy type, risk profile, initial cash, allowed symbols, max order size, max exposure, dan status active/paused/disabled.
- Strategy Types: Strategi awal yang bisa dirancang adalah noise trader, market maker, momentum trader, contrarian, value investor, dan event/news trader.
- Market Maker Bot: Bot dapat menjaga likuiditas dengan memasang bid dan offer pada spread tertentu, tetapi tetap dibatasi inventory, cash, dan risk limit.
- Fundamental Bot: Bot dapat bereaksi terhadap laporan keuangan, dividen, IPO, dan valuasi sederhana untuk membuat pasar terasa bisa dianalisis.
- Admin Control: Admin dapat membuat, mengaktifkan, mem-pause, mengubah konfigurasi, atau mematikan bot tertentu.
- Risk Limits: Bot harus memiliki batas maksimum order per menit/sesi, maksimum posisi per saham, maksimum cash usage, maksimum loss, dan batas cancellation rate.
- Trading Rule Compliance: Bot tidak boleh menggunakan short selling atau margin trading pada MVP. Bot juga harus tunduk pada auto rejection volume, special notation, market halt, symbol suspend, non-cancellation period, dan order expiry akhir sesi.
- Fee-Aware Strategy: Strategi bot harus memperhitungkan broker fee, levy, tax, dan biaya transaksi lain agar perilaku trading tidak menghasilkan profit palsu akibat mengabaikan biaya.
- Audit Trail: Semua order bot harus bisa ditelusuri ke bot account, strategy id, decision timestamp, dan alasan/decision context jika tersedia.
- Performance Tracking: Sistem dapat menghitung return, realized P/L, unrealized P/L, win rate, turnover, market impact, dan inventory per bot.
- Fairness Rule: Bot tidak boleh membaca data rahasia yang tidak tersedia untuk player, kecuali admin secara eksplisit membuat bot khusus untuk simulasi market maker.

## 3. Persyaratan Non-Fungsional
- Tech Stack: Bot belum menjadi layanan terpisah pada tahap ini. Implementasi awal dapat berupa worker/script yang berjalan di ekosistem Sekuritas atau service terpisah nanti. Jika dipisah, stack akan ditentukan setelah strategi bot lebih matang.
- Fairness: Bot dan player harus melewati jalur transaksi yang sama.
- Safety: Bot engine harus bisa dihentikan cepat jika terjadi spam order, bug strategi, atau gangguan pasar.
- Configurable: Strategy parameter harus dapat diubah tanpa mengubah kode inti sebanyak mungkin.
- Observability: Aktivitas bot harus mudah dipantau melalui log, metrics, dan dashboard admin di masa depan.
- Isolation: Error di satu bot tidak boleh menghentikan seluruh pasar atau bot lain.
- Rate Limiting: Bot harus dibatasi agar tidak membanjiri MATS dan WebSocket.
- Reproducibility: Untuk testing, bot idealnya mendukung random seed agar perilaku dapat direplay.

## 4. Kriteria Penerimaan (Acceptance Criteria)
- Bot dapat dibuat sebagai user khusus di Sekuritas tanpa jalur order khusus.
- Bot dapat memiliki cash, portfolio, order history, dan settlement status seperti player.
- Bot dapat mengirim buy/sell order melalui fungsi/API yang sama dengan player.
- Order bot dapat matched dengan order player dan tetap melalui settlement.
- Order bot dapat terkena reject karena ARA/ARB, fraksi harga, volume limit, special notation, market halt, non-cancellation period, atau saldo/saham tidak cukup.
- Order bot yang belum matched expired pada akhir sesi seperti order player.
- Fee transaksi bot tercatat dan memengaruhi P/L bot.
- Admin dapat pause/resume bot.
- Aktivitas bot dapat dibedakan dari player melalui metadata dan audit log.
- Minimal satu strategi bot sederhana dapat dirancang nanti untuk mengisi order book tanpa melanggar validasi Sekuritas.

## 5. Pertanyaan / Asumsi Terbuka
- Asumsi: BOT_MAIN_PLAN.md belum dibuat karena konsep bot masih akan di-improve.
- Asumsi: Bot engine belum menjadi layanan terpisah pada tahap awal. Bot dapat dimulai sebagai worker/modul terkontrol, lalu dipisah jika sudah kompleks.
- Asumsi: Bot tidak boleh direct insert order ke MATS.
- Asumsi: Market maker boleh memiliki konfigurasi khusus, tetapi order tetap lewat Sekuritas.
- Asumsi: Bot tidak perlu email verification, tetapi tetap perlu account resmi dan audit trail.
- Asumsi: Bot MVP tidak menggunakan short selling dan margin trading.
- Pertanyaan: Bot engine akan berjalan di backend Sekuritas, service terpisah, atau di laptop yang sama dengan BEI/MATS?
- Pertanyaan: Apakah bot boleh punya modal sangat besar untuk stabilisasi pasar, atau modalnya harus sebanding dengan player?
- Pertanyaan: Apakah bot boleh tahu event masa depan seperti jadwal dividen sebelum player, atau semua informasi harus simetris?
- Pertanyaan: Apakah bot didesain untuk menantang player, menstabilkan pasar, atau menciptakan volatilitas?
