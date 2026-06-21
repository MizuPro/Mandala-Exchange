# BEI Core Rules & Issuers

## Deskripsi Umum
Fitur ini merupakan bagian dari **BEI Service** yang berfungsi sebagai sistem pendaftaran otoritas utama (Authority Registry) untuk emiten (issuers), sekuritas yang tercatat (listed securities), manajemen broker, serta aturan-aturan perdagangan (trading rules). Layanan ini mengatur segala aspek terkait data fundamental perusahaan yang terdaftar, informasi broker anggota, serta konfigurasi peraturan batas harga (price bands), ukuran lot, dan batas tick size di berbagai mekanisme pasar.

## Komponen Utama & Logika

- **Issuers & Securities Registration** ([issuers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/issuers.ts#L114-L413)):
  Mengelola pendaftaran emiten baru, pembuatan efek tercatat, dan notasi khusus (special notations). Terdapat validasi ketat `validateSecurityTickValues` ([issuers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/issuers.ts#L68-L112)) yang memastikan bahwa harga IPO, *reference price*, maupun *previous close* mematuhi aturan ukuran *tick size* dari papan perdagangan yang bersangkutan.

- **Broker Members Management** ([brokers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/brokers.ts#L18-L67)):
  Menangani pendaftaran dan aktivasi broker yang bisa terhubung dengan sistem bursa. Menyediakan endpoint untuk validasi status broker aktif oleh sistem MATS.

- **Trading Rules Configuration** ([rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts#L110-L484)):
  Memelihara parameter perdagangan seperti *Tick Size*, *Lot Size*, *Price Bands* (ARA/ARB), serta jadwal sesi perdagangan (Session Templates & Segments). Selain itu, komponen ini bertanggung jawab:
  - Menyediakan snapshot pengaturan dan sesi yang aktif ke *Matching Engine* (MATS).
  - Melakukan agregasi data pasar saat sesi ditutup `POST /integration/mats/sessions/active/status` ([rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts#L210-L380)). Ini mencakup kalkulasi OHLCV dari seluruh transaksi yang terjadi dan memperbarui index MDX secara otomatis.

## Alur Kerja (Workflow)

1. **Registrasi Emiten:** Admin membuat emiten baru beserta sekuritas yang akan didaftarkan. Diimplementasikan di ([issuers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/issuers.ts#L164)).
2. **Penyusunan Peraturan:** Admin mendefinisikan *trading rules profile*, *price bands*, dan *tick sizes*. Diimplementasikan di ([rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts#L113)).
3. **Penyediaan Snapshot ke MATS:** Layanan MATS secara berkala atau saat startup akan mengambil aturan ini untuk validasi *order entry* pada matching engine. Diimplementasikan di ([rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts#L467)).
4. **Penutupan Sesi & Settlement:** Saat sesi dinyatakan tertutup, BEI Service akan mengeksekusi aggregasi data pasar dan memicu *auto-settlement*. Diimplementasikan di ([rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts#L230-L372)).

## Daftar File yang Terlibat
- [issuers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/issuers.ts) - Mengelola endpoint untuk entitas perusahaan emiten dan sekuritasnya.
- [brokers.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/brokers.ts) - Mengelola daftar broker yang memiliki akses ke bursa.
- [rules.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/rules.ts) - Konfigurasi rule perdagangan, kontrol sesi, dan kalkulasi index penutupan pasar.
