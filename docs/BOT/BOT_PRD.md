# Product Requirements Document (PRD) — Mandala Exchange Bot System

**Versi**: 2.0  
**Tanggal**: 2026-06-27  
**Status**: Draft — Disetujui untuk perencanaan lanjutan  
**Author**: Mandala Exchange Engineering  

---

## 1. Latar Belakang & 

### 1.1 Masalah Yang Ingin Diselesaikan

Mandala Exchange adalah simulasi bursa saham yang membutuhkan **pasar yang hidup dan realistis** — bahkan saat jumlah player manusia masih sangat sedikit (2–10 orang). Tanpa bot, kondisi pasar akan tampak mati:
- Order book kosong atau sangat tipis
- Tidak ada pergerakan harga yang wajar
- Tidak ada volume transaksi
- Player tidak mendapatkan pengalaman yang menyerupai trading saham sesungguhnya

### 1.2 Visi

Membangun ekosistem bot yang **mensimulasikan kondisi pasar saham Indonesia secara realistis** — bukan sekadar mengisi order book atau menantang player, melainkan menciptakan dinamika pasar yang organik: adanya kepanikan, euphoria, spekulasi, aksi korporasi, dan perilaku investasi institusional vs. retail yang nyata.

Sistem ini harus mampu berjalan sebagai **layanan terpisah yang mandiri** (`BOT service`), dieksekusi secara lokal di laptop yang sama dengan sistem utama, namun tidak melalui jalur istimewa apapun — setiap order bot tetap masuk melalui Sekuritas API sebagaimana player manusia.

### 1.3 Prinsip Desain Inti

1. **Realisme** — Perilaku bot harus menyerupai perilaku investor nyata di pasar modal Indonesia (BEJ/IDX), bukan AI trading yang sempurna.
2. **Fairness** — Bot tidak boleh mendapatkan data atau privilege yang tidak tersedia untuk player. Informasi harus simetris.
3. **Kepatuhan Aturan** — Bot tunduk pada seluruh aturan pasar: ARA/ARB, fraksi harga, lot size, non-cancellation period, order expiry, market halt, dll.
4. **Diversity** — Ada banyak "kepribadian" bot: dari retail tidak rasional hingga bandar yang bergerak strategis.
5. **Independensi** — Bot engine berjalan terpisah dari Sekuritas/MATS/BEI. Error di bot tidak boleh memengaruhi core trading engine.
6. **Observabilitas** — Setiap keputusan bot harus dapat ditelusuri, di-audit, dan dihentikan sewaktu-waktu.

---

## 2. Arsitektur Sistem

### 2.1 Posisi Bot dalam Ekosistem Mandala Exchange

```
┌─────────────────────────────────────────────────────────────────┐
│                        LAPTOP LOKAL                             │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ BEI Service  │    │ MATS Engine  │    │Sekuritas Backend │  │
│  │ port: 4100   │◄───│  port: 8082  │◄───│   port: 3002     │  │
│  │ (privat)     │    │  (privat)    │    │   (publik)       │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                   │             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  BOT SERVICE (BARU)                     │    │
│  │  port: 9090 (privat)                                    │    │
│  │                                                         │    │
│  │  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │    │
│  │  │ Bot Registry │  │ Strategy    │  │ Market Data   │  │    │
│  │  │ & Scheduler  │  │ Engine Pool │  │ Consumer      │  │    │
│  │  └──────────────┘  └─────────────┘  └───────────────┘  │    │
│  │                                              │            │    │
│  │  Bot mengirim order ke Sekuritas API ────────┘            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                │                                │
│                   POST /api/v1/orders                           │
│                   (sama seperti player manusia)                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Komponen Internal Bot Service

Bot service adalah aplikasi **Go (Golang)** yang berjalan sebagai proses terpisah. Ia terdiri dari:

#### A. Market Data Consumer (Single WebSocket)
- Hanya melakukan **1 koneksi WebSocket** ke MATS secara internal (`ws://127.0.0.1:8082/v1/market-data/ws`) menggunakan service token dengan scope `market:read`.
- Data yang diterima didistribusikan (*fan-out*) secara internal ke memori masing-masing 2000 bot melalui Go Channels, menghindari ribuan koneksi WebSocket.
- Menyimpan state lokal: order book snapshot per symbol, last trade price, OHLC per sesi, market depth, dll.

#### B. Bot Registry & Lifecycle Manager
- Menyimpan konfigurasi seluruh bot (dari database atau file JSON/YAML)
- Mengelola lifecycle bot: `active`, `paused`, `disabled`, `cooldown`
- Admin API untuk control bot (pause/resume/adjust parameter)

#### C. Strategy Engine Pool
- Setiap bot instance memiliki strategy engine sendiri
- Engine membaca: market data snapshot, bot portfolio state, sesi perdagangan saat ini, event pasar, flag khusus
- Engine menentukan: apakah perlu submit order, amend order, atau cancel order

#### D. Order Executor & Global Rate Limiter
- Bot **tidak mengirim HTTP request secara langsung**.
- Keputusan dari ribuan bot dimasukkan ke dalam antrean tunggal (*Order Queue*).
- Hanya disediakan "kurir" (*worker pool*, misalnya 10-20 *worker*) yang bertugas mengambil antrean dan mengeksekusinya via HTTP ke Sekuritas Backend.
- **Global Rate Limiter**: Dibatasi maksimal **2.000 order per menit** untuk gabungan seluruh bot guna menjaga kestabilan laptop dan backend Sekuritas.
- Mencatat seluruh keputusan ke bot audit log.

#### E. Session State Monitor
- Membaca status sesi dari MATS/BEI secara berkala
- Menentukan kapan bot boleh aktif (hanya di sesi continuous, tidak saat halted)
- Mengelola perilaku bot saat opening/closing auction

#### F. Bot Portfolio State
- Menyimpan posisi saham dan kas setiap bot (sinkron dari Sekuritas portfolio API)
- **Corporate Action Sync**: Menerima injeksi kas (penambahan saldo) secara otomatis saat emiten membagikan dividen (Ex-Date/Payment Date), sama persis seperti akun player nyata.
- Digunakan oleh strategy engine untuk keputusan berbasis portofolio

### 2.3 Alur Data Lengkap

```
MATS WebSocket ──► Market Data Consumer ──► State Cache (Redis/Memory)
                                                        │
                                                        ▼
                                          Strategy Engine (per bot)
                                                        │
                                              keputusan order?
                                               ya │   tidak │
                                                  ▼         ▼
                                         Order Executor   tunggu
                                                  │
                                POST /api/v1/orders (Sekuritas API)
                                                  │
                                         Sekuritas Backend
                                          validasi + reserve
                                                  │
                                         MATS matching engine
                                                  │
                                       WebSocket event kembali
                                          (order update, fill)
                                                  │
                                         Bot Portfolio State update
```

### 2.4 Tech Stack Bot Service

| Komponen | Pilihan | Alasan |
|---|---|---|
| **Runtime** | **Go (Golang)** | Eksekusi 2000+ goroutine sangat ringan dan ramah RAM. Konsisten dengan arsitektur MATS. |
| **HTTP Client** | `net/http` bawaan Go | Komunikasi ke Sekuritas API dengan *connection pooling* yang efisien |
| **WebSocket Client** | `ws` package | Subscribe ke MATS market data |
| **Scheduler** | `node-cron` atau custom timer | Mengatur kapan bot aktif per sesi |
| **Config** | YAML file + env override | Mudah diubah tanpa recompile |
| **State Cache** | In-memory + opsional Redis | Berbagi data antar bot instances |
| **Database** | PostgreSQL (Docker) | Menyimpan bot registry, audit log, performance history |
| **Admin API** | Fastify | REST API untuk kontrol bot |

---

## 3. Klasifikasi Bot: Tier & Strategi

Sistem bot dibagi menjadi **2 Tier Utama** yang mencerminkan ekosistem pasar nyata:

### 3.1 Tier 1 — Retail Bots

Bot yang mensimulasikan investor retail Indonesia pada umumnya. Karakteristiknya:
- Modal relatif kecil (Rp 5 juta – Rp 100 juta)
- Keputusan sering dipengaruhi sentiment, rumor, dan momentum sesaat
- Tidak memiliki edge informasi atau algoritma canggih
- Sering bertindak terlambat (beli saat sudah naik tinggi, jual saat sudah turun jauh)
- Bisa panik dan melakukan aksi berlebihan

**Jumlah**: 50–200 bot retail aktif per sesi

### 3.2 Tier 2 — Institusional / Bandar Bots

Bot yang mensimulasikan investor besar (fund manager, sekuritas proprietary, "bandar"). Karakteristiknya:
- Modal sangat besar (Rp 500 juta – Rp 10 miliar)
- Keputusan lebih terstruktur dan berdasarkan analisis
- Dapat membentuk (atau menghancurkan) tren harga suatu saham
- Bergerak perlahan tapi konsisten (accumulation/distribution)

**Jumlah**: 5–20 bot institusional aktif per sesi

### 3.3 Distribusi Populasi Bot (Hukum 80/20)

Untuk menciptakan ekosistem bursa yang serealistis mungkin (mengadopsi komposisi IHSG), pembuatan (creation) bot tidak dilakukan dengan rasio yang merata (1:1). Populasi bot akan mengikuti **Prinsip Pareto (Hukum 80/20)**, di mana mayoritas populasi adalah *Retail*, namun mayoritas modal dikendalikan oleh *Institusi*.

- **Tier 1 (Retail) — ~85% hingga 90% dari total populasi bot**
  - **~45% Noise Trader**: Mendominasi keramaian order book harian dengan keputusan acak.
  - **~35% Momentum Trader**: Pasukan *scalper* yang selalu mengejar saham yang sedang *breakout* (FOMO).
  - **~10% Contrarian / Dip Buyer**: Para penangkap "pisau jatuh" di ritel.
- **Tier 2 (Institusional & Bandar) — ~10% hingga 15% dari total populasi bot**
  - **~3-5% Market Maker**: Sedikit jumlahnya tapi selalu menjaga *spread* likuiditas.
  - **~4% Value Investor**: Institusi yang secara pasif membeli di harga fundamental bawah.
  - **~2% Index Tracker / Arbitrage**: Menjaga keseimbangan bobot saham gabungan/indeks.
  - **~2% Event-Driven**: Bereaksi instan saat ada berita (aksi korporasi).
  - **~1-2% Bandar**: Terbatas, sangat rahasia, umumnya 1 bot (atau 1 grup) hanya berfokus mendominasi 1 saham spesifik.
- **Skenario Khusus (0% Default)**
  - **Panic Seller**: Di-generate/diaktifkan secara paksa oleh Admin hanya saat ingin melakukan *stress test* skenario krisis (crash).

### 3.4 Dynamic Market Discovery (Auto-Pilot)

Agar sistem sepenuhnya *auto-pilot*, mayoritas bot tidak menggunakan daftar saham (simbol) yang di-*hardcode* oleh admin.
- **GET Market Data**: Melalui koneksi internal, Bot Service akan mengambil data seluruh emiten aktif secara berkala dari BEI/MATS (bersifat *Read-Only*).
- **Dynamic Universe**: Konfigurasi parameter bot menggunakan *tag* dinamis seperti `"ALL"`, `"RANDOM_10"`, atau `"SECTOR_FINANCE"`.
- Jika ada saham baru yang IPO, saham tersebut otomatis terdeteksi masuk ke radar (universe) milik bot *Retail/Momentum/Event-Driven* tanpa campur tangan admin sama sekali.
- Pengecualian hanya berlaku untuk bot **Market Maker** dan **Bandar** yang secara natural di dunia nyata memang bertugas menjaga 1 saham spesifik (bisa di-*hardcode* per saham).

*Catatan: Sesuai aturan fairness, Bot Service HANYA melakukan GET/Read ke layanan BEI/MATS untuk penemuan saham, namun **wajib menggunakan POST ke Sekuritas API** untuk semua aksi trading/order-nya.*

---

## 4. Tipe Strategi Bot (Detail)

### 4.1 Noise Trader Bot

**Deskripsi**: Trader yang bertransaksi secara semi-acak. Mensimulasikan retail yang terjebak FOMO atau panik.

**Perilaku**:
- Memilih saham secara acak dari universe yang diperbolehkan
- Ukuran order kecil: 1–5 lot
- Waktu entry acak dalam sesi continuous
- Kadang beli, kadang jual tanpa alasan fundamental yang jelas
- Bisa memasang limit order di harga yang tidak masuk akal (sangat jauh dari last price)

**Parameter**:
```yaml
strategy: noise_trader
trade_frequency: setiap 5-20 menit (random)
order_size_lots: 1-5
price_deviation_max: 2%   # max jarak dari best bid/ask
cancel_probability: 0.3   # probabilitas cancel order setelah 10 menit
symbols_universe: "ALL"   # dinamis: auto-detect semua saham aktif di bursa
session_active: [continuous]
```

**Tujuan dalam ekosistem**: Menghasilkan volume dan noise sehingga order book tidak kosong. Mencegah pasar terlihat terlalu sepi.

---

### 4.2 Market Maker Bot

**Deskripsi**: Bot yang menjaga likuiditas dengan selalu memasang dua sisi (bid dan ask) di sekitar mid price. Mensimulasikan dealer/broker yang menyediakan likuiditas.

**Perilaku**:
- Selalu menjaga `N` level bid dan `N` level ask terpasang di order book
- Spread diatur berdasarkan volatilitas terkini: semakin volatile → spread makin lebar
- Inventory management: jika terlalu banyak beli (inventory +), naikkan ask dan turunkan bid agar posisi kembali netral
- Menghitung biaya transaksi (fee + levy) dalam spread minimum yang dibutuhkan

**Parameter**:
```yaml
strategy: market_maker
symbol: BBCA
spread_ticks: 2-6        # jumlah tick spread antara bid dan ask
levels: 3                 # kedalaman level yang dijaga
max_inventory_lots: 100   # maksimum posisi satu arah
refresh_interval_sec: 30  # seberapa sering me-refresh orders
fee_aware: true           # memperhitungkan fee dalam spread
session_active: [continuous, pre_close]
```

**Tujuan dalam ekosistem**: Menjaga order book selalu ada bid dan ask, memperlancar proses matching, mencegah harga melompat terlalu jauh dalam satu trade.

---

### 4.3 Momentum Trader Bot

**Deskripsi**: Bot yang mengikuti tren harga. Beli jika harga naik, jual jika harga turun. Mensimulasikan trader retail yang "ikut tren".

**Perilaku**:
- Mengamati pergerakan harga N menit terakhir
- Jika harga naik > X% dari N menit lalu → beli
- Jika harga turun > Y% dari N menit lalu → jual
- Take profit pada target tertentu, stop loss pada batas kerugian tertentu
- Lebih agresif di saham yang sedang dalam tren kuat

**Parameter**:
```yaml
strategy: momentum_trader
lookback_minutes: 15
buy_trigger_pct: 1.5     # beli jika naik 1.5% dalam 15 menit
sell_trigger_pct: -1.5   # jual jika turun 1.5% dalam 15 menit
take_profit_pct: 3.0     # lepas posisi jika untung 3%
stop_loss_pct: -2.0      # cut loss jika rugi 2%
order_size_lots: 5-20
session_active: [continuous]
```

**Tujuan dalam ekosistem**: Memperkuat tren yang sudah terbentuk. Memberikan momentum price action yang realistis. Saham yang naik akan menarik lebih banyak bot momentum (dan menggerakkan harga lebih jauh).

---

### 4.4 Contrarian / Value Dip Buyer Bot

**Deskripsi**: Bot yang "buy the dip" — beli ketika harga turun tajam dan jual ketika harga pulih. Mensimulasikan value investor atau contrarian trader.

**Perilaku**:
- Memantau penurunan harga dari high intraday atau previous close
- Jika harga turun > X% dari peak → mulai akumulasi bertahap
- Jual secara bertahap ketika harga kembali ke level yang dianggap wajar
- Lebih sabar: tidak panik jika harga turun lebih lanjut setelah beli

**Parameter**:
```yaml
strategy: contrarian
dip_trigger_from_high_pct: -3.0   # mulai beli jika turun 3% dari high hari ini
accumulation_lots_per_order: 10   # beli per tahap
target_recovery_pct: 2.0          # jual jika pulih 2% dari entry average
max_positions_lots: 200           # batas total posisi
patience_minutes: 60              # tunggu hingga 60 menit sebelum cut
session_active: [continuous, pre_close]
```

**Tujuan dalam ekosistem**: Menciptakan support level alami. Mencegah harga jatuh terlalu dalam tanpa pemulihan. Memberikan nuansa pasar bahwa selalu ada pembeli di harga rendah.

---

### 4.5 Value Investor Bot

**Deskripsi**: Bot yang bertransaksi berdasarkan valuasi fundamental. Beli ketika saham dianggap murah secara fundamental, jual ketika sudah mahal.

**Perilaku**:
- Membaca data emiten dari BEI: EPS, DER, PBV estimasi, dividend yield historis
- Menghitung "fair value" secara dinamis: Karena sistem tidak memiliki database fundamental lengkap, *Fair Value* disimulasikan menggunakan **Moving Average Jangka Panjang** (misal: rata-rata harga 200 hari/sesi terakhir). Garis rata-rata panjang ini dianggap sebagai jangkar nilai fundamental sementaranya.
- Jika harga pasar < fair value × (1 - margin_of_safety) → beli
- Jika harga pasar > fair value × (1 + sell_premium) → jual
- Bergerak sangat perlahan: order kecil per hari, tidak terpengaruh noise intraday

**Parameter**:
```yaml
strategy: value_investor
universe: "RANDOM_10"           # dinamis: pilih 10 saham acak (atau filter sektor)
margin_of_safety: 0.15          # beli jika 15% di bawah fair value
sell_premium: 0.20              # jual jika 20% di atas fair value
order_size_lots: 20-50
max_portfolio_pct_per_stock: 30 # maks 30% portofolio di satu saham
rebalance_frequency: daily      # evaluasi sekali per sesi
session_active: [continuous]
```

**Tujuan dalam ekosistem**: Memberikan anchor harga fundamental. Mencegah harga menyimpang terlalu jauh dari nilai wajar dalam jangka panjang. Mensimulasikan institusional yang membeli saat valuasi menarik.

---

### 4.6 Bandar / Accumulation-Distribution Bot

**Deskripsi**: Bot Tier 2 yang mensimulasikan "bandar" — aktor pasar besar yang diam-diam mengumpulkan saham (accumulation) lalu mendistribusikannya di harga tinggi. Ini adalah strategi yang paling kompleks.

**Fase Accumulation**:
- Beli dalam jumlah kecil dan konsisten selama berhari-hari di sekitar support
- Tidak membuat harga naik secara dramatis — justru menjaga harga flat atau sedikit naik
- Kadang sengaja menekan harga sebentar (jual kecil) untuk memicu retail jual dan membeli lebih murah
- Tahap ini membutuhkan modal besar dan kesabaran tinggi

**Fase Mark-Up (Distribusi Dimulai)**:
- Mulai mendorong harga naik dengan bid agresif
- Volume meningkat → menarik momentum trader dan retail
- Bersamaan dengan distribusi bertahap: mulai jual lot besar di harga tinggi ke retail yang beli

**Fase Distribution**:
- Harga di puncak, distribusi besar ke retail yang FOMO
- Bot ini sudah hampir tidak punya posisi
- Harga kemudian turun (karena tidak ada buyer lagi dan retail mulai kelelahan)

**Parameter**:
```yaml
strategy: bandar
symbol: GOTO                       # satu bandar fokus di satu saham
accumulation_target_lots: 5000
accumulation_price_range:
  min: 80   # tick
  max: 120
accumulation_daily_lots: 100-300   # akumulasi harian tersembunyi
markup_trigger_days: 10            # setelah 10 hari akumulasi, mulai mark-up
markup_daily_lots: 500             # volume besar saat mendorong harga
distribution_start_premium: 0.30  # mulai distribusi saat naik 30%
distribution_daily_lots: 200-800
session_active: [all]
multi_day: true                    # strategi multi-hari
```

**Tujuan dalam ekosistem**: Menciptakan dinamika siklus harga yang paling realistis. Mensimulasikan kenapa saham bisa naik dan turun dalam pola yang tidak random — ada "tangan besar" di baliknya.

---

### 4.7 Event-Driven / News Trader Bot

**Deskripsi**: Bot yang bereaksi terhadap event corporate action di BEI: dividend announcement, stock split, rights issue, laporan keuangan.

**Perilaku & Efek Domino (Butterfly Effect)**:
- **Event Injector**: Admin dapat menyuntikkan berita (contoh: "EARNINGS_POSITIVE" atau "RUMOR_NEGATIVE") beserta tingkat intensitasnya secara manual, maupun otomatis via template jadwal kalender aksi korporasi BEI.
- **Efek Langsung**: Bot *Event-Driven* merespons berita dengan memborong (beli) atau membuang (jual) saham tersebut secara agresif, menciptakan pergerakan harga awal.
- **Efek Lanjutan (Domino)**: Pergerakan harga awal ini memicu alarm bagi bot *Momentum Trader* untuk ikut FOMO, dan mengundang perlawanan dari *Contrarian/Value Investor*, menciptakan reaksi berantai (*snowball effect*) yang membuat pergerakan pasar menjadi tidak tertebak.

**Parameter**:
```yaml
strategy: event_driven
events_monitored:
  - dividend_announcement     # reaksi: beli
  - ex_dividend_date          # reaksi: jual (setelah ex-date)
  - quarterly_earnings        # reaksi: beli/jual tergantung hasil
  - stock_split               # reaksi: beli (positif sentiment)
  - rights_issue              # reaksi: umumnya jual
  - ipo_listing               # reaksi: berebut beli/pesan (sebagai IPO Hunter) pada masa penawaran & hari pertama listing
reaction_delay_minutes: 2-30  # delay reaksi (mensimulasikan keterlambatan info)
reaction_intensity: 0.8       # probabilitas bot bereaksi (tidak 100% reaktif)
order_size_lots: 20-100
session_active: [continuous]
```

**Tujuan dalam ekosistem**: Membuat harga bereaksi terhadap event fundamental secara organik. Saham yang pay dividend akan naik menjelang cum-date seperti di pasar nyata.

---

### 4.8 Panic Seller Bot (Stress Scenario)

**Deskripsi**: Bot yang mensimulasikan kepanikan massal — sell-off besar-besaran. Digunakan untuk mensimulasikan kondisi pasar bearish atau krisis lokal.

**Perilaku**:
- Diaktifkan secara manual oleh admin atau dipicu oleh kondisi tertentu (harga turun > ARB threshold)
- Memasang sell order market atau limit di bawah bid untuk memaksa harga turun
- Meningkatkan volume jual secara dramatis dalam waktu singkat
- Mensimulasikan "margin call massal" atau "sudden sell-off" dari institusi asing

**Parameter**:
```yaml
strategy: panic_seller
trigger: manual_or_condition
trigger_condition: price_drop_pct_from_open > 5.0
sell_intensity: high            # banyak lot, cepat
price_aggressiveness: market_order_preference
duration_minutes: 15-30
symbols: all_or_specific
```

**Tujuan dalam ekosistem**: Menciptakan kondisi stress test untuk player. Mensimulasikan hari-hari bearish di pasar nyata.

---

### 4.9 Index Tracker / Arbitrage Bot

**Deskripsi**: Bot institusional pasif yang mengelola portofolio menyerupai reksa dana indeks. Bot ini otomatis membagi porsi beli ke seluruh saham secara proporsional sesuai dengan bobot *market cap* saham terhadap Indeks Gabungan (Mandala Composite Index - MDX).

**Perilaku**:
- Membaca komposisi dan bobot saham pada Indeks MDX.
- Mengalokasikan dana secara proporsional mengikuti bobot masing-masing emiten di dalam indeks.
- Melakukan **Rebalancing Berkala** (misalnya setiap sesi penutupan di hari/minggu tertentu): jika ada saham yang harganya naik tajam (bobotnya membesar), bot akan melakukan *take profit* sebagian dan membeli saham yang sedang turun (bobotnya mengecil) agar proporsinya kembali seimbang.
- Transaksi dilakukan bertahap agar tidak merusak harga pasar.

**Parameter**:
```yaml
strategy: index_tracker
target_index: MDX
tracking_error_tolerance_pct: 2.0  # toleransi deviasi bobot sebelum rebalancing
rebalance_frequency: weekly        # dieksekusi berkala
order_size_lots: 50-200            # lot per tahap rebalance
session_active: [continuous, pre_close]
```

**Tujuan dalam ekosistem**: Menjaga stabilitas dan keterkaitan (*correlation*) pergerakan antar saham *bluechip* (penyusun indeks). Mensimulasikan likuiditas konstan dari institusi/reksa dana pasif yang selalu hadir di pasar nyata.

---

## 5. Bot Identity & Account Management

### 5.1 Bot sebagai Akun Sekuritas

Setiap bot didaftarkan sebagai broker account di Sekuritas dengan:

```typescript
// Tabel users di Sekuritas
{
  id: "bot-001-market-maker-bbca",
  email: "bot.mm.bbca@mandala-internal.local",
  account_type: "BOT",          // field baru
  is_bot: true,                  // flag baru
  bot_strategy: "market_maker",
  bot_tier: "institutional",     // "retail" atau "institutional"
  bot_display_name: "MM Alpha",  // nama publik di order book (opsional: anonymous)
  status: "active",
  email_verified: true,          // auto-verified, tidak butuh OTP
  created_by: "admin_system",
}

// Tabel broker_accounts di Sekuritas
{
  user_id: "bot-001-market-maker-bbca",
  broker_code: "MANDALA",
  initial_cash: 5_000_000_000,  // Rp 5 Miliar untuk MM Bot
  is_bot_account: true,
}
```

### 5.2 Bot Credentials

- Setiap bot memiliki pasangan `email` / `password` yang hanya diketahui oleh BOT service
- BOT service melakukan login ke Sekuritas API untuk mendapatkan JWT token
- JWT token di-refresh secara berkala (sebelum expire)
- Token ini digunakan untuk semua order submission

### 5.3 Bot Identity Metadata

```typescript
interface BotConfig {
  id: string;                        // unique bot ID
  name: string;                      // nama display
  strategy: BotStrategy;             // tipe strategi
  tier: "retail" | "institutional";
  
  // Keuangan
  initial_cash: number;              // modal awal dalam rupiah
  allowed_symbols: string[];         // saham yang boleh diperdagangkan
  max_order_size_lots: number;       // maks lot per order
  max_exposure_pct: number;          // maks % dari portofolio di satu saham
  max_daily_loss_pct: number;        // hentikan bot jika daily loss > X%
  
  // Risk limits
  max_orders_per_minute: number;     // rate limit per bot
  max_cancel_rate: number;           // maks % order yang dibatalkan
  
  // Operational
  status: "active" | "paused" | "disabled" | "cooldown";
  random_seed?: number;              // untuk reproducibility saat testing
  strategy_params: Record<string, any>; // parameter khusus per strategi
}
```

### 5.4 Initial Seeding (Genesis Inventory)

Sebuah bursa yang baru berjalan (Day 1) membutuhkan likuiditas sisi jual (Ask). Jika semua bot hanya dibekali uang tunai (Cash), pasar tidak akan bisa berjalan karena tidak ada yang memiliki barang saham untuk dijual. 
Oleh karena itu, sistem membutuhkan mekanisme **Genesis Seeding**:
- **Market Maker & Bandar Bot**: Saat pertama kali sistem bursa dihidupkan (Day 1), *BOT Service* akan melakukan injeksi *Inventory* (lot saham) dan uang tunai ke dalam portofolio mereka secara langsung ke database Sekuritas.
- **Retail Bot (Noise, Momentum, dll)**: Hanya dibekali uang tunai di awal. Mereka harus membeli barang dari *Market Maker* atau *Bandar* di hari-hari pertama.
- **Aturan Ketat (Strict Rule)**: Proses injeksi "gaib" ini **HANYA BOLEH DILAKUKAN SEKALI** pada Hari Ke-1 (Genesis). Untuk hari-hari berikutnya, jika ada emiten baru yang IPO, bot tidak boleh diberi saham secara cuma-cuma. Bot (sebagai *IPO Hunter*) wajib menggunakan uang kas mereka sendiri yang tersisa untuk memesan/membeli saham IPO sesuai prosedur asli bursa. Tidak ada lagi uang atau saham gratis dari udara setelah Day 1.

---

## 6. Market Realism Engine

Ini adalah lapisan yang membuat perilaku bot tidak seragam dan terasa "manusiawi".

### 6.1 Human-Like Imperfections (Ketidaksempurnaan)

Setiap bot memiliki parameter "imperfeksi manusia":

```yaml
human_params:
  # Keterlambatan keputusan
  reaction_delay_ms:
    min: 500
    max: 45000     # hingga 45 detik setelah signal muncul
  
  # Probabilitas melakukan kesalahan harga
  price_fat_finger_prob: 0.02    # 2% kemungkinan salah harga (lebih tinggi / rendah)
  price_fat_finger_range: 3      # salah hingga 3 tick
  
  # Probabilitas tidak jadi order (ragu-ragu)
  decision_abort_prob: 0.10     # 10% kemungkinan batal setelah keputusan

  # Reaksi berlebihan (overreaction)
  overreaction_prob: 0.15       # 15% kemungkinan order ukuran 2x dari biasanya

  # Hari tidak aktif
  inactive_day_prob: 0.05       # 5% kemungkinan bot tidak aktif satu hari penuh
```

### 6.2 Herd Behavior (Perilaku Kawanan)

Sistem memiliki mekanisme "contagion" antar bot:
- Jika N bot momentum mulai beli suatu saham dalam waktu bersamaan → memicu bot noise trader lain ikut beli (FOMO effect)
- Jika harga turun lebih dari ARB/2 → memicu panic seller bot aktif lebih agresif
- Tidak setiap bot terinfeksi — ada probabilitas berdasarkan profil bot

### 6.3 Session-Aware Behavior & The "U-Shaped" Activity Curve

Bot berperilaku berbeda tergantung fase perdagangan (sesi), dan dirancang untuk mensimulasikan kurva aktivitas *U-Shaped* (sangat sibuk di awal dan akhir sesi) yang lazim terjadi di pasar saham nyata.

**Mekanisme Rush-Hour (U-Shaped Curve):**
1. **Morning Rush (Awal Continuous)**: Saat sesi `continuous` baru saja dimulai, akan ada lonjakan aktivitas (multiplier frekuensi order 3x - 5x) dari mayoritas bot. Ini merepresentasikan trader yang mengeksekusi analisis semalam, bereaksi terhadap berita pagi, atau gap harga opening. Aktivitas tinggi ini berlangsung selama sekitar 30% pertama dari durasi sesi.
2. **Mid-Day Lull (Fase Mereda)**: Setelah *rush-hour* pagi lewat, pasar tidak mati, tetapi aktivitas bot akan melambat (kembali ke frekuensi normal atau lebih rendah) untuk mencari ekuilibrium harga.
3. **Closing Rush (Menjelang Pre-Close)**: Sekitar 10-20% waktu terakhir sebelum sesi `continuous` berakhir (dan masuk pre-close), aktivitas kembali melonjak. Bot momentum, contrarian, dan value investor berlomba menyesuaikan posisi sebelum pasar tutup.

> [!WARNING]
> **Peringatan Durasi Sesi Simulasi:**
> Jangan pernah menggunakan acuan jam nyata (*real-life time*, misal jam 09:00 - 16:00) untuk perhitungan logika *Rush Hour* ini. Template sesi di *production* Mandala Exchange berjalan dengan waktu yang sangat dikompresi (misalnya simulasi 1 hari selesai hanya dalam 15 menit atau 1 jam). 
> Logika U-Shaped Curve **harus bersifat dinamis**, dihitung berdasarkan **persentase (%) dari total durasi sesi continuous** pada saat itu (contoh: *30% dari awal durasi sesi*, bukan "sampai jam 10 pagi").

| Sesi | Perilaku Bot |
|---|---|
| `closed` | Semua bot idle. Tidak ada order. |
| `pre_open` | Hanya bandar dan event-driven yang mulai memasang order awal. |
| `opening_auction` | Pergerakan *low-volume*. Bot berpartisipasi dalam pembentukan harga IEP (*Indicative Equilibrium Price*) secara pasif/wajar berdasarkan fair value estimasi. Tidak agresif. |
| `continuous` | **U-Shaped Curve Aktif**. Rush hour di 30% waktu awal, melandai di pertengahan, lalu melonjak lagi menjelang akhir. |
| `pre_close` | Market maker mulai menarik spread. Contrarian mulai ambil posisi akhir. |
| `closing_auction` | Pergerakan *low-volume*. Hanya bot value dan market maker yang aktif berpartisipasi di harga IEP penutupan. |
| `non_cancellation` | Bot tidak bisa cancel. Bot yang tahu ini harus lebih berhati-hati memasang order. |
| `halted` | Semua bot berhenti. Market maker tidak quote. |

### 6.4 Portfolio Awareness

Bot sadar akan posisi mereka sendiri:
- Bot tidak akan sell saham yang tidak dimilikinya (kecuali ada bug — dan ini harus tercegah di Sekuritas)
- Bot value investor tidak akan membeli lebih dari batas eksposur per saham
- Bot market maker akan menyesuaikan quote ketika inventory sudah mentok

### 6.5 Sentiment Simulation

Sistem memiliki variabel **market sentiment global** yang diupdate setiap sesi:
```typescript
interface MarketSentiment {
  overall: "bearish" | "neutral" | "bullish";  // override dari admin atau computed
  volatility_regime: "low" | "medium" | "high";
  sector_sentiment: Record<string, "positive" | "neutral" | "negative">;
}
```
Sentiment ini mempengaruhi:
- Agresivitas momentum bot
- Frekuensi noise trader
- Spread yang digunakan market maker
- Ambang trigger panic seller

### 6.6 Context & Event Awareness (Kesadaran Kondisi Pasar)

Meskipun 1 bot memiliki 1 tipe strategi utama (1 Bot = 1 Tipe), seluruh bot menerima injeksi data *Global Context* secara *real-time*. Ini memungkinkan bot bereaksi terhadap *event* tanpa harus berubah kepribadian.
- **Data Context**: Berisi status volatilitas saat ini, berita/aksi korporasi yang sedang aktif (diinjeksi oleh *Event Injector*), dan anomali pasar.
- **Reaksi Spesifik**: 
  - *Market Maker* membaca *context* berita (volatilitas tinggi) → bereaksi dengan memperlebar jarak *Bid-Ask* atau berhenti sementara.
  - *Value Investor* membaca *context* kepanikan (harga jatuh) akibat berita → bereaksi dengan semakin agresif membeli karena diskon besar.
Dengan ini, sistem terhindar dari pembuatan bot hibrida yang rumit, namun tetap mempertahankan respons pasar yang sangat organik.

### 6.7 [OPTIONAL] Sector Correlation & Compute Offloading
*(Fitur ini berstatus opsional dan ditunda pengerjaannya menunggu keputusan final)*

Untuk mencapai realisme absolut di mana saham-saham dalam satu sektor bergerak beriringan (efek sektoral), sistem membutuhkan **Correlation Engine**. Mengingat beban komputasi matriks yang berat, fitur ini dirancang dengan arsitektur *Compute Offloading*:
1. **Metadata Saham yang Presisi**: Sistem harus mendefinisikan kategori sektor yang persis sama untuk setiap emiten (misal: BBCA, BMRI, BBNI wajib memiliki parameter `sector: FINANCE` di database/config). Tanpa keseragaman nama ini, korelasi tidak bisa dihitung.
2. **External Cloud Service**: *Correlation Engine* dijalankan di *server* pihak ketiga (misal: Heroku/Cloud) yang berlangganan data WebSocket MATS lokal via *tunneling*. Server awan ini yang akan memproses perhitungan matematika berat (Korelasi Matriks).
3. **Webhook Trigger**: Jika awan mendeteksi korelasi kuat (misal indeks sektor keuangan meroket), ia hanya menembakkan satu *webhook/signal* ringan kembali ke *BOT Service* lokal.
4. **Eksekusi Lokal**: *BOT Service* menerima sinyal tersebut dan menyuntikkannya ke *Global Context*, sehingga bot-bot di sektor terkait ikut bereaksi tanpa membebani CPU laptop lokal.
---

## 7. Fee Awareness & P&L Calculation

### 7.1 Simulasi Biaya Transaksi

Setiap bot harus memperhitungkan biaya transaksi agar P&L tidak distorsi:

```typescript
// Menggunakan fee-service yang sama dengan player
function calculateExpectedFee(side: "buy" | "sell", price: number, lots: number): number {
  const value = price * lots * 100; // asumsi lot size 100 lembar
  if (side === "buy") {
    return value * 0.0015; // 0.15% broker buy fee
  } else {
    return value * (0.0015 + 0.001); // 0.15% sell + 0.1% PPh
  }
}
```

### 7.2 Bot P&L Tracking

Setiap bot memiliki:
- `realized_pnl`: P&L dari posisi yang sudah ditutup, setelah fee
- `unrealized_pnl`: nilai mark-to-market posisi terbuka
- `total_fee_paid`: akumulasi biaya transaksi
- `win_rate`: persentase trade yang menguntungkan
- `turnover`: total nilai transaksi

### 7.3 Auto-Disable Berdasarkan Loss

```yaml
risk_control:
  max_daily_loss_pct: 5.0        # bot dimatikan jika daily loss > 5% modal
  max_weekly_loss_pct: 15.0      # bot dimatikan jika weekly loss > 15% modal
  auto_disable_on_breach: true
  require_admin_reactivation: true  # butuh admin untuk aktifkan kembali
```

---

## 8. Audit Trail & Observability

### 8.1 Bot Decision Log

Setiap keputusan bot dicatat ke database:

```typescript
interface BotDecisionLog {
  id: string;
  bot_id: string;
  strategy: string;
  timestamp: Date;
  
  // Konteks saat keputusan dibuat
  symbol: string;
  session_status: string;
  last_price: number;
  best_bid: number;
  best_ask: number;
  bot_cash: number;
  bot_position_lots: number;
  
  // Keputusan
  decision: "buy" | "sell" | "cancel" | "hold";
  decision_reason: string;         // penjelasan singkat
  
  // Eksekusi
  order_submitted: boolean;
  sekuritas_order_id?: string;
  order_price?: number;
  order_lots?: number;
  
  // Hasil
  order_status?: string;
  reject_reason?: string;
}
```

### 8.2 Bot Performance Dashboard (Admin)

Admin dapat melihat:
- Status setiap bot: aktif/pause/disabled
- P&L real-time setiap bot
- Order count per bot per sesi
- Error rate dan reject rate
- Market impact: berapa % volume pasar yang dihasilkan oleh bot

### 8.3 Circuit Breaker

Jika bot service mengalami masalah:
1. **Spam Order Detection**: Jika satu bot submit > `max_orders_per_minute` → bot di-cooldown otomatis selama 10 menit
2. **Total System Breaker**: Jika seluruh bot service menghasilkan > 500 order/menit → seluruh bot service di-pause
3. **Error Surge Detection**: Jika reject rate > 50% dalam 5 menit → bot di-cooldown sambil menunggu investigation
4. **Manual Kill Switch**: Admin dapat hentikan seluruh bot dalam satu API call

---

## 9. Deployment & Infrastruktur

### 9.1 Posisi dalam Startup Stack

Bot service ditambahkan ke `start-all.bat` sebagai proses terakhir setelah semua service utama ready:

```batch
:: Urutan startup
1. Docker DB containers (BEI DB, MATS DB, Sekuritas DB, Redis)
2. BEI Service
3. MATS Engine
4. Sekuritas Backend
5. Sekuritas Frontend
6. BOT Service  ← baru, berjalan paling akhir
7. (opsional) Cloudflare Tunnel
```

### 9.2 Konfigurasi Environment Bot Service

```env
# BOT/.env
BOT_SERVICE_PORT=9090
BOT_SERVICE_HOST=127.0.0.1    # privat, tidak publik

# Sekuritas API
SEKURITAS_API_URL=http://localhost:3002
BOT_API_INTERNAL_KEY=<secret_key>  # untuk admin endpoint bot

# MATS (untuk subscribe market data langsung)
MATS_WS_URL=ws://127.0.0.1:8082/v1/market-data/ws
MATS_SERVICE_TOKEN=<bot_market_read_token>   # scope: market:read saja

# Database Bot
BOT_DATABASE_URL=postgres://mandala_bot:mandala_bot@localhost:5435/mandala_bot

# Redis (berbagi dengan MATS/BEI)
REDIS_URL=redis://localhost:6379

# Konfigurasi bot
BOT_CONFIG_PATH=./config/bots.yaml   # file konfigurasi bot
BOT_ENABLED=true
BOT_MAX_GLOBAL_ORDERS_PER_MINUTE=300

# Logging
BOT_LOG_LEVEL=info
BOT_AUDIT_LOG_ENABLED=true
```

### 9.3 Struktur Direktori BOT Service

```
BOT/
├── src/
│   ├── index.ts                  # entry point
│   ├── config/
│   │   ├── env.ts                # env loader
│   │   └── bots.yaml             # konfigurasi seluruh bot
│   ├── core/
│   │   ├── market-data.ts        # WebSocket consumer MATS
│   │   ├── session-monitor.ts    # tracking status sesi
│   │   ├── bot-registry.ts       # lifecycle bot
│   │   ├── order-executor.ts     # submit/cancel ke Sekuritas
│   │   └── circuit-breaker.ts    # safety mechanisms
│   ├── strategies/
│   │   ├── base-strategy.ts      # abstract base class
│   │   ├── noise-trader.ts
│   │   ├── market-maker.ts
│   │   ├── momentum-trader.ts
│   │   ├── contrarian.ts
│   │   ├── value-investor.ts
│   │   ├── bandar.ts
│   │   ├── event-driven.ts
│   │   └── panic-seller.ts
│   ├── models/
│   │   ├── bot-config.ts
│   │   ├── market-state.ts
│   │   └── bot-portfolio.ts
│   ├── admin-api/
│   │   └── routes.ts             # endpoint kontrol admin
│   └── db/
│       ├── schema.ts
│       └── migrations/
├── config/
│   └── bots.yaml                 # konfigurasi default bot
├── docker-compose.yml            # DB bot saja
├── package.json
└── tsconfig.json
```

### 9.4 Docker Compose Bot

```yaml
# BOT/docker-compose.yml
services:
  bot-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mandala_bot
      POSTGRES_PASSWORD: mandala_bot
      POSTGRES_DB: mandala_bot
    ports:
      - "5435:5432"
    volumes:
      - bot_db_data:/var/lib/postgresql/data

volumes:
  bot_db_data:
```

---

## 10. Admin Control Panel (API & Frontend)

### 10.1 Admin Control API (Backend)
Admin dapat mengontrol bot melalui REST API internal (tidak publik):

```
Base URL: http://localhost:9090/admin

# Autentikasi
Header: x-bot-admin-key: <BOT_API_INTERNAL_KEY>

# Endpoints
GET    /admin/bots                         # list semua bot + status
GET    /admin/bots/:id                     # detail bot tertentu
POST   /admin/bots/:id/pause              # pause satu bot
POST   /admin/bots/:id/resume             # resume satu bot
POST   /admin/bots/:id/disable            # disable permanen
POST   /admin/bots/pause-all             # hentikan semua bot (emergency)
POST   /admin/bots/resume-all            # aktifkan semua bot
PATCH  /admin/bots/:id/params             # update parameter bot (live)

GET    /admin/performance                  # P&L semua bot
GET    /admin/audit-log?bot_id=&limit=100 # audit log keputusan
GET    /admin/market-impact               # kontribusi bot ke volume pasar
POST   /admin/sentiment                   # set market sentiment override
GET    /admin/health                      # health check bot service
```

### 10.2 Bot Control Dashboard (Frontend UI)
Sebagai antarmuka dari API di atas, sistem ini akan dilengkapi dengan **Frontend Web Dashboard** khusus admin ("Ruang Kendali Sutradara").

**A. Fitur Observability (Yang Bisa Dilihat):**
1. **Live Bot Demographics:** Visualisasi populasi bot yang sedang *online*, dikelompokkan berdasarkan strategi (jumlah bot aktif, error, atau paused).
2. **Aggregated P&L:** Dasbor kekayaan bot untuk melihat strategi mana (Ritel vs Institusi) yang sedang mendulang profit atau mengalami kerugian.
3. **Market Impact:** Grafik kontribusi persentase *volume* transaksi di bursa (Bot vs Manusia).
4. **Live Audit Trail:** *Ticker* log waktu nyata (*real-time*) yang membocorkan keputusan algoritma besar (misal: "Bandar-A memulai akumulasi di GOTO" atau "Market Maker BBCA melebarkan *spread*").

**B. Fitur Control Panel (Yang Bisa Diatur):**
1. **Global Sentiment Override:** Pengubah *mood* pasar (Netral, Bullish, Bearish) yang akan memengaruhi agresivitas *Noise* dan *Momentum Trader*.
2. **Event & News Injector:** Form untuk menyuntikkan berita/krisis pada saham tertentu untuk memicu reaksi bot *Event-Driven*.
3. **Emergency Buttons:** Tombol *Trigger Panic Seller* (untuk stress test *Flash Crash*) dan *Global Kill Switch* (*Pause/Resume* seluruh bot secara instan).
4. **Live Parameter Tweaking:** Kemampuan mengubah parameter bot (seperti besaran lot order) saat simulasi berjalan tanpa perlu me-restart server.

**Integrasi**: Dasbor ini dapat berdiri sendiri sebagai *Bot Control Panel* atau diintegrasikan ke dalam halaman *Super Admin Dashboard* Mandala Exchange jika ada.

---

## 11. Skenario Pasar yang Bisa Disimulasikan

Dengan kombinasi bot yang ada, sistem mampu mensimulasikan:

### Skenario A: "Hari Normal"
- Market maker aktif di semua saham likuid
- Noise trader menciptakan volume acak
- Momentum trader mengikuti micro-trend
- Contrarian membeli saat ada penurunan kecil

### Skenario B: "Bandar Sedang Akumulasi"
- Satu atau dua saham terlihat flat dengan volume rendah
- Tidak ada catalyst jelas, harga tidak bergerak
- Di baliknya, bandar bot sedang diam-diam mengumpulkan

### Skenario C: "Saham Terbang"
- Bandar bot mulai mark-up setelah akumulasi selesai
- Momentum trader tertarik dan ikut beli
- Noise trader FOMO
- Harga naik 10–30% dalam beberapa sesi
- Kemudian distribusi dimulai dan retail terjebak di puncak

### Skenario D: "Market Crash"
- Panic seller bot diaktifkan admin
- Harga turun mendekati ARB di banyak saham
- Contrarian mulai beli tapi belum cukup menahan
- Market maker memperlebar spread drastis

### Skenario E: "Reaksi Korporasi"
- Admin input event dividen untuk BBCA
- Event-driven bot langsung beli
- Harga BBCA naik menjelang cum-date
- Turun kembali setelah ex-date (event-driven bot jual)

---

## 12. Pembatasan & Aturan Kepatuhan

### 12.1 Aturan yang Berlaku untuk Semua Bot (Tanpa Pengecualian)

- ✅ Harus masuk melalui Sekuritas API (tidak ada direct inject ke MATS)
- ✅ Tunduk pada validasi: ARA/ARB, fraksi harga, lot size, saldo/posisi
- ✅ Tunduk pada aturan non-cancellation period
- ✅ Order expired di akhir sesi jika tidak matched
- ✅ Dikenakan broker fee, levy, dan PPh sesuai aturan
- ✅ Tidak boleh short sell (MVP)
- ✅ Tidak boleh margin trading (MVP)
- ✅ Tunduk pada auto-rejection volume BEI
- ✅ Harus berhenti saat market halt atau symbol suspend

### 12.2 Informasi yang Tidak Boleh Dimiliki Bot

Untuk menjaga fairness (informasi simetris):
- ❌ Bot tidak boleh tahu order player lain sebelum masuk ke order book
- ❌ Bot tidak boleh tahu session schedule sebelum player tahu
- ❌ Bot tidak boleh membaca portfolio player lain
- ❌ Bot tidak boleh tahu event masa depan yang belum dipublikasikan di BEI

### 12.3 Yang Diperbolehkan untuk Bot Institusional

- ✅ Modal lebih besar dari rata-rata retail
- ✅ Reaksi lebih cepat (reaction_delay lebih kecil)
- ✅ Strategi multi-hari (bandar, value investor)
- ✅ Konfigurasi khusus per saham (market maker fokus per simbol)
- ✅ Dapat membaca seluruh data publik pasar (same as any player)

---

## 13. Schema Database Bot Service

```sql
-- Tabel registry bot
CREATE TABLE bots (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  strategy VARCHAR(50) NOT NULL,
  tier VARCHAR(20) NOT NULL,           -- 'retail' atau 'institutional'
  sekuritas_user_id VARCHAR(64),       -- user_id di Sekuritas
  status VARCHAR(20) DEFAULT 'active',
  config JSONB NOT NULL,               -- semua parameter strategi
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel sesi JWT token bot
CREATE TABLE bot_tokens (
  bot_id VARCHAR(64) REFERENCES bots(id),
  jwt_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (bot_id)
);

-- Tabel audit log keputusan
CREATE TABLE bot_decision_logs (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) REFERENCES bots(id),
  strategy VARCHAR(50),
  symbol VARCHAR(12),
  session_status VARCHAR(30),
  decision VARCHAR(20),
  decision_reason TEXT,
  context_snapshot JSONB,              -- state pasar saat keputusan
  order_submitted BOOLEAN DEFAULT FALSE,
  sekuritas_order_id VARCHAR(64),
  order_price BIGINT,
  order_lots INT,
  order_status VARCHAR(30),
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel performance harian
CREATE TABLE bot_daily_performance (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) REFERENCES bots(id),
  session_date DATE NOT NULL,
  orders_submitted INT DEFAULT 0,
  orders_filled INT DEFAULT 0,
  orders_rejected INT DEFAULT 0,
  orders_cancelled INT DEFAULT 0,
  total_buy_value BIGINT DEFAULT 0,
  total_sell_value BIGINT DEFAULT 0,
  total_fee_paid BIGINT DEFAULT 0,
  realized_pnl BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, session_date)
);

-- Tabel market sentiment override
CREATE TABLE market_sentiment (
  id SERIAL PRIMARY KEY,
  overall VARCHAR(10) NOT NULL,         -- bearish, neutral, bullish
  volatility_regime VARCHAR(10),
  sector_sentiment JSONB,
  set_by VARCHAR(64),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 14. Persyaratan Non-Fungsional

| Aspek | Requirement |
|---|---|
| **Throughput** | Bot service mampu submit hingga 300 order/menit ke Sekuritas tanpa timeout |
| **Latency** | Keputusan bot (dari signal hingga order submit) < 5 detik dalam kondisi normal |
| **Isolation** | Error satu bot tidak menghentikan bot lain atau sistem utama |
| **Reliability** | Bot service bisa restart tanpa kehilangan state penting (ambil dari DB/API) |
| **Reproducibility** | Mendukung `random_seed` per bot untuk memutar ulang skenario testing |
| **Observability** | Semua keputusan tercatat; admin dashboard tersedia |
| **Safety** | Circuit breaker aktif; kill switch tersedia; bot tidak bisa berjalan saat `MATS_STATUS=halted` |
| **Configurable** | Semua parameter bot bisa diubah via API atau YAML tanpa restart full |
| **Fairness** | Informasi market yang digunakan bot sama dengan yang tersedia untuk player |

---

## 15. Kriteria Penerimaan (Acceptance Criteria)

### Kriteria Minimum MVP

- [ ] Bot dapat didaftarkan sebagai akun khusus di Sekuritas tanpa jalur order bypass
- [ ] Bot dapat submit, amend, cancel order melalui Sekuritas API sama seperti player
- [ ] Bot terkena reject jika ARA/ARB, saldo kurang, fraksi salah, non-cancellation period
- [ ] Order bot dapat matched dengan order player secara normal
- [ ] Settlement bot berjalan sama seperti player
- [ ] Minimal 3 strategi bot berjalan bersamaan: noise trader, market maker, momentum
- [ ] Admin dapat pause/resume bot individual melalui API
- [ ] Bot audit log tersedia dan bisa dicari

### Kriteria Full Feature

- [ ] Semua 8 strategi bot berjalan (termasuk bandar multi-hari)
- [ ] Herd behavior dan sentiment system aktif
- [ ] Bot performance dashboard tersedia
- [ ] Circuit breaker dan auto-disable loss limit berfungsi
- [ ] Skenario pasar A–E bisa disimulasikan
- [ ] Bot service dapat di-restart tanpa kehilangan state kritis
- [ ] Reproduksi skenario via random seed berfungsi

---

## 16. Asumsi & Keputusan Final

| Aspek | Keputusan |
|---|---|
| **Deployment** | Bot berjalan sebagai proses terpisah di laptop lokal (privat, tidak publik) |
| **Akses pasar** | Bot hanya melalui Sekuritas API `http://localhost:3002` |
| **Market data** | Bot subscribe langsung ke MATS WebSocket secara internal (bukan via proxy Sekuritas) |
| **Modal bot** | Bot institusional boleh punya modal jauh lebih besar dari player; tidak perlu setara |
| **Informasi** | Simetris — bot hanya boleh membaca data publik pasar yang sama dengan player |
| **Tujuan utama** | Menghidupkan pasar semirip mungkin dengan kondisi pasar saham Indonesia di reallife |
| **Short selling/margin** | Tidak digunakan di MVP |
| **Email verification** | Bot di-bypass (auto-verified oleh admin/sistem) |
| **Multi-hari** | Bandar dan value investor mendukung strategi multi-hari |
| **Tech stack** | Node.js TypeScript, PostgreSQL terpisah (port 5435), Redis berbagi |

---

## 17. Pertanyaan Terbuka

- Apakah `bots.yaml` menjadi konfigurasi tunggal atau ada management UI tersendiri?
- Berapa jumlah bot maksimum yang bisa berjalan tanpa membebani laptop secara signifikan? (perlu benchmark)
- Apakah bot perlu mekanisme "memory" antar sesi — misalnya bandar bot mengingat posisi akumulasinya dari hari kemarin?
- Apakah perlu logging ke file (untuk debugging) selain ke database?
- Kapan bot service mulai dieksekusi? Setelah fase core Mandala Exchange stabil?

---

## 18. Ekspektasi & Hasil Akhir (Success Metrics)

Ketika **SISTEM BOT** ini sudah diimplementasikan sepenuhnya (100%), berikut adalah ekspektasi *end-goal* dari sisi pengalaman (experience) maupun teknikal:

1. **Pasar yang Bernyawa (Alive Market):** Saat *player* manusia melakukan login, mereka akan langsung disuguhkan *Order Book* yang berkedip, *running trade* yang terus mengalir, dan grafik harga (chart) yang bergerak naik-turun seolah-olah sedang bermain di bursa saham sungguhan dengan ribuan *player* online.
2. **Reaktivitas Natural (Cause & Effect):** Jika *player* manusia membeli saham dalam jumlah raksasa secara tiba-tiba (HAKA), sistem bot akan bereaksi secara instan: bot momentum akan ikut-ikutan membeli (fomo), harga akan melonjak, lalu bot *contrarian* / *value investor* akan mulai menjual untuk mengambil *profit*.
3. **Likuiditas Tak Terbatas namun Rasional:** Saham-saham kasta atas (Bluechip/LQ45) tidak akan pernah mengalami "kekosongan" antrean (selalu ada bid/ask yang rapat berkat Market Maker). Sebaliknya, saham kasta bawah akan terasa sepi dan menakutkan karena *spread* yang lebar dan antrean bolong-bolong.
4. **Zero-Maintenance (Auto-Pilot):** Admin cukup menyalakan *server* di pagi hari, dan ribuan bot ini akan otomatis menyesuaikan diri. Jika ada emiten baru (IPO), mereka otomatis meramaikannya tanpa perlu admin melakukan *coding* ulang atau mengubah konfigurasi (berkat *Dynamic Market Discovery*).
5. **Kekuatan Stress-Test:** Sistem mampu menangani *throughput* ribuan *order* per detik/menit tanpa membuat server utama (BEI & Sekuritas) lumpuh, membuktikan ketangguhan arsitektur *Mandala Exchange*.
