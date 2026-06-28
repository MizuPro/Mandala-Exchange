# Main Implementation Plan: BOT Service Mandala Exchange (Rebuild)

Berdasarkan `docs/BOT/BOT_PRD.md`, berikut adalah rencana implementasi (dari nol/rebuild) untuk membangun layanan simulasi pasar (BOT Service) menggunakan arsitektur Go (Golang). Setiap tugas di bawah ini dipetakan langsung dengan bagian (Section) spesifik di dalam dokumen PRD agar tidak ada fitur yang terlewat.

## Fase 1: Inisialisasi Project & Core Engine Dasar
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 1.1: Setup Go Project (`go mod init mandala-bot`) & Struktur Folder standar sesuai **PRD Bagian 9**.
  - [ ] Task 1.2: Pembuatan `Global Rate Limiter` & `Order Queue` berbasis Go Channels (Maksimal throughput minimal 2.000 - 3000 order/menit) sesuai **PRD Bagian 2.4 & 14**.
  - [ ] Task 1.3: Setup Skema Database PostgreSQL untuk Bot Service (`bots`, `bot_tokens`, `bot_decision_logs`, `bot_daily_performance`, `market_sentiment`) sesuai **PRD Bagian 13**.
  - [ ] Task 1.4: Implementasi `Circuit Breaker` (Spam order detection, Total System Breaker, Error Surge) sebagai pelindung sistem sesuai **PRD Bagian 8.3**.

## Fase 1: Inisialisasi Project & Core Engine Dasar
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 1.1: Setup Go Project (`go mod init mandala-bot`), Struktur Folder standar, dan *Environment Variable Loader* (`.env`) sesuai **PRD Bagian 9.2 & 9.3**.
  - [ ] Task 1.2: Pembuatan `Global Rate Limiter` & `Order Queue` berbasis Go Channels (Maksimal throughput minimal 2.000 - 3000 order/menit) sesuai **PRD Bagian 2.4 & 14**.
  - [ ] Task 1.3: Setup *Docker Compose* khusus bot (jika terpisah) dan Skema Database PostgreSQL (`bots`, `bot_tokens`, `bot_decision_logs`, `bot_daily_performance`, `market_sentiment`) sesuai **PRD Bagian 9.4 & 13**.
  - [ ] Task 1.4: Implementasi `Circuit Breaker` (Spam order detection, Total System Breaker, Error Surge) sebagai pelindung sistem sesuai **PRD Bagian 8.3**.

## Fase 1: Inisialisasi Project & Core Engine Dasar
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 1.1: Setup Project Node.js TypeScript (`npm init`, `tsc --init`), Struktur Folder standar (`src/`, `config/`, `models/`), dan *Environment Variable Loader* (`dotenv`) sesuai **PRD Bagian 9.2, 9.3, & 16**.
  - [ ] Task 1.2: Pembuatan `Global Rate Limiter` & `Order Queue` berbasis *Event Loop/Queue System* Node.js (Maksimal throughput minimal 2.000 - 3000 order/menit) sesuai **PRD Bagian 2.2D & 14**.
  - [ ] Task 1.3: Setup *Docker Compose* khusus bot (jika terpisah) dan Skema Database PostgreSQL (`bots`, `bot_tokens`, `bot_decision_logs`, `bot_daily_performance`, `market_sentiment`) sesuai **PRD Bagian 9.4 & 13**.
  - [ ] Task 1.4: Implementasi `Circuit Breaker` (Spam order detection, Total System Breaker, Error Surge) sebagai pelindung sistem sesuai **PRD Bagian 8.3**.

## Fase 2: Konektivitas Pasar & Registrasi Bot
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 2.1: Implementasi mekanisme Bot Genesis Seeding & Auto-Registrasi ke Database `users` (dengan flag `account_type="BOT"`, `is_bot=true`) dan `broker_accounts` di Sekuritas sesuai **PRD Bagian 5.1 & 5.4**.
  - [ ] Task 2.2: Penyusunan konfigurasi `bots.yaml` berbasis Hukum Pareto 80/20 (85% Retail, 15% Institusi) dengan dukungan *Random Seed* (untuk reproduktibilitas) sesuai **PRD Bagian 3.3, 5.3 & 14**.
  - [ ] Task 2.3: Implementasi HTTP Client tangguh untuk Login (menggunakan dummy email/password otomatis), *Session Token Management* (JWT), dan mekanisme **State Recovery** (Bot bisa restart tanpa kehilangan state penting) sesuai **PRD Bagian 5.2 & 14**.
  - [ ] Task 2.4: Implementasi WebSocket Consumer ke MATS untuk menerima live market data & mekanisme internal `Fan-out` broadcast ke ribuan bot *in-memory* sesuai **PRD Bagian 2.2A & 2.3**.
  - [ ] Task 2.5: Implementasi *Dynamic Market Discovery* (Pemanggilan API `GET /v1/public/securities` BEI untuk membentuk *universe* saham dinamis, termasuk mendeteksi emiten baru IPO secara otomatis) sesuai **PRD Bagian 3.4 & 4.7**.

## Fase 3: Realisme Pasar & Akuntansi Bot
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 3.1: Implementasi `Session Monitor` dan *U-Shaped Activity Curve* yang perhitungannya **100% dinamis berdasarkan persentase (%) durasi sesi continuous saat itu**, mengambil jadwal dari API MATS, sesuai **PRD Bagian 2.2E & 6.3**.
  - [ ] Task 3.2: Implementasi Sistem Sentimen Pasar (Global *Bullish/Bearish/Neutral* yang memperbesar/memperkecil probabilitas bot bertransaksi) sesuai **PRD Bagian 6.5**.
  - [ ] Task 3.3: Implementasi Algoritma *Human-Like Imperfections* (Probabilitas error *Fat Finger*, *Reaction Delay* natural, probabilitas batal/overreaction) & *Herd Behavior* (Kecenderungan ikut-ikutan FOMO/Panic) sesuai **PRD Bagian 6.1 & 6.2**.
  - [ ] Task 3.4: Implementasi injeksi *Global Context & Event Awareness* (volatilitas, berita aktif) yang disiarkan ke semua bot agar bisa bereaksi tanpa mengubah strategi utama, sesuai **PRD Bagian 6.6**.
  - [ ] Task 3.5: Implementasi *Bot Portfolio State*, *Fee Awareness*, dan *Auto-Disable* (Pelacakan cash/inventory, pencegahan jual kosong, sinkronisasi dividen/Corporate Action, hitung fee, tracking P&L, serta matikan bot jika menyentuh `max_daily_loss_pct`) sesuai **PRD Bagian 2.2F, 6.4, 7.1, 7.2, & 7.3**.

## Fase 4: Log Keputusan & Mesin Strategi Retail (Tier 1)
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 4.1: Implementasi infrastruktur *Bot Decision Logging* (mencatat alasan bot membeli/menjual ke DB Postgres `bot_decision_logs`) untuk keperluan audit sesuai **PRD Bagian 8.1**.
  - [ ] Task 4.2: Implementasi algoritma strategi **Noise Trader** (Volume acak, waktu acak, pencipta likuiditas semu) sesuai **PRD Bagian 4.1**.
  - [ ] Task 4.3: Implementasi algoritma strategi **Momentum Trader** (Membeli saham yang sedang tren naik / breakout / FOMO) sesuai **PRD Bagian 4.3**.
  - [ ] Task 4.4: Implementasi algoritma strategi **Contrarian / Value Dip Buyer** (Membeli agresif saat harga turun drastis, *mean-reversion*) sesuai **PRD Bagian 4.4**.
  - [ ] Task 4.5: Implementasi algoritma strategi **Value Investor** (Membeli jika harga di bawah *Fair Value* historis MA-200, akumulasi lambat) sesuai **PRD Bagian 4.5**.

## Fase 5: Mesin Strategi Institusional (Tier 2)
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 5.1: Implementasi algoritma strategi **Market Maker** (Fokus pada 1 saham, membanjiri buku order untuk menjaga bid/ask spread) sesuai **PRD Bagian 4.2**.
  - [ ] Task 5.2: Implementasi algoritma strategi **Bandar** (Strategi multi-hari: Fase Akumulasi sembunyi-sembunyi → Fase Mark-up harga terbang → Distribusi ritel) sesuai **PRD Bagian 4.6**.
  - [ ] Task 5.3: Implementasi algoritma strategi **Event-Driven / News Trader** (Diam menanti event dari admin, bereaksi paling instan di market, bertindak sebagai *IPO Hunter*) sesuai **PRD Bagian 4.7**.
  - [ ] Task 5.4: Implementasi algoritma strategi **Panic Seller** (Pembuang barang massal ke antrean kiri / ARB untuk simulasi *stress test*) sesuai **PRD Bagian 4.8**.
  - [ ] Task 5.5: Implementasi algoritma strategi **Index Tracker / Arbitrage** (Pembeli pasif kumpulan saham indeks besar dengan rebalancing) sesuai **PRD Bagian 4.9**.

## Fase 6: Bot Control Panel, Skenario, & Deployment (Admin Panel)
- **Status**: [ ] Belum Mulai
- **Tugas**:
  - [ ] Task 6.1: Pembuatan REST API Internal untuk Admin Panel (Fitur Pause/Resume per bot, Set Sentiment, Trigger Event, Emergency Stop, dan **Live Parameter Tweaking** tanpa restart) sesuai **PRD Bagian 10.1 & 14**.
  - [ ] Task 6.2: Pembangunan *Frontend Web Dashboard* khusus "Ruang Kendali Sutradara" (Demografik bot, Agregasi P&L, Log Keputusan *Live*, Injector Berita) sesuai **PRD Bagian 10.2 & 8.2**.
  - [ ] Task 6.3: Audit kepatuhan aturan *Fairness* bot (Bot tidak tahu isi portofolio orang lain, bot tunduk pada limit ARA/ARB, bot bisa di-reject, order expire di akhir hari) sesuai **PRD Bagian 12**.
  - [ ] Task 6.4: Load Testing eksekusi Skenario Pasar Ekstrem (Skenario A - E: Hari Normal, Bandar Akumulasi, Saham Terbang, Market Crash, Reaksi Event) untuk validasi *End-Goal* sesuai **PRD Bagian 11**.
  - [ ] Task 6.5: Integrasi skrip *startup* final (menambahkan eksekusi service bot ke file `start-all.bat` pada urutan ke-6) sesuai **PRD Bagian 9.1**.

## Fase 7: [OPTIONAL] Advanced Realism - Sector Correlation Engine
- **Status**: [ ] Belum Mulai (Ditunda/Opsional)
- **Tugas**:
  - [ ] Task 7.1: Implementasi standardisasi metadata sektor emiten sesuai **PRD Bagian 6.7**.
  - [ ] Task 7.2: Pembuatan microservice *Correlation Engine* untuk komputasi offload (cloud/external) dan *Webhook Receiver* sesuai **PRD Bagian 6.7**.

---

## Ekspektasi Hasil Akhir (End Goal)
Ketika seluruh fase di atas selesai, sistem ini harus memenuhi ekspektasi di **PRD Bagian 18**:
1. **Pasar Bernyawa:** Order book terus berkedip dengan volume dan frekuensi seperti dunia nyata.
2. **Reaktivitas Natural (Cause & Effect):** Tindakan player raksasa (HAKA/HAKI) memicu domino reaksi dari bot (fomo momentum, stop-loss contrarian).
3. **Likuiditas Logis:** Saham kasta bawah sepi, saham Bluechip/LQ45 padat (Market Maker aktif).
4. **Auto-Pilot Total:** Emiten baru IPO akan otomatis diramaikan oleh algoritma tanpa intervensi.

---
### Catatan Eksekusi (Evaluation Model)
**Evaluasi Eksekusi Model**: 
Plan di atas melibatkan pembuatan ulang service dari nol dengan spesifikasi tingkat tinggi (Realisme Dinamis, Concurrency ketat Go, Algoritma Saham Tingkat Lanjut seperti Bandar & Market Maker).

Karena kompleksitas algoritma matematika pasar, manajemen konkurensi (Goroutines, rate limiters, fan-out), serta integrasi antar-database yang rumit, **eksekusi pengembangan bot baru (terutama di Fase 4 dan 5) sangat direkomendasikan menggunakan model yang lebih Advance (seperti Gemini 1.5 Pro atau Gemini 2.0 Pro)**. Model Gemini 3 Flash ideal digunakan untuk mempersiapkan kerangka dasar di Fase 1 dan Fase 2, namun akan kesulitan menyusun logika *trading* semu-cerdas (Bandar/Momentum) yang sangat kontekstual.
