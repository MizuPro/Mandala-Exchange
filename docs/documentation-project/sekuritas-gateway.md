# SEKURITAS Backend (Gateway & Service Layer)

## Deskripsi Umum
Backend dari layanan **SEKURITAS** berfungsi ganda sebagai *API Gateway* untuk aplikasi *frontend*, serta manajer *state* lokal untuk akun pengguna, saldo dana (RDN), dan inventaris efek (*Portfolio*). Layanan ini menengahi komunikasi ke **BEI** (untuk sinkronisasi kliring dan penitipan) dan ke **MATS** (untuk pengiriman pesanan dan penerimaan data transaksi).

## Komponen Utama & Logika

### 1. Manajemen Akun & Integrasi Bank (RDN)
- **File**: [account-service.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/services/account-service.ts)
- **Fungsi**: Membuat *Broker Account* bagi pengguna yang baru mendaftar. Jika dalam mode nyata (financeMode="rdn"), layanan ini akan memanggil API eksternal (Bank Mandala CB) untuk memvalidasi data kependudukan berdasarkan email pengguna dan secara otomatis membukakan Rekening Dana Nasabah (RDN), SID (Single Investor Identification), dan SRE (Sub Rekening Efek).
- **Entitas Lokal**: `broker_accounts`, `sid_references`, `sre_references`, `rdn_references`, `cash_balances`.

### 2. Orkestrasi Pemesanan (Order Service)
- **File**: [order-service.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/services/order-service.ts)
- **Fungsi**: Menangani `Place`, `Amend`, dan `Cancel` pesanan dari pengguna sebelum dikirimkan ke mesin pencocokan MATS.
- **Logika Reservasi**:
  - Saat pesanan *Buy* masuk, nilai gross + estimasi *fee* dihitung dan secara lokal dipindahkan dari `cash_balances.available` ke `cash_balances.reserved` dalam sebuah transaksi database (atomik).
  - Saat pesanan *Sell* masuk, jumlah lot yang dijual dipindahkan dari `securities_positions.available` ke `reserved`.
  - Jika `matsClient.placeOrder` menolak, dana/efek yang di-*reserve* otomatis dikembalikan.
- **Webhook Listener (`handleWebhookUpdate`)**: Saat MATS mengabarkan terjadinya transaksi (trade) atau perubahan status, fungsi ini memperbarui `orders`, membuat `trade_fills`, dan merilis dana/efek dari *reserved* menuju *pending* (untuk *buy*) atau menambah saldo kas *pending* (untuk *sell*).

### 3. Portofolio & Rekonsiliasi BEI
- **File**: [portfolio.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/routes/portfolio.ts)
- **Fungsi**: Merangkum posisi kas, posisi saham, dan riwayat *fill*/*trade* dari database lokal (`cash_balances`, `securities_positions`, `trade_fills`).
- **Integrasi Custody**: Menyediakan *endpoint* proksi (`/custody/summary` & `/custody/reconciliation`) yang meneruskan permintaan ke API BEI untuk mencocokkan pencatatan efek di buku besar sekuritas (lokal) dengan buku besar kustodian pusat (BEI).

## Alur Kerja (Workflow) - Siklus Hidup Pesanan
1. **User Request**: Klien HTTP (*Frontend*) mengirimkan pesanan ke `POST /orders` ([orders.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/routes/orders.ts)).
2. **Pre-Check & Reservation**: Backend memvalidasi *lot size*, kecukupan saldo, mengunci *reserved balance* lalu menyimpannya ke database dengan status "pending" ([order-service.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/services/order-service.ts#L216-L253)).
3. **Dispatch to MATS**: Memanggil `matsClient.placeOrder`. Jika berhasil tanpa error, status pesanan tidak langsung sukses melainkan menunggu *callback* webhook.
4. **Webhook Update**: Rute `/webhooks/mats` menerima payload *event* dari MATS, dan fungsi `handleWebhookUpdate` dipanggil untuk menyesuaikan kuantitas *filled*, mencatat *trade fill*, dan merilis *reserved* secara atomik di database Sekuritas.

## Daftar File yang Terlibat
- [orders.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/routes/orders.ts) - Rute API penerima HTTP pesanan.
- [order-service.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/services/order-service.ts) - Implementasi utama reservasi dana, sinkronisasi *state* pemesanan dengan MATS dan kalkulasi *fee*.
- [account-service.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/services/account-service.ts) - Proses pembuatan SID, SRE, dan RDN.
- [portfolio.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/SEKURITAS/backend/src/routes/portfolio.ts) - Rute API penyedia laporan kas, portofolio dan *proxy* rekonsiliasi ke BEI.
