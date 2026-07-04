# BOT-v2 Service Boundary

Versi: 1.0
Tanggal: 2026-07-03
Status: Konsep final awal

## 1. Tujuan

Dokumen ini menjelaskan batas tanggung jawab BEI, MATS, Sekuritas, News & Fair Value, dan BOT-v2. Tujuannya agar implementasi tidak melebar dan tidak membuat shortcut yang merusak fairness simulasi.

## 2. Prinsip Boundary

1. BOT tidak boleh direct order ke MATS.
2. BOT tidak boleh direct mutation ke database BEI, MATS, atau Sekuritas.
3. BOT hanya submit order lewat Sekuritas.
4. MATS hanya matching engine dan market data source.
5. Sekuritas adalah source of truth untuk akun, saldo, posisi, order, reservation, settlement.
6. BEI adalah source of truth untuk emiten, rules, fee, session, IPO, corporate action, news, fair value, dan market regime.
7. News dan fair value saat ini menjadi module BEI/Admin, tetapi disiapkan agar nanti bisa dipisah menjadi service baru.

## 3. BEI Service

### 3.1 Tanggung jawab BEI

BEI bertanggung jawab atas:

1. Daftar saham aktif.
2. Trading rules.
3. Fee schedule.
4. Session template dan session instance.
5. IPO lifecycle.
6. Corporate action.
7. News atau announcement.
8. Fair value estimate.
9. Market regime.
10. Sector sentiment.
11. Liquidity profile per saham.
12. ARA/ARB rule.
13. Suspend/halt status.

### 3.2 News & Fair Value sebagai module BEI

Untuk MVP, News & Fair Value dibuat sebagai module di BEI.

Alasan:

1. Domain news dan fair value lebih dekat ke emiten dan bursa.
2. Implementasi lebih sederhana.
3. Admin BEI bisa mengelola news, fair value, sentiment, dan expiry di satu tempat.
4. Nanti bisa dipisah menjadi service sendiri jika sudah scalable.

### 3.3 Future extraction

Walaupun awalnya module BEI, desain datanya harus siap dipisah.

Artinya:

1. Gunakan ID yang stabil.
2. Gunakan API internal/public yang jelas.
3. Jangan terlalu bergantung pada database internal BEI.
4. Gunakan versioning pada fair value.
5. Gunakan published_at dan expiry pada news.

## 4. MATS Engine

### 4.1 Tanggung jawab MATS

MATS bertanggung jawab atas:

1. Order book.
2. Matching engine.
3. Opening auction.
4. Continuous trading.
5. Closing auction.
6. ARA/ARB enforcement.
7. Self-trade prevention jika diterapkan.
8. Market data.
9. Operational session state.

### 4.2 MATS tidak perlu tahu fair value

MATS tidak perlu mengetahui fair value, news sentiment, atau strategi BOT. MATS hanya menjalankan aturan market dan matching order.

MATS boleh mengetahui suspend/halt status dari BEI, tetapi bukan MATS yang menilai apakah news bagus atau buruk.

### 4.3 Tidak ada direct order dari BOT ke MATS

Order flow yang benar:

```text
BOT
  -> Sekuritas API
  -> Sekuritas validasi cash/position/rule
  -> MATS order gateway
  -> MATS matching
```

Order flow yang tidak boleh:

```text
BOT
  -> MATS langsung
```

## 5. Sekuritas Backend

### 5.1 Tanggung jawab Sekuritas

Sekuritas bertanggung jawab atas:

1. User account.
2. BOT account.
3. Cash.
4. Position.
5. Reservation.
6. Buying power.
7. Order API.
8. Order status.
9. Settlement.
10. Portfolio snapshot.
11. Account event stream.
12. IPO subscription dari player dan BOT.
13. BOT provisioning.
14. BOT token.
15. BOT genesis.

### 5.2 BOT sebagai akun khusus

BOT sebaiknya dibuat sebagai account type khusus:

```yaml
account_type: BOT
external_bot_id: noise-0001
email: noise-0001@bot.internal
email_verified: true
created_by: SYSTEM
```

BOT tidak perlu email verification manual, tetapi tetap ditandai jelas sebagai BOT.

### 5.3 Endpoint minimum untuk BOT

Endpoint internal yang disarankan:

```text
POST /api/v1/internal/bots/provision
POST /api/v1/internal/bots/tokens
POST /api/v1/internal/bots/genesis
POST /api/v1/internal/bots/portfolio-snapshot
GET  /api/v1/internal/bots/events/ws
GET  /api/v1/internal/bots/orders/by-client-order-id
```

Endpoint public atau investor yang juga dipakai BOT:

```text
POST /api/v1/orders
POST /api/v1/orders/:id/cancel
POST /api/v1/ipo-events/:id/subscriptions
```

BOT harus menggunakan endpoint order yang sama secara prinsip dengan player.

## 6. BOT-v2 Go Service

### 6.1 Tanggung jawab BOT-v2

BOT-v2 bertanggung jawab atas:

1. Registry bot.
2. Config bot.
3. Strategy execution.
4. Scheduler.
5. Market state cache.
6. Portfolio cache.
7. Order decision.
8. Order queue.
9. Order executor ke Sekuritas.
10. Decision log.
11. Bot lifecycle.
12. Bot bankruptcy state.
13. Admin control.

### 6.2 Data yang boleh disimpan BOT

BOT boleh menyimpan:

1. Bot config.
2. Strategy state.
3. Bot memory.
4. Market summary cache.
5. Portfolio cache hasil snapshot/event Sekuritas.
6. Decision log.
7. Simulation run metadata.
8. Bankrupt status.

BOT tidak boleh menjadi source of truth untuk saldo dan posisi. Saldo dan posisi resmi tetap milik Sekuritas.

## 7. News Schema

News harus punya intensity dan expiry.

Contoh schema:

```yaml
id: news-0001
symbol: MNDL
sector: finance
type: earnings_positive
title: Laba MNDL Naik Signifikan
body: Ringkasan berita untuk player dan BOT.
sentiment: positive
intensity: high
scope: symbol
published_at_session: 42
published_at_segment: pre_open
expires_at_session: 52
simulation_only: false
created_by: admin_bei
```

### 7.1 News type awal

```text
earnings_positive
earnings_negative
dividend_announcement
ex_dividend
rights_issue
stock_split
ipo_news
rumor_positive
rumor_negative
sector_positive
sector_negative
suspension
uma
management_issue
macro_positive
macro_negative
```

### 7.2 Intensity

```text
low
medium
high
extreme
```

### 7.3 Scope

```text
symbol
sector
market
```

## 8. Fair Value Schema

Fair value diinput manual oleh admin BEI untuk MVP.

Contoh schema:

```yaml
symbol: MNDL
fair_value: 1250
confidence: medium
method: admin_estimate
effective_from_session: 42
effective_until_session: 72
version: 3
notes: Fair value manual berdasarkan kondisi simulasi dan fundamental emiten.
visible_to_player: true
visible_to_bot: true
```

### 8.1 Fair value bukan harga pasti

Fair value adalah anchor. Fair value tidak boleh membuat semua bot bertindak rasional sempurna.

BOT yang sangat peduli fair value:

1. Value Investor.
2. Contrarian.
3. Market Maker sebagai anchor ringan.

BOT yang kurang peduli fair value:

1. Noise Trader.
2. Momentum Trader.
3. Index Tracker.

## 9. Market Regime Schema

Contoh schema:

```yaml
session_id: 42
global_regime: neutral
sector_regime:
  finance: mild_positive
  commodity: mild_negative
volatility_regime: normal
created_by: system_or_admin
```

Market regime tidak mengubah harga langsung. Market regime hanya mengubah kecenderungan bot dan player.

## 10. IPO Schema

IPO harus dapat dideteksi dinamis oleh BOT.

Contoh schema:

```yaml
ipo_event_id: ipo-0001
symbol: NEWC
company_name: New Company Tbk
status: subscription
offering_price: 200
fair_value_initial: 260
fair_value_confidence: low
ipo_hype_score: 88
ipo_archetype: hot_ipo
oversubscription_ratio: 15.2
float_ratio: low
sector_sentiment: positive
listing_sentiment: high
subscription_start_session: 40
subscription_end_session: 42
listing_session: 45
```

### 10.1 IPO status

```text
draft
bookbuilding
subscription
allocation
listed
cancelled
```

### 10.2 IPO archetype

```text
hot_ipo
normal_ipo
overpriced_ipo
quiet_ipo
failed_hype_ipo
```

## 11. Admin Control Minimum

Untuk MVP, admin cukup bisa:

1. Create/edit news.
2. Set news intensity.
3. Set news expiry.
4. Create/edit fair value.
5. Set market regime.
6. Set sector sentiment.
7. Create/edit IPO metadata.
8. Set IPO hype score.
9. Provision bot.
10. Run genesis bot.
11. Pause/resume bot group.
12. View bankrupt bot.
13. View decision log summary.
14. View order error summary.
15. Start/stop BOT service.

## 12. Public Fairness Rule

Jika BOT menggunakan sebuah data untuk membuat keputusan, maka player minimal harus bisa melihat versi publik dari data tersebut.

Data yang harus public:

1. Published news.
2. Fair value estimate.
3. IPO status.
4. IPO hype label atau informasi yang mewakili hype.
5. Session status.
6. Trading rules.
7. Suspend/halt status.

Data yang tidak boleh diberikan ke BOT:

1. Future news.
2. Draft news yang belum published.
3. Portfolio player.
4. Pending order private player.
5. Identitas player yang melakukan order.
6. Rencana admin yang belum public.
