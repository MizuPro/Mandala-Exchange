# 🏛️ Rangkuman Komprehensif: BEI Service (Bursa Efek Indonesia)
**Pusat Otoritas Pasar (Market Authority) Mandala Exchange**

Dokumen ini memberikan penjelasan lengkap, detail, dan menyeluruh mengenai maksud, fungsi, tujuan, arsitektur, skema database, aturan operasional, serta pola integrasi **BEI Service** di dalam ekosistem **Mandala Exchange**. Rangkuman ini ditujukan bagi developer, system architect, atau siapapun yang ingin mempelajari, mengintegrasikan, atau mereplikasi layanan otoritas bursa ini.

---

## 1. Pendahuluan & Tujuan Layanan

### Latar Belakang & Maksud
Pada arsitektur awal Mandala Exchange, tanggung jawab pengelolaan data emiten, regulasi perdagangan, aksi korporasi, kliring, penyelesaian transaksi (*settlement*), dan buku besar kustodian (*custody ledger*) bercampur di dalam service broker (Sekuritas) dan mesin pencocokan transaksi (Matching Engine). Hal ini menyulitkan pelacakan bug, rawan inkonsistensi saldo kas/saham, serta membuat batas domain (*domain boundary*) menjadi kabur.

**BEI Service** dibangun sebagai mikroservis independen berbasis **Node.js, Fastify, TypeScript, dan Drizzle ORM** untuk mengonsolidasikan seluruh tanggung jawab otoritas pasar saham ke dalam satu sumber kebenaran tunggal (*Single Source of Truth*).

### Fungsi & Tujuan Utama
1.  **Pusat Otoritas Pasar (Market Authority)**: Mengelola master data emiten, saham tercatat, status listing, notasi khusus pengawasan, aturan trading (lot & tick size), batas ARA/ARB harian, status broker anggota bursa, dan konfigurasi sesi perdagangan.
2.  **Buku Besar Kustodian Sentral (Custody Ledger SSoT)**: Bertindak sebagai Kustodian Sentral (menyerupai KSEI di Indonesia) yang menyimpan data posisi kas RDN (*Rekening Dana Nasabah*) dan saldo efek SRE (*Sub Rekening Efek*) resmi milik seluruh investor.
3.  **Mesin Penyelesaian Transaksi (Settlement Engine)**: Memproses kliring netting dan transfer dana/efek antar-rekening kustodian secara aman, konsisten, dan idempotent setelah sesi perdagangan ditutup.
4.  **Eksekutor Aksi Korporasi & IPO**: Mengatur siklus pendaftaran emiten baru melalui IPO (*Initial Public Offering*) serta memproses aksi korporasi (Dividen tunai, Stock Split, Reverse Split, Saham Bonus, Rights Issue, dan Waran) yang berdampak langsung pada jumlah saham beredar dan saldo kepemilikan investor.
5.  **Pengawasan & Alerting (Surveillance)**: Mendeteksi aktivitas mencurigakan secara real-time seperti transaksi pencucian uang (*wash trade*), volatilitas harga ekstrem, manipulasi harga, dan circuit breaker.
6.  **Pemberi Konteks Keputusan Bot (Automated Trading Bot Helper)**: Menyediakan data analisis pendukung seperti nilai wajar saham (*fair value*), iklim/rezim pasar (*market regimes*), profil likuiditas saham, dan umpan berita (*news feed*) simulator guna memandu AI Trading Bot dalam mengeksekusi order.

---

## 2. Batasan Layanan & Pembagian Tanggung Jawab (Service Boundary)

Ekosistem Mandala Exchange memiliki tiga pilar utama yang saling berinteraksi dengan pembagian tugas yang jelas:

```mermaid
graph TD
    subgraph BEI Service [🏛️ BEI Service - Market Authority]
        direction TB
        DB[(PostgreSQL)]
        BEI_API[REST API & Webhooks]
        Ledger[Custody & Settlement Ledger]
        Corp[Corporate Actions & IPO Engine]
    end

    subgraph MATS Service [⚡ MATS Service - Matching Engine]
        ME[Matching Engine]
        OB[Order Book]
        Redis[(Redis Cache & Pub/Sub)]
    end

    subgraph Sekuritas Service [💼 Mandala Sekuritas - Broker]
        BrokerAPI[Broker API]
        ClientPort[Client Portfolios]
        OrderVal[Order & Cash Validation]
    end

    %% Hubungan Integrasi
    MATS_Read[1. Get Rules & Securities] --> BEI_API
    ME -->|2. Capture Trade matched| BEI_API
    BEI_API -->|3. Publish updates via Redis| Redis
    Redis -.->|4. Real-time Cache Update| ME
    BrokerAPI -->|5. Query Public Data & Ledger| BEI_API
    BEI_API -->|6. Callback Settlement / CA| BrokerAPI
```

1.  **BEI Service**:
    *   **Pemilik Domain**: Profil emiten, saham tercatat, papan pencatatan, notasi pengawasan, aturan lot dan tick size, price band ARA/ARB, fee/pajak transaksi bursa, capture transaksi matched resmi, batch settlement, buku besar saldo efek/kas kustodian, IPO lifecycle, corporate action execution, market summary, dan log audit.
    *   **Aturan Desain**: **Tidak memproses antrean order book real-time secara langsung**. Pencocokan transaksi diserahkan sepenuhnya ke MATS.
2.  **MATS Service (Go-based Matching Engine)**:
    *   **Pemilik Domain**: Penerimaan order dari broker, pemeliharaan antrean order book, mekanisme lelang (*opening/closing call auction*), continuous matching, penghitungan IEP/IEV, live market data (bid/ask depth, last trade tape), dan pengiriman transaksi matched ke BEI.
    *   **Aturan Desain**: MATS tidak menyimpan saldo kustodian. MATS selalu mengonsumsi regulasi trading (seperti price band & tick size) dari BEI untuk melakukan penolakan order secara otomatis (*auto-rejection*).
3.  **Mandala Sekuritas (Broker)**:
    *   **Pemilik Domain**: Pendaftaran akun pemain, verifikasi KYC, pemeliharaan saldo cash & saham lokal, reservasi saldo sebelum order dikirim ke MATS, estimasi biaya transaksi bursa ke klien, visualisasi portofolio & leaderboard pemain, serta rekonsiliasi data saldo lokal terhadap buku besar BEI.
    *   **Aturan Desain**: Semua retailer dan bot bertransaksi lewat Sekuritas. Bot/trader retail **tidak memiliki hak** langsung memanggil API internal BEI Service.

---

## 3. Detail Integrasi Sistem Saat Ini

Integrasi antar-service di dalam Mandala Exchange dirancang menggunakan kombinasi REST API, Redis Pub/Sub (Event-Driven), dan Webhook Callbacks:

### A. Integrasi BEI dengan MATS (Matching Engine)
*   **Startup Sync**: MATS memanggil `GET /v1/integration/mats/rules` dan `GET /v1/integration/mats/securities` saat bootup untuk memuat aturan trading dan daftar simbol aktif ke in-memory cache miliknya.
*   **Broker Validation**: MATS memanggil `GET /v1/brokers/:code/validate` untuk memastikan broker pengirim order terdaftar aktif di bursa.
*   **Trade Capture**: Saat Matching Engine mencocokkan pesanan, MATS mengirimkan payload transaksi ke BEI via `POST /v1/trades/capture`. BEI memprosesnya secara idempotent berdasarkan `idempotency_key` (format `trade:<mats_trade_id>`).
*   **Redis Pub/Sub (`market_updates` channel)**:
    *   Ketika admin BEI memperbarui data aturan, status emiten, suspensi saham, atau circuit breaker, BEI mempublikasikan pesan ke Redis. MATS langsung mendengarkan channel ini untuk memutakhirkan memori internal secara instan tanpa restart.
    *   Transisi fase sesi bursa disiarkan oleh BEI ke channel Redis ini agar MATS mengubah status operasional order book-nya.
*   **Circuit Breaker**: Modul Surveillance BEI memonitor penurunan indeks MDX secara real-time. Jika terdeteksi penurunan drastis, BEI menembak endpoint MATS `POST /v1/admin/session/halt` untuk menghentikan perdagangan global.

### B. Integrasi BEI dengan Mandala Sekuritas (Broker)
*   **Data Feeds**: Sekuritas memanggil API publik BEI untuk mengambil detail profil emiten, fundamental keuangan, berita pasar, fee schedule, dan event IPO aktif.
*   **Reconciliation & Ledger Balance**: Sekuritas memverifikasi posisi saldo kas (RDN) dan saham (SRE) klien dengan memanggil `GET /v1/custody/accounts/:brokerCode/:investorId/summary` ke BEI.
*   **Webhook Callback**:
    *   **Settlement Completed**: Begitu batch settlement selesai diproses di BEI (akhir sesi), BEI mengirimkan notifikasi ke URL webhook Sekuritas (`SEKURITAS_SETTLEMENT_WEBHOOK_URL`). Sekuritas kemudian melepaskan cadangan saldo nasabah (*unreserve cash/stock*) dan menyesuaikan saldo portofolio lokal.
    *   **Corporate Action Completed**: Saat aksi korporasi dieksekusi, BEI mengirimkan daftar hak (*entitlements*) investor ke webhook Sekuritas (`SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL`) guna memperbarui portofolio nasabah secara otomatis dan sinkron.

### C. Integrasi BEI dengan Automated Trading Bots (BOT-v2)
*   **Bot Helper Feeds**: Bot membutuhkan data pasar agregat untuk menghitung keputusan trading. BEI menyediakan endpoint khusus (di-mount **tanpa prefix `/v1`**):
    *   `GET /bot/fair-value-module`: Nilai wajar teoritis saham terbaru yang ditandai `visible_to_bot = true`.
    *   `GET /bot/market-regime`: Status rezim pasar makro terupdate (volatilitas dan sektoral).
    *   `GET /bot/liquidity-profile`: Profil karakteristik likuiditas & volatilitas saham.
    *   `GET /bot/news-module`: Feed simulator berita aktif untuk konsumsi reaksi bot.
*   **Flow Order**: Bot tidak menggunakan token bursa internal BEI. Bot bertransaksi layaknya investor biasa melalui API Mandala Sekuritas.

---

## 4. Entitas Utama & Skema Database

Struktur data BEI didefinisikan secara deklaratif di Drizzle ORM ([schema.ts](file:///e:/_BELAJAR%20PROGRAMMING_/github/Mandala-Exchange/BEI/src/db/schema.ts)) dengan relasi antar-entitas yang ketat:

```
                            [ Relasi Entitas Utama ]
                            
   ┌───────────┐         ┌───────────────────┐         ┌─────────────────────┐
   │  issuers  │◄────────┤ listed_securities │◄────────┤  special_notations  │
   └─────┬─────┘         └─────────┬─────────┘         └─────────────────────┘
         │                         │
         ▼                         ▼
   ┌───────────┐         ┌───────────────────┐         ┌─────────────────────┐
   │ financial │         │      trades       │◄────────┤    custody_ledger   │
   │  reports  │         └───────────────────┘         └─────────────────────┘
   └───────────┘
```

### A. Master Data Emiten & Saham
1.  **`issuers`**: Menyimpan profil korporasi emiten (`code`, `name`, `sector`, `summary`, `business_description`, `is_active`).
2.  **`listed_securities`**: Menyimpan saham terdaftar (`issuer_id`, `symbol`, `name`, `board`, `sector`, `shares_outstanding`, `ipo_price`, `reference_price`, `previous_close`, `status` [listed, suspended, delisted, prelisted], `market_mechanism` [regular, call_auction]).
3.  **`special_notations`**: Status pengawasan khusus per saham (`security_id`, `type` [watchlist, specialmonitoring, suspend, delistingrisk, unusualcondition], `note`, `is_active`, `effective_from`, `effective_to`).
4.  **`issuer_announcements`**: Pengumuman resmi dari emiten (`issuer_id`, `security_id`, `type`, `title`, `body`, `published_at`).
5.  **`financial_reports`**: Data fundamental mentah dan rasio keuangan (`issuer_id`, `period`, `revenue`, `net_income`, `assets`, `liabilities`, `equity`, `eps`, `book_value_per_share`, `dividend_payout`, `ratios` [JSONB untuk ROE, ROA, DER, PER, PBV]).

### B. Aturan Perdagangan & Sesi
6.  **`broker_members`**: Registrasi broker anggota bursa (`code`, `name`, `status`, `service_identifier` [backend url sekuritas]).
7.  **`trading_rule_profiles`**: Profil aturan trading berdasarkan Papan Pencatatan (`board`) dan Segmen Pasar.
8.  **`lot_size_rules`**: Jumlah lembar saham dalam 1 lot (default: 100 lembar) (`profile_id`, `instrument_type`, `lot_size`).
9.  **`tick_size_rules`**: Aturan fraksi harga minimum berdasarkan rentang harga saham (`profile_id`, `min_price`, `max_price`, `tick_size`).
10. **`price_band_rules`**: Aturan batas kenaikan (ARA) dan penurunan (ARB) maksimum harian (`profile_id`, `min_reference_price`, `max_reference_price`, `ara_percent`, `arb_percent`, `min_price`).
11. **`auto_rejection_rules`**: Aturan penolakan volume order yang terlalu besar (`profile_id`, `max_lots_per_order`, `max_listed_shares_percent`).
12. **`session_templates`**: Template sesi bursa (`name`, `status`, `settlement_mode`, `settlement_delay_sessions`, `post_closing_enabled`, `is_active`).
13. **`session_segments`**: Segmen waktu per sesi bursa (`template_id`, `sequence`, `status`, `duration_seconds`, `allow_order_entry`, `allow_cancel_amend`).
14. **`session_instances`**: Instance fisik dari trading session yang berjalan (`session_template_id`, `virtual_day_index`, `status`, `current_segment_sequence`, `virtual_duration_seconds`, `real_duration_seconds`, `mats_node_id`, `started_at`, `expected_end_at`, `version` [optimistic locking]).
15. **`trading_halts`**: Data pembekuan perdagangan global/saham (`security_id`, `status` [active, inactive], `reason`, `started_at`, `ended_at`).
16. **`fee_schedules`**: Konfigurasi rate biaya transaksi (`broker_buy_rate`, `broker_sell_rate`, `exchange_fee_rate`, `clearing_fee_rate`, `settlement_fee_rate`, `vat_rate`, `sell_tax_rate`, `minimum_fee`, `effective_date`, `is_active`).

### C. Transaksi, Kliring, dan Penyelesaian (Settlement)
17. **`trades`**: Menyimpan replika matched trade dari MATS (`mats_trade_id`, `sequence_number`, `session_id`, `security_id`, `symbol`, `price`, `quantity`, `value`, `buy_broker_id`, `sell_broker_id`, `buy_investor_id`, `sell_investor_id`, `buy_order_id`, `sell_order_id`, `occurred_at`, `idempotency_key`).
18. **`settlement_batches`**: Penampung batch penyelesaian transaksi per sesi (`session_id`, `mode`, `status`, `scheduled_for`, `processed_at`).
19. **`settlement_instructions`**: Instruksi transfer dana/saham hasil netting (`batch_id`, `trade_id`, `type` [dvp, rvp], `status`, `from_custody_account_id`, `to_custody_account_id`, `security_id`, `quantity`, `cash_amount`, `idempotency_key`).
20. **`custody_accounts`**: Akun resmi efek & kas nasabah (`broker_id`, `investor_id`, `sid` [Single Investor Identification], `sre` [Sub Rekening Efek], `rdn` [Rekening Dana Nasabah], `status`).
21. **`custody_ledger_entries`**: Buku besar mutasi saldo append-only (`custody_account_id`, `security_id`, `entry_type` [trade_settlement, cash_settlement, cash_dividend, stock_split, reverse_split, bonus_share, rights_issue, warrant, adjustment, reversal], `asset_type` [cash, security, right, warrant], `quantity` [positif/negatif], `cash_amount` [positif/negatif], `position_state`, `reference_type`, `reference_id`, `idempotency_key`).

### D. IPO, Corporate Action, Surveillance, dan Bot
22. **`ipo_events`**: Detail IPO (`issuer_id`, `security_id`, `offered_shares`, `offering_price`, `bookbuilding_start`, `bookbuilding_end`, `subscription_start`, `subscription_end`, `listing_date`, `status` [draft, bookbuilding, subscription, allocation, listed, cancelled], `underwriter_broker_id`, `hype_score`, `ipo_archetype`, `oversubscription_ratio`, `float_ratio`, `sector_sentiment`, `subscription_lot_size`).
23. **`ipo_subscriptions`**: Pendaftaran antrean beli saham IPO nasabah (`ipo_event_id`, `broker_id`, `investor_id`, `requested_shares`, `status`).
24. **`ipo_allocations`**: Hasil penjatahan final saham IPO (`ipo_subscription_id`, `allocated_shares`, `allocation_value`, `status`, `allocation_key`).
25. **`ipo_lifecycle_outbox`**: Implementasi Transactional Outbox Pattern untuk keandalan sinkronisasi IPO ke Sekuritas (`event_key`, `ipo_event_id`, `event_type`, `target`, `payload`, `status`, `attempts`, `next_attempt_at`, `delivered_at`, `last_error`).
26. **`corporate_actions`**: Event aksi korporasi emiten (`security_id`, `type` [cash_dividend, stock_split, reverse_split, bonus_share, rights_issue, warrant], `status` [draft, announced, recording, processing, completed, cancelled], `title`, `description`, `recording_date`, `execution_date`, `ratio_numerator`, `ratio_denominator`, `cash_amount_per_share`, `exercise_price`, `idempotency_key`).
27. **`surveillance_alerts`**: Alarm deteksi transaksi tidak wajar (`session_id`, `security_id`, `type`, `severity`, `message`, `evidence` [JSONB], `status`).
28. **`fair_values`**: Nilai wajar per saham untuk bot (`symbol`, `fair_value`, `confidence`, `visible_to_bot`, `visible_to_player`).
29. **`market_regimes`**: Skenario rezim volatilitas bursa (`session_id`, `global_regime`, `sector_regimes`, `volatility_regime`).
30. **`security_liquidity_profiles`**: Karakteristik likuiditas historis per saham (`symbol`, `liquidity_level`, `volatility_level`, `retail_interest`, `institutional_interest`).
31. **`news`**: Berita buatan untuk simulator reaksi bot (`title`, `body`, `symbol`, `sector`, `sentiment`, `intensity`, `status`, `published_session`, `expiry_session`).
32. **`audit_logs`**: Log mutasi aksi admin (`actor`, `action`, `entity_type`, `entity_id`, `before` [JSONB], `after` [JSONB], `reason`).

---

## 5. Alur Siklus Sesi Perdagangan (Trading Session Lifecycle)

Sesi perdagangan di Mandala Exchange berjalan melalui tahapan fase transisi status (`session_statuses`):
`closed` ──► `pre_open` ──► `opening_auction` ──► `continuous` ──► `pre_close` ──► `random_closing` ──► `closing_auction` ──► `non_cancellation` ──► `post_closing` ──► `closed`. 

Jika terjadi kondisi darurat, sesi dapat dipindahkan ke status `halted` (Suspensi Pasar/Circuit Breaker).

Ketika bursa berganti fase sesi perdagangan, BEI Service mengeksekusi logika operasional berikut:

```
                  [ Transisi Siklus Sesi Perdagangan ]
                  
     closed ──────► pre_open ──────► continuous ──────► closed
                  (Inisialisasi)    (Delta Index)    (Auto-Settlement &
                                                      Agregasi Data)
```

### A. Fase Inisialisasi Sesi (`pre_open`)
Ketika status sesi berganti ke `pre_open` (Lelang Pembukaan), BEI Service memicu proses inisialisasi sesi MDX di Redis (`initializeMdxSession`):
*   BEI mengambil data harga acuan (`reference_price` atau `previous_close`) serta jumlah saham beredar (`shares_outstanding`) untuk semua saham aktif dari database PostgreSQL.
*   Menyimpan data tersebut ke cache Redis (`mdx:last_price:<symbol>` dan `mdx:shares:<symbol>`).
*   Menghitung nilai awal total kapitalisasi pasar (`mdx:prev_mcap`) dan mempublikasikan nilai indeks MDX pembuka ke Redis Pub/Sub (`market_updates` channel) untuk dibaca oleh frontend visualisasi.

### B. Fase Perdagangan Aktif (`continuous`)
Selama transaksi berlangsung secara real-time di Matching Engine (MATS), BEI bertugas melacak delta fluktuasi indeks:
*   Setiap trade matched yang di-capture oleh BEI memicu `applyTradeDelta(symbol, newPrice)`.
*   Sistem menghitung perubahan kapitalisasi pasar akibat perubahan harga transaksi terakhir saham tersebut secara *in-memory* di Redis.
*   Menghitung ulang nilai indeks gabungan pasar Mandala Exchange (MDX) dan langsung menyiarkan nilai terbaru via Pub/Sub secara instan tanpa membebani server database PostgreSQL.

### C. Fase Penutupan Sesi (`closed`)
Begitu sesi perdagangan dinyatakan selesai (`closed`), BEI menjalankan tugas akhir hari (*end-of-day jobs*):
1.  **Trade Capture Finality Barrier**: Sebelum kliring berjalan, BEI memvalidasi apakah jumlah transaksi (`trades`) yang di-capture di database BEI sama dengan jumlah transaksi yang diharapkan (`expectedTradeCount`) dari laporan MATS. Jika ada transaksi yang tertinggal akibat latensi jaringan, proses kliring akan diblokir sementara (`settlementBlockedReason`) untuk menunggu semua trade tersimpan.
2.  **Agregasi & Market Summary**:
    *   BEI menghitung data ringkasan pasar seperti harga Open, High, Low, Close (OHLC), volume, nilai transaksi, dan frekuensi per saham dari data trade hari itu, lalu menyimpannya ke tabel `market_summaries`.
    *   Nilai penutupan indeks pasar MDX dihitung ulang menggunakan kapitalisasi pasar rata-rata tertimbang dan disimpan resmi di database `market_indices`.
    *   Memperbarui harga penutupan hari ini menjadi `previous_close` dan `reference_price` baru pada tabel `listed_securities` untuk digunakan sebagai acuan ARA/ARB pada sesi perdagangan berikutnya.
3.  **Auto-Settlement Trigger**:
    *   BEI memicu pembuatan batch settlement secara otomatis via internal HTTP request `POST /v1/settlement/batches` dengan mode `end_of_session`.
    *   Melakukan netting kewajiban kas dan saham, menghasilkan instruksi settlement (`settlement_instructions`), mengeksekusi mutasi buku besar kustodian (`custody_ledger_entries`), dan mengirimkan webhook status penyelesaian ke Mandala Sekuritas untuk pembaruan saldo portofolio klien.

---

## 6. Regulasi & Aturan Perdagangan (Trading Rules)

Sebagai market authority, BEI Service menegakkan aturan-aturan perdagangan meniru Bursa Efek Indonesia asli (BEI-like) sebagai berikut:

### A. Fraksi Harga (Tick Size Tier)
Aturan fraksi harga menentukan perubahan minimum harga penawaran saham yang diperbolehkan dalam order book:

| Rentang Harga (Rp) | Fraksi / Tick Size (Rp) | Maksimum Perubahan Harga (1 Step) |
| :--- | :--- | :--- |
| < 200 | 1 | 20 |
| 200 - < 500 | 2 | 50 |
| 500 - < 2.000 | 5 | 100 |
| 2.000 - < 5.000 | 10 | 200 |
| >= 5.000 | 25 | 500 |

*MATS menolak pesanan jika harga yang diajukan tidak habis dibagi oleh fraksi harga yang berlaku.*

### B. Price Band & Auto Reject Atas / Bawah (ARA / ARB)
Untuk menghindari fluktuasi harga yang terlalu ekstrem dalam satu hari perdagangan, BEI menerapkan batas atas dan batas bawah persentase pergerakan harga saham berdasarkan harga acuan (*reference price*):

1.  **Papan Utama & Pengembangan (Simulasi Standard)**:
    *   **Harga Rp50 - Rp200**: ARA maks +35%, ARB maks -15%
    *   **Harga >Rp200 - Rp5.000**: ARA maks +25%, ARB maks -15%
    *   **Harga >Rp5.000**: ARA maks +20%, ARB maks -15%
2.  **Papan Akselerasi / Watchlist**:
    *   Batas ARA dan ARB diatur secara simetris flat (misal: maksimum 10%).
    *   Mekanisme perdagangan menggunakan Call Auction periodik (tidak kontinu).

*Sistem penolakan ini dihitung secara otomatis oleh MATS dengan mengambil reference price pagi hari yang bersumber dari BEI.*

---

## 7. Siklus Hidup Transaksi, Kliring, dan Penyelesaian (Settlement)

Berikut adalah visualisasi transisi dari pencocokan order hingga perpindahan aset final:

```
[ Peta Alur Transaksi ]

Pemain (Order) 
   │
   ▼
Broker (Mandala Sekuritas) ────► Validasi Saldo Klien (RDN & SRE di-reserve)
   │
   ▼ (Kirim Order)
Matching Engine (MATS) ────────► Cocok (Match) ──► Terbit Trade Matched
                                                       │
   ┌───────────────────────────────────────────────────┘
   ▼ (Trade Capture)
BEI Service (Capture Trade)
   │ (Status Aset: Reserved)
   ▼
Sesi Pasar Ditutup (Status: Closed)
   │
   ▼ (Auto-Settlement)
Settlement Engine (BEI)
   ├─► Hitung Netting Dana & Saham (Clearing)
   ├─► Buat Settlement Instruction (DVP/RVP/FOP)
   ├─► Eksekusi Mutasi Saldo Buku Besar (Custody Ledger)
   │     - Pendebitan/Pengkreditan Akun Kas RDN
   │     - Pendebitan/Pengkreditan Akun Saham SRE
   │     - Status Aset menjadi: Settled
   ▼
Kirim Webhook Callback Completed ──► Mandala Sekuritas ──► Unreserve & Update Portfolio Klien
```

### A. Alur Pemrosesan Kliring & Settlement (DVP & RVP)
1.  **Membuka Batch (`POST /v1/settlement/batches`)**:
    *   Membaca semua `trades` di database BEI untuk sesi tertentu.
    *   Memastikan akun kustodian pembeli dan penjual terdaftar melalui `ensureCustodyAccount`. Jika belum terdaftar, BEI men-generate akun baru lengkap dengan referensi SID, SRE, dan RDN.
    *   Menghasilkan dua jenis instruksi settlement untuk setiap trade:
        *   **DVP (Delivery Versus Payment - Transfer Efek)**: Mengirimkan saham dari akun penjual ke akun pembeli. Kuantitas disesuaikan, kas bernilai 0. Idempotency Key: `settlement:<sessionId>:<tradeId>:security`.
        *   **RVP (Receive Versus Payment - Transfer Kas)**: Mengirimkan uang kas dari akun pembeli ke akun penjual. Kuantitas bernilai 0, kas bernilai total transaksi (`trade.value`). Idempotency Key: `settlement:<sessionId>:<tradeId>:cash`.
2.  **Eksekusi Perpindahan Saldo (`POST /v1/settlement/batches/:id/process`)**:
    *   Sistem membaca seluruh instruksi di dalam batch.
    *   **Double-Entry Buku Besar**:
        *   Untuk DVP: Menambahkan entri ledger `trade_settlement` debet (`-qty`) di akun penjual dan kredit (`+qty`) di akun pembeli.
        *   Untuk RVP: Menambahkan entri ledger `cash_settlement` debet (`-cashAmount`) di akun pembeli dan kredit (`+cashAmount`) di akun penjual.
    *   Mengubah status instruksi menjadi `settled` dan status batch menjadi `settled`.
3.  **Webhook Callback**:
    *   Mengirim notifikasi asinkron ke server Sekuritas berisi data transaksi detail (`notifySekuritasSettlement`). Jika webhook gagal, status diset `failed` dan akan di-retry oleh worker BEI.

### B. Integritas Saldo Kustodian (Append-Only Ledger)
Semua perubahan saldo kas RDN maupun saham SRE **dilarang keras memodifikasi kolom saldo akhir secara langsung**. Sistem kustodian BEI merekam setiap transaksi sebagai baris mutasi baru (`custody_ledger_entries`) dengan status `settled`. Saldo ril investor dihitung melalui penjumlahan kumulatif (`SUM`) dari seluruh mutasi ledger historis.

---

## 8. Penanganan Aksi Korporasi & Siklus IPO

### A. Aksi Korporasi (Corporate Actions)
Admin BEI dapat mendaftarkan rencana aksi korporasi. Begitu tanggal eksekusi (`execution_date`) tiba, admin memicu endpoint `/v1/corporate-actions/:id/process`. Sistem BEI secara otomatis membekukan data snapshot kepemilikan dan menyuntikkan saldo baru:
*   **Cash Dividend (Dividen Tunai)**: Menyuntikkan entri ledger `cash_dividend` berisi penambahan kas (`+cashAmount`) ke RDN investor terdaftar pada *recording date*. Rumus: `quantity * cashAmountPerShare`.
*   **Stock Split / Reverse Split**: Melakukan pemecahan (atau penggabungan) saham. Sistem menghitung selisih (`delta = (quantity * ratio) - quantity`) dan menyuntikkan ledger `stock_split` atau `reverse_split` (positif untuk split, negatif untuk reverse). Harga acuan (`reference_price`) saham induk disesuaikan secara proporsional.
*   **Bonus Share (Saham Bonus)**: Menyuntikkan saldo saham baru (`+quantity`) ke SRE investor secara gratis berdasarkan rasio kepemilikan.
*   **Rights Issue (HMETD) & Warrant**: Menerbitkan instrumen derivatif baru (`asset_type` diset `right` atau `warrant`) ke rekening investor.
    *   **Auto-Register Derivative**: BEI secara otomatis mendaftarkan simbol instrumen baru ke tabel `listed_securities` dengan board `derivatives`, harga acuan dasar Rp50, dan simbol berakhiran `-R` (Rights, misal: `MNDL-R`) atau `-W` (Warrant, misal: `MNDL-W`). Jumlah saham beredar disesuaikan dengan total hasil konversi rasio.

### B. Siklus IPO (Initial Public Offering)
Proses IPO di BEI dikelola secara ketat melalui tahapan status:
1.  **Draft**: Penginputan rencana IPO, target penawaran (`offeredShares`), harga penawaran (`offeringPrice`), jadwal masa penawaran, underwriter broker, dan estimasi nilai wajar awal (`initialFairValue`).
2.  **Publish**: Memicu transisi status ke `bookbuilding` atau `subscription` agar dapat dibaca publik (pemain & bot).
3.  **Allocate (Penjatahan & Distribusi)**:
    *   **Minting Initial Supply**: Menciptakan saham IPO (`offeredShares`) ke akun kustodian Underwriter (berkode investor `TREASURY_IPO_<eventId>`).
    *   **Netting & Alokasi**: Untuk setiap pemesanan nasabah berstatus `submitted`, sistem menghitung jatah saham berdasarkan `allocationRatio` dibulatkan ke kelipatan `subscriptionLotSize`.
    *   **Double-Entry Alokasi**: 
        *   Mendebet saham dari akun Underwriter dan mengkreditkannya ke akun SRE investor.
        *   Mendebet kas dari RDN investor senilai total harga beli (`allocatedShares * offeringPrice`) dan mengkreditkannya ke RDN Underwriter.
    *   Status IPO beralih ke `allocation`.
4.  **List (Pencatatan Perdana)**:
    *   Mengubah status saham dari `prelisted` ke `listed` di tabel `listed_securities`.
    *   Menetapkan `ipoPrice`, `referencePrice`, dan `previousClose` saham baru ke harga penawaran IPO (`offeringPrice`).
    *   Membuka visualisasi estimasi nilai wajar awal agar dapat dibaca oleh bot trading.
5.  **Cancel (Pembatalan & Reversal)**:
    *   Jika IPO dibatalkan setelah alokasi, sistem melakukan pembalikan (*reversal*) mutasi otomatis: mendebet kembali saham SRE nasabah, mengembalikan dana RDN nasabah, serta melakukan penjurnalan balik di rekening Underwriter.

### C. Keandalan Pengiriman Data IPO (Transactional Outbox Pattern)
Guna menjamin data transaksi penting (alokasi saham, listing perdana, pembatalan/reversal) sampai ke webhook Mandala Sekuritas secara andal tanpa dipengaruhi oleh gangguan jaringan, BEI Service menerapkan **Transactional Outbox Pattern**:
1.  **Pencatatan Outbox**: Event IPO tidak dikirim secara synchronous ke Sekuritas dalam transaksi database utama. Sebaliknya, event dimasukkan ke tabel `ipo_lifecycle_outbox` (`status = 'pending'`) bersama dengan payload data dan `event_key` yang unik untuk menjamin idempotensi di sisi penerima.
2.  **Outbox Worker**: Latar belakang worker berjalan secara periodik setiap 5 detik (`startIpoOutboxWorker`). Worker memindai entri outbox berstatus `pending` atau `failed` yang jadwal `next_attempt_at` telah tiba.
3.  **Exponential Backoff Retry**: Jika pengiriman webhook mengalami kegagalan (misalnya karena server sekuritas down), worker akan menaikkan kolom `attempts`, merekam pesan error ke `last_error`, mengubah status menjadi `failed`, dan menjadwalkan ulang pengiriman menggunakan algoritma Exponential Backoff:
    $$\text{delay (detik)} = \min(300, \max(1, 2^{\min(\text{attempts}, 8)}))$$
    Hal ini mencegah membanjiri server sekuritas (*thundering herd*) saat sistem mereka sedang pulih.

### D. Bot Genesis Custody (`POST /v1/internal/bots/genesis-custody`)
Pada masa awal persiapan simulasi (genesis phase), sistem membutuhkan setup saldo kas dan saham awal untuk ratusan Automated Trading Bots. Proses ini difasilitasi oleh endpoint BEI secara idempotent:
*   **Keamanan Hashing**: Request wajib menyertakan `genesis_run_id` dan `payload_hash` (SHA-256 dari array akun bot). BEI menghitung ulang hash payload untuk mencocokkannya dengan `payload_hash` demi mencegah modifikasi data di perjalanan.
*   **Idempotency Record**: Sistem mencatat riwayat run di tabel `bot_genesis_custody_runs`. Jika terjadi retry pengiriman dengan `genesis_run_id` yang sama, BEI langsung mengembalikan respons run sukses sebelumnya tanpa memproses ulang mutasi saldo.
*   **Pencatatan Buku Besar**: Untuk setiap bot, BEI mendaftarkan akun kustodian baru (`custody_accounts`) dengan format ID investor unik, lalu mendistribusikan saldo awal saham SRE via ledger `ipo_allocation` dengan status `settled` secara langsung. Logika database dijalankan dalam satu transaction block (`BEGIN` ... `COMMIT`) dengan row-level lock (`FOR UPDATE`) untuk memastikan konsistensi mutlak.

---

## 9. Sistem Berita Emiten & Pengumuman (News & Announcement System)

BEI Service membedakan dua jenis umpan berita/informasi yang diterbitkan ke pasar:

### A. Pengumuman Resmi Emiten (`issuer_announcements`)
*   **Maksud**: Keterbukaan informasi resmi yang diterbitkan langsung oleh emiten terdaftar (seperti laporan keuangan tahunan, berita material direksi, jadwal RUPS, corporate action dividen/split, atau info IPO).
*   **Visibilitas**: Ditujukan untuk pemain/trader manusia dan broker Mandala Sekuritas sebagai dasar keputusan analisis fundamental manual.
*   **Endpoint Akses**: `GET /v1/announcements`. BEI memfilter pengumuman agar hanya menampilkan rilis dengan waktu `published_at` sebelum atau sama dengan waktu server saat ini (`published_at <= now()`).

### B. Simulator Berita Sentimen Bot (`news`)
*   **Maksud**: Simulator feed berita yang dirancang khusus untuk memandu Automated Trading Bots dalam merespons iklim pasar secara dinamis.
*   **Targeting & Filter**: Berita dapat ditargetkan secara spesifik ke emiten tertentu (`symbol` e.g. `MNDL`) atau sektor industri tertentu (`sector`). Filter emiten didukung lewat query parameter `?symbol=<CODE>` di endpoint `/v1/public/news` dan `/bot/news-module`.
*   **Atribut Sentimen & Intensitas**: Setiap berita simulator dibekali atribut `sentiment` (`very_negative`, `negative`, `neutral`, `positive`, `very_positive`) dan `intensity` (`low`, `medium`, `high`, `extreme`). Bot akan mem-parsing nilai sentimen dan intensitas ini sebagai pengali bobot saat mengajukan order book.
*   **Sesi Kadaluwarsa (`expiry_session`)**: Guna menyimulasikan relevansi berita, setiap rilis dibekali kolom `expiry_session`. Jika hari virtual aktif sesi saat ini telah melampaui `expiry_session`, berita tidak akan dikembalikan lagi pada umpan aktif bot/player agar bot tidak mengambil keputusan bias dari berita usang.
*   **Redis Broadcast**: Saat berita diterbitkan oleh admin (`POST /v1/news/:id/publish`), BEI langsung menyiarkan event `news_published` ke Redis Pub/Sub agar bot yang sedang berjalan secara asinkron dapat bereaksi secara real-time.

---

## 10. Keamanan, Otorisasi, dan Pengawasan Pasar

### A. Otorisasi Service-to-Service (`x-service-token`)
Semua endpoint (kecuali `/health`) dilindungi oleh otorisasi token di HTTP Header: `x-service-token: <token>`.
Token internal dikonfigurasi melalui variabel lingkungan `BEI_SERVICE_TOKENS` (format array JSON). Hak akses dibatasi menggunakan sistem scope:
*   **`admin:*`**: Otoritas penuh (Operator BEI) untuk CRUD data master, lelang, manipulasi aturan bursa, interupsi pasar, eksekusi IPO, dan aksi korporasi.
*   **`mats`**: Mengonsumsi scope `market:read, rules:read, broker:read, trade:capture, market-summary:write, session:write`.
*   **`sekuritas`**: Mengonsumsi scope `market:read, rules:read, broker:read, custody:read, custody:write, settlement:read, corporate-action:read, ipo:read, ipo:write, report:read`.
*   **`bot`**: Mengonsumsi scope `market:read, rules:read, corporate-action:read, ipo:read`.

### B. Pengawasan Pasar & Circuit Breaker (Surveillance Scan)
Sistem memiliki modul pemindaian aktivitas tidak wajar (`POST /v1/surveillance/scan/:sessionId`) yang dijalankan untuk mendeteksi potensi kecurangan atau volatilitas tidak terkendali:

1.  **Extreme Price Movement (Circuit Breaker per Saham)**:
    *   Jika perubahan harga transaksi terakhir (`last` atau `close`) saham dibandingkan dengan harga acuan (`reference_price`) bernilai $\ge 15\%$ (baik naik maupun turun):
        *   Memicu alert tipe `ara_or_extreme_gain` atau `arb_or_extreme_drop`.
        *   Tingkat keparahan (*severity*): Diatur `high` jika perubahan $\ge 25\%$, dan `medium` jika di bawahnya.
        *   **Auto Suspend**: BEI langsung menyuntikkan notasi khusus suspensi baru (`type = 'suspend'`) di tabel `special_notations` untuk menghentikan perdagangan saham tersebut.
        *   BEI mempublikasikan event `suspend_symbol` ke Redis Pub/Sub agar MATS segera membekukan order book saham tersebut secara real-time.
2.  **Unusual Volume**:
    *   Jika volume perdagangan suatu saham melampaui 3 kali lipat volume rata-rata historisnya (`averageVolume` di dalam `metadata`), sistem memicu alert tipe `unusual_volume` dengan tingkat keparahan `medium`.
3.  **Circuit Breaker (Market Halt - Penangguhan Seluruh Bursa)**:
    *   Sistem menghitung rata-rata perubahan harga dari seluruh saham aktif yang diperdagangkan pada sesi tersebut (`averageChange`).
    *   Jika rata-rata penurunan harga gabungan saham di bursa $\le -5\%$ (anjlok lebih dari 5%):
        *   Mengubah status sesi template aktif menjadi `halted` di tabel `session_templates`.
        *   Mempublikasikan event `market_halt` ke Redis Pub/Sub untuk menyuruh MATS menghentikan continuous matching di seluruh instrumen secara instan.
        *   Memicu alert tipe `market_halt_signal` dengan tingkat keparahan `high`.
4.  **Wash Trade Detection**:
    *   Mendeteksi jika ada transaksi matched di mana pembeli dan penjual memiliki identitas investor yang sama (`buy_investor_id = sell_investor_id`). Memicu alert tipe `wash_trade_signal` dengan tingkat keparahan `high`.
5.  **Bot Dominance Detection**:
    *   Mendeteksi jika jumlah transaksi yang melibatkan akun bot (`ILIKE 'bot%'`) pada suatu saham dalam satu sesi $\ge 10$ transaksi. Memicu alert tipe `bot_dominance` dengan tingkat keparahan `medium`.

### C. Kalkulasi Indeks MDX Real-Time
*   BEI menghitung nilai indeks gabungan pasar Mandala Exchange (MDX Index) secara real-time.
*   Saat trade capture masuk, BEI memicu `applyTradeDelta` untuk menghitung delta perubahan kapitalisasi pasar saham tersebut secara *in-memory* menggunakan Redis Pipeline.
*   Nilai indeks terbaru disiarkan langsung via Redis Pub/Sub channel `market_updates` agar dapat segera ditampilkan pada grafik live dashboard pemain tanpa membebani database utama PostgreSQL.

---

## 11. Rincian Konfigurasi Lingkungan (.env)

BEI Service dikonfigurasi melalui variabel lingkungan berikut:
*   `APP_ENV`: Status lingkungan aplikasi (`development` | `production`).
*   `PORT`: Port HTTP BEI Service (default: `4100`).
*   `HOST`: Host bind address (default: `0.0.0.0`).
*   `DATABASE_URL`: URI Database PostgreSQL BEI (default: `postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei`).
*   `REDIS_URL`: URL Server Redis untuk Pub/Sub dan in-memory cache (default: `redis://localhost:6379`).
*   `BEI_SERVICE_TOKENS`: Array JSON berisi daftar identitas nama, token rahasia, dan cakupan scope yang diizinkan.
*   `BEI_TO_SEKURITAS_TOKEN`: Token rahasia yang disertakan BEI saat mengirimkan callback webhook ke Sekuritas.
*   `SEKURITAS_SETTLEMENT_WEBHOOK_URL`: URL endpoint di server Sekuritas untuk menerima notifikasi penyelesaian transaksi.
*   `SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL`: URL endpoint di server Sekuritas untuk menerima daftar hak aksi korporasi.

---

## 12. Daftar Lengkap API Endpoints BEI Service

Semua endpoint administratif dan integrasi memiliki prefix `/v1` di awal jalurnya.

### A. Endpoint Master Data & Emiten
*   `POST /v1/issuers`: Membuat profil emiten baru.
*   `PATCH /v1/issuers/:id`: Mengubah profil emiten.
*   `GET /v1/issuers/:id`: Mendapatkan detail profil emiten.
*   `POST /v1/securities`: Mendaftarkan saham baru (Listed Security).
*   `PATCH /v1/securities/:symbol`: Mengubah parameter saham.
*   `POST /v1/securities/:symbol/notations`: Menambahkan notasi khusus pengawasan.
*   `POST /v1/securities/:symbol/suspend`: Menghentikan sementara perdagangan saham (Manual Suspend).
*   `POST /v1/securities/:symbol/resume`: Membuka status suspensi saham (Manual Resume).
*   `POST /v1/issuers/:issuerId/announcements`: Membuat pengumuman resmi keterbukaan emiten.

### B. Endpoint Aturan Dagang (Trading Rules) & Sesi
*   `POST /v1/rules/profiles`: Membuat profil kumpulan aturan perdagangan baru.
*   `POST /v1/rules/lot-sizes`: Menambahkan aturan lot size per instrumen.
*   `POST /v1/rules/tick-sizes`: Menambahkan aturan tick size bertingkat.
*   `POST /v1/rules/price-bands`: Menambahkan batas ARA/ARB bertingkat.
*   `POST /v1/rules/auto-rejections`: Menambahkan batasan volume order.
*   `POST /v1/sessions/templates`: Membuat template sesi perdagangan bursa baru.
*   `POST /v1/sessions/segments`: Menambahkan segmen durasi waktu ke template sesi.
*   `POST /v1/fee-schedules`: Membuat skema tarif biaya transaksi bursa & pajak baru.
*   `POST /v1/trading-halts`: Mengaktifkan/menonaktifkan suspensi pasar global (Circuit Breaker).
*   `GET /v1/public/fee-schedule`: Memperoleh skema tarif biaya transaksi yang aktif.

### C. Endpoint Pengelolaan Anggota Broker
*   `POST /v1/brokers`: Mendaftarkan broker baru sebagai anggota bursa.
*   `PATCH /v1/brokers/:code/status`: Mengubah status aktif broker (Active/Suspended/Inactive).
*   `GET /v1/brokers`: Menampilkan daftar seluruh broker anggota bursa.
*   `GET /v1/brokers/:code/validate`: Validasi keabsahan broker oleh Matching Engine.

### D. Endpoint Transaksi & Settlement (Penyelesaian)
*   `POST /v1/trades/capture`: Merekam transaksi matched resmi secara idempotent (MATS only).
*   `POST /v1/settlement/batches`: Membuat batch instruksi settlement (DVP/RVP) untuk sesi terpilih.
*   `POST /v1/settlement/batches/:id/process`: Mengeksekusi mutasi buku besar kustodian nasabah dalam batch settlement dan mengirim callback ke Sekuritas.
*   `GET /v1/settlement/session/:sessionId`: Memantau instruksi settlement dalam sesi perdagangan tertentu.
*   `GET /v1/custody/accounts/:brokerCode/:investorId/summary`: Sinkronisasi saldo kas RDN dan saham SRE nasabah.

### E. Endpoint IPO & Aksi Korporasi
*   `POST /v1/ipo-events`: Membuat draft event IPO baru.
*   `PATCH /v1/ipo-events/:id`: Mengubah draft/parameter IPO.
*   `POST /v1/ipo-events/:id/publish`: Mempublikasikan event IPO ke pasar (Bookbuilding / Subscription).
*   `GET /v1/ipo-events`: Mengambil daftar penawaran IPO publik.
*   `GET /v1/ipo-events/:id`: Mendapatkan detail IPO.
*   `POST /v1/ipo-events/:id/subscriptions`: Mengirimkan pemesanan saham IPO investor.
*   `POST /v1/ipo-events/:id/allocate`: Mengeksekusi penjatahan saham IPO dan netting kas investor.
*   `POST /v1/ipo-events/:id/list`: Resmi mendaftarkan saham IPO ke bursa (Listed).
*   `POST /v1/ipo-events/:id/cancel`: Membatalkan event IPO dan melakukan pembalikan (*reversal*) saldo teralokasi.
*   `POST /v1/corporate-actions`: Mendaftarkan event rencana aksi korporasi baru.
*   `POST /v1/corporate-actions/:id/process`: Mengeksekusi aksi korporasi (Stock Split, Reverse Split, Dividen, Saham Bonus, dll.) ke buku besar investor.
*   `POST /v1/internal/bots/genesis-custody`: Inisiasi saldo awal dan akun kustodian untuk Automated Trading Bots secara idempotent dan ter-hashing.

### F. Endpoint Fundamental Keuangan, Berita, & Fair Value Publik
*   `POST /v1/financial-reports`: Menginput data laporan keuangan emiten secara manual.
*   `POST /v1/financial-reports/generate`: Men-generate data historis laporan keuangan berdasarkan proyeksi skenario (bull/bear/neutral).
*   `GET /v1/issuers/:issuerId/financial-reports`: Melihat riwayat laporan keuangan emiten.
*   `GET /v1/public/securities/:symbol/fundamentals`: Akses data fundamental publik suatu saham.
*   `POST /v1/news`: Membuat draf berita baru.
*   `GET /v1/news`: Menampilkan daftar berita (admin view).
*   `PATCH /v1/news/:id`: Memperbarui konten berita.
*   `POST /v1/news/:id/publish`: Mempublikasikan berita agar dibaca publik & bot secara real-time via Pub/Sub.
*   `POST /v1/news/:id/archive`: Mengarsipkan berita yang kadaluwarsa.
*   `DELETE /v1/news/:id`: Menghapus draf berita.
*   `GET /v1/public/news`: Feed berita publik bagi investor & bot.
*   `GET /v1/public/fair-values`: Mendapatkan daftar nilai wajar saham yang terlihat oleh pemain (`visible_to_player = true`) pada sesi aktif.
*   `GET /v1/public/fair-values/:symbol`: Mendapatkan nilai wajar terbaru untuk simbol saham spesifik yang terlihat oleh pemain.

### G. Endpoint Khusus Bot (Di-mount tanpa prefix `/v1`)
*   `GET /bot/daftar-saham-aktif`: Mengambil daftar saham aktif lengkap dengan data emiten dan notasi khusus untuk bot.
*   `GET /bot/trading-rules`: Mengambil profil aturan lot size, tick size, dan price band untuk bot.
*   `GET /bot/fee-schedule`: Mengambil skema tarif biaya transaksi aktif untuk bot.
*   `GET /bot/session-state`: Mengambil status instance sesi perdagangan terupdate untuk bot.
*   `GET /bot/ipo-lifecycle`: Mengambil data IPO publik untuk bot.
*   `GET /bot/corporate-action-minimal`: Mengambil daftar rencana aksi korporasi yang aktif untuk bot.
*   `GET /bot/news-module`: Mengambil feed simulator berita terbitan bursa untuk bot.
*   `GET /bot/fair-value-module`: Mengambil daftar nilai wajar saham terbaru yang terdeteksi oleh bot (`visible_to_bot = true`).
*   `GET /bot/market-regime`: Mengambil status rezim pasar volatilitas makro terupdate untuk bot.
*   `GET /bot/liquidity-profile`: Mengambil daftar profil likuiditas saham untuk bot.
*   `POST /bot/admin/fair-value`: Menyeting atau memperbarui nilai wajar saham secara manual (menghasilkan versi baru) untuk bot & player.
*   `POST /bot/admin/market-regime`: Menyeting status market regime makro secara manual.

### H. Endpoint Surveillance, Pelaporan, & Rekonsiliasi
*   `POST /v1/surveillance/scan/:sessionId`: Menjalankan pemindaian pola manipulasi pasar (UMA, wash trade) pada sesi perdagangan terpilih.
*   `GET /v1/surveillance/alerts`: Melihat daftar peringatan hasil surveillance.
*   `GET /v1/reports/trades/:sessionId`: Mengunduh laporan transaksi bursa dalam satu sesi.
*   `GET /v1/reports/settlements/:sessionId`: Mengunduh laporan status penyelesaian batch.
*   `GET /v1/reports/fee-tax/:sessionId`: Mengunduh laporan fee transaksi dan pajak.
*   `GET /v1/reports/market-summary/:sessionId`: Mengunduh ringkasan pasar (OHLC, volume, gainers/losers).
*   `GET /v1/reports/corporate-actions`: Mengunduh laporan riwayat corporate actions.
*   `GET /v1/reports/custody-movements`: Mengunduh log mutasi buku besar kustodian.
*   `GET /v1/reconciliation/:brokerCode/:investorId`: Laporan posisi kas RDN & saham SRE resmi untuk rekonsiliasi sekuritas.

---

## 13. Panduan bagi Pengembang Layanan Baru (Developer Onboarding)

Bagi pengembang yang ingin membuat layanan broker baru, robot automated trading, atau tool audit eksternal:

1.  **Mintalah Token Kredensial**: Hubungi bursa untuk mendaftarkan nama layanan Anda ke variabel `BEI_SERVICE_TOKENS` guna memperoleh token HTTP header `x-service-token` dengan scope yang dibatasi (contoh: scope `market:read` jika hanya membaca data pasar publik).
2.  **Generate Tipe Data Terpusat**: Semua kontrak API didefinisikan secara terpusat di [openapi.yaml](file:///e:/_BELAJAR PROGRAMMING_/github/Mandala-Exchange/openapi.yaml). Jika Anda menggunakan TypeScript, selalu sinkronkan tipe data API bursa dengan mengeksekusi:
    ```bash
    npm run openapi:generate
    ```
3.  **Terapkan Logika Idempotensi**: BEI mewajibkan parameter `idempotency_key` pada setiap transaksi capture, penyerahan alokasi IPO, atau pengiriman instruksi saldo. Rancang algoritma pembentukan key yang unik (e.g. `ledger:<action>:<id>:<account>`) agar saat terjadi retry jaringan tidak menghasilkan data ganda.
4.  **Dengarkan Event Redis Pub/Sub**: Daripada melakukan polling REST API berulang kali yang membebani server, hubungkan koneksi Redis Anda ke server bursa dan daftarkan diri untuk mendengarkan (*subscribe*) channel `market_updates` guna menerima update harga MDX Index, perubahan status sesi, dan berita bursa secara real-time.
5.  **Patuhi Batasan Domain & Logika Double-Entry**: Jangan pernah memodifikasi tabel database kustodian secara tidak sah. BEI memvalidasi status saldo kas dan saham secara ketat. Pastikan setiap perpindahan dana dicatatkan dalam instruksi kliring RVP/DVP yang berpasangan (*double-entry*) agar lolos rekonsiliasi audit bursa.
