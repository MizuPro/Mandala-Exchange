# BOT-v2 Concept - Agent-Based Simulation Mandala Exchange

Versi: 1.0
Tanggal: 2026-07-03
Status: Konsep final awal

## 1. Ringkasan

BOT-v2 adalah sistem bot baru untuk Mandala Exchange yang menggunakan pendekatan Agent-Based Simulation. BOT-v2 tidak dirancang sebagai AI trading bot yang sempurna, tetapi sebagai simulasi populasi investor yang memiliki perilaku berbeda-beda.

Setiap bot adalah agent yang memiliki:

1. Identitas akun.
2. Modal.
3. Portfolio.
4. Strategi.
5. Risk limit.
6. Memory lintas sesi.
7. Reaksi terhadap news, fair value, market regime, IPO, dan kondisi order book.

BOT-v2 bertugas membuat pasar terasa hidup ketika jumlah player manusia masih sedikit. Namun, BOT-v2 tidak boleh membuat market menjadi tidak natural, misalnya semua saham selalu ARA atau ARB setiap session.

## 2. Definisi Agent-Based Simulation

BOT-v2 dapat disebut Agent-Based Simulation karena memenuhi prinsip berikut:

1. Agent memiliki state masing-masing.
2. Agent memiliki policy atau strategi sendiri.
3. Agent membaca environment pasar.
4. Agent mengambil keputusan buy, sell, cancel, atau hold.
5. Keputusan agent masuk ke order book melalui jalur resmi.
6. Perubahan order book memengaruhi agent lain.
7. Harga dan volume muncul dari interaksi banyak agent dan player, bukan dari controller yang mengatur harga langsung.

Go language cocok digunakan karena BOT-v2 lebih banyak membutuhkan concurrency, scheduler, WebSocket, HTTP client, queue, rate limiter, dan in-memory state. Python populer untuk riset, tetapi Go lebih cocok untuk service runtime yang harus hidup bersama BEI, MATS, dan Sekuritas.

## 3. Prinsip Desain Utama

### 3.1 Bot setara dengan player

BOT harus diperlakukan seperti investor biasa. BOT tidak boleh memiliki privilege trading khusus.

BOT boleh:

1. Membaca market data publik.
2. Membaca news publik.
3. Membaca fair value publik.
4. Membuat order melalui Sekuritas.
5. Mendapat event akun dari Sekuritas.

BOT tidak boleh:

1. Direct order ke MATS.
2. Direct update saldo atau posisi.
3. Membaca portfolio player.
4. Membaca pending order player.
5. Mengetahui future news.
6. Mengabaikan fee, lot size, ARA/ARB, session rule, atau settlement.

### 3.2 News tidak mengubah harga langsung

News hanya mengubah sentiment dan persepsi bot/player. Harga tetap berubah karena order yang masuk dan matching di MATS.

Alur yang benar:

```text
Admin BEI membuat news
BEI publish news
Player dan BOT melihat news
BOT dan player bereaksi
Order masuk lewat Sekuritas
MATS melakukan matching
Harga bergerak karena transaksi
```

Alur yang tidak boleh:

```text
Admin BEI membuat news
Sistem langsung menaikkan harga
```

### 3.3 ARA/ARB bukan default

ARA dan ARB harus menjadi output dari kondisi ekstrem, bukan kejadian normal setiap session.

Saham boleh mendekati ARA atau ARB jika ada kombinasi faktor:

1. News sangat kuat.
2. Sentiment sangat positif atau negatif.
3. Volume meningkat.
4. Trade frequency meningkat.
5. Order imbalance kuat.
6. Momentum bertahan.
7. Liquidity cukup atau sangat tipis, tergantung kondisi.
8. IPO hype tinggi.
9. Bandar sedang aktif.
10. Market regime mendukung.

## 4. Arsitektur Umum

```text
BEI Service
  - Securities
  - Session
  - Rules
  - Fee Schedule
  - IPO
  - Corporate Action
  - News
  - Fair Value
  - Market Regime

MATS Engine
  - Order Book
  - Matching
  - Auction
  - Continuous Trading
  - Market Data
  - ARA/ARB enforcement
  - Session operational state

Sekuritas Backend
  - Account
  - Cash
  - Position
  - Reservation
  - Order API
  - Settlement
  - BOT provisioning
  - BOT token
  - BOT snapshot
  - BOT event stream

BOT-v2 Go Service
  - Agent Registry
  - Market State Cache
  - Portfolio Cache
  - Strategy Engine
  - Scheduler
  - Order Queue
  - Order Executor to Sekuritas
  - Decision Log
  - Admin Control
```

## 5. Session System

Sistem saat ini memiliki total 1 session selama 300 detik atau 5 menit.

| Segment | Durasi | Order BOT |
|---|---:|---|
| pre_open | 3 detik | Tidak boleh |
| opening_auction | 27 detik | Boleh |
| continuous | 210 detik | Boleh |
| pre_close | 3 detik | Tidak boleh |
| non_cancellation | 5 detik | Tidak boleh cancel/amend, order mengikuti rule market jika diizinkan sistem |
| closing_auction | 27 detik | Boleh |
| post_closing | 10 detik | Tidak boleh |
| closed | 15 detik | Tidak boleh |

Keputusan final: BOT hanya boleh mengirim order pada opening auction, continuous, dan closing auction. Tidak ada order di luar auction dan continuous.

## 6. Perilaku per Segment

### 6.1 pre_open

Digunakan untuk persiapan:

1. Load market snapshot.
2. Load news dan fair value.
3. Load session state.
4. Load portfolio state.
5. Set intent awal.

BOT tidak mengirim order pada segment ini.

### 6.2 opening_auction

Auction pembukaan berlangsung 27 detik. Tidak semua bot boleh aktif agresif di sini.

Bot yang lebih relevan:

1. Event-Driven.
2. IPO Hunter.
3. Market Maker tertentu.
4. Momentum jika ada news/IPO kuat.
5. Noise Trader dalam jumlah kecil.

Rekomendasi:

```text
hanya 10% sampai 25% bot aktif yang boleh mempertimbangkan order opening auction
```

### 6.3 continuous

Continuous adalah pusat aktivitas BOT. Semua strategi boleh berjalan di segment ini.

Rekomendasi interval evaluasi untuk session 5 menit:

| Bot | Interval evaluasi awal |
|---|---:|
| Noise Trader | 30 sampai 90 detik |
| Momentum Trader | 10 sampai 30 detik, dengan confirmation |
| Contrarian | 30 sampai 90 detik |
| Market Maker | 10 sampai 25 detik |
| Value Investor | 1 sampai 2 kali per session |
| Event-Driven | 3 sampai 30 detik setelah news, tergantung intensity |
| Index Tracker | Saat rebalance atau akhir session |
| Bandar | 0 sampai 2 keputusan besar per session |

### 6.4 pre_close

Digunakan untuk persiapan closing auction:

1. Hitung PnL.
2. Cek exposure.
3. Cek open order.
4. Tentukan apakah perlu ikut closing auction.

BOT tidak mengirim order pada segment ini.

### 6.5 non_cancellation

Pada segment ini, BOT tidak boleh cancel atau amend. Jika ada risk cancel, request ditunda atau ditandai sebagai deferred sesuai aturan market.

### 6.6 closing_auction

Bot yang relevan:

1. Market Maker.
2. Index Tracker.
3. Value Investor.
4. Bandar tertentu.
5. Event-Driven jika news muncul mendekati penutupan.
6. Noise Trader dalam jumlah kecil.

Closing auction tidak boleh dibuat terlalu ramai agar close price tidak terlalu sering ekstrem.

### 6.7 post_closing dan closed

Digunakan untuk:

1. Update memory.
2. Update session summary.
3. Decay news impact.
4. Update bot PnL.
5. Cek bot bankrupt.
6. Rotasi active bot.
7. Persiapan session berikutnya.

## 7. Market Regime

Market regime dipakai sebagai konteks umum session. Default paling sering adalah neutral.

Rekomendasi distribusi normal:

| Regime | Probabilitas default |
|---|---:|
| neutral | 65% |
| mild_positive | 12.5% |
| mild_negative | 12.5% |
| strong_positive | 3.5% |
| strong_negative | 3.5% |
| event_driven | 3% |
| panic | 0% default, hanya scenario |

Market regime memengaruhi probabilitas dan agresivitas bot, tetapi tidak langsung mengubah harga.

## 8. Saham Awal dan Scaling

Saat ini BEI memiliki 3 seed saham:

1. MNDL.
2. NUSA.
3. BARA.

Rekomendasi jumlah bot aktif berdasarkan jumlah saham:

| Jumlah saham | Bot aktif normal |
|---:|---:|
| 3 saham | 50 sampai 100 bot |
| 10 saham | 100 sampai 250 bot |
| 20 saham | 300 sampai 500 bot |
| 50 saham | 500 sampai 1000 bot, setelah performance test |
| 100 saham | 1000 sampai 2000 bot, hanya jika sistem kuat |

2000 bot sebaiknya dianggap sebagai registered bot atau stress test, bukan default runtime awal.

## 9. Liquidity Profile per Saham

Setiap saham harus memiliki karakter agar market tidak terasa datar.

Field yang disarankan:

```yaml
symbol: MNDL
sector: finance
liquidity_level: high
volatility_level: medium
retail_interest: medium
institutional_interest: high
typical_spread_level: low
typical_volume_level: high
ipo_status: listed
```

Contoh karakter awal:

| Symbol | Karakter awal |
|---|---|
| MNDL | Saham utama, lebih likuid, relatif stabil |
| NUSA | Medium liquidity, responsif ke news |
| BARA | Commodity/cyclical, lebih volatile |

## 10. Memory Lintas Sesi

Karena 1 session hanya 5 menit, memory bot sebaiknya tidak terlalu pendek.

Rekomendasi:

| Memory | Jumlah session | Fungsi |
|---|---:|---|
| short memory | 5 session | FOMO, panic, recent ARA/ARB |
| medium memory | 20 session | trend, volume spike, failed breakout |
| long memory | 60 session | fair value deviation, bandar accumulation, IPO cooling period |

Memory yang disimpan adalah ringkasan, bukan raw event.

Contoh symbol session summary:

```yaml
symbol: MNDL
session_id: 42
open: 1000
high: 1100
low: 980
close: 1080
volume: 125000
trade_count: 320
return_pct: 0.08
ara_hit: false
arb_hit: false
news_impact_score: 0.7
fair_value_at_session: 1200
avg_spread: 2
avg_depth: 5000
```

## 11. Kriteria Market Bagus

Market dianggap bagus jika:

1. Order book tidak kosong.
2. Spread masih wajar.
3. Volume ada.
4. Tidak semua saham ARA/ARB.
5. Tidak ada cash minus.
6. Tidak ada saham minus.
7. Order reject bot rendah.
8. Player bisa beli dan jual tanpa market mati.
9. Pergerakan besar terjadi karena katalis kuat.
10. News kecil tidak langsung membuat market ekstrem.
11. IPO hype terasa, tetapi tidak selalu punya pola yang sama.
12. Bot bisa rugi, nyangkut, dan bangkrut.
