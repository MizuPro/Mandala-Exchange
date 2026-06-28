# Product Requirements Document (PRD) — Mandala Exchange Bot System

**Versi**: 3.0  
**Tanggal**: 2026-06-29  
**Status**: Disetujui untuk implementasi setelah seluruh prasyarat Fase 0 terpenuhi  
**Author**: Mandala Exchange Engineering  

**Dokumen pendamping normatif**:

- `docs/BOT/BOT_API_CONTRACTS.md` — wire format, idempotency, event/replay, session, dan freshness.
- `docs/BOT/BOT_STATE_MACHINES.md` — lifecycle, accounting, pause/kill, recovery, genesis, dan shutdown.
- `docs/BOT/BOT_STRATEGY_SPEC.md` — typed strategy config dan anti-predictability baseline.
- `docs/BOT/BOT_PERFORMANCE_TEST_PLAN.md` — workload, performance gate, soak, failure injection, dan scenario oracle.

**Roadmap lanjutan**: `docs/BOT/BOT_AGENT_BASED_SIMULATION_ROADMAP.md` untuk formalisasi ABM, experiment framework, calibration, validation, emergence metrics, dan advanced predictability testing.

---

## 0. Kontrak Keputusan Final

Bagian ini bersifat normatif. Jika ada contoh lama di dokumen ini yang bertentangan dengan bagian ini, kontrak pada Bagian 0 yang berlaku.

### 0.1 Batas Implementasi

- BOT Service tetap menjadi satu proses Go yang mengelola banyak bot sebagai state dan task konkuren; satu bot bukan satu proses.
- Semua aksi order (`place`, `amend`, dan `cancel`) wajib melalui Sekuritas API menggunakan JWT akun bot. Tidak ada direct order injection ke MATS.
- BEI menjadi sumber kebenaran untuk emiten, sesi, trading rules, fee schedule, indeks, IPO, corporate action, dan custody.
- Sekuritas menjadi sumber kebenaran untuk akun, buying power, posisi, order milik investor, reservation, pending settlement, dan JWT.
- MATS menjadi sumber kebenaran operasional untuk matching, order book, market data, dan status sesi yang sedang dieksekusi.
- Database BOT hanya menyimpan registry/config bot, state strategi, checkpoint event, decision log, scenario run, dan metrik. Database BOT tidak menjadi sumber kebenaran saldo atau order resmi.

### 0.2 Target Skala dan Performance Budget

Target operasional dilakukan bertahap:

| Tahap | Bot Aktif | Tujuan |
|---|---:|---|
| Proof of Concept | 10 | Validasi order, fill, cancel, expiry, dan settlement |
| Baseline | 100 | Validasi recovery, memory leak, dan konsistensi state |
| Default Laptop Lokal | 300–500 | Operasi normal pada Intel i5-10300H dan RAM 16 GB |
| Extended Load Test | 1.000 | Uji sesi penuh dan burst terkontrol |
| Maximum Stress Test | 2.000 | Batas stress test, bukan default runtime |

Budget runtime:

```yaml
performance_budget:
  bot_rss_max_mb: 500
  bot_cpu_average_percent: 10
  bot_cpu_peak_percent: 40
  total_stack_ram_max_gb: 12
  order_rate_sustained_per_minute: 300
  order_rate_burst_capacity: 100
  order_rate_burst_window_seconds: 10
  order_rate_hard_limit_per_minute: 600
  queue_wait_p95_ms: 2000
  sekuritas_api_p95_ms: 500
  reconciliation_interval_seconds: 60
  decision_log_hold_sample_rate: 0.02
```

Peningkatan di atas 300 order/menit hanya boleh dilakukan setelah benchmark membuktikan Sekuritas, MATS, dan database tetap berada dalam budget.

### 0.3 Source of Truth Konfigurasi

Urutan precedence konfigurasi adalah:

```text
compiled defaults
  → bots.yaml sebagai bootstrap template
  → config persisten pada database BOT
  → runtime override yang langsung dipersist ke database BOT
```

`bots.yaml` tidak boleh menimpa bot yang sudah ada saat restart. Perubahan massal dari YAML terhadap bot existing hanya boleh dilakukan melalui operasi reconcile eksplisit dan teraudit.

### 0.4 Mode Runtime

```yaml
runtime_mode: live | deterministic_test
```

- `live`: mengejar realisme operasional dan hanya reproducible secara statistik.
- `deterministic_test`: memakai virtual clock, input event journal, scheduler ordering, config snapshot, dan random seed untuk replay deterministik.

### 0.5 Keputusan Operasional Tambahan

- BEI adalah pembuat dan persistence authority `session_instance_id`; MATS mengeksekusi segment dan melanjutkan instance aktif setelah restart.
- Account event stream memakai global monotonic sequence, delivery at-least-once, snapshot `as_of_sequence`, replay, dan explicit slow-consumer disconnect.
- Place order memakai `client_order_id` stabil. HTTP timeout menghasilkan `submit_unknown` dan wajib direkonsiliasi; tidak boleh blind retry dengan ID baru.
- Sekuritas menjadi coordinator genesis saga.
- Semantics pause, pause-and-cancel, disable, kill switch, accounting, rounding, shutdown, dan restart mengikuti `BOT_STATE_MACHINES.md`.
- Baseline anti-predictability pada `BOT_STRATEGY_SPEC.md` wajib tersedia sebelum strategi MVP dinyatakan selesai; predictor/statistical hardening lanjutan tetap berada pada roadmap ABM.

---

## 1. Latar Belakang & Tujuan

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

### 1.4 Definisi Waktu & Hari Kerja Bursa
> [!IMPORTANT]
> **Penegasan Satuan Waktu**:
> Istilah **"Hari" (Day)** atau **"Hari Kerja Bursa" (Daily)** di dalam dokumen ini **bukan berarti 24 jam real-life**. 
> 
> "1 Hari" dalam sistem simulasi diartikan sebagai **"1 Sesi Perdagangan / Trading Session"**. Durasi sesi continuous nyata ini dikompresi sesuai dengan konfigurasi template session yang ditentukan oleh Admin Bursa (misalnya 1 sesi selesai dalam 15 menit atau 1 jam real-time). Seluruh logika harian bot (seperti P&L harian, daily loss limit, atau fase akumulasi bandar) mengacu pada siklus trading session ini.

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
- Saat connect/reconnect, BOT mengirim daftar universe dan wajib memperoleh initial depth/price/summary snapshot seluruh simbol melalui WebSocket atau bulk snapshot contract sebelum readiness menjadi `ready`.
- Market event memperbarui **shared immutable snapshot per simbol**. Bot membaca snapshot tersebut ketika scheduler mengevaluasi strategi; event tidak disalin ke channel milik masing-masing bot.
- Signal berbasis simbol hanya dikirim kepada strategi yang memang berlangganan simbol tersebut. Desain ini mencegah fan-out ribuan alokasi per market event.
- Menyimpan state lokal: order book snapshot per symbol, last trade price, OHLC per sesi, market depth, dll.
- Market WebSocket hanya menjadi sumber market state, bukan sumber kebenaran portfolio atau private order state.

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
- Disediakan 10 worker awal yang mengambil antrean dan mengeksekusinya via HTTP connection pool ke Sekuritas Backend. Jumlah worker dapat dikonfigurasi, tetapi tidak boleh dipakai untuk melampaui global rate limit.
- **Global Rate Limiter**: sustained rate awal adalah **300 aksi order per menit**, burst maksimal 100 aksi dalam 10 detik, dan hard breaker 600 aksi per menit untuk gabungan seluruh bot.
- Antrean memakai prioritas: `risk/cancel` → `market/event-driven` → `normal strategy` → `market-maker refresh`.
- TTL default: risk/cancel 15 detik, market order 3 detik, event-driven 5 detik, normal limit 15 detik, dan market-maker refresh 5 detik.
- Keputusan stale tidak dikirim dan dicatat sebagai `expired_before_submit`.
- Setiap place order memakai `client_order_id` stabil. Timeout response menghasilkan `submit_unknown`; worker melakukan lookup/reconciliation dan tidak melakukan blind retry.
- Mencatat seluruh keputusan ke bot audit log.

#### E. Session State Monitor
- Membaca `session_state` dan `session_timer` dari MATS serta melakukan snapshot/recovery melalui API sesi aktif BEI.
- Menentukan kapan bot boleh aktif (hanya di sesi continuous, tidak saat halted)
- Mengelola perilaku bot saat opening/closing auction
- Menggunakan `session_instance_id` dan `virtual_day_index`, bukan tanggal kalender laptop, untuk seluruh logika daily/multi-session.
- Freshness default: market/account heartbeat 30 detik, rules/fee 300 detik, session snapshot 10 detik, dan MDX composition 300 detik. Aksi degradation/fail-closed mengikuti `BOT_API_CONTRACTS.md`.

#### F. Bot Portfolio State (In-Memory Cache & Bulk Snapshot)
- **Bulk Snapshot API**: Saat startup, BOT Service memuat cash, positions, open orders, dan event checkpoint seluruh akun BOT melalui internal bulk API Sekuritas. BOT Service dilarang membaca atau menulis database Sekuritas secara langsung.
- **In-Memory Cache**: State lokal membedakan `available`, `reserved`, dan `pending` untuk kas maupun saham, sama seperti model Sekuritas.
- **Single Internal Account Event Stream**: BOT Service membuka satu koneksi internal ke Sekuritas untuk event akun seluruh bot. Stream memiliki sequence monotonik, checkpoint, replay, dan gap detection.
- Stream menggunakan global monotonic sequence, at-least-once delivery, retention minimal 24 jam/100.000 event, heartbeat, serta explicit disconnect untuk slow consumer. Detail mengikuti `BOT_API_CONTRACTS.md`.
- **Recovery**: Jika sequence meloncat atau reconnect tidak dapat direplay, bot terkait di-pause, bulk snapshot diambil ulang, lalu bot baru di-resume setelah state konsisten.
- **Staggered Reconciliation**: Rekonsiliasi berjalan setiap 60 detik dalam batch 50–100 akun. Sekuritas tetap menjadi source of truth.
- **Corporate Action Sync**: Menerima injeksi kas (penambahan saldo) secara otomatis saat emiten membagikan dividen (Ex-Date/Payment Date), sama persis seperti akun player nyata.
- Digunakan oleh strategy engine untuk keputusan berbasis portofolio

#### G. Scheduler
- Scheduler menggunakan min-heap/timing wheel atau scheduler shard, bukan satu `time.Ticker` permanen untuk setiap bot × simbol.
- Strategy worker pool awal berjumlah 4–8 worker dan dibatasi agar burst evaluasi tidak menghabiskan seluruh CPU.
- Seluruh jadwal diberi deterministic jitter agar ribuan bot tidak bangun pada milidetik yang sama.
- Panic recovery dilakukan per task sehingga error satu strategi tidak menghentikan scheduler global.

### 2.3 Alur Data Lengkap

```
MATS WebSocket ──► Market Data Consumer ──► Shared Market Snapshot
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
                               Sekuritas Internal Account Event Stream
                             (order update, fill, settlement, corporate action)
                                                  │
                                         Bot Portfolio State update
```

### 2.4 Tech Stack Bot Service

| Komponen | Pilihan | Alasan |
|---|---|---|
| **Runtime** | **Go (Golang)** | Eksekusi 2000+ goroutine sangat ringan dan ramah RAM. Konsisten dengan arsitektur MATS. |
| **HTTP Client** | `net/http` bawaan Go | Komunikasi ke Sekuritas API dengan *connection pooling* yang efisien |
| **Router** | `github.com/go-chi/chi/v5` | Ringan dan konsisten dengan MATS |
| **WebSocket Client** | `github.com/coder/websocket` | Konsisten dengan implementasi WebSocket MATS |
| **Scheduler** | Min-heap/timing wheel + bounded worker pool | Menghindari ribuan ticker dan burst task tak terbatas |
| **Rate Limiter** | `golang.org/x/time/rate` | Token bucket yang teruji dan mendukung burst terkontrol |
| **Config** | `gopkg.in/yaml.v3` + env + DB override | YAML hanya bootstrap; DB menjadi source of truth setelah provisioning |
| **State Cache** | In-memory + opsional Redis | Berbagi data antar bot instances |
| **Database** | PostgreSQL + `pgx/v5` | Konsisten dengan MATS, efisien untuk batch insert dan explicit transaction |
| **Migration** | `goose` | Migration berversi; tidak memakai runtime auto-migrate |
| **Redis** | `go-redis/v9` | Event/config invalidation dan cache opsional |
| **Admin API** | `chi` + `net/http` | REST API privat untuk kontrol bot |

GORM tidak digunakan. Explicit SQL melalui `pgx/v5` dipilih agar kontrak schema, bulk operation, optimistic locking, dan migration lebih mudah diaudit.

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

**Jumlah default runtime**: 255–425 bot retail aktif untuk konfigurasi 300–500 bot. Jumlah dapat diturunkan pada PoC atau dinaikkan bertahap saat load test.

### 3.2 Tier 2 — Institusional / Bandar Bots

Bot yang mensimulasikan investor besar (fund manager, sekuritas proprietary, "bandar"). Karakteristiknya:
- Modal sangat besar (Rp 500 juta – Rp 10 miliar)
- Keputusan lebih terstruktur dan berdasarkan analisis
- Dapat membentuk (atau menghancurkan) tren harga suatu saham
- Bergerak perlahan tapi konsisten (accumulation/distribution)

**Jumlah default runtime**: 45–75 bot institusional aktif untuk konfigurasi 300–500 bot.

### 3.3 Distribusi Populasi Bot

Untuk menciptakan ekosistem bursa yang serealistis mungkin (mengadopsi komposisi IHSG), pembuatan (creation) bot tidak dilakukan dengan rasio yang merata (1:1). Populasi bot akan mengikuti **Prinsip Pareto (Hukum 80/20)**, di mana mayoritas populasi adalah *Retail*, namun mayoritas modal dikendalikan oleh *Institusi*.

- **Tier 1 (Retail) — tepat 85% dari total populasi bot**
  - **40% Noise Trader**
  - **30% Momentum Trader**
  - **15% Contrarian / Dip Buyer**
- **Tier 2 (Institusional & Bandar) — tepat 15% dari total populasi bot**
  - **5% Market Maker**
  - **5% Value Investor**
  - **2% Index Tracker**
  - **2% Event-Driven**
  - **1% Bandar**
- **Skenario Khusus (0% Default)**
  - **Panic Seller** bukan strategi populasi autonomous. Ia adalah *scenario actor* yang dibuat/diaktifkan hanya oleh Admin saat stress test.

Dengan klasifikasi ini terdapat **8 strategi autonomous** dan 1 scenario actor. Seluruh persentase autonomous berjumlah tepat 100%.

### 3.4 Dynamic Market Discovery (Auto-Pilot)

Agar sistem sepenuhnya *auto-pilot*, mayoritas bot tidak menggunakan daftar saham (simbol) yang di-*hardcode* oleh admin.
- **Listed Securities**: Bot Service mengambil emiten aktif dari `GET /v1/public/securities` BEI menggunakan read-only service token.
- **Trading Rules**: Tick size, lot size, board, ARA/ARB, dan auto-rejection diambil dari `GET /v1/integration/mats/rules`, lalu dicache berdasarkan version/effective time.
- **IPO Discovery**: Masa penawaran IPO dideteksi dari event IPO BEI/Sekuritas, bukan dari daftar listed securities. Subscription selalu dilakukan melalui Sekuritas menggunakan JWT bot.
- **Dynamic Universe**: Konfigurasi parameter bot menggunakan *tag* dinamis seperti `"ALL"`, `"RANDOM_10"`, atau `"SECTOR_FINANCE"`.
- Jika ada saham baru yang IPO, saham tersebut otomatis terdeteksi masuk ke radar (universe) milik bot *Retail/Momentum/Event-Driven* tanpa campur tangan admin sama sekali.
- Pengecualian hanya berlaku untuk bot **Market Maker** dan **Bandar** yang secara natural di dunia nyata memang bertugas menjaga 1 saham spesifik (bisa di-*hardcode* per saham).

*Catatan: Sesuai aturan fairness, Bot Service HANYA melakukan GET/Read ke layanan BEI/MATS untuk penemuan saham, namun **wajib menggunakan POST ke Sekuritas API** untuk semua aksi trading/order-nya.*

Jika snapshot rule tidak tersedia atau sudah stale melewati batas konfigurasi, order baru harus dihentikan secara fail-closed sampai sinkronisasi berhasil.

---

## 4. Tipe Strategi Bot (Detail)

Contoh parameter pada Bagian 4 menjelaskan intent produk. Schema machine-valid, type, unit, distribution, bounds, seed, drift, dan config-change semantics yang normatif berada pada `BOT_STRATEGY_SPEC.md`; notasi ringkas seperti `1-5` tidak boleh disalin langsung sebagai YAML runtime.

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
cancel_probability: 0.3   # probabilitas cancel order setelah 10 menit virtual bursa (BOT Service menyimpan timestamp order untuk melacak usianya secara in-memory)
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
- **Self-Trading Prevention**: Algoritma Market Maker **wajib secara internal menjamin** bahwa harga Bid tertinggi yang dipasangnya selalu lebih rendah **minimal 1 tick/fraksi** dari harga Ask terendah miliknya sendiri. Ini bertujuan untuk mencegah bot memakan ordernya sendiri yang dapat mengakibatkan wash sales tidak produktif dan pemborosan fee transaksi.

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
  min_price: 80
  max_price: 120
accumulation_daily_lots: 100-300   # akumulasi harian tersembunyi
markup_trigger_sessions: 10        # setelah 10 session instance akumulasi, mulai mark-up
markup_daily_lots: 500             # volume besar saat mendorong harga
distribution_start_premium: 0.30  # mulai distribusi saat naik 30%
distribution_daily_lots: 200-800
session_active: [pre_open, opening_auction, continuous, pre_close, closing_auction]
multi_day: true                    # strategi multi-hari
```

> [!IMPORTANT]
> **Persistensi State Multi-Sesi**:
> Karena strategi Bandar berjalan lintas-sesi (multi-session), status internal Bandar (seperti fase aktif, jumlah lot terkumpul, dan counter sesi berjalan) **wajib disimpan secara persisten di database PostgreSQL** (pada kolom `state` di tabel `bots`). Hal ini menjamin bahwa Bandar bot tidak kehilangan memori progres akumulasinya jika server/service bot di-restart di luar jam sesi.

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
  - ipo_subscription          # subscription melalui Sekuritas pada masa penawaran
  - ipo_listing               # order reguler melalui Sekuritas pada hari pertama listing
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
- Transaksi dilakukan bertahap agar tidak merusak harga pasar. **Aturan TWAP (Time-Weighted Average Price)** wajib diimplementasikan di mana order rebalancing yang bernilai besar dibagi secara otomatis menjadi potongan-potongan order kecil (*slice orders*) dan dieksekusi bertahap sepanjang durasi sesi perdagangan aktif untuk menghindari guncangan harga yang tidak wajar.

**Parameter**:
```yaml
strategy: index_tracker
target_index: MDX
tracking_error_tolerance_pct: 2.0  # toleransi deviasi bobot sebelum rebalancing
rebalance_frequency_sessions: 5   # 1 minggu simulasi = 5 session instance selesai
order_size_lots: 50-200            # lot per tahap rebalance
session_active: [continuous, pre_close]
```

**Tujuan dalam ekosistem**: Menjaga stabilitas dan keterkaitan (*correlation*) pergerakan antar saham *bluechip* (penyusun indeks). Mensimulasikan likuiditas konstan dari institusi/reksa dana pasif yang selalu hadir di pasar nyata.

Komposisi dan bobot MDX dibaca dari `GET /v1/indices/MDX/composition`. Jika endpoint atau snapshot valid belum tersedia, strategi Index Tracker dinonaktifkan tanpa memengaruhi strategi lain.

---

## 5. Bot Identity & Account Management

### 5.1 Bot sebagai Akun Sekuritas

Setiap bot didaftarkan sebagai akun `BOT` melalui internal batch provisioning Sekuritas. Field minimal yang wajib tersedia:

```typescript
// Tabel users di Sekuritas
{
  id: "<uuid>",
  email: "bot.mm.bbca@mandala-internal.local",
  status: "verified"
}

// Tabel broker_accounts di Sekuritas
{
  id: "<uuid>",
  user_id: "<uuid>",
  external_bot_id: "bot-001-market-maker-bbca",
  account_type: "BOT",
  status: "ACTIVE"
}
```

Metadata strategi, tier, display name, dan config utama tetap dimiliki database BOT. Sekuritas hanya menyimpan metadata yang diperlukan untuk account classification dan audit.

### 5.2 Batch Provisioning & Startup Authentication

Provisioning menggunakan endpoint:

```http
POST /api/v1/internal/bots/provision
x-service-token: <bot-to-sekuritas-token>
Idempotency-Key: <provision-run-id>
```

Request berisi batch bot dengan `external_bot_id`, email, tier, strategy, dan initial cash. Response memisahkan `created`, `existing`, dan `failed`. `external_bot_id` wajib unik agar retry tidak menghasilkan akun ganda.

BOT tidak menyimpan ribuan password. JWT akun BOT diperoleh melalui:

```http
POST /api/v1/internal/bots/tokens
x-service-token: <bot-to-sekuritas-token>
```

- JWT bersifat short-lived, default 1 jam.
- Refresh dilakukan 5–10 menit sebelum expiry secara staggered.
- JWT tetap dipakai pada endpoint order yang sama dengan player.
- Token tidak boleh ditulis ke log.
- Jika token harus dicache secara persisten, token wajib dienkripsi at-rest.
- Kemudahan token issuance hanya berlaku pada autentikasi; validasi saldo, order, fee, dan market rules tetap identik dengan player.

### 5.3 Bot Identity Metadata

```go
type BotConfig struct {
	ID                string                 `json:"id" yaml:"id"`                                 // unique bot ID
	Name              string                 `json:"name" yaml:"name"`                             // nama display
	Strategy          string                 `json:"strategy" yaml:"strategy"`                     // tipe strategi
	Tier              string                 `json:"tier" yaml:"tier"`                             // "retail" atau "institutional"
	InitialCashIDR    int64                  `json:"initial_cash_idr" yaml:"initial_cash_idr"`      // modal awal dalam rupiah
	AllowedSymbols    []string               `json:"allowed_symbols" yaml:"allowed_symbols"`       // saham yang boleh diperdagangkan
	MaxOrderSizeLots  int                    `json:"max_order_size_lots" yaml:"max_order_size_lots"` // maks lot per order
	MaxExposurePct    float64                `json:"max_exposure_pct" yaml:"max_exposure_pct"`     // maks % dari portofolio di satu saham (evaluasi preventif hanya saat order beli baru)
	MaxDailyLossPct   float64                `json:"max_daily_loss_pct" yaml:"max_daily_loss_pct"` // hentikan bot jika daily loss > X%
	MaxOrdersPerMin   int                    `json:"max_orders_per_minute" yaml:"max_orders_per_minute"` // rate limit per bot
	MaxCancelRate     float64                `json:"max_cancel_rate" yaml:"max_cancel_rate"`       // maks % order yang dibatalkan
	Status            string                 `json:"status" yaml:"status"`                         // "active" | "paused" | "disabled" | "cooldown"
	RandomSeed        *int64                 `json:"random_seed,omitempty" yaml:"random_seed,omitempty"` // untuk reproducibility saat testing
	ConfigVersion     int64                  `json:"config_version" yaml:"config_version"`
	StrategyParams    map[string]interface{} `json:"strategy_params" yaml:"strategy_params"`       // parameter khusus per strategi
}
```

### 5.4 Initial Seeding (Genesis Inventory)

Sebuah bursa yang baru berjalan (Day 1) membutuhkan likuiditas sisi jual (Ask). Jika semua bot hanya dibekali uang tunai (Cash), pasar tidak akan bisa berjalan karena tidak ada yang memiliki barang saham untuk dijual. 
Oleh karena itu, sistem membutuhkan mekanisme **Genesis Seeding**:
- **Market Maker & Bandar Bot**: Saat pertama kali sistem bursa dihidupkan (Day 1), *BOT Service* akan menginisiasi proses injeksi *Inventory* (lot saham) dan uang tunai ke dalam portofolio mereka.
- **Isolasi Sistem (Boundary)**: BOT Service dilarang membaca/menulis database Sekuritas atau BEI secara langsung. Seeding dilakukan melalui `POST /api/v1/internal/bots/genesis`.
- **Idempotency**: Setiap genesis mempunyai `genesis_run_id`, idempotency key, dan payload hash. Run yang sudah `completed` tidak boleh dieksekusi ulang.
- **Cross-Service Consistency**: Genesis memakai pola saga/outbox untuk membentuk cash ledger Sekuritas dan custody ledger BEI. Status hanya boleh `completed` setelah keduanya konsisten.
- **Unit Inventory**: Payload lintas layanan selalu memakai lembar saham. Nilai lot pada config dikalikan lot size aktif sebelum dikirim.
- **Retail Bot (Noise, Momentum, dll)**: Hanya dibekali uang tunai di awal. Mereka harus membeli barang dari *Market Maker* atau *Bandar* di hari-hari pertama.
- **Aturan Ketat (Strict Rule)**: Proses injeksi "gaib" ini **HANYA BOLEH DILAKUKAN SEKALI** pada Hari Ke-1 (Genesis). Untuk hari-hari berikutnya, jika ada emiten baru yang IPO, bot tidak boleh diberi saham secara cuma-cuma. Bot (sebagai *IPO Hunter*) wajib menggunakan uang kas mereka sendiri yang tersisa untuk memesan/membeli saham IPO sesuai prosedur asli bursa. Tidak ada lagi uang atau saham gratis dari udara setelah Day 1.

Jika saga genesis gagal sebagian, scheduler BOT tetap `not_ready`; operator harus menjalankan retry idempotent atau kompensasi. BOT tidak boleh trading sebelum reconciliation membuktikan Sekuritas dan custody BEI konsisten.

### 5.5 IPO Subscription Bot

Bot mendeteksi IPO dari endpoint/event publik, kemudian memesan melalui:

```http
POST /api/v1/ipo-events/:id/subscriptions
Authorization: Bearer <bot-user-jwt>
```

Sekuritas wajib melakukan validasi periode, reserve cash, meneruskan subscription ke BEI, mengubah reserved menjadi settled sesuai alokasi, me-refund selisih, dan memperbarui pending/available shares. Bot tidak boleh memanggil endpoint subscription BEI secara langsung.

Lifecycle event adalah `draft → bookbuilding → subscription → allocation → listed`, dengan `cancelled` sebagai terminal sebelum listing. Investor hanya boleh cancel saat window subscription masih terbuka dan allocation belum dimulai. Saham hasil allocation tetap `pending` serta tidak dapat dijual sampai event menjadi `listed`. Cancellation setelah allocation wajib memakai reversal ledger/custody. Detail normatif terdapat pada Bagian 9 `BOT_API_CONTRACTS.md` dan Bagian 14 `BOT_STATE_MACHINES.md`.

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
> **Peringatan Durasi Sesi & Kompresi Waktu:**
> 1. Jangan pernah menggunakan acuan jam nyata (*real-life time*, misal jam 09:00 - 16:00) untuk perhitungan logika *Rush Hour* ini. Sesi di *production* Mandala Exchange berjalan dengan waktu yang sangat dikompresi (misalnya simulasi 1 hari bursa selesai hanya dalam 15 menit atau 1 jam real-time). Logika U-Shaped Curve **wajib bersifat dinamis**, dihitung berdasarkan **persentase (%) dari total durasi sesi continuous** pada saat itu.
> 2. **Kompensasi Jeda Waktu Bot**: Seluruh parameter jeda/frekuensi transaksi di file `bots.yaml` (misal: "setiap 5-20 menit") dianggap sebagai **Waktu Virtual Bursa**. BOT Service secara dinamis wajib mengonversi nilai virtual tersebut ke **Jeda Waktu Nyata** di laptop Anda dengan membaginya dengan *Rasio Kompresi Sesi* (Durasi Virtual / Durasi Nyata).
>    *   *Rumus*: $\text{Jeda Nyata} = \frac{\text{Jeda Virtual}}{\text{Rasio Kompresi}}$
>    *   *Contoh*: Jika sesi continuous 6 jam (360 menit) dikompresi menjadi 15 menit real-time (rasio 24x), maka jeda virtual 5–20 menit akan dieksekusi oleh Go sebagai jeda nyata **12.5 s.d. 50 detik**.

**Kontrak Session Instance:**

- `session_template_id` hanya mendefinisikan urutan segmen dan durasi.
- Setiap putaran simulasi membuat `session_instance_id` UUID baru dan `virtual_day_index` monotonik.
- Template/session snapshot menyimpan `virtual_duration_seconds` dan `real_duration_seconds` per segmen. Rasio kompresi dihitung dari dua nilai tersebut, bukan dari asumsi jam perdagangan hardcoded.
- MATS menerbitkan `session_instance_id`, `virtual_day_index`, status, kedua durasi, dan sisa waktu nyata pada `session_state`/`session_timer`.
- Daily reset, performance, daily loss, MA history, dan state multi-session mengacu pada session instance, bukan tanggal kalender.
- Satu minggu simulasi didefinisikan sebagai lima session instance yang selesai.
- Jika identitas session instance belum tersedia atau meloncat, strategi di-pause sampai snapshot sesi berhasil dipulihkan.

| Sesi | Perilaku Bot |
|---|---|
| `closed` | Semua bot idle. Tidak ada order. |
| `pre_open` | Hanya bandar dan event-driven yang mulai memasang order awal. |
| `opening_auction` | Pergerakan *low-volume*. Bot berpartisipasi dalam pembentukan harga IEP (*Indicative Equilibrium Price*) secara pasif/wajar berdasarkan fair value estimasi. Tidak agresif. |
| `continuous` | **U-Shaped Curve Aktif**. Rush hour di 30% waktu awal, melandai di pertengahan, lalu melonjak lagi menjelang akhir. |
| `pre_close` | Market maker mulai menarik spread. Contrarian mulai ambil posisi akhir. |
| `closing_auction` | Pergerakan *low-volume*. Hanya bot value dan market maker yang aktif berpartisipasi di harga IEP penutupan. |
| `non_cancellation` | **NCP Kepatuhan Preventif**: Bot memantau status sub-sesi NCP ini dari WebSocket MATS secara real-time. Jika masuk fase NCP, bot secara otomatis menonaktifkan *cancel logic* internal mereka agar tidak mengirim perintah cancel yang pasti ditolak bursa, guna menghemat kuota *Rate Limit* global. |
| `halted` | Semua bot berhenti. Market maker tidak quote. |

### 6.4 Portfolio Awareness & Reserved State Tracking

Setiap bot memiliki "kesadaran" (*awareness*) in-memory terhadap portofolio mereka sendiri untuk menghindari reject order:
- **Pencegahan Jual Kosong (Short Selling)**: Bot tidak diperbolehkan menjual saham yang tidak dimilikinya di memori lokal.
- **Lifecycle State**: Cache membedakan `available`, `reserved`, dan `pending`. Fill tidak otomatis membuat proceeds/efek dapat dipakai sebelum lifecycle settlement Sekuritas menyatakannya available.
- **Reserved State Management**: Ketika bot mengirim order beli, jumlah kas yang dibutuhkan dibekukan (*Reserved Cash*). Saat bot mengirim order jual, jumlah lembar saham yang dijual dibekukan (*Reserved Shares*). Bot tidak dapat memakai state reserved/pending untuk order baru.
- **Order Timestamp & Usia Order**: Untuk mendukung probabilitas pembatalan order (*cancel probability*), setiap order aktif bot yang disimpan in-memory wajib mencatat timestamp pembuatan order. Scheduler internal BOT Service akan secara berkala mengevaluasi usia order tersebut berdasarkan kompresi waktu sesi.
- **Eksposur Risiko (Max Exposure)**: Bot tidak diperbolehkan membeli saham melebihi batas parameter `max_exposure_pct` terhadap total portofolio berjalan. Batasan ini dihitung secara preventif **hanya pada saat bot akan mengirimkan order beli baru** (total portofolio = kas + lot kepemilikan * 100 * Last Price). Kenaikan exposure pasif akibat apresiasi harga pasar tidak boleh mematikan bot.
- **Inventory Management**: Bot market maker akan secara dinamis menyempitkan atau melebarkan spread ask/bid, serta memiringkan quote harga jika status inventori sahamnya mendekati kapasitas penuh (*max inventory limit*).

### 6.5 Sentiment Simulation

Sistem memiliki variabel **market sentiment global** yang diupdate setiap sesi:
```go
type MarketSentiment struct {
	Overall          string            `json:"overall"`           // bearish, neutral, bullish
	VolatilityRegime string            `json:"volatility_regime"` // low, medium, high
	SectorSentiment  map[string]string `json:"sector_sentiment"`  // key: nama sektor, value: positive, neutral, negative
}
```
Sentiment ini mempengaruhi:
- Agresivitas momentum bot
- Frekuensi noise trader
- Spread yang digunakan market maker
- Ambang trigger panic seller

### 6.6 Context & Event Awareness (Kesadaran Kondisi Pasar)

Meskipun 1 bot memiliki 1 tipe strategi utama (1 Bot = 1 Tipe), seluruh bot menerima injeksi data *Global Context* secara *real-time*. Ini memungkinkan bot bereaksi terhadap *event* tanpa harus berubah kepribadian.
- **Data Context**: Berisi status volatilitas, announcement/aksi korporasi yang sudah dipublikasikan, anomali pasar, status suspensi/market halt dari MATS, serta batas ARA/ARB dari versioned rule snapshot BEI.
- **Reaksi Spesifik**: 
  - *Market Maker* membaca *context* berita (volatilitas tinggi) → bereaksi dengan memperlebar jarak *Bid-Ask* atau berhenti sementara.
  - *Value Investor* membaca *context* kepanikan (harga jatuh) akibat berita → bereaksi dengan semakin agresif membeli karena diskon besar.
Dengan ini, sistem terhindar dari pembuatan bot hibrida yang rumit, namun tetap mempertahankan respons pasar yang sangat organik.

**Fairness Event Publication:**

1. Admin membuat announcement/event di BEI.
2. BEI menetapkan `published_at` dan mempublikasikannya kepada player melalui kanal publik Sekuritas.
3. BOT baru boleh memulai reaction delay setelah event publik diterima.
4. Bot Control Panel hanya bertindak sebagai UI/proxy ke BEI dan tidak boleh membuat informasi privat khusus BOT.
5. Event `simulation_only=true` hanya boleh digunakan pada stress test yang ditandai jelas, bukan permainan normal.

### 6.7 Self-Trade Prevention

Pre-check internal Market Maker tetap dilakukan, tetapi jaminan terakhir wajib berada pada matching engine MATS berdasarkan `account_id`.

```yaml
self_trade_prevention: cancel_newest
```

Jika incoming order akan match dengan resting order milik akun yang sama, MATS membatalkan/menolak incoming order dengan reason `self_trade_prevented` dan tidak menghasilkan trade. Pemeriksaan perbedaan best bid/best ask internal saja tidak dianggap cukup karena terdapat race antara submit, amend, dan cancel.

### 6.8 Anti-Predictability Baseline

Sebelum strategi MVP dinyatakan selesai, implementasi wajib memiliki:

- HMAC per-session seed yang tidak diekspos ke player.
- Bounded distribution untuk threshold, interval, order size, reaction delay, dan cooldown.
- Rotasi 300–500 bot aktif dari registry yang lebih besar dengan target ratio tetap.
- Bounded parameter drift per session.
- Multi-signal confirmation agar satu large trade tidak memicu seluruh bot.
- Hysteresis untuk mencegah keputusan bolak-balik pada threshold exact.
- Conditional Bandar transition dalam patience window, bukan perpindahan pada counter sesi exact.

Schema, bounds, dan config-change semantics mengikuti `BOT_STRATEGY_SPEC.md`. Advanced predictor dan statistical exploitability test mengikuti roadmap ABM.

### 6.9 [OPTIONAL] Sector Correlation & Compute Offloading
*(Fitur ini berstatus opsional dan ditunda pengerjaannya menunggu keputusan final)*

Untuk realisme tambahan di mana saham-saham dalam satu sektor bergerak beriringan, sistem dapat menggunakan **Correlation Engine**. Fitur ini wajib dibenchmark secara lokal terlebih dahulu; external compute hanya dipilih jika profiling membuktikan kebutuhan:
1. **Metadata Saham yang Presisi**: Sistem harus mendefinisikan kategori sektor yang persis sama untuk setiap emiten (misal: BBCA, BMRI, BBNI wajib memiliki parameter `sector: FINANCE` di database/config). Tanpa keseragaman nama ini, korelasi tidak bisa dihitung.
2. **Local First**: Jalankan komputasi periodik berbasis snapshot/batch dan ukur CPU/RAM sebelum memindahkannya keluar laptop.
3. **External Optional**: Jika external compute diperlukan, jangan mengekspos MATS WebSocket melalui tunnel. Kirim snapshot minimal melalui authenticated outbound channel dan terima signal dengan signature, replay protection, timeout, serta fail-safe.
4. **Eksekusi Lokal**: *BOT Service* menerima sinyal tersebut dan menyuntikkannya ke *Global Context*, sehingga bot-bot di sektor terkait ikut bereaksi tanpa membebani CPU laptop lokal.
---

## 7. Fee Awareness & P&L Calculation

### 7.1 Simulasi Biaya Transaksi

Setiap bot harus memperhitungkan biaya transaksi agar P&L tidak distorsi. Fee schedule aktif diambil dari `GET /v1/public/fee-schedule` BEI dan dicache berdasarkan `effective_date`. Contoh rate di bawah hanya ilustrasi dan bukan konstanta runtime:

```go
// Menggunakan fee-service yang sama dengan player
func CalculateExpectedFee(
	side Side,
	priceIDR int64,
	quantityShares int64,
	schedule FeeSchedule,
) Money {
	return schedule.Calculate(side, priceIDR, quantityShares)
}
```

Nilai uang persisten menggunakan `BIGINT` rupiah atau `NUMERIC` sesuai kebutuhan rate. `float64` tidak digunakan untuk saldo, fee nominal, nilai exposure, atau P&L persisten; persentase konfigurasi tetap boleh direpresentasikan sebagai floating-point.

### 7.2 Bot P&L Tracking

Setiap bot memiliki:
- `realized_pnl`: P&L dari posisi yang sudah ditutup, setelah fee
- `unrealized_pnl`: nilai mark-to-market posisi terbuka (harga acuan untuk kalkulasi MTM berjalan wajib menggunakan **Last Price** yang didapatkan dari WebSocket)
- `total_fee_paid`: akumulasi biaya transaksi
- `win_rate`: persentase trade yang menguntungkan
- `turnover`: total nilai transaksi

### 7.3 Auto-Disable Berdasarkan Loss

```yaml
risk_control:
  max_daily_loss_pct: 5.0        # bot dimatikan jika daily loss > 5% modal
  max_weekly_loss_pct: 15.0      # weekly = 5 session instance selesai
  auto_disable_on_breach: true
  require_admin_reactivation: true  # butuh admin untuk aktifkan kembali
```

### 7.4 Penanganan Kebangkrutan Bot (Out of Cash & Bangkrut Total)

Untuk mensimulasikan kegagalan finansial secara realistis tanpa intervensi suntikan dana otomatis:
1. **Fase Likuidasi Portofolio (Out of Cash)**:
   * Jika bot kehabisan uang tunai (kas = 0 atau tidak cukup untuk membeli 1 lot saham termurah di universenya) tetapi masih memiliki *inventory* saham, bot akan secara otomatis dipaksa masuk ke mode **Likuidasi Portofolio**.
   * Dalam mode ini, seluruh logika beli (*buy logic*) dinonaktifkan. Bot hanya akan memasang order jual (*sell limit/market*) secara bertahap pada sisa kepemilikan sahamnya sampai laku terjual untuk mengembalikan posisi kasnya.
2. **Fase Bangkrut Total**:
   * Jika kas bot bernilai 0 DAN bot tidak memiliki saham lagi untuk dijual di portofolionya, bot tersebut dinyatakan **Bangkrut Total**.
   * BOT Service akan secara otomatis mematikan bot tersebut, memperbarui status bot di database PostgreSQL menjadi `"bankrupt"`, dan menonaktifkannya secara permanen dari daftar scheduler.

---

## 8. Audit Trail & Observability

### 8.1 Bot Decision Log

Setiap keputusan bot dicatat ke database:

```go
type BotDecisionLog struct {
	ID                  uint64    `json:"id"`
	BotID               string    `json:"bot_id"`
	SimulationRunID     string    `json:"simulation_run_id"`
	SessionInstanceID   string    `json:"session_instance_id"`
	VirtualDayIndex     int64     `json:"virtual_day_index"`
	Strategy            string    `json:"strategy"`
	Timestamp           time.Time `json:"timestamp"`
	Symbol              string    `json:"symbol"`
	SessionStatus       string    `json:"session_status"`
	Decision            string    `json:"decision"`
	DecisionReason      string    `json:"decision_reason"`
	ContextSnapshot     any       `json:"context_snapshot"`
	OrderSubmitted      bool      `json:"order_submitted"`
	SekuritasOrderID    *string   `json:"sekuritas_order_id,omitempty"`
	OrderPriceIDR       *int64    `json:"order_price_idr,omitempty"`
	OrderQuantityShares *int64    `json:"order_quantity_shares,omitempty"`
	OrderStatus         *string   `json:"order_status,omitempty"`
	RejectReason        *string   `json:"reject_reason,omitempty"`
}
```

Kebijakan logging:

- `BUY`, `SELL`, `CANCEL`, reject, risk breach, lifecycle error, dan circuit breaker selalu dicatat.
- Keputusan `HOLD` disampling default 2%, bukan dicatat seluruhnya.
- Log dikumpulkan dalam batch 100–500 baris dan di-flush setiap 1–5 detik.
- Retention default 30 session instance dan dapat dikonfigurasi.
- Log tidak boleh memuat JWT, password, service token, atau data rahasia player.

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
2. **Total System Breaker**: Jika gabungan aksi order melebihi hard limit 600/menit → seluruh strategy submission di-pause; risk/cancel queue tetap boleh diproses
3. **Error Surge Detection**: Jika reject rate > 50% dalam 5 menit → bot di-cooldown sambil menunggu investigation
4. **Manual Kill Switch**: Admin dapat hentikan seluruh bot dalam satu API call
5. **Dependency Breaker**: Jika Sekuritas, MATS, BEI rule snapshot, account event stream, atau session identity tidak sehat/stale → order baru dihentikan fail-closed
6. **Queue Pressure Breaker**: Jika queue di atas 80% kapasitas selama 10 detik → hentikan task prioritas rendah; jika mencapai 100% → drop item stale dan pause strategy producer

---

## 9. Deployment & Infrastruktur

### 9.1 Posisi dalam Startup Stack

Bot service ditambahkan ke `start-all.bat` setelah semua dependency utama sehat. Startup wajib menggunakan health/readiness check, bukan fixed sleep saja:

```batch
:: Urutan startup
1. Docker DB containers (BEI DB, MATS DB, Sekuritas DB, BOT DB, Redis)
2. Migration BEI, Sekuritas, MATS, dan BOT
3. BEI Service → tunggu ready
4. MATS Engine → tunggu ready dan rule sync
5. Sekuritas Backend → tunggu ready
6. BOT Service → provision/token/snapshot/reconciliation
7. Sekuritas Frontend
8. (opsional) Cloudflare Tunnel
```

BOT tidak menjalankan strategi sampai BEI rules, MATS session/market feed, Sekuritas account event stream, JWT, dan initial portfolio reconciliation siap.

### 9.2 Konfigurasi Environment Bot Service

```env
# BOT/.env
BOT_SERVICE_PORT=9090
BOT_SERVICE_HOST=127.0.0.1    # privat, tidak publik
BOT_RUNTIME_MODE=live

# Sekuritas API
SEKURITAS_API_URL=http://localhost:3002
SEKURITAS_BOT_SERVICE_TOKEN=<bot_to_sekuritas_token>

# MATS (untuk subscribe market data langsung)
MATS_WS_URL=ws://127.0.0.1:8082/v1/market-data/ws
MATS_SERVICE_TOKEN=<bot_market_read_token>   # scope: market:read saja

# BEI read-only API
BEI_API_URL=http://127.0.0.1:4100
BEI_SERVICE_TOKEN=<bot_readonly_token>

# Database Bot
BOT_DATABASE_URL=postgres://mandala_bot:mandala_bot@localhost:5435/mandala_bot

# Redis (berbagi dengan MATS/BEI)
REDIS_URL=redis://localhost:6379

# Admin API privat
BOT_API_INTERNAL_KEY=<secret_key>

# Konfigurasi bot
BOT_CONFIG_PATH=./config/bots.yaml   # file konfigurasi bot
BOT_ENABLED=true
BOT_MAX_GLOBAL_ORDERS_PER_MINUTE=300
BOT_HARD_GLOBAL_ORDERS_PER_MINUTE=600
BOT_ORDER_BURST_CAPACITY=100
BOT_ORDER_QUEUE_CAPACITY=5000
BOT_ORDER_WORKERS=10
BOT_STRATEGY_WORKERS=8
BOT_RECONCILIATION_INTERVAL_SECONDS=60
BOT_DECISION_HOLD_SAMPLE_RATE=0.02
BOT_DB_MAX_CONNECTIONS=15

# Logging
BOT_LOG_LEVEL=info
BOT_AUDIT_LOG_ENABLED=true
```

Environment dipisahkan mengikuti pola proyek:

| Mode | BOT API | BOT PostgreSQL | Env Runtime | Env Docker |
|---|---:|---:|---|---|
| Development | 9090 | 5435 | `BOT/.env.development` | `BOT/.env.docker.development` |
| Production | 9091 | 5535 | `BOT/.env.production` | `BOT/.env.docker.production` |

Secret development dan production wajib berbeda. BOT API, BOT database, BEI, dan MATS tetap bind ke loopback dan tidak diekspos melalui Cloudflare Tunnel.

### 9.3 Struktur Direktori BOT Service

```
BOT/
├── cmd/
│   └── bot/
│       └── main.go               # entry point utama
├── config/
│   ├── env.go                    # env loader
│   └── bots.yaml                 # konfigurasi default bot
├── core/
│   ├── market_data.go            # WebSocket consumer MATS
│   ├── session_monitor.go        # tracking status sesi
│   ├── bot_registry.go           # lifecycle bot
│   ├── order_executor.go         # submit/cancel ke Sekuritas
│   ├── account_events.go         # sequenced event stream Sekuritas
│   ├── portfolio_cache.go        # available/reserved/pending cache
│   ├── reconciliation.go         # bulk snapshot/recovery
│   ├── scheduler.go              # min-heap/sharded scheduler
│   └── circuit_breaker.go        # safety mechanisms
├── strategies/
│   ├── base_strategy.go          # interface / base strategy
│   ├── noise_trader.go
│   ├── market_maker.go
│   ├── momentum_trader.go
│   ├── contrarian.go
│   ├── value_investor.go
│   ├── bandar.go
│   ├── event_driven.go
│   ├── index_tracker.go
│   └── panic_seller.go           # scenario actor
├── models/
│   ├── bot_config.go
│   ├── market_state.go
│   └── bot_portfolio.go
├── api/
│   └── routes.go                 # REST API admin kontrol (chi)
├── db/
│   ├── store.go                  # pgx repositories
│   └── migrations/               # Database migrations
├── internal/
│   ├── bei/                      # read-only BEI client
│   ├── mats/                     # market WebSocket client
│   └── sekuritas/                # order/provision/snapshot/event client
├── tests/
│   ├── integration/
│   └── load/
├── docker-compose.yml            # DB bot saja
├── go.mod
└── go.sum
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
      - "${BOT_DB_PORT:-5435}:5432"
    volumes:
      - bot_db_data:/var/lib/postgresql/data

volumes:
  bot_db_data:
```

Docker Compose wajib memakai project/volume berbeda untuk development dan production agar data tidak tercampur.

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
POST   /admin/bots/:id/pause-and-cancel   # pause + cancel order cancellable
POST   /admin/bots/:id/resume             # resume satu bot
POST   /admin/bots/:id/disable            # disable permanen
POST   /admin/bots/:id/disable-and-cancel # disable + cancel order cancellable
POST   /admin/bots/pause-all             # hentikan semua bot (emergency)
POST   /admin/bots/resume-all            # aktifkan semua bot
PATCH  /admin/bots/:id/params             # update parameter bot (live)

GET    /admin/performance                  # P&L semua bot
GET    /admin/audit-log?bot_id=&limit=100 # audit log keputusan
GET    /admin/market-impact               # kontribusi bot ke volume pasar
POST   /admin/sentiment                   # set market sentiment override
POST   /admin/scenarios                    # membuat simulation scenario
POST   /admin/scenarios/:id/start          # mulai scenario
POST   /admin/scenarios/:id/stop           # hentikan scenario
GET    /admin/health                      # health check bot service
GET    /admin/readiness                   # dependency + reconciliation readiness
```

Update parameter memakai optimistic locking melalui `config_version`. Jika version request sudah stale, API mengembalikan `409 Conflict`.

`pause` hanya menghentikan keputusan/order baru; existing order tetap aktif. `kill switch` menghentikan producer global dan mencoba cancel seluruh order cancellable, tetapi tetap mengonsumsi event/reconciliation. Semantics lengkap mengikuti `BOT_STATE_MACHINES.md`.

### 10.2 Bot Control Dashboard (Frontend UI)
Antarmuka BOT diintegrasikan sebagai halaman **Super Admin Sekuritas** ("Ruang Kendali Sutradara"). Tidak dibuat frontend server atau port UI terpisah. Browser memanggil proxy admin Sekuritas; secret BOT tidak disimpan di browser.

**A. Fitur Observability (Yang Bisa Dilihat):**
1. **Live Bot Demographics:** Visualisasi populasi bot yang sedang *online*, dikelompokkan berdasarkan strategi (jumlah bot aktif, error, atau paused).
2. **Aggregated P&L:** Dasbor kekayaan bot untuk melihat strategi mana (Ritel vs Institusi) yang sedang mendulang profit atau mengalami kerugian.
3. **Market Impact:** Grafik kontribusi persentase *volume* transaksi di bursa (Bot vs Manusia).
4. **Live Audit Trail:** *Ticker* log waktu nyata (*real-time*) yang membocorkan keputusan algoritma besar (misal: "Bandar-A memulai akumulasi di GOTO" atau "Market Maker BBCA melebarkan *spread*").

**B. Fitur Control Panel (Yang Bisa Diatur):**
1. **Global Sentiment Override:** Pengubah *mood* pasar (Netral, Bullish, Bearish) yang akan memengaruhi agresivitas *Noise* dan *Momentum Trader*.
2. **Event & News Injector:** Form meneruskan event ke BEI agar dipublikasikan kepada player sebelum BOT bereaksi. Event stress test privat wajib ditandai `simulation_only`.
3. **Emergency Buttons:** Tombol *Trigger Panic Seller* (untuk stress test *Flash Crash*) dan *Global Kill Switch* (*Pause/Resume* seluruh bot secara instan).
4. **Live Parameter Tweaking:** Kemampuan mengubah parameter bot (seperti besaran lot order) saat simulasi berjalan tanpa perlu me-restart server. Parameter yang diubah secara live ini akan disimpan langsung ke database PostgreSQL (tabel `bots` kolom `config`) agar perubahan bersifat persisten.

Refresh agregasi dashboard default 2–5 detik. UI tidak melakukan query per bot untuk setiap market event dan tidak membuka satu WebSocket per bot.

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
- ✅ Tunduk pada validasi ARA/ARB, tick size, lot size, saldo, dan posisi. Helper `GetValidPriceTick` wajib memakai snapshot trading rules BEI aktif
- ✅ Tunduk pada aturan non-cancellation period
- ✅ Order expired di akhir sesi jika tidak matched (proses *expire* otomatis dilakukan oleh MATS Matching Engine saat sesi masuk status `closed`, BOT Service secara pasif mendengarkan dan memperbarui status order in-memory)
- ✅ Dikenakan broker fee, levy, dan PPh sesuai aturan
- ✅ Tidak boleh short sell (MVP)
- ✅ Tidak boleh margin trading (MVP)
- ✅ Tunduk pada auto-rejection volume BEI
- ✅ Harus berhenti saat market halt atau symbol suspend (saat menerima notifikasi suspensi emiten/market halt via WebSocket MATS, BOT Service secara in-memory wajib menangguhkan strategy execution untuk emiten tersebut dan membersihkan seluruh sisa order book lokalnya secara otomatis)
- ✅ Tick size, lot size, ARA/ARB, dan fee wajib berasal dari snapshot rule/fee BEI aktif; tidak boleh menjadi konstanta hardcoded BOT
- ✅ MATS wajib menerapkan Self-Trade Prevention berdasarkan account ID
- ✅ BOT dilarang memakai cash/shares berstatus `reserved` atau `pending`
- ✅ BOT dilarang trading ketika account event sequence gap, reconciliation belum selesai, atau dependency snapshot stale

### 12.2 Informasi yang Tidak Boleh Dimiliki Bot

Untuk menjaga fairness (informasi simetris):
- ❌ Bot tidak boleh tahu order player lain sebelum masuk ke order book
- ❌ Bot tidak boleh tahu session schedule sebelum player tahu
- ❌ Bot tidak boleh membaca portfolio player lain
- ❌ Bot tidak boleh tahu event masa depan yang belum dipublikasikan di BEI
- ❌ Bot tidak boleh membaca private order/account event milik player manusia

### 12.3 Yang Diperbolehkan untuk Bot Institusional

- ✅ Modal lebih besar dari rata-rata retail
- ✅ Reaksi lebih cepat (reaction_delay lebih kecil)
- ✅ Strategi multi-hari (bandar, value investor)
- ✅ Konfigurasi khusus per saham (market maker fokus per simbol)
- ✅ Dapat membaca seluruh data publik pasar (same as any player)

---

## 13. Schema Database Bot Service

```sql
CREATE TABLE bots (
  id VARCHAR(64) PRIMARY KEY,
  external_bot_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  strategy VARCHAR(50) NOT NULL,
  tier VARCHAR(20) NOT NULL,
  sekuritas_user_id UUID,
  sekuritas_account_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','cooldown','disabled','bankrupt')),
  config JSONB NOT NULL,
  config_version BIGINT NOT NULL DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  state_version BIGINT NOT NULL DEFAULT 1,
  random_seed BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cache token bersifat opsional. Ciphertext harus dienkripsi oleh application key.
CREATE TABLE bot_tokens (
  bot_id VARCHAR(64) PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  encrypted_token BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE simulation_runs (
  id UUID PRIMARY KEY,
  mode VARCHAR(30) NOT NULL CHECK (mode IN ('live','deterministic_test')),
  global_seed BIGINT,
  config_snapshot JSONB NOT NULL,
  status VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE genesis_runs (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  payload_hash VARCHAR(128) NOT NULL,
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('pending','processing','completed','failed','compensating')),
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE bot_config_versions (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  config JSONB NOT NULL,
  changed_by VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bot_id, version)
);

CREATE TABLE bot_state_snapshots (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_instance_id UUID,
  state_version BIGINT NOT NULL,
  strategy_state JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE event_checkpoints (
  stream_name VARCHAR(64) PRIMARY KEY,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bot_decision_logs (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  simulation_run_id UUID REFERENCES simulation_runs(id),
  session_instance_id UUID,
  virtual_day_index BIGINT,
  strategy VARCHAR(50) NOT NULL,
  symbol VARCHAR(12),
  session_status VARCHAR(30),
  decision VARCHAR(30) NOT NULL,
  decision_reason TEXT,
  context_snapshot JSONB,
  order_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  sekuritas_order_id VARCHAR(64),
  order_price_idr BIGINT,
  order_quantity_shares BIGINT,
  order_status VARCHAR(30),
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX bot_decision_logs_session_idx
  ON bot_decision_logs(session_instance_id, bot_id, created_at);

CREATE TABLE bot_session_performance (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(64) NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_instance_id UUID NOT NULL,
  virtual_day_index BIGINT NOT NULL,
  orders_submitted INT NOT NULL DEFAULT 0,
  orders_filled INT NOT NULL DEFAULT 0,
  orders_rejected INT NOT NULL DEFAULT 0,
  orders_cancelled INT NOT NULL DEFAULT 0,
  total_buy_value_idr BIGINT NOT NULL DEFAULT 0,
  total_sell_value_idr BIGINT NOT NULL DEFAULT 0,
  total_fee_paid_idr NUMERIC(24,6) NOT NULL DEFAULT 0,
  realized_pnl_idr NUMERIC(24,6) NOT NULL DEFAULT 0,
  peak_unrealized_pnl_idr NUMERIC(24,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, session_instance_id)
);

CREATE TABLE market_sentiment (
  id BIGSERIAL PRIMARY KEY,
  simulation_run_id UUID REFERENCES simulation_runs(id),
  overall VARCHAR(10) NOT NULL CHECK (overall IN ('bearish','neutral','bullish')),
  volatility_regime VARCHAR(10),
  sector_sentiment JSONB,
  set_by VARCHAR(64),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE scenario_events (
  id UUID PRIMARY KEY,
  simulation_run_id UUID REFERENCES simulation_runs(id),
  event_type VARCHAR(50) NOT NULL,
  symbol VARCHAR(12),
  intensity NUMERIC(8,4),
  simulation_only BOOLEAN NOT NULL DEFAULT FALSE,
  bei_announcement_id UUID,
  published_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Migration memakai `goose` dan harus reversible bila aman. Runtime tidak boleh memakai auto-migrate. State saldo, posisi, dan order resmi tidak disimpan sebagai source of truth pada schema ini.

---

## 14. Persyaratan Non-Fungsional

| Aspek | Requirement |
|---|---|
| **Throughput** | Sustained 300 aksi order/menit, burst 100/10 detik, hard breaker 600/menit |
| **Decision Latency** | Signal sampai masuk queue p95 < 100 ms |
| **Queue Latency** | Waktu tunggu queue p95 < 2 detik pada kondisi normal |
| **Execution Latency** | Keluar queue sampai response Sekuritas p95 < 500 ms; item stale tidak dikirim |
| **Isolation** | Error satu bot tidak menghentikan bot lain atau sistem utama |
| **Reliability** | Restart melakukan replay atau bulk snapshot tanpa kehilangan state strategi dan tanpa memakai state account stale |
| **Reproducibility** | Deterministic test mode menyimpan run ID, virtual clock, config snapshot, seeds, input journal, dan scheduler order |
| **Observability** | Semua aksi/material decision tercatat; HOLD disampling; metric queue, rate, error, memory, dan dependency tersedia |
| **Safety** | Circuit breaker, queue pressure breaker, dependency breaker, STP, dan kill switch aktif |
| **Configurable** | YAML menjadi bootstrap; DB + optimistic config version menjadi source of truth runtime |
| **Fairness** | Informasi market yang digunakan bot sama dengan yang tersedia untuk player |
| **Resource BOT** | Pada 2.000 bot: RSS ≤ 500 MB, CPU average ≤ 10%, CPU peak ≤ 40% pada mesin target |
| **Resource Stack** | Total stack target ≤ 12 GB RAM agar tidak memicu paging pada laptop 16 GB |
| **Database** | BOT DB pool default maksimum 15 koneksi; decision log menggunakan batch insert |
| **Recovery** | Event gap terdeteksi, bot terkait di-pause, dan reconciliation selesai sebelum resume |

---

## 15. Kriteria Penerimaan (Acceptance Criteria)

### Kriteria Minimum MVP

- [ ] Setiap putaran sesi memiliki `session_instance_id` dan `virtual_day_index` unik
- [ ] Batch provisioning dan token issuance idempotent tersedia
- [ ] Genesis seeding konsisten antara cash/position Sekuritas dan custody BEI
- [ ] Bulk portfolio snapshot dan sequenced account event stream tersedia
- [ ] Snapshot `as_of_sequence` + replay tidak kehilangan event yang concurrent
- [ ] Timeout submit diselesaikan melalui `client_order_id` tanpa duplicate order
- [ ] Bot dapat didaftarkan sebagai akun khusus di Sekuritas tanpa jalur order bypass
- [ ] Bot dapat submit, amend, cancel order melalui Sekuritas API sama seperti player
- [ ] Bot terkena reject jika ARA/ARB, saldo kurang, fraksi salah, non-cancellation period
- [ ] Order bot dapat matched dengan order player secara normal
- [ ] Settlement bot berjalan sama seperti player
- [ ] Minimal 3 strategi bot berjalan bersamaan: noise trader, market maker, momentum
- [ ] Admin dapat pause/resume bot individual melalui API
- [ ] Pause, pause-and-cancel, disable, dan kill switch mengikuti state machine normatif
- [ ] Bot audit log tersedia dan bisa dicari
- [ ] Restart saat terdapat open order pulih melalui replay/snapshot tanpa double reservation
- [ ] MATS mencegah self-trade berdasarkan account ID
- [ ] PoC 10 bot lulus satu siklus sesi lengkap tanpa mismatch reconciliation

### Kriteria Full Feature

- [ ] Semua 8 strategi autonomous berjalan; Panic Seller berjalan sebagai scenario actor
- [ ] Herd behavior dan sentiment system aktif
- [ ] Bot performance dashboard tersedia
- [ ] Circuit breaker dan auto-disable loss limit berfungsi
- [ ] Skenario pasar A–E bisa disimulasikan
- [ ] Bot service dapat di-restart tanpa kehilangan state kritis
- [ ] Deterministic test run dapat direplay dengan hasil keputusan/order yang sama
- [ ] IPO subscription bot berjalan melalui Sekuritas dengan reserve, allocation, dan refund benar
- [ ] Event/news dipublikasikan kepada player sebelum reaction delay bot dimulai
- [ ] Load test 500 bot memenuhi seluruh performance budget
- [ ] Load test 1.000 dan 2.000 bot terdokumentasi; 2.000 tidak menjadi syarat default runtime
- [ ] Scenario A–E lulus oracle dan correctness invariant pada `BOT_PERFORMANCE_TEST_PLAN.md`
- [ ] Normal market memenuhi baseline quote ratio, empty-book duration, spread, reject, STP, dan reconciliation
- [ ] Baseline anti-predictability pada `BOT_STRATEGY_SPEC.md` aktif sebelum full strategy release

---

## 16. Asumsi & Keputusan Final

| Aspek | Keputusan |
|---|---|
| **Deployment** | Bot berjalan sebagai proses terpisah di laptop lokal (privat, tidak publik) |
| **Akses pasar** | Bot hanya melalui Sekuritas API `http://localhost:3002` |
| **Market data** | Bot subscribe langsung ke MATS WebSocket secara internal (bukan via proxy Sekuritas) |
| **Private account state** | Satu sequenced internal event stream + bulk snapshot dari Sekuritas |
| **Modal bot** | Bot institusional boleh punya modal jauh lebih besar dari player; tidak perlu setara |
| **Informasi** | Simetris — bot hanya boleh membaca data publik pasar yang sama dengan player |
| **Tujuan utama** | Menghidupkan pasar semirip mungkin dengan kondisi pasar saham Indonesia di reallife |
| **Short selling/margin** | Tidak digunakan di MVP |
| **Autentikasi** | Bot di-auto-verified saat internal provisioning dan memperoleh short-lived JWT tanpa menyimpan password |
| **Multi-hari** | Bandar dan value investor menyimpan state berdasarkan session instance |
| **Config source** | YAML bootstrap; database BOT menjadi source of truth runtime |
| **Tech stack** | Go, chi, coder/websocket, pgx, goose, PostgreSQL terpisah, Redis berbagi |
| **Default scale** | 300–500 aktif; 1.000 extended; 2.000 stress test |
| **Dashboard** | Terintegrasi ke Super Admin Sekuritas; tidak ada port frontend BOT terpisah |
| **Money type** | BIGINT/NUMERIC; tidak menggunakan float untuk uang persisten |

---

## 17. Prasyarat API Lintas Layanan

Seluruh keputusan terbuka sebelumnya telah ditutup oleh Bagian 0 dan Bagian 16. Implementasi BOT penuh menunggu kontrak berikut:

### 17.1 BEI/MATS

- `trading_session_instance` unik untuk setiap putaran simulasi.
- `session_state`/`session_timer` membawa instance ID, virtual day, durasi, dan remaining time.
- Endpoint existing `GET /v1/integration/mats/sessions/active` diperluas untuk snapshot instance aktif; tidak membuat path sesi baru yang duplikatif.
- `GET /v1/indices/MDX/composition` menyediakan simbol, bobot, effective time, dan version.
- Read-only BOT service identity memiliki scope minimal `market:read`, `rules:read`, dan `corporate-action:read`.
- MATS menerapkan Self-Trade Prevention berdasarkan account ID.

### 17.2 Sekuritas

- `POST /api/v1/internal/bots/provision`
- `POST /api/v1/internal/bots/tokens`
- `POST /api/v1/internal/bots/genesis`
- `POST /api/v1/internal/bots/portfolio-snapshot`
- `GET /api/v1/internal/bots/events/ws?after_sequence=...`
- `POST /api/v1/ipo-events/:id/subscriptions`
- `GET /api/v1/orders/by-client-id/:clientOrderId`

Seluruh internal endpoint memakai scoped service token, idempotency key untuk mutation, audit log, request limit, dan hanya bind ke jaringan internal/loopback. Wire contract dan error semantics mengikuti `BOT_API_CONTRACTS.md`.

### 17.3 Logging dan Operasi

- Structured log ke stdout/file dipakai untuk debugging operasional dengan rotation.
- Decision/audit log material disimpan ke database.
- Secret dan data player tidak boleh muncul di kedua jenis log.
- BOT baru dieksekusi setelah seluruh task Fase 0 pada MAIN_PLAN selesai.

---

## 18. Ekspektasi & Hasil Akhir (Success Metrics)

Ketika **SISTEM BOT** ini sudah diimplementasikan sepenuhnya (100%), berikut adalah ekspektasi *end-goal* dari sisi pengalaman (experience) maupun teknikal:

1. **Pasar yang Bernyawa (Alive Market):** Saat *player* manusia melakukan login, mereka akan langsung disuguhkan *Order Book* yang berkedip, *running trade* yang terus mengalir, dan grafik harga (chart) yang bergerak naik-turun seolah-olah sedang bermain di bursa saham sungguhan dengan ribuan *player* online.
2. **Reaktivitas Natural (Cause & Effect):** Jika *player* manusia membeli saham dalam jumlah raksasa secara tiba-tiba (HAKA), sistem bot akan bereaksi secara instan: bot momentum akan ikut-ikutan membeli (fomo), harga akan melonjak, lalu bot *contrarian* / *value investor* akan mulai menjual untuk mengambil *profit*.
3. **Likuiditas Rasional:** Saham kasta atas memiliki quote yang konsisten sesuai inventory dan risk limit Market Maker. Likuiditas tetap terbatas oleh modal, inventory, fee, dan global rate limit; saham kasta bawah tetap lebih sepi dan memiliki spread lebih lebar.
4. **Low-Maintenance Auto-Pilot:** Admin menyalakan stack dan BOT melakukan health check, provisioning/reconciliation, serta market discovery otomatis. Emiten/IPO baru diproses melalui discovery dan workflow Sekuritas tanpa perubahan kode.
5. **Kekuatan Stress-Test Terukur:** Sistem memenuhi performance budget pada 500 bot aktif dan memiliki hasil benchmark terdokumentasi untuk 1.000/2.000 bot tanpa menjadikan angka tersebut default runtime.
