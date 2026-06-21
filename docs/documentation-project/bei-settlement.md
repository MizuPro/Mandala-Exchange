# BEI Settlement & Custody

## Deskripsi Umum
Fitur ini merupakan inti dari penyelesaian transaksi (clearing & settlement) pada BEI Service. Fitur ini mengelola akun kustodian untuk setiap investor (termasuk penerbitan SID, SRE, dan RDN secara simulatif), mengeksekusi perpindahan hak milik efek dan dana secara serentak (DVP/RVP), serta memproses aksi korporasi (corporate actions) seperti pembagian dividen tunai, *stock split*, *bonus shares*, dan eksekusi waran.

## Komponen Utama & Logika

- **Custody Account Service** ([custody.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/services/custody.ts#L10-L35)):
  Setiap investor yang bertransaksi akan divalidasi dan secara otomatis didaftarkan akun kustodiannya jika belum ada, dengan penomoran unik SID, SRE, dan RDN.

- **Settlement Batches & Process** ([settlement.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/settlement.ts#L141-L268)):
  Proses penyelesaian akhir secara *Delivery vs Payment* (DVP) dan *Receipt vs Payment* (RVP). Saat sebuah batch diproses, instruksi penyelesaian untuk perpindahan efek (DVP) dan kas (RVP) akan dieksekusi. Posisi ledger (`custody_ledger_entries`) dari pihak pembeli dan penjual akan langsung diperbarui. Proses ini kemudian mengirimkan webhook penyelesaian (`notifySekuritasSettlement`) ke Sekuritas.

- **Corporate Actions Processing** ([corporate-actions.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/corporate-actions.ts#L165-L274)):
  Memproses eksekusi aksi korporasi pada tanggal jatuh tempo (*execution date*). Fitur ini membaca posisi positif efek investor (berdasarkan ledger akun kustodian). Tergantung jenis aksi korporasinya (misal `cash_dividend`, `stock_split`), sistem akan membuat entri ledger baru yang menambah kas atau menyesuaikan kepemilikan saham investor secara otomatis tanpa perlu intervensi manual dari pengguna akhir, lalu mengirimkan webhook aksi korporasi ke sistem hilir.

- **IPO Subscriptions & Allocations** ([corporate-actions.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/corporate-actions.ts#L319-L368)):
  Pemesanan saham IPO dari broker (Sekuritas) ditampung di `ipo_subscriptions`. Saat masa alokasi (allocation), sistem membagikan saham IPO berdasar porsi rasio (`allocationRatio`) dan melakukan injeksi efek secara langsung ke buku kustodian investor (`custody_ledger_entries` dengan `assetType: "security"`).

## Alur Kerja (Workflow)

1. **Inisiasi Settlement:** Saat sesi perdagangan ditutup, layanan rules akan men-trigger batch settlement. Diimplementasikan di ([settlement.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/settlement.ts#L79)).
2. **Pembuatan Ledger DVP/RVP:** Setiap trade dipetakan menjadi entri transfer dana dan efek. Diimplementasikan di ([settlement.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/settlement.ts#L153)).
3. **Eksekusi Aksi Korporasi:** Untuk aksi korporasi yang akan jatuh tempo, ledger investor yang "berhak" (eligible) akan dimodifikasi (pembagian dividen, split saham). Diimplementasikan di ([corporate-actions.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/corporate-actions.ts#L177)).
4. **Notifikasi Hilir:** Setelah settlement atau aksi korporasi rampung, sistem menembakkan webhook ke Sekuritas untuk menyinkronkan saldo pengguna akhir. Diimplementasikan di ([settlement.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/settlement.ts#L45)).

## Daftar File yang Terlibat
- [settlement.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/settlement.ts) - Endpoint utama untuk menghasilkan dan memproses batch settlement serta ledger kustodian.
- [corporate-actions.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/routes/corporate-actions.ts) - Mengelola pembuatan dan eksekusi event corporate action dan penjatahan IPO.
- [custody.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/services/custody.ts) - Logika khusus pembuatan dan pencarian akun SID/SRE/RDN investor.
