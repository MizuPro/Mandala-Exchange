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

- [x] Short return searah.
- [x] Volume atau trade frequency meningkat.
- [x] Minimal dua confirmation.
- [x] Spread masih dapat diterima.
- [x] Order-book imbalance mendukung.
- [x] Fair value menjadi safety brake.
- [x] Satu order besar tidak cukup menjadi trigger.

Parameter awal:

```text
interval: 10–30 detik
max order: 0–3 per session
inactive rate: 5–15%
```

### 6.2 Contrarian

Signal minimum:

- [x] Harga bergerak cukup jauh dari session reference.
- [x] Harga diskon/premium terhadap fair value.
- [x] Momentum mulai melemah atau imbalance berbalik.
- [x] Fundamental news buruk dapat memblokir buy.
- [x] Entry dilakukan bertahap.

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

- [x] Neutral market tanpa news.
- [x] Satu order besar tanpa confirmation.
- [x] Sustained price dan volume movement.
- [x] Harga jauh di bawah fair value.
- [x] Harga jauh di atas fair value.
- [x] Thin order book.

### 6.4 Exit criteria Fase 4B

- [x] Momentum tidak bereaksi pada satu order besar.
- [x] Momentum bereaksi pada movement terkonfirmasi.
- [x] Contrarian tidak selalu melawan trend.
- [x] Contrarian mempertimbangkan fair value dan news.
- [x] Tidak semua strategi memilih side yang sama.
- [x] Tidak ada order invalid atau accounting error.

## 7. Fase 4C — Event-Driven dan News Calibration

### 7.1 Scope

- [x] Normalize news signal.
- [x] Filter published news.
- [x] Filter effective session dan expiry.
- [x] Support scope symbol, sector, dan market.
- [x] Map sentiment menjadi directional bias.
- [x] Map intensity menjadi reaction probability dan size.
- [x] Track news yang sudah diproses per bot.

### 7.2 Reaction target

| Intensity | Event-Driven | Noise |
|---|---:|---:|
| Low | 20–30% | 0–5% |
| Medium | 40–60% | 5–10% |
| High | 70–85% | 10–25% |
| Extreme | 80–95% | 20–40% |

Momentum tetap membutuhkan price/volume confirmation.

### 7.3 Test Fase 4C

- [x] Draft news tidak dibaca.
- [x] Future news tidak dibaca.
- [x] Expired news tidak memicu order.
- [x] Low news tidak membuat market ekstrem.
- [x] Medium news memberi efek kecil atau sedang.
- [x] High news memberi efek kuat.
- [x] High news tidak selalu membuat ARA/ARB.
- [x] Negative news menghasilkan sell bias.
- [x] News tidak mengubah harga secara langsung.

### 7.4 Exit criteria Fase 4C

- [x] Event-Driven menjadi first responder.
- [x] Bot lain menjadi secondary responder.
- [x] Reaction rate sesuai rentang konfigurasi dalam repeated test.
- [x] Satu news tidak diproses berulang tanpa batas.
- [x] Tidak ada akses draft atau future data.

## 8. Fase 4D — Market Maker dan Action Queue

### 8.1 Action queue

Perluas queue menjadi:

```text
place
cancel
amend
```

Guardrail:

- [x] Action memiliki account ID dan correlation/client ID.
- [x] Cancel/amend hanya untuk open order milik bot.
- [x] Tidak cancel/amend pada `non_cancellation`.
- [x] Tidak retry buta dengan ID baru.
- [x] Unknown outcome direconcile.
- [x] Terminal order dihapus dari open-order registry.

### 8.2 Market Maker dasar

- [x] Quote bid dan offer di sekitar reference mid.
- [x] Spread berdasarkan liquidity dan volatility.
- [x] Quote price selalu valid tick dan price-band.
- [x] Inventory limit per symbol.
- [x] Cash exposure limit.
- [x] Quote size configurable.
- [x] Widen spread ketika volatilitas naik.
- [x] Withdraw sementara saat extreme news.
- [x] Refresh quote melalui amend atau cancel-place.
- [x] Hindari self-trade.

Parameter awal:

```text
interval: 10–25 detik
quote refresh: 2–8 per session
population: maksimal 8% total bot
```

### 8.3 Test Fase 4D

- [x] Quote tidak crossing tanpa alasan.
- [x] Quote lama dibatalkan atau di-amend.
- [x] Inventory limit menghentikan quote searah.
- [x] News high melebarkan spread.
- [x] News extreme dapat menarik quote.
- [x] Market Maker dapat rugi.
- [x] Market Maker tidak selalu menyediakan likuiditas.
- [x] Self-trade prevention tidak menjadi status mayoritas.

### 8.4 Exit criteria Fase 4D

- [x] Order book memiliki bid dan offer.
- [x] Spread tetap wajar tetapi tidak selalu sempurna.
- [x] Quote lifecycle tidak meninggalkan stale order.
- [x] Cancel/amend mematuhi session.
- [x] Tidak ada inventory atau cash minus.

## 9. Fase 4E — Strategi Pelengkap dan 50 Bot

### 9.1 Value Investor sederhana

- [x] Buy berdasarkan margin of safety.
- [x] Sell berdasarkan premium.
- [x] Maksimal 0–1 order per session.
- [x] Inactive rate 30–60%.

### 9.2 Index Tracker sederhana

- [x] Aktivitas utama mendekati akhir session.
- [x] Maksimal 0–1 order per session.
- [x] Tidak bereaksi langsung pada news biasa.
- [x] Belum membutuhkan indeks kompleks.

### 9.3 Bandar sederhana

- [x] Maksimal 0–2 keputusan besar per session.
- [x] Tidak selalu aktif.
- [x] Membutuhkan inventory dan cash yang cukup.
- [x] Memakai fair value dan liquidity sebagai guardrail.
- [x] Belum menerapkan fase manipulasi advanced.

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

- [x] 10 neutral sessions.
- [x] 5 medium-news sessions.
- [x] 5 high-news sessions.
- [x] 3 negative-news sessions.
- [x] Restart test.
- [x] Player interaction test.

### 9.6 Exit criteria Fase 4E

- [x] 50 bot aktif dengan komposisi tepat.
- [x] Tidak ada strategi yang mendominasi seluruh volume.
- [x] Order book tidak kosong.
- [x] Market menghasilkan volume dan transaksi.
- [x] Player tetap dapat bertransaksi.
- [x] Tidak ada cash/position minus.

## 10. Fase 4F — Calibration dan Scaling ke 100 Bot

### 10.1 Metrics wajib

Per session dan per strategi:

- [x] Decision count.
- [x] Enqueued dan dropped count.
- [x] Place, cancel, dan amend count.
- [x] Accepted, rejected, filled, cancelled, dan expired.
- [x] Reject reason.
- [x] Fill ratio.
- [x] Order latency.
- [x] Queue depth.
- [x] Event stream lag.
- [x] Volume dan trade count per simbol.
- [x] Average spread.
- [x] Average depth.
- [x] Return per simbol.
- [x] ARA/ARB occurrence.
- [x] CPU dan memory BOT.

### 10.2 Scaling gates

Naik dari 50 ke 100 hanya jika:

- [x] Reject rate rendah dan dapat dijelaskan.
- [x] Queue tidak menumpuk.
- [x] Sekuritas latency stabil.
- [x] MATS tidak overload.
- [x] CPU dan memory BOT stabil.
- [x] Tidak ada accounting error.
- [x] Market neutral tidak sering ARA/ARB.

### 10.3 Rate limit

```text
start: 60 order/menit
calibration ceiling: 120 order/menit
```

Rate limit dinaikkan berdasarkan hasil pengukuran, bukan hanya jumlah bot.

### 10.4 Exit criteria Fase 4F

- [x] 100 bot dapat berjalan stabil.
- [x] Market tidak terlalu sepi atau terlalu padat.
- [x] News medium memberi efek kecil–sedang.
- [x] News high memberi efek kuat tetapi tidak selalu ARA.
- [x] Bot tidak spam order.
- [x] Player tetap bisa berinteraksi secara wajar.
- [x] Tidak ada cash atau position minus.
- [x] Seluruh exit criteria Fase 4 terpenuhi.

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
