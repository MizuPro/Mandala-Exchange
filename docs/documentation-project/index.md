# Dokumentasi Proyek Mandala Exchange

Selamat datang di direktori dokumentasi Mandala Exchange. Sistem ini dibangun dengan arsitektur microservices yang terbagi atas tiga tulang punggung utama:

1. **BEI (Bursa Efek Indonesia - Core System)**
   Pusat aturan utama (aturan *tick size*, ARA/ARB, pendaftaran emiten, sesi market) sekaligus lembaga kliring dan penitipan.
2. **MATS (Mandala Automated Trading System)**
   Mesin pencocokan pesanan (*matching engine*) berkinerja tinggi yang memegang buku antrian (Order Book) di dalam memori dan mendistribusikan aliran *market data*.
3. **SEKURITAS (Broker System)**
   Aplikasi klien (Backend Gateway & Frontend UI) tempat *end-user* atau nasabah menaruh pesanan dan melihat portofolio mereka. Sekuritas mengelola RDN lokal yang disinkronisasikan ke bank dan BEI.

## Navigasi Fitur

### Layanan BEI (Pusat & Kustodian)
- [Aturan Inti & Emiten (BEI Core Rules)](bei-core-rules.md): Dokumentasi terkait pendaftaran emiten, pengelolaan status broker, aturan sesi perdagangan (pre-open, continuous, close), dan perhitungan fraksi harga/ARA-ARB.
- [Sistem Penyelesaian & Kustodian (BEI Settlement)](bei-settlement.md): Dokumentasi terkait proses kliring dan penyelesaian DVP/RVP, pemisahan buku sub-rekening (SRE), dan distribusi Corporate Actions (seperti pembagian Dividen).

### Layanan MATS (Mesin Perdagangan)
- [Mesin Pencocokan (MATS Matching Engine)](mats-matching-engine.md): Dokumentasi alur pemrosesan pemesanan (Place, Amend, Cancel) beserta algoritma pencocokan terus-menerus (*Continuous*) maupun pelelangan terpusat (*Auction Uncross*).
- [Distribusi Data Pasar (MATS Market Data)](mats-market-data.md): Dokumentasi alur penyiaran WebSocket untuk mendistribusikan ringkasan harga terbaru dan Order Book secara nyata (real-time).

### Layanan SEKURITAS (Broker)
- [Gerbang API & Layanan Backend (Sekuritas Gateway)](sekuritas-gateway.md): Dokumentasi terkait integrasi pihak ketiga (RDN Bank Mandala), pengelolaan status pesanan tersinkronisasi via webhook, kalkulasi fee sekuritas lokal, serta manajemen saldo (reserved vs available).
- [Antarmuka Pengguna Frontend (Sekuritas UI)](sekuritas-ui.md): Dokumentasi cara *state management* (Zustand) menerima dan menampilkan *Market Data Stream* seketika ke dalam komponen *User Interface* (Candlestick dan entri formulir perdagangan yang responsif).

---
*Dokumentasi ini dibuat dan di-maintain secara otomatis untuk membantu pengembang memahami letak berkas dan alur dari fitur yang ada di sistem yang saling terhubung ini.*
