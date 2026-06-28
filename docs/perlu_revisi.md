# Laporan Temuan Masalah & Rencana Revisi Sistem

Dokumen ini merangkum dua permasalahan utama (bug/gap analisis) yang ditemukan pada ekosistem Mandala Exchange berdasarkan hasil pengujian otomatis E2E dan penelusuran kode (code tracing).

---

## POIN 1: Kegagalan Pendebetan & Refund Kas pada Allotment IPO

### A. Detail Permasalahan & Kronologi Bug
Dalam pengujian E2E penjatahan (allotment) saham perdana (Initial Public Offering - IPO) emiten baru **MOSE** dengan rasio penjatahan **25%** (oversubscribed 400%):
* **Distribusi Saham**: Berhasil. Semua trader yang memesan menerima tepat 25% saham dari kuantitas pemesanan mereka di portofolio Sekuritas.
* **Saldo Kas Trader**: **Bermasalah**. Saldo kas trader di database Sekuritas (`cash_balances`) tetap utuh (tidak terpotong sama sekali). Akibatnya, trader mendapatkan saham IPO tersebut secara **cuma-cuma (gratis)**, dan tidak ada sisa dana ditahan (hold/reserve) yang dikembalikan ke saldo kas riil (*available cash*).

### B. Analisis Penyebab Utama (Root Cause)
1. **Webhook BEI Hanya Mengirim Entitlement Saham**:
   Pada file [corporate-actions.ts (BEI)](file:///E:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/corporate-actions.ts) baris 371-379, array `entitlements` yang dikirim ke Sekuritas hanya berisi item yang bertipe `"security"` (penambahan saham):
   ```typescript
   entitlements.push({
     broker_account_id: subscription.investorId,
     investor_id: subscription.investorId,
     broker_code: broker.code,
     symbol: symbol,
     asset_type: "security",
     quantity: allocatedShares,
     idempotency_key: `ledger:ipo:${allocation.id}`
   });
   ```
   Tidak ada entri entitlement untuk pemotongan kas (`asset_type: "cash"` bernilai negatif) yang dikirimkan oleh BEI.
2. **Parser Webhook Sekuritas Hanya Memproses Saham**:
   Di sisi Sekuritas (`SEKURITAS/backend/src/services/corporate-action-service.ts`), karena webhook yang diterima hanya bertipe `"security"`, sistem hanya menambahkan saldo saham ke portofolio nasabah (`applySecurityMovement`), namun tidak memiliki logika mandiri untuk memotong saldo kas nasabah sesuai harga penawaran IPO.

### C. Rekomendasi Alternatif Solusi
* **Alternatif 1: Pengiriman Entitlement Kas Negatif via Webhook BEI (Cepat & Efisien)**:
  BEI memodifikasi proses pembuatan webhook `/ipo-events/:id/allocate` agar mengirimkan dua entitlement untuk setiap nasabah: satu untuk penambahan saham (`asset_type: "security"`), dan satu untuk pendebetan kas RDN (`asset_type: "cash"` dengan `cash_amount: -totalCost`). Sekuritas sudah mendukung pendebetan kas otomatis jika menerima entitlement kas negatif, sehingga tidak perlu merubah kode Sekuritas.
* **Alternatif 2: Integrasi Alur Pemesanan / Hold Saldo di Sekuritas (Terbaik & Sesuai Riil)**:
  Sekuritas memindahkan saldo kas pemesanan nasabah dari status `available` ke status `reserved` sejak pemesanan dilakukan. Saat webhook alokasi BEI diterima, Sekuritas secara lokal menghitung dan memindahkan dana dari `reserved` ke `settled` (sebesar nilai alokasi riil), lalu melepaskan sisa dana yang ditahan kembali ke saldo `available` (sebagai refund otomatis).

---

## POIN 2: Ketiadaan Perdagangan dan Standarisasi ARA/ARB untuk Waran & Right Issue

### A. Detail Permasalahan
Dalam pengujian corporate action tingkat lanjut untuk pembagian Waran (Warrant) dan Right Issue (HMETD):
1. **Waran/Right Tidak Bisa Diperdagangkan (Default)**:
   Aset turunan seperti `MOSE-W` (Waran) dan `MOSE-R` (Right) berhasil didistribusikan ke portofolio Sekuritas nasabah dengan harga rata-rata Rp 0. Namun, BEI tidak mendaftarkan simbol tersebut ke dalam tabel bursa `listed_securities`. Akibatnya, MATS (Mandala Trading System) tidak memiliki orderbook untuk simbol tersebut dan mengembalikan error `"symbol_not_found"` saat ada order dikirimkan.
2. **Aturan ARA/ARB yang Tidak Standar (Jika Dipaksakan Trading)**:
   Jika admin bursa mendaftarkan simbol waran secara manual ke bursa agar bisa diperdagangkan, validasi batas harga (ARA/ARB) di MATS dilakukan berdasarkan profil papan perdagangan (`board`), bukan tipe instrumen (`instrument_type`). Hal ini menyebabkan waran di papan utama (`main`) akan dikenai batas ARA (20%-35%) dan ARB (15%) yang sama persis dengan saham induknya, padahal di pasar nyata aturan ARA/ARB waran memiliki karakteristik berbeda (lebih longgar atau ditiadakan).

### B. Cara Menemukan Masalah (How We Found It)
Temuan ini didapatkan melalui penelusuran kode (code tracing) pada repositori Mandala Exchange:
1. **Pemeriksaan Database Schema & Seed**:
   * Di BEI Service (`BEI/src/db/migrate.ts`), kita memeriksa ENUM tipe aset bursa (`ledger_asset_type`: `'cash'`, `'security'`, `'right'`, `'warrant'`), namun di tabel `listed_securities` hanya ada kolom `board` (`board_type` ENUM: `'main'`, `'development'`, dll) tanpa kolom spesifik tipe instrumen.
   * Di file seed (`BEI/src/db/seed.ts`), kita menemukan bahwa profil aturan perdagangan (`trading_rule_profiles`) hanya dibuat untuk 4 papan (`main`, `development`, `new_economy`, `watchlist`).
2. **Analisis Logika Proses Corporate Action**:
   * Di `BEI/src/routes/corporate-actions.ts` baris 242-261, kita melihat bahwa penanganan `rights_issue` dan `warrant` hanya memutasi `custody_ledger_entries` dengan `assetType` setara `"right"` atau `"warrant"`, namun tidak ada panggilan database atau API untuk mendaftarkan simbol baru ke `listed_securities`.
3. **Penelusuran Logika Trading Engine MATS**:
   * Di `MATS/internal/rules/cache.go` pada fungsi `ValidateOrder`, kita melihat MATS mengambil profil aturan dari `c.profileFor(security)` yang mencocokkan `profile.Board == security.Board`. MATS langsung menolak order jika simbol tidak ditemukan di list bursa (`symbol_not_found`).
   * Fungsi `validPriceBand` memproses batas ARA/ARB (`ara_percent` dan `arb_percent`) yang diambil langsung dari aturan price band per papan, tanpa filter terpisah untuk tipe instrumen `right` atau `warrant`.

### C. Rekomendasi Alternatif Solusi
* **Alternatif 1: Pendaftaran Simbol Otomatis pasca Aksi Korporasi & Pengenalan Tipe Instrumen di MATS**:
  Modifikasi router `/corporate-actions/:id/process` di BEI agar otomatis meng-insert baris baru ke tabel `listed_securities` dengan simbol `${saham_induk}-R` atau `${saham_induk}-W` saat memproses aksi korporasi tersebut. Kemudian, tambahkan kolom `instrument_type` pada model `listed_securities` bursa dan teruskan ke MATS. Di MATS (`rules/cache.go`), buat pengecualian validasi harga (ARA/ARB) jika tipe instrumen adalah `"warrant"` atau `"right"`.
* **Alternatif 2: Penerapan Board Khusus Efek Turunan (Derivatives Board - Lebih Rapi)**:
  Tambahkan nilai baru `'derivatives'` ke dalam ENUM `board_type` di database BEI. Buat profil aturan perdagangan baru (`trading_rule_profiles`) khusus untuk board `'derivatives'` dengan `ara_percent` dan `arb_percent` yang disesuaikan (misalnya ARA/ARB di-set sangat besar/100% atau dibebaskan) serta `lot_size` dan `tick_size` khusus. Setiap waran/right baru yang terbit didaftarkan di bawah board `'derivatives'` ini agar mewarisi aturan perdagangan khusus efek turunan secara otomatis.

