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

- **Status**: [ ] Dalam pengerjaan — audit 2026-06-29: provisioning, identity, session/STP, MDX, snapshot, dan sequenced account stream sudah memiliki implementasi; genesis saga dan IPO investor lifecycle belum sesuai kontrak normatif sehingga fase belum selesai.
- **Blocking**: Seluruh Fase 1–7 bergantung pada kontrak yang relevan di fase ini.
- **Tugas**:
  - [x] **Task 0.1 — Trading Session Instance (BEI + MATS)**
    BEI menjadi creator/persistence authority session instance; MATS menjadi segment executor dengan lock/lease dan melanjutkan instance aktif setelah restart. Setiap putaran menghasilkan `session_instance_id` UUID dan `virtual_day_index` unik/monotonik. Tambahkan `virtual_duration_seconds`, `real_duration_seconds`, expected version, idempotent transition/finality, serta event/snapshot lengkap.
  - [x] **Task 0.2 — Self-Trade Prevention (MATS)**
    Implementasikan STP berdasarkan account ID dengan default `cancel_newest`. Publikasikan status/reason `self_trade_prevented`; tidak boleh menghasilkan trade atau fee.
  - [x] **Task 0.3 — BOT Service Identity & Scope**
    Tambahkan token BOT pada BEI, MATS, dan Sekuritas dengan least privilege. BEI: `market:read`, `rules:read`, `corporate-action:read`; MATS: `market:read`; Sekuritas: scope khusus internal BOT provisioning/token/snapshot/event. Token development dan production harus berbeda.
  - [ ] **Task 0.4 — Idempotent Batch Provisioning & JWT Issuance (Sekuritas)**
    Implementasikan `POST /api/v1/internal/bots/provision` dan `POST /api/v1/internal/bots/tokens`. Tambahkan unique `external_bot_id`, idempotency key, response `created/existing/failed`, short-lived JWT, staggered refresh, audit log, serta larangan logging secret.
  - [ ] **Task 0.5 — Genesis Seeding Saga (Sekuritas + BEI)**  
    Implementasikan `POST /api/v1/internal/bots/genesis`, `genesis_run_id`, payload hash, outbox/retry/compensation, cash ledger Sekuritas, dan custody ledger BEI. Payload inventory memakai lembar. Genesis hanya boleh selesai sekali dan harus aman di-retry.
  - [ ] **Task 0.6 — Bulk Portfolio Snapshot & Sequenced Account Event Stream (Sekuritas)**
    Implementasikan `POST /api/v1/internal/bots/portfolio-snapshot` dan `GET /api/v1/internal/bots/events/ws?after_sequence=...`. Snapshot transaction-consistent membawa `as_of_sequence`. Stream memakai global monotonic sequence, at-least-once delivery, retention, replay, heartbeat, explicit slow-consumer disconnect, gap detection, order lifecycle, settlement, dan corporate action.
  - [ ] **Task 0.7 — IPO Subscription via Sekuritas**  
    Implementasikan event lifecycle `draft → bookbuilding → subscription → allocation → listed/cancelled` dan `POST /api/v1/ipo-events/:id/subscriptions` untuk user/BOT JWT. Cakupan wajib meliputi subscription lot size, window validation, full cash reserve, cancel sebelum allocation, forwarding idempotent ke BEI, partial/zero allocation, official fee, debit aktual, refund, pending shares sampai listing, exceptional reversal, notification, outbox, duplicate protection, dan reconciliation.
  - [x] **Task 0.8 — Komposisi Indeks MDX (BEI)**
    Implementasikan `GET /v1/indices/MDX/composition` dengan symbol, weight, effective time, dan version. Tambahkan contract test untuk perubahan komposisi.
  - [x] **Task 0.9 — Rule/Fee/Session Contract Finalization**
    Tetapkan dan uji kontrak existing `GET /v1/public/securities`, `GET /v1/integration/mats/rules`, `GET /v1/public/fee-schedule`, dan `GET /v1/integration/mats/sessions/active`. Jangan membuat endpoint sesi duplikatif.
  - [ ] **Task 0.10 — Cross-Service Contract & Recovery Tests**  
    Implementasikan schema/error/idempotency dari `BOT_API_CONTRACTS.md`; uji retry provisioning, partial genesis failure, event gap/replay, snapshot concurrent event, slow consumer, submit unknown, restart dengan open order, duplicate webhook, settlement, IPO reserve/cancel/partial allocation/refund/listing/reversal, session rollover, concurrent transition, dan STP.
  - [ ] **Task 0.11 — Contract Freeze Review**  
    Cocokkan implementasi BEI/MATS/Sekuritas dengan `BOT_API_CONTRACTS.md` dan `BOT_STATE_MACHINES.md`; version-kan perubahan, catat backward compatibility/migration, dan larang Fase 1 memakai mock yang berbeda dari contract final.
- **Exit Criteria**:
  - [ ] Seluruh endpoint memiliki schema request/response, auth scope, error code, idempotency, dan integration test.
  - [ ] State transition dan accounting lulus invariants pada `BOT_STATE_MACHINES.md`.
  - [x] Satu session rollover menghasilkan instance ID baru.
  - [ ] Genesis menghasilkan saldo Sekuritas dan custody BEI yang dapat direkonsiliasi.
  - [x] Account event gap dapat dipulihkan dengan replay atau snapshot.

---

## Fase 1: Fondasi BOT Service, Database, Scheduler, dan Safety

- **Status**: [ ] Dalam pengerjaan — fondasi build/migration/scheduler/queue/readiness tersedia, tetapi config precedence/runtime override, breaker lengkap, metrics operasional, dan failure tests belum memenuhi seluruh task.
- **Dependency**: Task 0.3 dan kontrak schema PRD.
- **Tugas**:
  - [ ] **Task 1.1 — Go Project & Dependency Setup**
    Buat module `BOT/` dengan `chi`, `coder/websocket`, `pgx/v5`, `goose`, `go-redis/v9`, `yaml.v3`, dan `x/time/rate`. Ikuti struktur direktori PRD Bagian 9.3.
  - [x] **Task 1.2 — Environment & Validation**
    Sediakan `.env.development.example`, `.env.production.example`, env Docker, validasi startup, secret redaction, dan port matrix: API 9090/9091, PostgreSQL 5435/5535.
  - [x] **Task 1.3 — Versioned Database Migration**
    Implementasikan schema `bots`, encrypted token cache opsional, `simulation_runs`, `genesis_runs`, config versions, state snapshots, event checkpoints, decision logs, session performance, sentiment, dan scenario events. Gunakan `BIGINT/NUMERIC` untuk uang; tidak memakai runtime auto-migrate.
  - [ ] **Task 1.4 — Config Source of Truth**  
    Implementasikan precedence compiled defaults → YAML bootstrap → DB config → persisted runtime override. Tambahkan `config_version`, optimistic locking, validation per strategy, dan explicit YAML reconcile.
  - [ ] **Task 1.5 — Shared Market State & Scheduler**
    Implementasikan immutable snapshot per symbol, min-heap/timing-wheel atau scheduler shard, 4–8 strategy workers, deterministic jitter, bounded concurrency, dan panic isolation per task.
  - [ ] **Task 1.6 — Priority Order Queue & Rate Limiter**
    Implementasikan prioritas `risk/cancel` → `market/event` → `normal` → `market-maker refresh`; sustained 300/menit, burst 100/10 detik, hard limit 600/menit, queue 5.000, 10 order workers, TTL normatif, dan `expired_before_submit`. Tambahkan stable `client_order_id`, local `submit_unknown`, lookup by client ID, serta larangan blind retry.
  - [ ] **Task 1.7 — Circuit Breaker & Readiness State Machine**  
    Implementasikan per-bot spam cooldown, total breaker, reject surge, queue pressure, dependency stale, kill switch, serta readiness `starting → syncing → ready → degraded → halted`.
  - [ ] **Task 1.8 — Structured Logging & Metrics**  
    Tambahkan metric CPU/RSS, goroutine, queue depth/wait, API latency, order rate, reject, event lag, reconciliation mismatch, scheduler lag, dan DB pool. Structured log wajib meredaksi secret.
- **Exit Criteria**:
  - [ ] Unit test scheduler, queue priority, TTL, rate limiter, config version, breaker, dan migration lulus.
  - [x] Service idle dapat start/stop bersih tanpa dependency nyata.
  - [x] DB connection pool maksimum default 15.

---

## Fase 2: Konektivitas, Identity, Market State, dan Recovery

- **Status**: [ ] Dalam pengerjaan — audit 2026-06-29 menemukan kontrak account-event stream Sekuritas belum tersedia dan integration test nyata belum lulus.
- **Dependency**: Task 0.1, 0.3, 0.4, 0.6, 0.9 dan Fase 1.
- **Tugas**:
  - [ ] **Task 2.1 — Provisioning & Token Client**  
    Implementasikan client batch provisioning, external bot mapping, short-lived JWT cache terenkripsi, staggered refresh 5–10 menit sebelum expiry, dan retry idempotent.
  - [ ] **Task 2.2 — Genesis Client & Startup Gate**  
    Jalankan genesis hanya melalui explicit initialization command/admin action. Service tidak ready sampai hasil genesis/reconciliation konsisten.
  - [ ] **Task 2.3 — MATS Market WebSocket**  
    Satu koneksi authenticated `market:read`, reconnect/backoff, heartbeat, resubscribe, sequence monitoring, depth, trade tape, price, summary, halt, suspend, session state, dan timer. Readiness menunggu initial snapshot seluruh universe melalui subscribe list atau bulk snapshot contract.
  - [ ] **Task 2.4 — BEI Discovery, Rules, Fee, dan MDX Client**  
    Cache listed securities, rules, fee schedule, corporate action/IPO metadata, dan MDX composition dengan version/effective time. Terapkan freshness threshold/aksi degradation dari `BOT_API_CONTRACTS.md`; fail-closed jika rules/session/account stream stale.
  - [ ] **Task 2.5 — Sekuritas Bulk Snapshot**  
    Muat cash, positions, open orders, dan checkpoint seluruh bot melalui batch API; tidak ada direct DB access.
  - [ ] **Task 2.6 — Sekuritas Account Event Consumer**  
    Konsumsi satu stream seluruh akun bot, terapkan sequence/checkpoint, replay, gap detection, dan pause/snapshot/resume recovery.
  - [ ] **Task 2.7 — Periodic Reconciliation**  
    Reconcile setiap 60 detik dalam batch 50–100 akun. Mismatch harus terukur, teraudit, dan tidak diperbaiki dengan menimpa Sekuritas dari BOT.
  - [ ] **Task 2.8 — Session Monitor & Virtual Clock**  
    Gunakan session instance sebagai daily boundary. Konversi virtual delay ke real delay dari duration/progress sesi, tangani reconnect dan rollover.
- **Exit Criteria**:
  - [ ] PoC 10 akun dapat provision, memperoleh JWT, snapshot, menerima event, dan rollover sesi.
  - [ ] Restart dengan open order tidak membuat reservation ganda.
  - [ ] Putuskan account stream dan MATS WS secara sengaja; recovery berhasil tanpa order stale.

---

## Fase 3: Portfolio Accounting, Risk, Realism, dan Deterministic Mode

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 2.
- **Tugas**:
  - [ ] **Task 3.1 — Portfolio Cache Lifecycle**  
    Implementasikan seluruh transition dan rounding pada `BOT_STATE_MACHINES.md`: cash/position `available-reserved-pending`, weighted average, fee resmi Sekuritas, market-order reserve, amend reservation, open order, partial fill, cancel, reject, expiry, settlement, dan corporate action.
  - [ ] **Task 3.2 — Dynamic Tick/ARA/ARB/Lot/Fee Helpers**  
    `GetValidPriceTick` memakai snapshot rule BEI, side-aware rounding, clamp price band, active lot size, dan fee schedule efektif.
  - [ ] **Task 3.3 — Risk & Bankruptcy**  
    Implementasikan max exposure saat buy baru, daily/weekly loss berdasarkan session instance, inventory limit, out-of-cash liquidation, dan status permanen `bankrupt`.
  - [ ] **Task 3.4 — U-Shaped Activity & Human Imperfections**  
    Implementasikan progress sesi berbasis persentase, compressed virtual delays, fat finger yang tetap valid rule, abort, overreaction, inactive session, dan bounded jitter. Gunakan typed distribution pada `BOT_STRATEGY_SPEC.md`.
  - [ ] **Task 3.5 — Herd Behavior & Market Sentiment**  
    Implementasikan sentiment global/sektor, volatility regime, contagion, probability cap, versioning, dan expiry override.
  - [ ] **Task 3.6 — Fair Event Context & Scenario Actor**  
    Event normal harus memiliki BEI announcement/published time sebelum BOT bereaksi. `simulation_only` hanya untuk stress test. Panic Seller dibuat sebagai scenario actor, bukan populasi autonomous.
  - [ ] **Task 3.7 — Strategy State Persistence**  
    Persist state Bandar/Value/Index dan checkpoint dengan `state_version`; snapshot saat transition/material change dan shutdown.
  - [ ] **Task 3.8 — Deterministic Test Runtime**  
    Simpan simulation run ID, global/per-bot seed, virtual clock, config snapshot, input journal, event sequence, dan scheduler ordering. Live mode tidak menjanjikan bit-for-bit replay.
  - [ ] **Task 3.9 — Anti-Predictability Baseline**  
    Implementasikan HMAC session seed, population rotation, bounded parameter drift, multi-signal confirmation, hysteresis, random cooldown, dan conditional Bandar transition sesuai `BOT_STRATEGY_SPEC.md`. Tidak memakai private player data.
- **Exit Criteria**:
  - [ ] Accounting lokal selalu kembali sama dengan snapshot Sekuritas setelah reconciliation.
  - [ ] Daily reset terjadi pada session rollover, bukan pergantian tanggal komputer.
  - [ ] Replay deterministic menghasilkan urutan keputusan/order yang sama.

---

## Fase 4: MVP Trading Strategies dan Decision Audit

- **Status**: [ ] Belum Mulai
- **Dependency**: Fase 3.
- **Tugas**:
  - [ ] **Task 4.1 — Decision Log Pipeline**  
    Log seluruh action/reject/risk/breaker, sampling HOLD default 2%, batch insert 100–500, flush 1–5 detik, retention 30 session instance, dan secret redaction.
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
