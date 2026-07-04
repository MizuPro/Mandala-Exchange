# BOT-v2 Implementation Plan

Versi: 1.0
Tanggal: 2026-07-03
Status: Rencana implementasi bertahap

## 1. Tujuan

Dokumen ini menjelaskan rencana implementasi BOT-v2 secara bertahap. Fokus utama adalah membuat sistem hidup dan valid dulu, bukan langsung membuat 2000 bot dengan semua strategi kompleks.

Prinsip urutan:

```text
valid dulu
hidup dulu
realistis dulu
baru scalable
baru advanced
```

## 2. Fase 0 - Service Readiness

Tujuan fase ini adalah memastikan BEI, MATS, dan Sekuritas siap mendukung BOT.

### 2.1 BEI readiness

BEI harus mendukung:

- [x] 1. Daftar saham aktif.
- [x] 2. Trading rules.
- [x] 3. Fee schedule.
- [x] 4. Session state.
- [x] 5. IPO lifecycle.
- [x] 6. Corporate action minimal.
- [x] 7. News module.
- [x] 8. Fair value module.
- [x] 9. Market regime.
- [x] 10. Liquidity profile per saham.

### 2.2 MATS readiness

MATS harus mendukung:

- [x] 1. Opening auction.
- [x] 2. Continuous trading.
- [x] 3. Closing auction.
- [x] 4. ARA/ARB enforcement.
- [x] 5. Market data snapshot.
- [x] 6. Market data WebSocket.
- [x] 7. Order hanya dari Sekuritas.
- [x] 8. Tidak ada order di luar segment yang diizinkan.

### 2.3 Sekuritas readiness

Sekuritas harus mendukung:

- [x] 1. Create akun BOT tanpa email verification manual.
- [x] 2. BOT account type.
- [x] 3. BOT token.
- [x] 4. Genesis cash.
- [x] 5. Genesis position.
- [x] 6. Portfolio snapshot.
- [x] 7. Account event stream.
- [x] 8. Order API untuk BOT.
- [x] 9. Cancel order.
- [x] 10. Order lookup by client_order_id.
- [x] 11. IPO subscription untuk BOT dan player.
- [x] 12. Settlement.
- [x] 13. Validasi saldo dan posisi agar tidak minus.

### 2.4 Exit criteria fase 0

Fase 0 selesai jika:

- [x] 1. 10 akun BOT bisa dibuat.
- [x] 2. 10 akun BOT bisa diberi cash genesis.
- [x] 3. Beberapa akun BOT bisa diberi saham genesis.
- [x] 4. BOT bisa submit order lewat Sekuritas.
- [x] 5. Order masuk MATS.
- [x] 6. MATS melakukan matching.
- [x] 7. Sekuritas menerima event order/fill.
- [x] 8. Portfolio BOT bisa di-update.
- [x] 9. Tidak ada cash minus.
- [x] 10. Tidak ada saham minus.

## 3. Fase 1 - News & Fair Value Module di BEI

Tujuan fase ini adalah membuat market environment lebih realistis sebelum strategi BOT terlalu jauh.

### 3.1 Fitur News MVP

Admin BEI bisa:

- [x] 1. Create news.
- [x] 2. Edit news.
- [x] 3. Set symbol atau sector.
- [x] 4. Set sentiment.
- [x] 5. Set intensity.
- [x] 6. Set published session.
- [x] 7. Set expiry session.
- [x] 8. Publish news.
- [x] 9. Mark news sebagai simulation_only jika untuk stress test.

### 3.2 Fitur Fair Value MVP

Admin BEI bisa:

- [x] 1. Set fair value per symbol.
- [x] 2. Set confidence.
- [x] 3. Set method.
- [x] 4. Set effective session.
- [x] 5. Set expiry.
- [x] 6. Set version.
- [x] 7. Tampilkan ke player dan BOT.

### 3.3 Exit criteria fase 1

Fase 1 selesai jika:

- [x] 1. Player bisa melihat published news.
- [x] 2. BOT bisa membaca published news.
- [x] 3. BOT tidak bisa membaca draft/future news.
- [x] 4. Player bisa melihat fair value.
- [x] 5. BOT bisa membaca fair value.
- [x] 6. News tidak mengubah harga langsung.
- [x] 7. Harga tetap berubah hanya karena order.

## 4. Fase 2 - BOT-v2 Skeleton Go Service

Tujuan fase ini adalah membuat service Go yang hidup tetapi belum memiliki strategi kompleks.

### 4.1 Komponen awal

1. Config loader.
2. Bot registry.
3. Sekuritas client.
4. BEI client.
5. MATS market data client.
6. Portfolio snapshot loader.
7. Account event consumer.
8. Scheduler sederhana.
9. Order queue.
10. Order executor.
11. Admin start/stop.
12. Basic logging.

### 4.2 Exit criteria fase 2

Fase 2 selesai jika:

1. BOT service bisa start.
2. BOT service bisa connect ke BEI.
3. BOT service bisa connect ke MATS market data.
4. BOT service bisa snapshot portfolio dari Sekuritas.
5. BOT service bisa menerima account event.
6. BOT service bisa menaruh order decision ke queue.
7. Queue bisa submit order ke Sekuritas.
8. Service bisa stop dengan aman.

## 5. Fase 3 - 10 Noise Trader Functional Test

Tujuan fase ini adalah membuktikan BOT bisa hidup dari awal sampai akhir session.

### 5.1 Scope

1. 10 Noise Trader.
2. 3 saham: MNDL, NUSA, BARA.
3. Limit order only.
4. Order hanya di opening auction, continuous, dan closing auction.
5. Max 1 sampai 2 order per bot per session.
6. Tidak ada strategi advanced.

### 5.2 Validasi

1. Bot bisa buy.
2. Bot bisa sell jika punya saham.
3. Bot tidak bisa beli jika cash kurang.
4. Bot tidak bisa jual jika saham tidak ada.
5. Bot tidak order di segment terlarang.
6. Portfolio update benar.
7. Tidak ada cash minus.
8. Tidak ada saham minus.
9. Restart service tidak merusak state.

## 6. Fase 4 - 50 sampai 100 Bot dengan 3 Saham

Tujuan fase ini adalah membuat market terasa hidup tanpa terlalu ramai.

### 6.1 Komposisi awal 100 bot

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

Untuk 50 bot, jumlah tinggal diskalakan.

### 6.2 Fitur strategi yang dibuat

1. Noise Trader sederhana.
2. Momentum Trader sederhana.
3. Contrarian sederhana.
4. Event-Driven sederhana.
5. Market Maker dasar.

Value Investor, Index Tracker, dan Bandar bisa dimulai sangat sederhana dulu.

### 6.3 Rate limit awal

Karena baru 3 saham:

```text
order limit: 60 sampai 120 order per menit
max order per bot per session: 1 sampai 3
```

### 6.4 Exit criteria fase 4

1. Order book tidak kosong.
2. Market ada volume.
3. Tidak semua saham ARA/ARB.
4. News medium memberi efek kecil atau sedang.
5. News high memberi efek kuat tetapi tidak selalu ARA.
6. Bot tidak spam order.
7. Player masih bisa bertransaksi secara wajar.
8. Tidak ada cash/position minus.

## 7. Fase 5 - IPO Dynamic Discovery

Tujuan fase ini adalah membuat BOT bisa mendeteksi saham IPO baru secara dinamis.

### 7.1 Flow IPO

```text
BEI create IPO
Sekuritas tampilkan IPO ke player
BOT membaca IPO event
IPO Hunter bisa subscribe via Sekuritas
Allocation terjadi
Saat listed, saham masuk active securities
BOT menambahkan saham ke universe sesuai filter
```

### 7.2 Fitur IPO

1. IPO lifecycle.
2. IPO hype score.
3. IPO archetype.
4. IPO subscription BOT.
5. IPO allocation.
6. Listed event.
7. IPO attention boost.
8. Fair value awal untuk IPO.

### 7.3 Exit criteria fase 5

1. BOT mendeteksi IPO baru.
2. Event-Driven/IPO Hunter bisa subscribe.
3. BOT tidak bisa jual sebelum listed.
4. Setelah listed, saham masuk universe.
5. IPO hype tinggi bisa menghasilkan pergerakan kuat.
6. IPO tidak selalu ARA dengan pola yang sama.

## 8. Fase 6 - 10 sampai 20 Saham dan 100 sampai 500 Bot

Tujuan fase ini adalah mulai mendekati default runtime BOT-v2.

### 8.1 Scaling

| Jumlah saham | Bot aktif |
|---:|---:|
| 10 saham | 100 sampai 250 |
| 20 saham | 300 sampai 500 |

### 8.2 Rate limit

Untuk 20 saham, boleh mulai mendekati:

```text
sustained order: 300 per menit
burst: 100 dalam 10 detik
hard limit: 600 per menit
```

Namun angka ini hanya dipakai jika Sekuritas, MATS, dan database kuat.

### 8.3 Exit criteria fase 6

1. 20 saham bisa aktif.
2. 300 sampai 500 bot bisa berjalan.
3. Market tidak selalu ARA/ARB.
4. Market normal mayoritas bergerak wajar.
5. News high terasa.
6. IPO hype terasa.
7. Bot memory lintas sesi bekerja.
8. Bankrupt bot tercatat.
9. Admin bisa pause/resume bot group.
10. Tidak ada accounting error.

## 9. Fase 7 - Advanced Behavior dan Stress Test

Tujuan fase ini adalah menguji batas sistem, bukan default runtime.

### 9.1 1000 bot

Digunakan untuk extended load test.

Syarat:

1. Correctness tetap lulus.
2. Tidak ada cash minus.
3. Tidak ada saham minus.
4. Sekuritas tidak overload.
5. MATS tetap match dengan benar.
6. BOT queue tidak menumpuk parah.

### 9.2 2000 bot

Digunakan untuk stress test, bukan default awal.

Syarat:

1. Tidak ada data corruption.
2. Tidak ada silent event loss.
3. Tidak ada OOM.
4. Fail-safe aktif jika overload.
5. Sistem bisa pause order producer.

## 10. Minimal Admin Panel BOT

Untuk MVP, admin panel BOT perlu menampilkan:

1. Total bot registered.
2. Total bot active.
3. Total bot paused.
4. Total bot distressed.
5. Total bot bankrupt.
6. Bot by strategy.
7. Bot by cash range.
8. Bot by PnL.
9. Order count per session.
10. Reject count.
11. Decision log summary.
12. Error summary.
13. Pause/resume per group.
14. Kill switch.
15. Bankrupt bot detail.

## 11. Testing Minimum

### 11.1 Correctness test

Wajib lulus:

1. Cash tidak boleh minus.
2. Position tidak boleh minus.
3. BOT tidak order di segment terlarang.
4. BOT tidak jual saham yang belum settled jika rule melarang.
5. BOT tidak memakai cash reserved.
6. BOT tidak blind retry order dengan ID baru saat timeout.
7. BOT bankrupt tidak ikut bermain lagi.

### 11.2 Market realism test

Cek:

1. Order book tidak kosong.
2. Spread tidak terlalu ekstrem pada hari normal.
3. Volume ada.
4. News low tidak membuat market meledak.
5. News high membuat reaksi terlihat.
6. IPO hot bisa naik kuat.
7. IPO normal tidak selalu ARA.
8. Player pump tidak selalu berhasil menjual ke bot.

### 11.3 Performance test awal

Untuk 3 saham dan 100 bot:

1. CPU BOT stabil.
2. Memory BOT stabil.
3. Queue tidak penuh.
4. Sekuritas latency masih aman.
5. MATS tidak overload.
6. Event stream tidak lag parah.

## 12. Risiko Implementasi

### 12.1 Terlalu banyak bot untuk sedikit saham

Risiko:

1. Market terlalu ramai.
2. Harga terlalu sering ekstrem.
3. Order book tidak natural.

Mitigasi:

1. 3 saham hanya 50 sampai 100 bot.
2. Tambah bot seiring jumlah saham bertambah.

### 12.2 News terlalu sering high impact

Risiko:

1. Market terlalu reaktif.
2. ARA/ARB terlalu sering.

Mitigasi:

1. News wajib punya intensity.
2. News high/extreme tidak boleh terlalu sering.
3. Expiry wajib.

### 12.3 Bandar terlalu agresif

Risiko:

1. Saham sering digoreng.
2. Player merasa market tidak fair.

Mitigasi:

1. Bandar aktif agresif hanya sebagian kecil.
2. Bandar butuh inventory, liquidity, sentiment, dan fase.
3. Bandar bisa gagal.

### 12.4 Market Maker terlalu kuat

Risiko:

1. Market terasa palsu.
2. Spread selalu terlalu bagus.
3. Player selalu bisa keluar posisi.

Mitigasi:

1. Market Maker punya inventory limit.
2. Market Maker bisa widen spread.
3. Market Maker bisa withdraw.
4. Market Maker bisa rugi.

### 12.5 Bot terlalu sering order karena session pendek

Risiko:

1. 5 menit session jadi terlalu padat.
2. MATS dan Sekuritas overload.
3. Harga terlalu cepat ekstrem.

Mitigasi:

1. Interval evaluasi dibatasi.
2. Max order per bot per session.
3. Global rate limiter.
4. Queue TTL.
5. Limit order only untuk MVP.

## 13. Keputusan Teknis Awal

1. BOT-v2 memakai Go.
2. BOT-v2 satu proses untuk banyak bot.
3. Satu bot bukan satu proses.
4. Gunakan shared market snapshot.
5. Gunakan scheduler, bukan ticker per bot-symbol.
6. Gunakan order queue global.
7. Gunakan global rate limiter.
8. Gunakan limit order only untuk MVP.
9. Gunakan memory summary, bukan raw event.
10. Gunakan admin manual untuk fair value awal.

## 14. Definition of Done BOT-v2 MVP

BOT-v2 MVP dianggap selesai jika:

1. 50 sampai 100 bot bisa bermain di 3 saham.
2. Semua order BOT lewat Sekuritas.
3. BOT hanya order di auction dan continuous.
4. News dan fair value dari BEI terbaca.
5. News tidak mengubah harga langsung.
6. Event-Driven bereaksi ke news/IPO.
7. Bot lain bereaksi sebagai secondary responder.
8. IPO dynamic discovery berjalan.
9. Bot bisa rugi dan bankrupt.
10. Admin bisa melihat bankrupt bot.
11. Tidak ada cash minus.
12. Tidak ada saham minus.
13. Market tidak selalu ARA/ARB.
14. Player tetap bisa berinteraksi dengan market.
