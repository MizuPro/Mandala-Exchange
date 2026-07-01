# Main Implementation Plan: BOT Service Mandala Exchange

Dokumen ini adalah urutan implementasi normatif untuk `docs/BOT/BOT_PRD.md` versi 3.0. BOT Service dibangun dari nol menggunakan Go, tetapi implementasi BOT penuh tidak boleh dimulai sebelum kontrak lintas layanan pada Fase 0 tersedia dan lulus integration test.

Dokumen pendamping normatif: `BOT_API_CONTRACTS.md`, `BOT_STATE_MACHINES.md`, `BOT_STRATEGY_SPEC.md`, dan `BOT_PERFORMANCE_TEST_PLAN.md`.

## Prinsip Eksekusi

- Kerjakan fase secara berurutan. Task yang memiliki dependency lintas layanan tidak boleh ditandai selesai hanya karena mock lokal berjalan.
- Semua mutation lintas layanan wajib idempotent dan teraudit.
- Sekuritas adalah source of truth akun, saldo, posisi, order investor, reservation, dan settlement state.
- BEI adalah source of truth emiten, rules, fee, sesi, indeks, IPO, corporate action, dan custody.
- MATS adalah source of truth matching, order book, dan market/session event operasional.
- Database BOT hanya menyimpan registry/config, state strategi, checkpoint, scenario run, decision log, dan metrik.
- Default runtime laptop adalah 300–500 bot aktif. Skala 1.000/2.000 hanya dinaikkan setelah performance gate sebelumnya lulus.

---

## Fase 0: Kontrak & Prasyarat Lintas Layanan

- **Status**: [x] Selesai — audit 2026-06-29: provisioning, identity, session/STP, MDX, snapshot, sequenced account stream, genesis saga dan IPO investor lifecycle telah diimplementasikan dan diverifikasi lulus integration test.
- **Blocking**: Seluruh Fase 1–7 bergantung pada kontrak yang relevan di fase ini.
- **Tugas**:
  - [x] **Task 0.1 — Trading Session Instance (BEI + MATS)**
    BEI menjadi creator/persistence authority session instance; MATS menjadi segment executor dengan lock/lease dan melanjutkan instance aktif setelah restart. Setiap putaran menghasilkan `session_instance_id` UUID dan `virtual_day_index` unik/monotonik. Tambahkan `virtual_duration_seconds`, `real_duration_seconds`, expected version, idempotent transition/finality, serta event/snapshot lengkap.
  - [x] **Task 0.2 — Self-Trade Prevention (MATS)**
    Implementasikan STP berdasarkan account ID dengan default `cancel_newest`. Publikasikan status/reason `self_trade_prevented`; tidak boleh menghasilkan trade atau fee.
  - [x] **Task 0.3 — BOT Service Identity & Scope**
    Tambahkan token BOT pada BEI, MATS, dan Sekuritas dengan least privilege. BEI: `market:read`, `rules:read`, `corporate-action:read`; MATS: `market:read`; Sekuritas: scope khusus internal BOT provisioning/token/snapshot/event. Token development dan production harus berbeda.
  - [x] **Task 0.4 — Idempotent Batch Provisioning & JWT Issuance (Sekuritas)**
    Implementasikan `POST /api/v1/internal/bots/provision` dan `POST /api/v1/internal/bots/tokens`. Tambahkan unique `external_bot_id`, idempotency key, response `created/existing/failed`, short-lived JWT, staggered refresh, audit log, serta larangan logging secret.
  - [x] **Task 0.5 — Genesis Seeding Saga (Sekuritas + BEI)**
    Implementasikan `POST /api/v1/internal/bots/genesis`, `genesis_run_id`, payload hash, outbox/retry/compensation, cash ledger Sekuritas, dan custody ledger BEI. Payload inventory memakai lembar. Genesis hanya boleh selesai sekali dan harus aman di-retry.
  - [x] **Task 0.6 — Bulk Portfolio Snapshot & Sequenced Account Event Stream (Sekuritas)**
    Implementasikan `POST /api/v1/internal/bots/portfolio-snapshot` dan `GET /api/v1/internal/bots/events/ws?after_sequence=...`. Snapshot transaction-consistent membawa `as_of_sequence`. Stream memakai global monotonic sequence, at-least-once delivery, retention, replay, heartbeat, explicit slow-consumer disconnect, gap detection, order lifecycle, settlement, dan corporate action.
  - [x] **Task 0.7 — IPO Subscription via Sekuritas**
    Implementasikan event lifecycle `draft → bookbuilding → subscription → allocation → listed/cancelled` dan `POST /api/v1/ipo-events/:id/subscriptions` untuk user/BOT JWT. Cakupan wajib meliputi subscription lot size, window validation, full cash reserve, cancel sebelum allocation, forwarding idempotent ke BEI, partial/zero allocation, official fee, debit aktual, refund, pending shares sampai listing, exceptional reversal, notification, outbox, duplicate protection, dan reconciliation.
  - [x] **Task 0.8 — Komposisi Indeks MDX (BEI)**
    Implementasikan `GET /v1/indices/MDX/composition` dengan symbol, weight, effective time, dan version. Tambahkan contract test untuk perubahan komposisi.
  - [x] **Task 0.9 — Rule/Fee/Session Contract Finalization**
    Tetapkan dan uji kontrak existing `GET /v1/public/securities`, `GET /v1/integration/mats/rules`, `GET /v1/public/fee-schedule`, dan `GET /v1/integration/mats/sessions/active`. Jangan membuat endpoint sesi duplikatif.
  - [x] **Task 0.10 — Cross-Service Contract & Recovery Tests**
    Implementasikan schema/error/idempotency dari `BOT_API_CONTRACTS.md`; uji retry provisioning, partial genesis failure, event gap/replay, snapshot concurrent event, slow consumer, submit unknown, restart dengan open order, duplicate webhook, settlement, IPO reserve/cancel/partial allocation/refund/listing/reversal, session rollover, concurrent transition, dan STP.
  - [x] **Task 0.11 — Contract Freeze Review**
    Cocokkan implementasi BEI/MATS/Sekuritas dengan `BOT_API_CONTRACTS.md` dan `BOT_STATE_MACHINES.md`; version-kan perubahan, catat backward compatibility/migration, dan larang Fase 1 memakai mock yang berbeda dari contract final.
- **Exit Criteria**:
  - [x] Seluruh endpoint memiliki schema request/response, auth scope, error code, idempotency, dan integration test.
  - [x] State transition dan accounting lulus invariants pada `BOT_STATE_MACHINES.md`.
  - [x] Satu session rollover menghasilkan instance ID baru.
  - [x] Genesis menghasilkan saldo Sekuritas dan custody BEI yang dapat direkonsiliasi.
  - [x] Account event gap dapat dipulihkan dengan replay atau snapshot.

---

## Fase 1: Fondasi BOT Service, Database, Scheduler, dan Safety

- **Status**: [x] Selesai — audit 2026-07-01: seluruh task 1.1–1.8 selesai dan exit criteria lulus. go build, go vet, 66 unit tests passed.
- **Dependency**: Task 0.3 dan kontrak schema PRD.
- **Tugas**:
  - [x] **Task 1.1 — Go Project & Dependency Setup**
    Buat module `BOT/` dengan `chi`, `coder/websocket`, `pgx/v5`, `goose`, `go-redis/v9`, `yaml.v3`, dan `x/time/rate`. Ikuti struktur direktori PRD Bagian 9.3.
    _Catatan implementasi: Semua dependency tersedia di go.mod. Struktur direktori: cmd/bot, internal/{circuitbreaker,client,config,logger,metrics,portfolio,queue,reconciliation,scheduler,session}, migrations. Build dan vet lulus._
  - [x] **Task 1.2 — Environment & Validation**
    Sediakan `.env.development.example`, `.env.production.example`, env Docker, validasi startup, secret redaction, dan port matrix: API 9090/9091, PostgreSQL 5435/5535.
  - [x] **Task 1.3 — Versioned Database Migration**
    Implementasikan schema `bots`, encrypted token cache opsional, `simulation_runs`, `genesis_runs`, config versions, state snapshots, event checkpoints, decision logs, session performance, sentiment, dan scenario events. Gunakan `BIGINT/NUMERIC` untuk uang; tidak memakai runtime auto-migrate.
  - [x] **Task 1.4 — Config Source of Truth**
    Implementasikan precedence compiled defaults → YAML bootstrap → DB config → persisted runtime override. Tambahkan `config_version`, optimistic locking, validation per strategy, dan explicit YAML reconcile.
    _Catatan implementasi: DefaultRiskConfig (compiled defaults), RiskConfig typed bounds per strategy spec §4, ValidateBotConfig, ReconcileYAML dengan ON CONFLICT DO NOTHING (tidak timpa bot existing per PRD §0.3), UpdateConfig dengan optimistic lock (409 on mismatch). 14 unit tests lulus._
  - [x] **Task 1.5 — Shared Market State & Scheduler**
    Implementasikan immutable snapshot per symbol, min-heap/timing-wheel atau scheduler shard, 4–8 strategy workers, deterministic jitter, bounded concurrency, dan panic isolation per task.
    _Catatan implementasi: SnapshotStore dengan Publish/Get (value copy, immutable); bounded dispatch dengan non-blocking send dan backpressure (re-queue on full channel); 8 workers default; panic recovery per task. 6 unit tests lulus._
  - [x] **Task 1.6 — Priority Order Queue & Rate Limiter**
    Implementasikan prioritas `risk/cancel` → `market/event` → `normal` → `market-maker refresh`; sustained 300/menit, burst 100/10 detik, hard limit 600/menit, queue 5.000, 10 order workers, TTL normatif, dan `expired_before_submit`. Tambahkan stable `client_order_id`, local `submit_unknown`, lookup by client ID, serta larangan blind retry.
    _Catatan implementasi: LookupByClientID (value copy, untuk submit_unknown reconciliation); semua 4 priority level verified; rate limiter configured per PRD (5/sec sustained, 10/sec hard, burst 100); expired_before_submit TTL. 8 unit tests lulus._
  - [x] **Task 1.7 — Circuit Breaker & Readiness State Machine**
    Implementasikan per-bot spam cooldown, total breaker, reject surge, queue pressure, dependency stale, kill switch, serta readiness `starting → syncing → ready → degraded → halted`.
    _Catatan implementasi: RecordQueuePressure/ClearQueuePressure (80% threshold); MarkDependencyStale/MarkDependencyFresh per dependency (bei/mats_ws/account_stream); ResetKillSwitch (halted→starting, admin recovery); SetState tidak override kill switch; state machine completeness end-to-end verified. 17 unit tests lulus._
  - [x] **Task 1.8 — Structured Logging & Metrics**
    Tambahkan metric CPU/RSS, goroutine, queue depth/wait, API latency, order rate, reject, event lag, reconciliation mismatch, scheduler lag, dan DB pool. Structured log wajib meredaksi secret.
    _Catatan implementasi: RecordEventLag; CollectDBPoolMetrics(pool) via pgxpool.Stat(); Snapshot() return MetricsSnapshot (lock-free value copy, vet clean); CPUPercent=0.0 di MVP (OS-specific sampling belum tersedia). Logger redaction test coverage token/secret/password/jwt case-insensitive. 18 unit tests lulus._
- **Exit Criteria**:
  - [x] Unit test scheduler, queue priority, TTL, rate limiter, config version, breaker, dan migration lulus. (66 tests total, go build lulus, go vet bersih — 2026-07-01)
  - [x] Service idle dapat start/stop bersih tanpa dependency nyata.
  - [x] DB connection pool maksimum default 15.

---

## Fase 2: Konektivitas, Identity, Market State, dan Recovery

- **Status**: [x] Selesai — audit 2026-07-01: gap-closing tasks 2.1–2.8 selesai dan exit criteria lulus. go build, go vet, 81 unit+integration tests passed (naik dari 66).
- **Dependency**: Fase 0 (seluruh kontrak) dan Fase 1 (fondasi).
- **Tugas**:
  - [x] **Task 2.1 — Provisioning & Token Client**
    Client batch provisioning, external bot mapping, short-lived JWT cache, staggered refresh goroutine 5–10 menit sebelum expiry dengan jitter per-akun, retry idempotent, expired token defense (GetToken return false), dan dropExpiredTokens untuk akun suspended.
  - [x] **Task 2.2 — Genesis Client & Startup Gate**
    Startup gate checks `genesis_runs` table: service tidak akan transisi ke `StateReady` sampai genesis completed. Jika ada bot registered tanpa genesis, service starts in limited mode dan mencetak warning eksplisit.
  - [x] **Task 2.3 — MATS Market WebSocket**
    Satu koneksi authenticated `market:read`, reconnect/backoff eksponensial, heartbeat tracking, resubscribe symbols, `depth_snapshot` per simbol, readiness menunggu ALL symbols snapshot, sequence monitoring.
  - [x] **Task 2.4 — BEI Discovery, Rules, Fee, dan MDX Client**
    Per-endpoint freshness threshold (SessionMaxAge 10s, Rules/Fees 300s, MDX 300s), IsSessionStale/IsRulesStale/IsFeesStale/IsMDXStale independent, session instance parsing dari BEI JSON, IsStale() = conjunction semua critical endpoints, ListedSymbols() menggunakan format array.
  - [x] **Task 2.5 — Sekuritas Bulk Snapshot**
    Muat cash, positions, open orders, checkpoint via batch API (max 100/batch); tidak ada direct DB access. Replace resets lastSequence ke as_of_sequence.
  - [x] **Task 2.6 — Sekuritas Account Event Consumer**
    Konsumsi stream global, sequence/checkpoint, replay, gap detection (ErrSequenceGap → snapshot-and-replay), 410 EVENT_SEQUENCE_TOO_OLD detection dan immediate snapshot-and-replay tanpa backoff, slow consumer disconnect handling.
  - [x] **Task 2.7 — Periodic Reconciliation**
    Reconcile setiap 60 detik dalam batch 100 akun. Mismatch terukur (metrics.RecordReconciliationMismatch), tidak menimpa Sekuritas dari BOT.
  - [x] **Task 2.8 — Session Monitor & Virtual Clock**
    Session instance dari BEI sebagai daily boundary, konversi virtual→real delay, IsActive/IsNonCancellation state checks, rollover callback, monotonicity guard, RealTimeRemaining, SessionProgress, wired ke BEI refresh goroutine di main.go.
- **Exit Criteria**:
  - [x] PoC 10 akun dapat provision, memperoleh JWT, snapshot, menerima event, dan rollover sesi — lulus di `poc_integration_test.go:TestPhase2PoC10Bot` (10 sub-test).
  - [x] Restart dengan open order tidak membuat reservation ganda — lulus di `poc_integration_test.go:restart_with_open_orders_no_duplicate_reservation`.
  - [x] Gap detection dan 410 EVENT_SEQUENCE_TOO_OLD → snapshot-and-replay — lulus di `poc_integration_test.go:account_event_stream_sequence_and_gap` dan `reconciliation/stream.go`.
  - [x] Putuskan account stream dan MATS WS secara sengaja; recovery berhasil tanpa order stale.

---

## Fase 3: Portfolio Accounting, Risk, Realism, dan Deterministic Mode

- **Status**: [x] Selesai — audit 2026-07-01: Task 3.1–3.9 dan seluruh exit criteria lulus. Recovery reconciliation atomik mengembalikan cache ke snapshot Sekuritas; integration nyata provisioning→genesis→order Sekuritas→MATS match→settlement→corporate action lulus; 182 regression test BOT lulus.
- **Dependency**: Fase 2.
- **Tugas**:
  - [x] **Task 3.1 — Portfolio Cache Lifecycle**
    Implementasikan seluruh transition dan rounding pada `BOT_STATE_MACHINES.md`: cash/position `available-reserved-pending`, weighted average, fee resmi Sekuritas, market-order reserve, amend reservation, open order, partial fill, cancel, reject, expiry, settlement, dan corporate action.
    _Selesai 2026-07-01: cache lifecycle, authoritative production settlement/corporate-action event, invariant reservation, market reserve, dan atomic amend tersedia. Integration test nyata provisioning→genesis→order Sekuritas→match MATS→settlement→corporate action lulus; restart BOT memulihkan snapshot dan event stream dari sequence 19._
  - [x] **Task 3.2 — Dynamic Tick/ARA/ARB/Lot/Fee Helpers**
    `GetValidPriceTick` memakai snapshot rule BEI, side-aware rounding, clamp price band, active lot size, dan fee schedule efektif.
    _Selesai 2026-07-01: snapshot resolver BEI fail-closed, active tick/band/lot, exact integer fee, dan MATS last-price wiring tersedia. Live BEI snapshot contract test, build, vet, dan regression test lulus._
  - [x] **Task 3.3 — Risk & Bankruptcy**
    Implementasikan max exposure saat buy baru, daily/weekly loss berdasarkan session instance, inventory limit, out-of-cash liquidation, dan status permanen `bankrupt`.
    _Selesai 2026-07-01: risk engine, migration, optimistic persistence, readiness/genesis gate, pre-buy exposure/inventory check, daily/weekly session loss, idempotent liquidation queue, dan Sekuritas JWT order client tersedia. Live integration membuktikan forced liquidation melalui Sekuritas, permanent bankruptcy, dan restart reload; 135 regression test lulus._
  - [x] **Task 3.4 — U-Shaped Activity & Human Imperfections**
    Implementasikan progress sesi berbasis persentase, compressed virtual delays, fat finger yang tetap valid rule, abort, overreaction, inactive session, dan bounded jitter. Gunakan typed distribution pada `BOT_STRATEGY_SPEC.md`.
    _Selesai 2026-07-01: typed bounded distribution dan config persistence, U-shaped continuous-session activity berbasis progress, compressed virtual reaction delay, per-bot inactive session, abort, bounded overreaction, serta fat finger berbasis active tick/price band tersedia. Boundary, deterministic seed, session guard, race, build, vet, dan 146 regression test lulus._
  - [x] **Task 3.5 — Herd Behavior & Market Sentiment**
    Implementasikan sentiment global/sektor, volatility regime, contagion, probability cap, versioning, dan expiry override.
    _Selesai 2026-07-01: state sentiment global/sektor dan volatility regime dipersist secara versioned per session; optimistic update, admin override ber-expiry dengan fallback, serta contagion berbasis trade concentration/price shock publik dengan susceptibility dan probability cap tersedia. Migration PostgreSQL nyata, restart recovery, concurrent update, build, vet, dan 155 regression test lulus._
  - [x] **Task 3.6 — Fair Event Context & Scenario Actor**
    Event normal harus memiliki BEI announcement/published time sebelum BOT bereaksi. `simulation_only` hanya untuk stress test. Panic Seller dibuat sebagai scenario actor, bukan populasi autonomous.
    _Selesai 2026-07-01: aggregate public announcement feed BEI dengan filter published_at tersedia bagi Sekuritas/player dan BOT; BOT mencatat received_at, menolak future/unpublished/simulation-only event pada live context, serta memulai reaction setelah publication gate. Panic Seller dikeluarkan dari autonomous strategy registry dan hanya valid sebagai typed simulation scenario actor. Migration/constraint PostgreSQL nyata, BEI contract test, build, vet, dan 163 regression test BOT lulus._
  - [x] **Task 3.7 — Strategy State Persistence**
    Persist state Bandar/Value/Index dan checkpoint dengan `state_version`; snapshot saat transition/material change dan shutdown.
    _Selesai 2026-07-01: persistence khusus Bandar/Value Investor/Index Tracker memakai migration berversi, JSONB strategy state/checkpoint, optimistic `state_version`, snapshot reason transition/material-change/shutdown, startup restore, dan retryable graceful-shutdown flush. PostgreSQL integration test membuktikan version conflict concurrent writer serta state/checkpoint bertahan setelah restart; 169 regression test BOT lulus._
  - [x] **Task 3.8 — Deterministic Test Runtime**
    Simpan simulation run ID, global/per-bot seed, virtual clock, config snapshot, input journal, event sequence, dan scheduler ordering. Live mode tidak menjanjikan bit-for-bit replay.
    _Selesai 2026-07-01: run artifact menyimpan run ID, mode, model/config snapshot, global/per-bot seed, virtual time, status, input/event/scheduler/decision/order journal, dan stable scheduler sequence. Live mode menolak klaim bit-for-bit journal; deterministic replay memvalidasi sequence gap dan menghasilkan output identik. Migration PostgreSQL nyata, restart artifact test, scheduler ordering test, build, vet, dan 173 regression test BOT lulus._
  - [x] **Task 3.9 — Anti-Predictability Baseline**
    Implementasikan HMAC session seed, population rotation, bounded parameter drift, multi-signal confirmation, hysteresis, random cooldown, dan conditional Bandar transition sesuai `BOT_STRATEGY_SPEC.md`. Tidak memakai private player data.
    _Selesai 2026-07-01: dedicated secret HMAC-SHA256 per model/bot/session/config version, deterministic population rotation dengan exact target ratio dan stateful/pinned cleanup guard, bounded mean-reverting drift, public-only multi-signal gate, hysteresis, randomized cooldown, serta conditional Bandar transition tersedia. Smoke test 30 deterministic runs membuktikan variasi populasi/drift/transition dalam bound; secret env development/production terpisah dan startup fail-closed. Build, vet, dan 180 regression test BOT lulus._
- **Exit Criteria**:
  - [x] Accounting lokal selalu kembali sama dengan snapshot Sekuritas setelah reconciliation.
  - [x] Daily reset terjadi pada session rollover, bukan pergantian tanggal komputer.
  - [x] Replay deterministic menghasilkan urutan keputusan/order yang sama.

---

## Fase 4: MVP Trading Strategies dan Decision Audit

- **Status**: [ ] Berjalan / Sebagian Selesai
- **Dependency**: Fase 3.
- **Tugas**:
  - [x] **Task 4.1 — Decision Log Pipeline**
    Log seluruh action/reject/risk/breaker, sampling HOLD default 2%, batch insert 100–500, flush 1–5 detik, retention 30 session instance, dan secret redaction.
    _Selesai dan diaudit ulang 2026-07-01: pipeline production terhubung ke order queue, Sekuritas submit/reject, risk transition, dependency breaker, dan queue expiry. Material log memakai bounded backpressure tanpa silent drop, failed batch dipertahankan untuk retry, shutdown menguras seluruh accepted record, sedangkan HOLD disampling configurable default 2%. Batch 100–500, flush 1–5 detik, retention default 30 session instance, schema audit lengkap, dan redaksi secret rekursif tersedia. Migration PostgreSQL `00009`, integration test insert/redaction/retention nyata, 195 regression test, build, dan vet lulus._
  - [ ] **Task 4.2 — Noise Trader**  
    Implementasikan typed config/distribution, universe dinamis, valid price deviation, small order, cancel probability, inventory awareness, dan session-aware frequency sesuai `BOT_STRATEGY_SPEC.md`.
  - [ ] **Task 4.3 — Momentum Trader**  
    Implementasikan lookback virtual time, distributed trigger, multi-signal confirmation, hysteresis, cooldown, take profit, stop loss, event/session boundaries, dan no-lookahead.
  - [ ] **Task 4.4 — Market Maker**  
    Implementasikan N-level quote, distributed refresh/size/spread, inventory skew, fee-aware spread, refresh/cancel policy, outstanding order tracking, STP pre-check, dan dependency pada MATS STP.
  - [ ] **Task 4.5 — End-to-End MVP Test**  
    Jalankan 10 bot tiga strategi selama satu session instance lengkap: place, amend, cancel, partial fill, fill, expiry, settlement, restart, dan reconciliation.
- **Exit Criteria**:
  - [ ] Seluruh Minimum MVP Acceptance Criteria pada PRD lulus.
  - [ ] Tidak ada self-trade, overspend, short sell, duplicate order, atau mismatch settlement.
  - [ ] Predictability smoke test pada `BOT_PERFORMANCE_TEST_PLAN.md` lulus.

---

## Fase 5: Strategi Lanjutan, IPO, dan Index

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 4; Task 0.7 untuk IPO dan Task 0.8 untuk Index Tracker.
- **Tugas**:
  - [ ] **Task 5.1 — Contrarian / Dip Buyer**  
    Intraday high/reference basis, staged accumulation, recovery exit, patience berbasis virtual time, dan max position.
  - [ ] **Task 5.2 — Value Investor**  
    MA-200 closed session instance, margin of safety, slow rebalance, portfolio concentration, dan fallback jika history belum cukup.
  - [ ] **Task 5.3 — Bandar Multi-Session**  
    State machine accumulation → mark-up → distribution, session counter, capital/inventory guard, restart persistence, dan anti-self-trade.
  - [ ] **Task 5.4 — Event-Driven & IPO Hunter**  
    Reaksi setelah `published_at`, event intensity, reaction delay, IPO subscription melalui Sekuritas, allocation/refund event, dan first-listing behavior.
  - [ ] **Task 5.5 — Index Tracker**  
    Versioned MDX composition, tracking error, rebalance setiap 5 session instance, TWAP slice dengan TTL/rate limit, dan disable-safe jika composition stale.
  - [ ] **Task 5.6 — Panic Seller Scenario Actor**  
    Manual/conditional stress actor, duration, symbol scope, risk cap, explicit `simulation_only`, serta cleanup/cancel saat scenario berakhir.
- **Exit Criteria**:
  - [ ] Delapan strategi autonomous berjalan dan Panic Seller hanya aktif sebagai scenario actor.
  - [ ] State Bandar bertahan melewati restart dan session rollover.
  - [ ] IPO tidak memberi saham gratis; reserve, allocation, debit, dan refund konsisten.

---

## Fase 6: Admin Control, Fairness, dan Scenario Validation

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 5.
- **Tugas**:
  - [ ] **Task 6.1 — Admin API**  
    Pause/resume/disable, pause-all/resume-all, sentiment, scenario, parameter update dengan optimistic config version, performance, audit, health, readiness, dan kill switch.
  - [ ] **Task 6.2 — Super Admin Sekuritas Integration**  
    Integrasikan Ruang Kendali BOT ke frontend Super Admin Sekuritas melalui backend proxy. Tidak ada frontend BOT/port 8080 terpisah dan secret BOT tidak masuk browser.
  - [ ] **Task 6.3 — Dashboard Query Efficiency**  
    Agregasi 2–5 detik, pagination, indexed query, cached metrics, dan tidak ada query/WS per bot per market event.
  - [ ] **Task 6.4 — Fairness Audit**  
    Verifikasi tidak ada private player state, future event, direct MATS order, stale rules, pending fund reuse, atau event BOT-only pada normal mode.
  - [ ] **Task 6.5 — Scenario A–E Tests**  
    Jalankan input, trigger, expected invariant, metric range, timeout, cleanup, dan pass/fail oracle pada `BOT_PERFORMANCE_TEST_PLAN.md` untuk Hari Normal, Akumulasi Bandar, Saham Terbang, Market Crash, dan Reaksi Korporasi.
- **Exit Criteria**:
  - [ ] Admin action teraudit dan aman terhadap concurrent update.
  - [ ] Seluruh scenario menjaga invariants saldo, custody, session rules, STP, dan rate limit.

---

## Fase 7: Performance Scaling, Deployment, dan Operational Readiness

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 6.
- **Tugas**:
  - [ ] **Task 7.1 — 100 Bot Baseline**  
    Jalankan canonical workload dan environment manifest pada `BOT_PERFORMANCE_TEST_PLAN.md`; profil CPU, RSS, GC, goroutine, queue, API latency, DB connections, event lag, reconciliation, dan memory trend.
  - [ ] **Task 7.2 — 300–500 Bot Default Gate**  
    Jalankan developer-realistic profile dan canonical workload. Wajib memenuhi seluruh correctness/performance gate, termasuk BOT RSS ≤ 500 MB, average CPU ≤ 10%, peak ≤ 40%, total stack RAM ≤ 12 GB, queue p95 ≤ 2 detik, dan Sekuritas API p95 ≤ 500 ms.
  - [ ] **Task 7.3 — 1.000 Bot Extended Test**  
    Naikkan populasi tanpa menaikkan rate limit lebih dahulu. Catat bottleneck dan lakukan tuning berbasis hasil profil.
  - [ ] **Task 7.4 — 2.000 Bot Stress Test**  
    Jalankan sebagai maximum stress test. Hasil harus terdokumentasi; gagal memenuhi budget tidak menghalangi default 300–500 selama sistem fail-safe.
  - [ ] **Task 7.5 — Development/Production Deployment**  
    BOT API 9090/9091, DB 5435/5535, env/secret/volume terpisah, loopback binding, log rotation, backup, migration, graceful shutdown, dan recovery runbook.
  - [ ] **Task 7.6 — `start-all.bat` Integration**  
    Tambahkan BOT DB, migration, dependency readiness, BOT startup setelah Sekuritas ready, dan hapus referensi Control Panel port 8080. Production tunnel tidak mengekspos BOT.
  - [ ] **Task 7.7 — Operational Runbook**  
    Dokumentasikan start, stop, restart, genesis, reconcile, event gap, breaker recovery, database backup/restore, token rotation, benchmark, dan emergency kill.
  - [ ] **Task 7.8 — Failure Injection & Soak Report**  
    Lulus 10-session soak 500 bot serta failure injection MATS/Sekuritas/BEI/DB/stream/queue/kill-switch. Simpan manifest, summary, metrics, failures, dan reconciliation report sesuai test plan.
- **Exit Criteria**:
  - [ ] Default 300–500 bot lulus seluruh performance budget dan multi-session soak test.
  - [ ] Startup/restart tidak membutuhkan koreksi database manual.
  - [ ] Production secret, database, dan volume terisolasi dari development.

---

## Fase 8: [OPTIONAL] Sector Correlation Engine

- **Status**: [ ] Ditunda/Opsional
- **Dependency**: Fase 7 stabil.
- **Tugas**:
  - [ ] **Task 8.1**: Standardisasi metadata sektor emiten dan versioning.
  - [ ] **Task 8.2**: Benchmark korelasi lokal terlebih dahulu; external compute hanya dipilih bila profiling membuktikan kebutuhan.
  - [ ] **Task 8.3**: Jika external compute dipakai, gunakan authenticated outbound channel/webhook, replay protection, timeout, dan fail-safe local fallback.

---

## Definition of Done Global

Implementasi BOT dinyatakan selesai jika:

1. Seluruh acceptance criteria PRD yang relevan sudah berupa automated test atau prosedur verifikasi terdokumentasi.
2. Tidak ada direct database access BOT ke Sekuritas/BEI dan tidak ada direct order injection ke MATS.
3. Saldo, posisi, order, settlement, dan custody dapat direkonsiliasi setelah restart atau event gap.
4. Delapan strategi autonomous dan scenario actor berjalan sesuai session/risk/fairness rules.
5. Default 300–500 bot memenuhi performance budget laptop Intel i5-10300H/RAM 16 GB.
6. Hasil benchmark 1.000/2.000 bot terdokumentasi tanpa menjadikan 2.000 bot sebagai default wajib.
7. Admin kill switch, dependency breaker, queue breaker, STP, token rotation, backup/restore, dan runbook telah diuji.
