# BOT-v2 Agent Behavior Specification

Versi: 1.0
Tanggal: 2026-07-03
Status: Konsep final awal

## 1. Tujuan

Dokumen ini menjelaskan perilaku agent BOT-v2, termasuk jenis bot, komposisi populasi, distribusi modal, reaksi terhadap news, fair value, IPO, ARA/ARB, session, dan bankruptcy.

## 2. Komposisi Populasi Final

Komposisi default BOT-v2:

| Jenis Bot | Persentase |
|---|---:|
| Noise Trader | 32% |
| Momentum Trader | 18% |
| Contrarian / Dip Buyer | 14% |
| Market Maker | 8% |
| Value Investor | 8% |
| Event-Driven / IPO Hunter | 12% |
| Index Tracker | 4% |
| Bandar | 4% |

Catatan penting:

1. Event-Driven dinaikkan ke 12% agar news dan IPO terasa.
2. Event-Driven tetap bukan satu-satunya bot yang merespon news.
3. Event-Driven adalah first responder.
4. Bot lain adalah secondary responder.
5. Bandar 4% bukan berarti semua Bandar agresif setiap session.

## 3. Contoh Jumlah Bot Aktif

### 3.1 Jika 100 bot aktif

| Jenis Bot | Jumlah |
|---|---:|
| Noise Trader | 32 |
| Momentum Trader | 18 |
| Contrarian | 14 |
| Market Maker | 8 |
| Value Investor | 8 |
| Event-Driven / IPO Hunter | 12 |
| Index Tracker | 4 |
| Bandar | 4 |

### 3.2 Jika 500 bot aktif

| Jenis Bot | Jumlah |
|---|---:|
| Noise Trader | 160 |
| Momentum Trader | 90 |
| Contrarian | 70 |
| Market Maker | 40 |
| Value Investor | 40 |
| Event-Driven / IPO Hunter | 60 |
| Index Tracker | 20 |
| Bandar | 20 |

Namun, untuk 3 saham awal, 500 bot terlalu banyak. Gunakan 50 sampai 100 bot dulu.

## 4. Distribusi Modal

Persentase jumlah bot tidak sama dengan kekuatan modal. Noise Trader banyak, tetapi modal kecil. Institusi dan Bandar sedikit, tetapi modal besar.

Rekomendasi modal awal:

| Jenis Bot | Modal awal rekomendasi |
|---|---:|
| Noise Trader | Rp1 juta sampai Rp25 juta |
| Momentum Trader | Rp5 juta sampai Rp75 juta |
| Contrarian | Rp10 juta sampai Rp150 juta |
| Event-Driven / IPO Hunter | Rp10 juta sampai Rp250 juta |
| Market Maker | Rp250 juta sampai Rp2 miliar |
| Value Investor | Rp100 juta sampai Rp1 miliar |
| Index Tracker | Rp250 juta sampai Rp3 miliar |
| Bandar | Rp1 miliar sampai Rp10 miliar |

Catatan:

1. Angka dapat disesuaikan dengan skala ekonomi Mandala Exchange.
2. Jangan membuat semua bot punya modal rata.
3. Noise Trader tidak boleh terlalu dominan secara nilai transaksi.
4. Bandar dan Market Maker harus punya risk limit agar tidak merusak market.

## 5. Inactive Rate per Session

Tidak semua bot aktif setiap session.

Rekomendasi inactive rate:

| Jenis Bot | Inactive rate per session |
|---|---:|
| Noise Trader | 10% sampai 25% |
| Momentum Trader | 5% sampai 15% |
| Contrarian | 10% sampai 20% |
| Market Maker | 0% sampai 10%, tergantung coverage |
| Value Investor | 30% sampai 60% |
| Event-Driven / IPO Hunter | 10% sampai 30%, kecuali ada event |
| Index Tracker | 70% sampai 95%, kecuali rebalance |
| Bandar | 50% sampai 80% tidak agresif |

## 6. Reaksi Bot terhadap News

Semua bot aware terhadap news, tetapi tidak semua bereaksi langsung.

| Jenis Bot | Reaksi terhadap news |
|---|---|
| Noise Trader | Bereaksi dangkal ke headline, sentiment, dan hype |
| Momentum Trader | Menunggu harga dan volume confirm |
| Contrarian | Menunggu harga ekstrem, sering melawan euforia atau panic |
| Market Maker | Mengubah spread, size, dan kadang withdraw |
| Value Investor | Menilai apakah news mengubah fair value |
| Event-Driven / IPO Hunter | First responder, paling cepat bereaksi |
| Index Tracker | Hampir tidak peduli news kecuali berdampak ke indeks |
| Bandar | Memanfaatkan news sesuai fase akumulasi, markup, atau distribusi |

## 7. News Intensity Response

News harus punya intensity.

### 7.1 Low news

Efek:

1. Event-Driven kecil mungkin bereaksi.
2. Noise hampir tidak berubah.
3. Momentum menunggu price action.
4. Market tidak boleh bergerak ekstrem.

Reaksi estimasi:

```text
Event-Driven reaction: 20% sampai 30%
Noise reaction: 0% sampai 5%
Momentum: hanya jika harga bergerak
```

### 7.2 Medium news

Efek:

1. Event-Driven cukup aktif.
2. Noise sedikit terpengaruh.
3. Momentum menunggu confirmation.
4. Harga bisa bergerak wajar.

Reaksi estimasi:

```text
Event-Driven reaction: 40% sampai 60%
Noise reaction: 5% sampai 10%
Momentum: menunggu confirmation
```

### 7.3 High news

Efek:

1. Event-Driven kuat.
2. Noise FOMO meningkat.
3. Momentum lebih mudah confirm.
4. Market Maker spread melebar.
5. Harga bisa bergerak kuat.

Reaksi estimasi:

```text
Event-Driven reaction: 70% sampai 85%
Noise reaction: 10% sampai 25%
Momentum: aktif jika volume confirm
```

### 7.4 Extreme news

Efek:

1. Banyak bot sadar event ini penting.
2. Event-Driven sangat aktif.
3. Noise bisa FOMO atau panic.
4. Momentum lebih cepat confirm.
5. Contrarian dan Value mulai jadi rem jika harga terlalu ekstrem.
6. ARA/ARB mungkin terjadi jika faktor lain mendukung.

Reaksi estimasi:

```text
Event-Driven reaction: 80% sampai 95%
Noise reaction: 20% sampai 40%
Momentum: lebih cepat confirm
```

## 8. Reaksi Bot terhadap Fair Value

Fair value dapat dilihat player dan bot. Namun, fair value tidak boleh membuat semua bot menjadi terlalu rasional.

| Jenis Bot | Respon terhadap fair value |
|---|---|
| Noise Trader | Hampir tidak peduli, hanya risk filter kecil |
| Momentum Trader | Tidak jadi trigger utama, hanya mengurangi agresivitas jika harga terlalu premium |
| Contrarian | Cukup peduli, beli saat harga jauh di bawah fair value |
| Market Maker | Pakai sebagai anchor mid-price jangka panjang |
| Value Investor | Paling peduli, beli diskon dan jual premium |
| Event-Driven | Peduli jika news mengubah fair value |
| Index Tracker | Hampir tidak peduli |
| Bandar | Pakai sebagai area strategi akumulasi, markup, dan distribusi |

## 9. Rule Fair Value per Bot

### 9.1 Noise Trader

Noise tidak memahami valuasi secara serius. Namun, jika harga terlalu jauh dari fair value, peluang beli turun.

```text
price <= fair_value * 1.2:
  normal

price > fair_value * 1.5:
  buy probability turun

price > fair_value * 2.0:
  hanya FOMO kecil yang masih mungkin beli
```

### 9.2 Momentum Trader

Momentum tetap fokus pada price action, tetapi fair value menjadi rem.

```text
price_to_fair_value <= 1.3:
  momentum normal

1.3 < price_to_fair_value <= 1.8:
  size dikurangi

price_to_fair_value > 1.8:
  hanya masuk jika news high/extreme dan volume kuat
```

### 9.3 Contrarian

Contrarian mulai tertarik ketika harga jauh di bawah fair value.

```text
price < fair_value * 0.85:
  mulai tertarik

price < fair_value * 0.70:
  akumulasi bertahap

price < fair_value * 0.50:
  tertarik besar, kecuali news fundamental buruk
```

### 9.4 Market Maker

Market Maker memakai fair value sebagai anchor, bukan harga wajib.

```text
harga dekat fair value:
  spread normal

harga jauh dari fair value:
  spread melebar

volatilitas tinggi:
  quote size turun

news extreme:
  bisa withdraw sementara
```

### 9.5 Value Investor

Value Investor memakai fair value sebagai dasar utama.

```text
buy jika market_price < fair_value * (1 - margin_of_safety)
sell jika market_price > fair_value * (1 + sell_premium)
```

Contoh:

```text
fair_value = 1000
margin_of_safety = 15%
sell_premium = 20%

buy jika harga < 850
sell jika harga > 1200
```

### 9.6 Event-Driven

Event-Driven bereaksi jika news mengubah fair value.

```text
fair value naik setelah news:
  bias bullish

fair value turun setelah news:
  bias bearish
```

### 9.7 Index Tracker

Index Tracker hanya peduli komposisi indeks dan bobot. Fair value bukan trigger utama.

### 9.8 Bandar

Bandar memakai fair value sebagai zona strategi.

```text
harga di bawah fair value:
  area akumulasi lebih aman

harga dekat fair value:
  bisa markup jika sentiment mendukung

harga jauh di atas fair value:
  mulai distribusi, bukan terus beli
```

## 10. IPO Behavior

IPO harus terdeteksi dinamis. BOT tidak hardcode daftar saham IPO.

Alur:

```text
BEI membuat IPO event
Sekuritas menampilkan IPO ke player
BOT membaca IPO event publik
IPO Hunter/Event-Driven bisa subscribe lewat Sekuritas
Saat listed, saham masuk listed securities
Bot lain mulai melihat saham tersebut sesuai universe filter
```

## 11. IPO Hype Score

IPO memiliki `ipo_hype_score` 0 sampai 100.

| Score | Interpretasi | Dampak |
|---:|---|---|
| 85 sampai 100 | hot IPO | Peluang ARA tinggi |
| 70 sampai 84 | bullish IPO | Peluang naik kuat |
| 50 sampai 69 | normal IPO | Price discovery normal |
| 30 sampai 49 | weak IPO | Bisa flat atau turun |
| 0 sampai 29 | bad IPO | Risiko turun tinggi |

IPO dengan score tinggi boleh punya peluang ARA cukup tinggi, tetapi tidak boleh selalu punya pola yang sama.

## 12. IPO Archetype

```text
hot_ipo
normal_ipo
overpriced_ipo
quiet_ipo
failed_hype_ipo
```

### 12.1 hot_ipo

Ciri:

1. Hype tinggi.
2. Oversubscription tinggi.
3. Float kecil.
4. Sector sentiment bagus.
5. Listing sentiment kuat.

Dampak:

1. Peluang ARA tinggi.
2. Event-Driven dan Noise lebih tertarik.
3. Momentum lebih cepat confirm.
4. Market Maker spread melebar.

### 12.2 normal_ipo

Ciri:

1. Hype sedang.
2. Demand cukup.
3. Sentiment normal.

Dampak:

1. Bisa naik wajar.
2. Belum tentu ARA.
3. Price discovery lebih seimbang.

### 12.3 overpriced_ipo

Ciri:

1. Harga IPO terlalu mahal.
2. Fair value confidence rendah.
3. Hype bisa ada, tetapi rawan gagal.

Dampak:

1. Awal bisa ramai.
2. Setelah itu bisa melemah.
3. Value Investor cenderung tidak masuk.

### 12.4 quiet_ipo

Ciri:

1. Hype rendah.
2. Volume kecil.
3. Tidak banyak perhatian.

Dampak:

1. Sideways.
2. Volume kecil.
3. Tidak ARA kecuali ada katalis tambahan.

### 12.5 failed_hype_ipo

Ciri:

1. Hype awal ada.
2. Listing mengecewakan.
3. Demand tidak cukup.

Dampak:

1. Bisa turun.
2. Noise yang FOMO bisa rugi.
3. Contrarian menunggu diskon lebih dalam.

## 13. IPO Attention Boost

Saat saham baru IPO/listed, saham itu masuk radar banyak bot, bukan cuma Event-Driven.

| Bot | IPO response |
|---|---|
| Event-Driven / IPO Hunter | Pantau sejak subscription sampai listing |
| Noise Trader | Sebagian tertarik karena saham baru |
| Momentum Trader | Masuk jika listing day volume dan harga confirm |
| Market Maker | Quote dengan spread lebih lebar |
| Value Investor | Hati-hati karena fair value confidence rendah |
| Contrarian | Biasanya tunggu pullback |
| Bandar | Observasi, bisa akumulasi jika hype dan liquidity cocok |
| Index Tracker | Tidak peduli kecuali masuk indeks |

## 14. ARA/ARB Guardrail

ARA/ARB tidak boleh terlalu sering. ARA/ARB hanya boleh muncul dari kombinasi faktor.

Faktor positif untuk ARA:

1. News high atau extreme positive.
2. IPO hype tinggi.
3. Market regime positive.
4. Sector sentiment positive.
5. Volume meningkat.
6. Trade frequency meningkat.
7. Bid pressure kuat.
8. Momentum bertahan.
9. Float kecil.
10. Bandar aktif.

Faktor positif untuk ARB:

1. News high atau extreme negative.
2. Market regime negative.
3. Sector sentiment negative.
4. Sell pressure kuat.
5. Panic scenario.
6. Market Maker withdraw.
7. Value Investor tidak mau masuk karena fundamental rusak.
8. Momentum breakdown confirm.

## 15. Anti Pump and Dump Exploit

Player boleh mencoba memompa saham, tetapi tidak boleh pasti menang.

BOT hanya boleh bereaksi ke data publik:

1. Price.
2. Volume.
3. Trade frequency.
4. Order book depth.
5. Spread.
6. Published news.
7. Public sentiment.

BOT tidak boleh tahu:

1. Identitas player yang membeli.
2. Niat player.
3. Portfolio player.
4. Future order player.

Guardrail:

1. Satu order besar tidak cukup memicu semua bot.
2. Momentum butuh confirmation.
3. Noise punya FOMO probability curve.
4. Fair value menjadi rem jika harga terlalu premium.
5. Contrarian dan Value bisa melawan euforia.
6. Market Maker bisa widen atau withdraw.
7. Bandar lain bisa ikut distribusi.

## 16. FOMO Probability Curve

Noise Trader dan sebagian Momentum tidak boleh semakin agresif tanpa batas saat harga naik.

Contoh:

```text
return 1% sampai 5%:
  FOMO naik

return 5% sampai 10%:
  FOMO tinggi

return 10% sampai 20%:
  FOMO mulai dibatasi

hampir ARA:
  sebagian FOMO, sebagian takut

ARA 2 session berturut:
  FOMO turun besar
```

## 17. Bot Bankruptcy

Bot boleh rugi dan bangkrut.

Status lifecycle sederhana:

```text
active -> distressed -> bankrupt
```

### 17.1 Distressed

Bot masuk distressed jika:

1. Cash sangat kecil.
2. Portfolio rugi besar.
3. Tidak bisa membeli 1 lot saham termurah.
4. Masih punya saham, pending, atau open order.

Distressed bot masih bisa ikut session tertentu, tetapi lebih pasif.

### 17.2 Bankrupt

Bot masuk bankrupt jika:

1. Cash terlalu kecil.
2. Tidak punya saham available.
3. Tidak punya pending settlement.
4. Tidak punya open order.
5. Net worth di bawah minimum threshold.

Contoh:

```text
cash < harga minimum 1 lot termurah
positions kosong
open_orders kosong
pending kosong
```

Bot bankrupt:

1. Tidak ikut bermain lagi.
2. Tetap tampil di admin panel BOT.
3. Bisa dianalisis performance-nya.
4. Bisa di-recover hanya lewat admin action khusus jika fitur itu nanti dibuat.

Admin panel menampilkan:

1. Bot ID.
2. Strategy.
3. Initial cash.
4. Final cash.
5. Final portfolio.
6. Realized PnL.
7. Unrealized PnL.
8. Bankrupt session.
9. Reason.

## 18. Order Type untuk MVP

Untuk MVP, BOT sebaiknya hanya memakai limit order.

Alasan:

1. Lebih aman.
2. Tidak terlalu agresif.
3. Mengurangi risiko bot sweep order book terlalu brutal.
4. Lebih cocok untuk session 5 menit.

Market order bisa dipertimbangkan nanti, tetapi harus sangat dibatasi.

## 19. Max Order per Bot per Session

Untuk 3 saham awal:

| Bot | Max order per session |
|---|---:|
| Noise Trader | 0 sampai 2 |
| Momentum Trader | 0 sampai 3 |
| Contrarian | 0 sampai 2 |
| Market Maker | 2 sampai 8 quote refresh, tergantung rule |
| Value Investor | 0 sampai 1 |
| Event-Driven / IPO Hunter | 0 sampai 3 saat ada event |
| Index Tracker | 0 sampai 1, kecuali rebalance |
| Bandar | 0 sampai 2 keputusan besar |

Nilai ini bisa dinaikkan setelah jumlah saham bertambah dan performance test lulus.
