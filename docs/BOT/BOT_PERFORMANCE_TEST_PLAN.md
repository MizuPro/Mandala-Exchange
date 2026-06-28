# BOT Performance, Soak, and Scenario Test Plan

**Versi**: 1.0  
**Tanggal**: 2026-06-29  
**Status**: Normatif untuk Fase 4, 6, dan 7  
**Mesin target**: Intel i5-10300H 4C/8T, RAM 16 GB, Windows  

## 1. Tujuan

- Membuktikan correctness sebelum scaling.
- Membuat benchmark dapat diulang.
- Menentukan apakah 300–500 bot aman sebagai default.
- Mendokumentasikan batas 1.000/2.000 bot tanpa menjadikannya syarat default.
- Memastikan skenario ekstrem tidak merusak accounting, fairness, atau safety.

## 2. Test Environment Manifest

Setiap laporan mencatat:

```yaml
environment:
  cpu: "Intel i5-10300H"
  ram_gb: 16
  os_version: ""
  go_version: ""
  node_version: ""
  docker_version: ""
  commit: ""
  power_mode: "plugged_in_performance"
  docker_memory_limit_gb: 10
  ide_running: true
  browser_tabs: 3
  antivirus_realtime: true
```

Catat service version, env mode, database size, symbol count, session template, compression ratio, dan log level.

Tidak boleh membandingkan hasil run dengan environment manifest berbeda tanpa label.

## 3. Canonical Workload

### 3.1 Universe

Default benchmark:

- 20 saham aktif.
- 5 high-liquidity.
- 10 medium-liquidity.
- 5 low-liquidity.
- 1 MDX composition.
- Tanpa IPO/corporate action kecuali scenario khusus.

### 3.2 Session

```yaml
session:
  virtual_continuous_seconds: 21600
  real_continuous_seconds: 1800
  total_real_session_minutes: 40
  warmup_real_minutes: 5
```

Jika development memakai sesi lebih pendek, hasil tidak boleh disebut soak result.

### 3.3 Population

```yaml
population_ratio:
  noise_trader: 0.40
  momentum_trader: 0.30
  contrarian: 0.15
  market_maker: 0.05
  value_investor: 0.05
  index_tracker: 0.02
  event_driven: 0.02
  bandar: 0.01
```

Panic Seller default 0.

### 3.4 Runtime Config

```yaml
runtime:
  sustained_orders_per_minute: 300
  burst_capacity: 100
  burst_window_seconds: 10
  hard_limit_per_minute: 600
  queue_capacity: 5000
  order_workers: 10
  strategy_workers: 8
  reconciliation_interval_seconds: 60
  reconciliation_batch_size: 100
  hold_log_sample_rate: 0.02
  dashboard_refresh_seconds: 5
```

### 3.5 Background Applications

Dua profil:

- `clean`: service stack + monitoring saja.
- `developer_realistic`: IntelliJ, terminal, dan maksimal 3 tab browser dashboard aktif.

Default gate 300–500 bot harus lulus `developer_realistic`.

## 4. Measurement

Sample interval resource: 1 detik.

Metric:

- BOT RSS/working set.
- Total stack RAM.
- BOT dan total CPU.
- Goroutine count.
- Go GC pause/allocation.
- Queue depth, wait, stale/drop.
- Strategy scheduler lag.
- HTTP latency/error/timeout.
- Order rate/reject.
- Event stream lag/reconnect/gap.
- Reconciliation duration/mismatch.
- DB connection/latency/lock wait.
- MATS match latency.
- Sekuritas API latency.
- Decision log batch/flush latency.

Percentile dihitung dari minimal 1.000 sample operasi. Jika sample kurang, laporan harus menyebut jumlahnya dan tidak boleh mengklaim p95 stabil.

## 5. Performance Gates

### 5.1 Correctness Gate — Semua Skala

```text
negative cash count = 0
negative position count = 0
self trade count = 0
duplicate official order count = 0
unresolved submit_unknown setelah recovery = 0
reconciliation mismatch sebelum resume = 0
event sequence silent drop = 0
session double transition = 0
```

### 5.2 Default 300–500 Bot Gate

| Metric | Batas |
|---|---:|
| BOT RSS | ≤ 500 MB |
| BOT CPU average | ≤ 10% |
| BOT CPU peak 10s average | ≤ 40% |
| Total stack RAM | ≤ 12 GB |
| Queue wait p95 | ≤ 2 detik |
| Queue stale/drop normal session | < 1% |
| Sekuritas API p95 | ≤ 500 ms |
| Order timeout | < 0,5% |
| Bot order reject rate | < 5% |
| Event lag p95 | ≤ 1 detik |
| Reconciliation batch p95 | ≤ 10 detik |
| Scheduler lag p95 | ≤ 250 ms |

Windows CPU dilaporkan sebagai persentase total seluruh logical processor.

### 5.3 Extended/Stress Gate

- 1.000 bot: correctness wajib tetap lulus; performance regression didokumentasikan.
- 2.000 bot: correctness dan fail-safe wajib lulus. Tidak wajib memenuhi default latency/resource gate.
- OOM, data corruption, silent event loss, atau service utama lumpuh adalah kegagalan.

## 6. Test Stages

### Stage A — 10 Bot Functional

- 1 session lengkap.
- Place/amend/cancel.
- Partial/full fill.
- Expiry.
- Settlement.
- Restart BOT saat open order.

### Stage B — 100 Bot Baseline

- 3 session.
- Memory trend.
- Event reconnect.
- Snapshot/replay.
- Decision log batching.

### Stage C — 300 Bot

- 5 session.
- Developer-realistic profile.
- Seluruh default gate.

### Stage D — 500 Bot Default Maximum

- 10 session soak.
- Satu restart setiap komponen pada session berbeda.
- Satu account stream interruption.
- Satu rule snapshot refresh.

### Stage E — 1.000 Bot Extended

- 5 session.
- Rate limit tetap 300/menit terlebih dahulu.
- Naikkan rate hanya dalam run terpisah.

### Stage F — 2.000 Bot Stress

- 3 session.
- Burst scenario.
- Hard breaker.
- Recovery.

## 7. Soak Test

Soak default:

- 500 bot.
- 10 session canonical.
- Tidak reset database di antara session.
- Logging normal.
- Dashboard aktif.

Pass:

- RSS tidak menunjukkan pertumbuhan tak terbatas.
- Goroutine kembali ke baseline range setelah reconnect/session rollover.
- DB connection tidak bocor.
- Reconciliation mismatch nol.
- Tidak ada pending queue/event yang terus tumbuh setelah session selesai.

## 8. Failure Injection

Wajib diuji:

- Putus MATS WebSocket 30 detik.
- Putus account event stream sampai replay dan sampai retention terlewati.
- Sekuritas API timeout setelah menerima order.
- BEI rules unavailable.
- PostgreSQL BOT restart.
- MATS restart saat continuous.
- Sekuritas restart dengan open order.
- Duplicate webhook/fill/allocation.
- Slow consumer.
- Queue penuh.
- Disk/log write lambat.
- Kill switch saat continuous dan NCP.

Setiap test mempunyai expected state transition berdasarkan `BOT_STATE_MACHINES.md`.

## 9. Market Realism Baseline

Target awal untuk canonical normal market:

```yaml
normal_market_targets:
  two_sided_quote_ratio_high_liquidity_min: 0.90
  empty_book_duration_high_liquidity_max_pct: 0.05
  median_spread_high_liquidity_max_ticks: 6
  bot_order_reject_rate_max: 0.05
  self_trade_count: 0
  duplicate_order_count: 0
  reconciliation_mismatch_count: 0
  hard_breaker_activation_normal_session_max: 0
```

Target ini adalah baseline simulasi, bukan klaim kesamaan dengan IDX. Perubahan target harus melalui versioned calibration/validation.

Untuk saham medium/low liquidity, target spread/depth ditentukan setelah baseline run agar tidak memaksakan likuiditas seragam.

## 10. Scenario Test Oracle

### 10.1 Scenario A — Hari Normal

Initial:

- Sentiment neutral.
- Panic Seller off.
- Tidak ada announcement material.

Expected:

- High-liquidity quote ratio memenuhi baseline.
- Hard breaker tidak aktif.
- Strategy contribution tidak dimonopoli satu akun.
- Seluruh correctness invariant lulus.

### 10.2 Scenario B — Bandar Akumulasi

Initial:

- Satu Bandar mempunyai cash dan target inventory valid.
- Symbol tidak suspended.

Expected:

- Bandar bergerak melalui Sekuritas dan settlement normal.
- Tidak self-trade.
- Fase tidak berpindah hanya karena counter sesi; inventory/liquidity condition wajib.
- Exposure dan rate limit dipatuhi.
- State bertahan setelah restart.

### 10.3 Scenario C — Saham Terbang

Trigger:

- Bandar memenuhi markup eligibility.

Expected:

- Momentum response memakai confirmation, tidak seluruh bot bereaksi serentak.
- Harga tidak menembus ARA.
- Tidak ada direct price manipulation di luar matched order.
- Distribution hanya menjual available inventory.
- Order queue/hard limit tetap aman.

### 10.4 Scenario D — Market Crash

Trigger:

- Admin memulai `simulation_only` Panic Seller.

Expected:

- Panic Seller hanya menjual available shares.
- ARA/ARB, halt, dan suspend dipatuhi.
- Market Maker dapat widen/withdraw.
- Kill switch berhasil; NCP order ditrack sampai terminal.
- Tidak ada saldo/position negatif.
- Scenario cleanup membatalkan remaining cancellable order.

### 10.5 Scenario E — Reaksi Korporasi

Trigger:

- BEI mempublikasikan announcement dengan `published_at`.

Expected:

- Player channel menerima publication sebelum atau bersamaan dengan BOT.
- Reaction delay BOT dimulai setelah publication.
- Tidak ada future information.
- Corporate action/IPO accounting idempotent.
- Duplicate event tidak menggandakan cash/share movement.

## 11. Predictability Smoke Test

Sebelum Fase 4 selesai:

- Jalankan minimal 30 deterministic runs dengan seed berbeda.
- Periksa distribusi timing, size, dan threshold.
- Pastikan agent tidak selalu bertindak pada timestamp relatif yang sama.
- Pastikan satu large trade tidak memicu seluruh Momentum bot.
- Pastikan Bandar transition tersebar dalam configured window.
- Pastikan population rotation mempertahankan ratio dalam tolerance ±2 percentage point.

Advanced model predictor mengikuti `BOT_AGENT_BASED_SIMULATION_ROADMAP.md`.

## 12. Report Format

Setiap stage menghasilkan:

```text
docs/BOT/test-results/<date>-<stage>-<bot-count>/
  manifest.json
  summary.md
  metrics.csv
  failures.json
  reconciliation.json
```

Raw event besar tidak dicommit ke Git; simpan artifact eksternal/lokal dan commit summary + hash.

Summary wajib mencantumkan:

- Pass/fail per gate.
- P50/P95/P99.
- Peak resource.
- Error/reject breakdown.
- Correctness invariant.
- Bottleneck.
- Perubahan config dari canonical.
- Rekomendasi skala aman.

## 13. Stop Conditions

Test otomatis dihentikan jika:

- Total RAM > 14 GB selama 30 detik.
- Windows mulai sustained paging yang membuat service timeout.
- Negative balance/position ditemukan.
- Duplicate order/trade side effect ditemukan.
- Reconciliation mismatch membesar.
- Service utama tidak responsif > 30 detik.
- Database corruption/error fatal.

Stop harus diikuti graceful kill/reconciliation sejauh masih aman.

## 14. Definition of Done

- Stage A–D lulus.
- 500 bot lulus 10-session soak pada developer-realistic profile.
- Failure injection pulih tanpa koreksi SQL manual.
- Scenario A–E mempunyai report dan seluruh invariant lulus.
- Hasil Stage E/F terdokumentasi.
- Skala default ditetapkan berdasarkan hasil, bukan asumsi.
