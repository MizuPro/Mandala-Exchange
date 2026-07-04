# BOT-v2 Fase 4 Implementation Plan

Versi: 1.0  
Tanggal: 2026-07-04  
Status: Siap dieksekusi bertahap

## 1. Tujuan

Dokumen ini menjabarkan implementasi Fase 4 dari
`BOT_V2_IMPLEMENTATION_PLAN.md` menjadi subfase yang dapat dikerjakan dan
divalidasi secara terpisah.

Target akhir Fase 4:

1. Menjalankan 50 sampai 100 bot pada MNDL, NUSA, dan BARA.
2. Membuat market hidup tanpa menghasilkan aktivitas yang terlalu padat.
3. Menambahkan strategi sederhana selain Noise Trader.
4. Membuat order setiap bot tersebar secara natural.
5. Membuktikan news medium dan high menghasilkan reaksi yang berbeda.
6. Menjaga correctness cash, position, reservation, session, dan order.

## 2. Prinsip Implementasi

1. Selesaikan satu subfase dan seluruh test-nya sebelum lanjut.
2. Mulai dari 20 bot campuran, kemudian 50 bot, lalu 100 bot.
3. Seluruh order, cancel, dan amend tetap melalui Sekuritas.
4. BOT hanya menggunakan data publik dari BEI dan MATS.
5. Gunakan satu scheduler global, bukan goroutine per bot-symbol.
6. Semua strategi memakai shared risk dan trading-rule layer.
7. Limit order tetap menjadi default Fase 4.
8. Parameter strategi harus configurable dan deterministic saat testing.
9. Market realism tidak boleh mengorbankan accounting correctness.
10. IPO subscription dan dynamic discovery tetap dikerjakan pada Fase 5.

## 3. Prasyarat

Fase 4 tidak dimulai sebelum kondisi berikut terpenuhi:

- [x] Segment session berjalan lengkap selama 300 detik.
- [x] Urutan `post_closing -> closed -> pre_open` benar.
- [x] Segment `closed` berjalan selama 15 detik.
- [x] BOT tidak order di segment terlarang.
- [x] Buy, sell, partial fill, fill, expiry, dan settlement bekerja.
- [x] Tick-size dan price-band selalu valid.
- [x] Account event tidak direplay dari sequence nol.
- [x] Maksimal order per bot menggunakan session instance ID.
- [x] Tidak ada cash atau position minus.
- [x] Restart BOT tidak merusak state.

## 4. Target Populasi

### 4.1 Komposisi 50 bot

| Strategi | Jumlah |
|---|---:|
| Noise Trader | 16 |
| Momentum Trader | 9 |
| Contrarian | 7 |
| Market Maker | 4 |
| Value Investor | 4 |
| Event-Driven | 6 |
| Index Tracker | 2 |
| Bandar | 2 |
| Total | 50 |

### 4.2 Komposisi 100 bot

| Strategi | Jumlah |
|---|---:|
| Noise Trader | 32 |
| Momentum Trader | 18 |
| Contrarian | 14 |
| Market Maker | 8 |
| Value Investor | 8 |
| Event-Driven | 12 |
| Index Tracker | 4 |
| Bandar | 4 |
| Total | 100 |

## 5. Fase 4A — Fondasi Multi-Strategy

### 5.1 Tujuan

Menyiapkan fondasi bersama sebelum menambahkan strategi baru.

### 5.2 Scope

- [x] Final verification Fase 3.
- [x] Shared trading-rule dan risk utilities.
- [x] Scheduler per-agent dengan jitter.
- [x] Rolling market signal cache.
- [x] Population generator.
- [x] Configurable global rate limit.
- [x] Session metrics dasar.

### 5.3 Shared decision utilities

Pisahkan logika umum dari Noise Trader:

- [x] Resolve session instance ID.
- [x] Resolve listed symbol universe.
- [x] Parse lot-size, tick-size, price-band, dan auto-rejection.
- [x] Snap price ke tick valid.
- [x] Clamp harga ke ARA/ARB.
- [x] Hitung available cash dan available position.
- [x] Hitung affordable quantity.
- [x] Validasi reserved cash dan reserved shares.
- [x] Buat unique client order ID.
- [x] Validasi max order per bot per session.

Semua strategi wajib memakai utilities ini.

### 5.4 Scheduler

Gunakan satu scheduler global yang menyimpan metadata per bot:

```text
next_evaluation_at
last_evaluation_at
last_active_session_id
inactive_for_session
```

Ketentuan:

- [x] Bot tidak dievaluasi serentak.
- [x] Setiap bot memiliki jitter sendiri.
- [x] Scheduler tidak membuat ticker per bot-symbol.
- [x] Opening dan closing auction tetap memakai participation probability.
- [x] Due bot diproses melalui worker pool terbatas atau sequential batch.
- [x] Tidak ada bot yang dievaluasi setelah context dibatalkan.

### 5.5 Market signal cache

Tambahkan rolling summary per simbol:

- [x] Last dan previous price.
- [x] Short return.
- [x] Open, high, low, dan close.
- [x] Volume delta.
- [x] Trade-count delta.
- [x] Best bid dan best ask.
- [x] Spread.
- [x] Bid depth dan ask depth.
- [x] Order-book imbalance.
- [x] Last update time.
- [x] Staleness status.

Cache hanya menyimpan agregat yang dibutuhkan, bukan seluruh raw event.

### 5.6 Population generator

Population config minimal:

```yaml
population:
  size: 50
  seed: 20260704
  composition:
    noise_trader: 16
    momentum_trader: 9
    contrarian: 7
    market_maker: 4
    value_investor: 4
    event_driven: 6
    index_tracker: 2
    bandar: 2
```

Generator bertanggung jawab atas:

- [x] Stable external bot ID.
- [x] Email internal bot.
- [x] Strategy assignment.
- [x] Initial cash range.
- [x] Initial inventory.
- [x] Risk profile.
- [x] Deterministic result berdasarkan seed.

### 5.7 Test Fase 4A

- [x] Unit test shared rule/risk utilities.
- [x] Unit test scheduler due-time dan jitter.
- [x] Unit test scheduler tidak mengevaluasi bot serentak.
- [x] Unit test rolling market signals.
- [x] Unit test deterministic population generator.
- [x] Integration test 20 Noise Trader dengan scheduler baru.
- [x] Restart dan event cursor test.
- [ ] Race test untuk registry, cache, dan scheduler.

Catatan race test: belum dapat dijalankan pada environment Windows saat ini karena
Go race detector membutuhkan CGO dan compiler GCC.

### 5.8 Exit criteria Fase 4A

- [x] Perilaku Noise Trader Fase 3 tetap lulus.
- [x] Order tersebar dalam waktu, tidak satu timestamp.
- [x] Population generator menghasilkan komposisi tepat.
- [x] Market signals tersedia dan tidak stale saat session aktif.
- [x] Rate limit dapat diatur dari config.
- [x] Tidak ada accounting regression.

## 6. Fase 4B — Momentum dan Contrarian

### 6.1 Momentum Trader

Signal minimum:

- [ ] Short return searah.
- [ ] Volume atau trade frequency meningkat.
- [ ] Minimal dua confirmation.
- [ ] Spread masih dapat diterima.
- [ ] Order-book imbalance mendukung.
- [ ] Fair value menjadi safety brake.
- [ ] Satu order besar tidak cukup menjadi trigger.

Parameter awal:

```text
interval: 10–30 detik
max order: 0–3 per session
inactive rate: 5–15%
```

### 6.2 Contrarian

Signal minimum:

- [ ] Harga bergerak cukup jauh dari session reference.
- [ ] Harga diskon/premium terhadap fair value.
- [ ] Momentum mulai melemah atau imbalance berbalik.
- [ ] Fundamental news buruk dapat memblokir buy.
- [ ] Entry dilakukan bertahap.

Parameter awal:

```text
interval: 30–90 detik
max order: 0–2 per session
inactive rate: 10–20%
```

### 6.3 Test Fase 4B

Gunakan 20 bot campuran:

```text
8 Noise
7 Momentum
5 Contrarian
```

Skenario:

- [ ] Neutral market tanpa news.
- [ ] Satu order besar tanpa confirmation.
- [ ] Sustained price dan volume movement.
- [ ] Harga jauh di bawah fair value.
- [ ] Harga jauh di atas fair value.
- [ ] Thin order book.

### 6.4 Exit criteria Fase 4B

- [ ] Momentum tidak bereaksi pada satu order besar.
- [ ] Momentum bereaksi pada movement terkonfirmasi.
- [ ] Contrarian tidak selalu melawan trend.
- [ ] Contrarian mempertimbangkan fair value dan news.
- [ ] Tidak semua strategi memilih side yang sama.
- [ ] Tidak ada order invalid atau accounting error.

## 7. Fase 4C — Event-Driven dan News Calibration

### 7.1 Scope

- [ ] Normalize news signal.
- [ ] Filter published news.
- [ ] Filter effective session dan expiry.
- [ ] Support scope symbol, sector, dan market.
- [ ] Map sentiment menjadi directional bias.
- [ ] Map intensity menjadi reaction probability dan size.
- [ ] Track news yang sudah diproses per bot.

### 7.2 Reaction target

| Intensity | Event-Driven | Noise |
|---|---:|---:|
| Low | 20–30% | 0–5% |
| Medium | 40–60% | 5–10% |
| High | 70–85% | 10–25% |
| Extreme | 80–95% | 20–40% |

Momentum tetap membutuhkan price/volume confirmation.

### 7.3 Test Fase 4C

- [ ] Draft news tidak dibaca.
- [ ] Future news tidak dibaca.
- [ ] Expired news tidak memicu order.
- [ ] Low news tidak membuat market ekstrem.
- [ ] Medium news memberi efek kecil atau sedang.
- [ ] High news memberi efek kuat.
- [ ] High news tidak selalu membuat ARA/ARB.
- [ ] Negative news menghasilkan sell bias.
- [ ] News tidak mengubah harga secara langsung.

### 7.4 Exit criteria Fase 4C

- [ ] Event-Driven menjadi first responder.
- [ ] Bot lain menjadi secondary responder.
- [ ] Reaction rate sesuai rentang konfigurasi dalam repeated test.
- [ ] Satu news tidak diproses berulang tanpa batas.
- [ ] Tidak ada akses draft atau future data.

## 8. Fase 4D — Market Maker dan Action Queue

### 8.1 Action queue

Perluas queue menjadi:

```text
place
cancel
amend
```

Guardrail:

- [ ] Action memiliki account ID dan correlation/client ID.
- [ ] Cancel/amend hanya untuk open order milik bot.
- [ ] Tidak cancel/amend pada `non_cancellation`.
- [ ] Tidak retry buta dengan ID baru.
- [ ] Unknown outcome direconcile.
- [ ] Terminal order dihapus dari open-order registry.

### 8.2 Market Maker dasar

- [ ] Quote bid dan offer di sekitar reference mid.
- [ ] Spread berdasarkan liquidity dan volatility.
- [ ] Quote price selalu valid tick dan price-band.
- [ ] Inventory limit per symbol.
- [ ] Cash exposure limit.
- [ ] Quote size configurable.
- [ ] Widen spread ketika volatilitas naik.
- [ ] Withdraw sementara saat extreme news.
- [ ] Refresh quote melalui amend atau cancel-place.
- [ ] Hindari self-trade.

Parameter awal:

```text
interval: 10–25 detik
quote refresh: 2–8 per session
population: maksimal 8% total bot
```

### 8.3 Test Fase 4D

- [ ] Quote tidak crossing tanpa alasan.
- [ ] Quote lama dibatalkan atau di-amend.
- [ ] Inventory limit menghentikan quote searah.
- [ ] News high melebarkan spread.
- [ ] News extreme dapat menarik quote.
- [ ] Market Maker dapat rugi.
- [ ] Market Maker tidak selalu menyediakan likuiditas.
- [ ] Self-trade prevention tidak menjadi status mayoritas.

### 8.4 Exit criteria Fase 4D

- [ ] Order book memiliki bid dan offer.
- [ ] Spread tetap wajar tetapi tidak selalu sempurna.
- [ ] Quote lifecycle tidak meninggalkan stale order.
- [ ] Cancel/amend mematuhi session.
- [ ] Tidak ada inventory atau cash minus.

## 9. Fase 4E — Strategi Pelengkap dan 50 Bot

### 9.1 Value Investor sederhana

- [ ] Buy berdasarkan margin of safety.
- [ ] Sell berdasarkan premium.
- [ ] Maksimal 0–1 order per session.
- [ ] Inactive rate 30–60%.

### 9.2 Index Tracker sederhana

- [ ] Aktivitas utama mendekati akhir session.
- [ ] Maksimal 0–1 order per session.
- [ ] Tidak bereaksi langsung pada news biasa.
- [ ] Belum membutuhkan indeks kompleks.

### 9.3 Bandar sederhana

- [ ] Maksimal 0–2 keputusan besar per session.
- [ ] Tidak selalu aktif.
- [ ] Membutuhkan inventory dan cash yang cukup.
- [ ] Memakai fair value dan liquidity sebagai guardrail.
- [ ] Belum menerapkan fase manipulasi advanced.

### 9.4 Genesis per strategi

| Strategi | Karakter genesis |
|---|---|
| Noise | Cash dan inventory kecil |
| Momentum | Cash kecil–menengah |
| Contrarian | Cash menengah dan inventory seimbang |
| Event-Driven | Cash menengah |
| Market Maker | Cash besar dan inventory tersebar |
| Value | Cash menengah–besar |
| Index | Cash besar dan inventory terdiversifikasi |
| Bandar | Cash dan inventory besar dengan risk limit |

### 9.5 Test 50 bot

Jalankan minimal:

- [ ] 10 neutral sessions.
- [ ] 5 medium-news sessions.
- [ ] 5 high-news sessions.
- [ ] 3 negative-news sessions.
- [ ] Restart test.
- [ ] Player interaction test.

### 9.6 Exit criteria Fase 4E

- [ ] 50 bot aktif dengan komposisi tepat.
- [ ] Tidak ada strategi yang mendominasi seluruh volume.
- [ ] Order book tidak kosong.
- [ ] Market menghasilkan volume dan transaksi.
- [ ] Player tetap dapat bertransaksi.
- [ ] Tidak ada cash/position minus.

## 10. Fase 4F — Calibration dan Scaling ke 100 Bot

### 10.1 Metrics wajib

Per session dan per strategi:

- [ ] Decision count.
- [ ] Enqueued dan dropped count.
- [ ] Place, cancel, dan amend count.
- [ ] Accepted, rejected, filled, cancelled, dan expired.
- [ ] Reject reason.
- [ ] Fill ratio.
- [ ] Order latency.
- [ ] Queue depth.
- [ ] Event stream lag.
- [ ] Volume dan trade count per simbol.
- [ ] Average spread.
- [ ] Average depth.
- [ ] Return per simbol.
- [ ] ARA/ARB occurrence.
- [ ] CPU dan memory BOT.

### 10.2 Scaling gates

Naik dari 50 ke 100 hanya jika:

- [ ] Reject rate rendah dan dapat dijelaskan.
- [ ] Queue tidak menumpuk.
- [ ] Sekuritas latency stabil.
- [ ] MATS tidak overload.
- [ ] CPU dan memory BOT stabil.
- [ ] Tidak ada accounting error.
- [ ] Market neutral tidak sering ARA/ARB.

### 10.3 Rate limit

```text
start: 60 order/menit
calibration ceiling: 120 order/menit
```

Rate limit dinaikkan berdasarkan hasil pengukuran, bukan hanya jumlah bot.

### 10.4 Exit criteria Fase 4F

- [ ] 100 bot dapat berjalan stabil.
- [ ] Market tidak terlalu sepi atau terlalu padat.
- [ ] News medium memberi efek kecil–sedang.
- [ ] News high memberi efek kuat tetapi tidak selalu ARA.
- [ ] Bot tidak spam order.
- [ ] Player tetap bisa berinteraksi secara wajar.
- [ ] Tidak ada cash atau position minus.
- [ ] Seluruh exit criteria Fase 4 terpenuhi.

## 11. Definition of Done Fase 4

Fase 4 selesai jika:

1. 50–100 bot bermain pada tiga saham.
2. Komposisi strategi sesuai target.
3. Order bot tersebar melalui scheduler dengan jitter.
4. Momentum membutuhkan confirmation.
5. Contrarian mempertimbangkan fair value dan news.
6. Event-Driven merespons intensity dan expiry.
7. Market Maker menjaga liquidity dengan inventory limit.
8. Value, Index, dan Bandar memiliki baseline behavior sederhana.
9. Semua action order melalui Sekuritas.
10. Market memiliki bid, offer, volume, dan transaksi.
11. Tidak semua saham sering ARA/ARB.
12. Tidak ada cash atau position minus.
13. Reject rate rendah dan dapat dijelaskan.
14. Player tetap dapat bertransaksi secara wajar.
15. CPU, memory, queue, Sekuritas, dan MATS stabil.

## 12. Urutan Eksekusi

```text
Fase 3 final gate
  -> Fase 4A fondasi
  -> Fase 4B Momentum + Contrarian
  -> Fase 4C Event-Driven
  -> Fase 4D Market Maker + action queue
  -> Fase 4E strategi pelengkap + 50 bot
  -> Fase 4F calibration + 100 bot
```

Setiap subfase harus memiliki test report sebelum subfase berikutnya dimulai.
