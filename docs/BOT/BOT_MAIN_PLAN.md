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
- **Aturan granularitas task Fase 4–8**:
  - Checkbox parent hanya boleh menjadi `[x]` setelah seluruh subtask dan exit criteria parent lulus.
  - Subtask implementasi lokal cukup dibuktikan dengan unit/component test yang relevan. Contract/integration test nyata wajib dijalankan pada subtask boundary antarlayanan; pengujian satu sesi penuh tetap menjadi tanggung jawab Task 4.5.
  - Dilarang mengganti aksi resmi (`place`, `amend`, `cancel`) dengan pencatatan lokal, mock, atau perubahan state cache sebagai bukti selesai.
  - Jika satu subtask menemukan dependency yang belum tersedia, biarkan checkbox terbuka dan catat blocker tanpa melompati urutan.
- **Tugas**:
  - [x] **Task 4.1 — Decision Log Pipeline**
    Log seluruh action/reject/risk/breaker, sampling HOLD default 2%, batch insert 100–500, flush 1–5 detik, retention 30 session instance, dan secret redaction.
    _Selesai dan diaudit ulang 2026-07-01: pipeline production terhubung ke order queue, Sekuritas submit/reject, risk transition, dependency breaker, dan queue expiry. Material log memakai bounded backpressure tanpa silent drop, failed batch dipertahankan untuk retry, shutdown menguras seluruh accepted record, sedangkan HOLD disampling configurable default 2%. Batch 100–500, flush 1–5 detik, retention default 30 session instance, schema audit lengkap, dan redaksi secret rekursif tersedia. Migration PostgreSQL `00009`, integration test insert/redaction/retention nyata, 195 regression test, build, dan vet lulus._
  - [x] **Task 4.2 — Noise Trader**
    - **Status**: Selesai 2026-07-02 — lifecycle cancel authoritative, recovery, integration lintas Sekuritas/MATS, dan race test telah lulus.
    - **Dependency**: 4.1
    - [x] **Task 4.2.1 — Typed Config dan Strict Validation**
      Implementasikan `NoiseTraderConfig` machine-valid untuk `decision_interval_virtual_minutes`, `order_size_lots`, `buy_probability`, `max_price_deviation_pct`, `cancel_probability`, `cancel_after_virtual_minutes`, dan dynamic `symbols_universe`. Gunakan distribution schema resmi, tolak unknown/irrelevant field pada strict mode, validasi fixed symbol terhadap snapshot BEI, dan pastikan config tervalidasi sebelum persist/activate.
      - **Bukti minimum**: table-driven unit test default, boundary, malformed distribution, unknown field, fixed symbol stale/tidak dikenal, dan normal/uniform sampling.
    - [x] **Task 4.2.2 — Deterministic Random State dan Session Lifecycle**
      Sediakan random state per bot/session yang berasal dari HMAC session seed tetapi tidak di-reset pada setiap tick. Persist atau journal decision sequence yang diperlukan deterministic replay; reset tepat sekali saat session instance berubah dan tetap berbeda antarbot.
      - **Bukti minimum**: test keputusan berurutan bervariasi dalam satu sesi, replay seed+input menghasilkan urutan identik, bot berbeda tidak memakai stream identik, serta race test concurrent scheduling.
    - [x] **Task 4.2.3 — Dynamic Universe dan Intent Generation**
      Pilih symbol acak hanya dari active universe terkini; hitung side dengan inventory/sentiment bias terbatas; order size kecil 1–5 lot; sell hanya dari available shares; price deviation mengacu market reference yang ditetapkan PRD dan tetap valid terhadap tick/ARA/ARB.
      - **Bukti minimum**: unit/component test universe refresh/IPO listing, delisted/stale exclusion, buy/sell distribution, insufficient inventory, lot conversion, price deviation, dan rule boundary.
    - [x] **Task 4.2.4 — Scheduler, Realism Filter, dan Order Queue**
      Jalankan strategi melalui shared scheduler, virtual clock, bounded worker, dan `realism.Engine.PlanDecision` sebagai filter akhir. Semua place order memakai stable `client_order_id`, melewati priority queue/rate limiter, lalu Sekuritas; tidak boleh membuat goroutine/timer tak terbatas per keputusan.
      - **Bukti minimum**: component test handler benar-benar dieksekusi, reschedule tidak mati setelah transient failure, session non-continuous tidak submit, queue backpressure/TTL tercatat, dan order tidak pernah langsung ke MATS.
    - [x] **Task 4.2.5 — Open-Order Aging dan Probabilistic Cancel**
      Track order resmi yang sudah open/partially-filled beserta timestamp virtual dari account event Sekuritas. Setelah sampled `cancel_after_virtual_minutes`, evaluasi `cancel_probability`, status terminal, remaining quantity, session/NCP, dan kirim cancel idempotent melalui Sekuritas dengan priority `risk/cancel`. Pre-submit abort tidak boleh dihitung sebagai cancel order.
      - **Bukti minimum**: integration test nyata place→open→cancel→event/release reservation, duplicate cancel, partial fill, already terminal, NCP/locked, restart/recovery open order, dan timeout/unknown tanpa blind retry.
      - **Selesai 2026-07-02**: pre-submit cancel telah dihapus; order dilacak dari queue dan hanya open/partially-filled authoritative yang dapat dicancel; aging memakai `created_at` Sekuritas dan pulih dari snapshot; probabilitas/delay deterministik per client order; NCP, terminal, remaining quantity, duplicate attempt, serta submit_unknown fail-closed. Integration nyata BEI→MATS→Sekuritas membuktikan place→open→cancel→reservation release, duplicate cancel idempotent, partial fill→cancel remaining, snapshot/recovery timestamp, dan NCP defer→post-NCP cancel. Integration juga menemukan dan memperbaiki double-count fill akibat event-order race.
    - [x] **Task 4.2.6 — Decision Audit dan Noise Trader Completion Gate**
      Catat HOLD/place/reject/cancel beserta session/config/sequence dan reason yang benar, tanpa secret. Jalankan focused unit/component/integration test, race test, regression BOT, build, vet, format, dan `git diff --check`.
      - **Exit Criteria Task 4.2**: scheduler menjalankan strategi; keputusan stochastic tidak mengulang stream akibat seed reset; symbol berasal active universe; order valid dan melalui Sekuritas; cancel benar-benar bekerja pada open order; restart/replay aman; seluruh bukti 4.2.1–4.2.6 lulus.
      - **Selesai 2026-07-02**: 226 test BOT, build, vet, 10 test dan build Sekuritas, 19 PostgreSQL integration test, integration lifecycle nyata, `git diff --check`, serta race test package Noise/Portfolio melalui Go 1.25 Debian toolchain lulus.
  - [ ] **Task 4.3 — Momentum Trader**
    - **Dependency**: 4.2 selesai; gunakan ulang contract strategy runtime, jangan membuat jalur order baru.
    - [ ] **Task 4.3.1 — Typed Config, History, dan Virtual-Time Lookback**
      Definisikan config trigger/lookback/cooldown/take-profit/stop-loss menggunakan distribution typed. Bangun window history berdasarkan virtual time dan closed/public market event; tetapkan warm-up/fallback saat data belum cukup.
    - [ ] **Task 4.3.2 — Public Multi-Signal dan No-Lookahead**
      Hitung price move, volume/trade confirmation, dan sentiment publik dengan event time/checkpoint. Tolak future event, private player data, stale snapshot, serta input setelah decision timestamp.
    - [ ] **Task 4.3.3 — Trigger, Hysteresis, dan Cooldown State**
      Implementasikan distributed buy/sell trigger, minimum confirmation, hysteresis, randomized cooldown, session rollover reset, dan persisted state/checkpoint agar restart tidak menduplikasi signal.
    - [ ] **Task 4.3.4 — Position Exit dan Risk Guard**
      Implementasikan take profit, stop loss, available/reserved/pending awareness, max exposure, session boundary, dan liquidation precedence tanpa memakai pending proceeds.
    - [ ] **Task 4.3.5 — Scheduler/Queue Integration dan Decision Audit**
      Integrasikan melalui shared scheduler, realism filter, stable client order ID, queue/Sekuritas, serta material decision log. Uji stale decision, breaker, queue expiry, dan transient dependency recovery.
    - [ ] **Task 4.3.6 — Momentum Completion Tests**
      Tambahkan deterministic replay, no-lookahead, restart, config boundary, trigger/hysteresis/cooldown, order-path integration, race, dan regression test.
      - **Exit Criteria Task 4.3**: momentum hanya bereaksi pada data publik yang tersedia pada decision time; tidak duplicate signal/order setelah restart; seluruh entry/exit tunduk session, risk, accounting, dan Sekuritas path.
  - [ ] **Task 4.4 — Market Maker**
    - **Dependency**: 4.3 selesai dan MATS STP Task 0.2 tetap tervalidasi.
    - [ ] **Task 4.4.1 — Typed Quote Config dan Symbol Assignment**
      Definisikan N-level, refresh interval, size, spread, inventory target/skew, outstanding limit, dan fixed/assigned symbol secara typed serta tervalidasi terhadap active rules.
    - [ ] **Task 4.4.2 — Fee-Aware Quote Model**
      Hitung bid/ask dari public book, volatility, active tick, ARA/ARB, official fee, minimum spread, dan inventory skew. Pastikan own best bid selalu di bawah own best ask minimal satu tick.
    - [ ] **Task 4.4.3 — Outstanding Order State**
      Track client/order ID, level, side, remaining quantity, version, age, amendability, dan terminal state dari account event. Pulihkan state dari snapshot/replay setelah restart.
    - [ ] **Task 4.4.4 — Refresh, Amend, Cancel, dan Idempotency**
      Buat diff desired-versus-live quote; pilih keep/amend/cancel/place secara bounded. Semua mutation melalui Sekuritas, memakai stable idempotency, menangani partial fill/NCP/submit_unknown, dan tidak melakukan cancel-replace storm.
    - [ ] **Task 4.4.5 — STP dan Inventory/Risk Safety**
      Jalankan local STP pre-check sebelum queue, pertahankan MATS sebagai final authority, batasi inventory/exposure/order rate, dan hentikan quote pada stale dependency/session/breaker.
    - [ ] **Task 4.4.6 — Market Maker Completion Tests**
      Uji N-level formation, fee-aware spread, skew, tick boundary, quote diff, partial fill, duplicate event, restart, STP, NCP, queue pressure, race, dan integration path nyata.
      - **Exit Criteria Task 4.4**: quote tetap bounded dan recoverable; tidak ada self-trade; mutation idempotent melalui Sekuritas; outstanding state sama dengan snapshot setelah reconciliation.
  - [ ] **Task 4.5 — End-to-End MVP Test**
    - **Dependency**: 4.2, 4.3, dan 4.4 selesai secara individual.
    - [ ] **Task 4.5.1 — Deterministic E2E Fixture dan Oracle**
      Siapkan manifest 10 bot/3 strategi, symbol/rule/fee/session config, seed, expected invariants, timeout, cleanup, dan bukti service nyata tanpa mock boundary.
    - [ ] **Task 4.5.2 — Full Session Order Lifecycle**
      Jalankan satu session instance lengkap dan buktikan place, amend, cancel, partial fill, fill, expiry, settlement, serta session boundary.
    - [ ] **Task 4.5.3 — Restart, Gap, dan Reconciliation**
      Restart BOT dengan open order, putuskan stream, lakukan snapshot/replay, dan buktikan tidak ada duplicate order/reservation serta mismatch kembali nol sebelum resume.
    - [ ] **Task 4.5.4 — Safety dan Fairness Assertions**
      Buktikan tidak ada self-trade, overspend, short sell, pending reuse, stale-rule order, direct MATS injection, private/future data, atau terminal-state regression.
    - [ ] **Task 4.5.5 — Predictability Smoke dan MVP Report**
      Jalankan predictability smoke test yang ditetapkan performance plan; simpan manifest/ringkasan hasil serta tautan bukti test tanpa mengklaim performance gate Fase 7.
      - **Exit Criteria Task 4.5**: seluruh Minimum MVP Acceptance Criteria PRD memiliki automated evidence atau prosedur verifikasi yang dapat diulang dan seluruh invariant bernilai lulus.
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
    - [ ] **5.1.1 Config dan public reference data**: typed decline/recovery/patience/stage/max-position config; intraday high/reference hanya dari data publik dan event time sah.
    - [ ] **5.1.2 Entry state machine**: distributed dip trigger, multi-signal confirmation, hysteresis, staged accumulation, virtual-time patience, dan cooldown.
    - [ ] **5.1.3 Exit dan accounting guard**: recovery exit, stop/risk precedence, concentration, available/reserved/pending awareness, serta session boundary.
    - [ ] **5.1.4 Persistence dan completion tests**: checkpoint/restart, deterministic replay, no-lookahead, order-path integration, failure recovery, dan audit log.
  - [ ] **Task 5.2 — Value Investor**
    - [ ] **5.2.1 Closed-session history**: bangun MA-200 hanya dari session instance finalized, dengan version/checkpoint dan fallback eksplisit jika history kurang.
    - [ ] **5.2.2 Valuation/config model**: typed margin-of-safety, rebalance interval, concentration, order slicing, dan bounded drift.
    - [ ] **5.2.3 Slow rebalance execution**: target portfolio, available funds/positions, fee awareness, TTL/rate limit, dan mutation melalui Sekuritas.
    - [ ] **5.2.4 Persistence dan completion tests**: multi-session/restart, insufficient history, corporate action adjustment, deterministic replay, dan integration test.
  - [ ] **Task 5.3 — Bandar Multi-Session**
    - [ ] **5.3.1 Typed config dan transition contract**: definisikan accumulation→mark-up→distribution beserta legal transition, conditional signal, min/max session, dan terminal/abort path.
    - [ ] **5.3.2 Persisted multi-session state**: session counter, inventory/capital basis, checkpoint/version, rollover tepat sekali, optimistic concurrency, dan restart restore.
    - [ ] **5.3.3 Phase execution**: staged orders, price/inventory guard, public signal confirmation, cooldown/hysteresis, fee/risk/session compliance.
    - [ ] **5.3.4 STP dan completion tests**: own-order awareness, local STP plus MATS authority, restart tiap fase, concurrent update, deterministic replay, dan multi-session integration.
  - [ ] **Task 5.4 — Event-Driven & IPO Hunter**
    - [ ] **5.4.1 Fair announcement ingestion**: dedupe/version, `published_at`/`received_at` gate, event intensity, reaction delay, dan penolakan future/private/`simulation_only` event.
    - [ ] **5.4.2 Event strategy state**: typed mapping event→signal, confirmation/cooldown/expiry, symbol scope, restart checkpoint, dan decision audit.
    - [ ] **5.4.3 IPO subscription client**: discovery dan subscribe/cancel hanya melalui Sekuritas dengan JWT/idempotency, lot/window/full-reserve validation, serta timeout lookup.
    - [ ] **5.4.4 Allocation/listing lifecycle**: partial/zero allocation, fee/debit/refund, pending shares, reversal, duplicate webhook, dan first-listing behavior.
    - [ ] **5.4.5 Completion tests**: fairness timing, restart/outbox/replay, reserve→allocation→refund→listing/reversal integration nyata, dan reconciliation.
  - [ ] **Task 5.5 — Index Tracker**
    - [ ] **5.5.1 MDX composition state**: consume version/effective time, validate weights, cache/checkpoint, reject rollback, dan disable hanya Index Tracker ketika stale.
    - [ ] **5.5.2 Target portfolio dan tracking error**: hitung target berbasis available/reserved/pending, price/fee, concentration, dan rebalance setiap 5 session instance.
    - [ ] **5.5.3 TWAP execution**: bounded slice, virtual schedule, TTL, rate limit, partial fill/remainder, stable ID, dan queue/Sekuritas path.
    - [ ] **5.5.4 Completion tests**: composition change, stale/invalid weight, restart mid-rebalance, insufficient cash, deterministic slicing, dan integration/reconciliation.
  - [ ] **Task 5.6 — Panic Seller Scenario Actor**
    - [ ] **5.6.1 Scenario-only config/lifecycle**: explicit `simulation_only`, admin/manual trigger contract, duration, symbol/actor scope, risk cap, idempotent start/stop, dan larangan registry autonomous.
    - [ ] **5.6.2 Execution dan isolation**: bounded sell behavior melalui Sekuritas, public market effects, rate/session/risk/STP compliance, serta tidak bocor ke live normal mode.
    - [ ] **5.6.3 Cleanup/recovery**: cancel cancellable order saat scenario selesai, track NCP/locked sampai terminal, restart restore, dan audit.
    - [ ] **5.6.4 Completion tests**: normal-mode exclusion, duplicate trigger, timeout, cleanup, NCP, restart, and accounting/reconciliation invariant.
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
    - [ ] **6.1.1 Auth/audit/error contract**: scoped admin token, correlation/idempotency, validation envelope, actor/reason, secret redaction, dan immutable audit.
    - [ ] **6.1.2 Per-bot lifecycle controls**: pause/resume/disable dan cancel variants sesuai state machine, optimistic version, readiness guard, dan restart persistence.
    - [ ] **6.1.3 Global controls**: pause-all/resume-all/kill-switch dengan bounded batch, NCP tracking, explicit recovery, dan account stream tetap berjalan.
    - [ ] **6.1.4 Runtime mutations**: sentiment/scenario/config update dengan typed validation, effective-session semantics, expiry, version conflict, dan rollback-safe failure.
    - [ ] **6.1.5 Read APIs dan completion tests**: performance/audit/health/readiness pagination, auth/contract/concurrency/failure/restart/integration tests.
  - [ ] **Task 6.2 — Super Admin Sekuritas Integration**
    - [ ] **6.2.1 Backend proxy contract**: allowlisted BOT endpoint, server-side scoped credential, timeout/error mapping/correlation, audit, dan larangan secret ke browser.
    - [ ] **6.2.2 Control UI**: lifecycle/global/sentiment/scenario/config controls dengan loading/error/version-conflict/confirmation/accessibility state.
    - [ ] **6.2.3 Observability UI**: health/readiness/performance/audit views dengan pagination dan bounded refresh; tanpa frontend BOT/port 8080 terpisah.
    - [ ] **6.2.4 Security/integration tests**: unauthorized/forbidden, proxy failure, concurrent update, secret scan, browser contract, dan admin action audit.
  - [ ] **Task 6.3 — Dashboard Query Efficiency**
    - [ ] **6.3.1 Query/index audit**: tetapkan query shape, pagination cursor, required index, explain baseline, dan larangan N+1.
    - [ ] **6.3.2 Aggregation/cache**: agregasi 2–5 detik, bounded cache/invalidation, cached metrics, dan satu shared feed alih-alih query/WS per bot/event.
    - [ ] **6.3.3 Load/completion tests**: ukur latency, DB connections/query count, memory, stale bound, pagination consistency, dan cache failure fallback.
  - [ ] **Task 6.4 — Fairness Audit**
    - [ ] **6.4.1 Data-flow static audit**: petakan setiap input strategi dan buktikan tidak ada private player state, direct DB lintas layanan, atau direct MATS order.
    - [ ] **6.4.2 Runtime fairness assertions**: future event, unpublished event, stale rules, pending fund reuse, BOT-only live event, dan privilege scope harus fail-closed.
    - [ ] **6.4.3 Adversarial/completion tests**: injeksikan payload terlarang/stale/future, token salah scope, boundary bypass, dan simpan evidence pass/fail.
  - [ ] **Task 6.5 — Scenario A–E Tests**
    - [ ] **6.5.1 Reusable scenario harness**: manifest, deterministic input, trigger, oracle, metric range, timeout, cleanup, artifact, dan failure diagnostics.
    - [ ] **6.5.2 Scenario A — Hari Normal**.
    - [ ] **6.5.3 Scenario B — Akumulasi Bandar**.
    - [ ] **6.5.4 Scenario C — Saham Terbang**.
    - [ ] **6.5.5 Scenario D — Market Crash**.
    - [ ] **6.5.6 Scenario E — Reaksi Korporasi**.
    - [ ] **6.5.7 Cross-scenario cleanup/reconciliation report**: tidak ada state bocor, saldo/custody/session/STP/rate-limit invariant lulus.
- **Exit Criteria**:
  - [ ] Admin action teraudit dan aman terhadap concurrent update.
  - [ ] Seluruh scenario menjaga invariants saldo, custody, session rules, STP, dan rate limit.

---

## Fase 7: Performance Scaling, Deployment, dan Operational Readiness

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 6.
- **Tugas**:
  - [ ] **Task 7.1 — 100 Bot Baseline**
    - [ ] **7.1.1 Reproducible manifest/instrumentation**: environment/service version, dataset, symbols, session, seed, DB size, log level, dan metric completeness.
    - [ ] **7.1.2 Canonical run**: warm-up dan full workload 100 bot tanpa mengubah normative rate limit.
    - [ ] **7.1.3 Profile/report**: CPU/RSS/GC/goroutine/queue/API/DB/event lag/reconciliation/memory trend beserta raw artifact dan bottleneck.
    - [ ] **7.1.4 Correctness gate**: invariant, restart/leak check, dan repeatability lulus sebelum 7.2.
  - [ ] **Task 7.2 — 300–500 Bot Default Gate**
    - [ ] **7.2.1 300-bot clean dan developer-realistic run**.
    - [ ] **7.2.2 500-bot clean dan developer-realistic run**.
    - [ ] **7.2.3 Budget verification**: BOT RSS ≤ 500 MB, average CPU ≤ 10%, peak ≤ 40%, total stack RAM ≤ 12 GB, queue p95 ≤ 2 detik, Sekuritas API p95 ≤ 500 ms, serta correctness gates.
    - [ ] **7.2.4 Profile-driven tuning and rerun**: hanya optimasi bottleneck terukur; dilarang menaikkan global rate limit untuk menutupi queue/scheduler issue.
    - [ ] **7.2.5 Default-capacity report**: manifest, raw metrics, comparison, failures, reconciliation, dan keputusan pass/fail.
  - [ ] **Task 7.3 — 1.000 Bot Extended Test**
    - [ ] **7.3.1 Capacity/readiness precheck**: 7.2 lulus, connection/worker/queue bounds tervalidasi, rate limit tidak dinaikkan.
    - [ ] **7.3.2 Canonical run dan failure behavior**.
    - [ ] **7.3.3 Bottleneck profile dan bounded tuning**.
    - [ ] **7.3.4 Repeat run/report**: correctness, fail-safe behavior, resource trend, dan batas operasional terdokumentasi.
  - [ ] **Task 7.4 — 2.000 Bot Stress Test**
    - [ ] **7.4.1 Stress manifest dan abort/safety threshold**.
    - [ ] **7.4.2 Maximum stress run tanpa menjadikannya default**.
    - [ ] **7.4.3 Degradation/recovery verification**: breaker, backpressure, no data corruption, reconciliation setelah load turun.
    - [ ] **7.4.4 Stress report**: bottleneck dan failure terdokumentasi; budget miss tidak menggagalkan default 300–500 jika fail-safe.
  - [ ] **Task 7.5 — Development/Production Deployment**
    - [ ] **7.5.1 Environment isolation**: API 9090/9091, DB 5435/5535, env/secret/volume/network terpisah dan loopback binding.
    - [ ] **7.5.2 Migration/startup/shutdown**: version check, no runtime auto-migrate, dependency gate, graceful drain, restart recovery.
    - [ ] **7.5.3 Logging/backup/restore/token rotation**: rotation/retention, encrypted backup, restore drill, scoped secret rotation.
    - [ ] **7.5.4 Deployment security/recovery tests**: tunnel exposure scan, cross-env isolation, failed migration, crash/restart, backup restore.
  - [ ] **Task 7.6 — `start-all.bat` Integration**
    - [ ] **7.6.1 BOT DB dan migration orchestration**.
    - [ ] **7.6.2 Dependency readiness/order**: BOT hanya start setelah Sekuritas dan required BEI/MATS contract ready; timeout/error terlihat.
    - [ ] **7.6.3 Shutdown/restart behavior**: process ownership, cleanup, idempotent rerun, dan tidak meninggalkan duplicate instance.
    - [ ] **7.6.4 Exposure/completion tests**: hapus Control Panel 8080, production tunnel tidak mengekspos internal service, smoke test dev/prod config.
  - [ ] **Task 7.7 — Operational Runbook**
    - [ ] **7.7.1 Normal operations**: start/stop/restart/status/migration/genesis.
    - [ ] **7.7.2 Recovery operations**: reconcile/event gap/breaker/queue/DB/stream/dependency recovery.
    - [ ] **7.7.3 Security/data operations**: backup/restore/token rotation/secret incident.
    - [ ] **7.7.4 Benchmark/emergency operations**: canonical run, evidence collection, kill switch, rollback/escalation.
    - [ ] **7.7.5 Runbook drill**: operator lain mengikuti prosedur pada environment bersih dan hasilnya dicatat.
  - [ ] **Task 7.8 — Failure Injection & Soak Report**
    - [ ] **7.8.1 Soak harness/artifact retention**: 500 bot, 10 session, manifest, periodic snapshot, metric/raw log, pass/fail oracle.
    - [ ] **7.8.2 Dependency injections**: MATS, Sekuritas, BEI, account/market stream disconnect/stale/timeout.
    - [ ] **7.8.3 Internal injections**: DB unavailable, queue pressure, worker panic, kill switch, restart, slow consumer.
    - [ ] **7.8.4 Post-failure reconciliation/leak check**: mismatch nol, no duplicate, no negative accounting, resource trend bounded.
    - [ ] **7.8.5 Final soak report**: summary, failures/root cause, recovery time, metrics, reconciliation, unresolved risk, dan explicit pass/fail.
- **Exit Criteria**:
  - [ ] Default 300–500 bot lulus seluruh performance budget dan multi-session soak test.
  - [ ] Startup/restart tidak membutuhkan koreksi database manual.
  - [ ] Production secret, database, dan volume terisolasi dari development.

---

## Fase 8: [OPTIONAL] Sector Correlation Engine

- **Status**: [ ] Ditunda/Opsional
- **Dependency**: Fase 7 stabil.
- **Tugas**:
  - [ ] **Task 8.1 — Sector Metadata Contract**
    - [ ] **8.1.1** Tetapkan authority BEI, schema sector/industry, effective time, version, dan backward compatibility.
    - [ ] **8.1.2** Implementasikan ingestion/cache/freshness serta mapping symbol yang fail-closed terhadap version rollback.
    - [ ] **8.1.3** Tambahkan contract/restart/change tests dan dokumentasikan consumer strategy.
  - [ ] **Task 8.2 — Local Correlation Baseline**
    - [ ] **8.2.1** Tetapkan workload/dataset/window/metric correctness dan memory/CPU budget.
    - [ ] **8.2.2** Implementasikan atau gunakan dependency kecil teruji untuk perhitungan lokal bounded tanpa mengganggu market loop.
    - [ ] **8.2.3** Benchmark/profile local engine dan dokumentasikan keputusan cukup/tidak cukup berdasarkan data.
  - [ ] **Task 8.3 — Optional External Compute**
    - [ ] **8.3.1** Hanya aktif jika bukti 8.2 menunjukkan kebutuhan; tetapkan versioned request/response dan data-minimization boundary.
    - [ ] **8.3.2** Implementasikan authenticated outbound channel/webhook, scoped secret, replay protection, correlation, timeout, retry/idempotency, dan circuit breaker.
    - [ ] **8.3.3** Sediakan fail-safe local fallback serta integration/failure/security test untuk duplicate, stale response, outage, dan recovery.

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
