# Agent-Based Market Simulation Roadmap

**Versi**: 1.0  
**Tanggal**: 2026-06-29  
**Status**: Roadmap pengembangan lanjutan — tidak memblokir MVP BOT  
**Dokumen induk**: `docs/BOT/BOT_PRD.md`  

**Dokumen pendamping**:

- `BOT_STRATEGY_SPEC.md` untuk baseline stochastic behavior dan anti-predictability sebelum MVP strategi.
- `BOT_PERFORMANCE_TEST_PLAN.md` untuk canonical workload, scenario oracle, dan predictability smoke test.
- `BOT_API_CONTRACTS.md` dan `BOT_STATE_MACHINES.md` untuk correctness/recovery yang menjadi fondasi eksperimen.

---

## 1. Tujuan Dokumen

Dokumen ini memformalkan BOT Mandala Exchange sebagai **Agent-Based Market Simulation (ABMS)** dan menjadi acuan pengembangan setelah BOT MVP, kontrak lintas layanan, recovery, fairness, serta performance gate utama stabil.

Roadmap ini bertujuan untuk:

1. Menjadikan perilaku pasar hasil simulasi dapat diuji, dibandingkan, dan dikalibrasi.
2. Memisahkan realisme pasar dari sekadar randomisasi.
3. Mengukur emergent behavior yang muncul dari interaksi agent.
4. Menyediakan eksperimen yang reproducible tanpa mengorbankan mode live.
5. Mengukur predictability BOT dari data publik agar pola mekanis dapat ditemukan sebelum dieksploitasi player.
6. Menjaga fairness: agent hanya bereaksi terhadap informasi yang juga tersedia bagi player.

Roadmap ini bukan alasan untuk menunda Fase 0–7 pada `BOT_MAIN_PLAN.md`.

---

## 2. Klasifikasi Model

Mandala Exchange BOT diklasifikasikan sebagai:

> **Heterogeneous, stochastic, event-driven agent-based financial market simulation dengan discrete session time dan continuous market event processing.**

Karakteristiknya:

- **Heterogeneous**: Agent mempunyai strategi, modal, risk appetite, reaction delay, dan state berbeda.
- **Stochastic**: Keputusan mengandung probability distribution dan random seed.
- **Event-driven**: Agent menerima perubahan market, session, order, settlement, corporate action, dan announcement.
- **Stateful**: Portfolio, open order, memory strategi, dan performance bertahan lintas event/sesi.
- **Interactive**: Keputusan agent mengubah order book, lalu perubahan tersebut memengaruhi agent lain.
- **Emergent**: Harga, volume, spread, volatilitas, FOMO, panic, dan liquidity regime tidak ditentukan langsung oleh satu controller pusat.

BOT tidak harus memakai machine learning agar disebut ABM. Rule-based autonomous agent tetap merupakan ABM selama agent memiliki state, policy, environment, dan interaksi.

---

## 3. Komponen Model

### 3.1 Agent

Unit agent adalah satu akun BOT dengan:

- Identity dan tier.
- Strategy policy.
- Cash dan securities state.
- Risk limits.
- Memory dan strategy state.
- Random state.
- Perception delay.
- Decision interval.
- Allowed symbols.
- Order dan cancellation policy.

Delapan autonomous agent archetype:

1. Noise Trader.
2. Momentum Trader.
3. Contrarian / Dip Buyer.
4. Market Maker.
5. Value Investor.
6. Bandar.
7. Event-Driven / IPO Hunter.
8. Index Tracker.

Panic Seller tetap menjadi **scenario actor**, bukan populasi autonomous default.

### 3.2 Environment

Environment agent terdiri dari:

- MATS order book dan matching engine.
- Trading session dan virtual clock.
- Listed securities dan market rules BEI.
- Fee/tax schedule.
- Corporate action dan IPO.
- Public announcement.
- Market sentiment dan volatility regime.
- Sekuritas account/order/settlement lifecycle.

### 3.3 Interaction

Agent tidak berkomunikasi privat satu sama lain. Interaksi terjadi melalui:

- Bid/ask dan depth.
- Trade tape.
- Last price dan market summary.
- Volume/frequency.
- Public announcement.
- Session transition.
- Market halt/suspend.

Herd behavior dihitung dari observable market activity atau aggregate public signal, bukan pesan rahasia antarbots.

### 3.4 Time

Model waktu menggunakan:

- `session_instance_id` sebagai satu hari virtual.
- `virtual_day_index` sebagai urutan hari simulasi.
- `virtual_duration_seconds` dan `real_duration_seconds` sebagai compression ratio.
- Event timestamp dan sequence.
- Virtual delay untuk reaction, patience, cooldown, dan strategy interval.

Tanggal kalender komputer tidak menjadi daily boundary model.

---

## 4. Prinsip Desain ABM

### 4.1 Bounded Rationality

Agent tidak mengetahui masa depan dan tidak mengoptimalkan pasar secara sempurna. Keputusan dibatasi oleh:

- Data publik yang diterima.
- Delay.
- Limited lookback.
- Portfolio sendiri.
- Risk limit.
- Strategy-specific heuristic.
- Probability of error, hesitation, dan overreaction.

### 4.2 Local Decision, Global Emergence

Controller global boleh mengatur session, scenario, atau sentiment regime, tetapi tidak boleh menentukan seluruh order agent satu per satu untuk menghasilkan chart yang diinginkan.

Harga dan volume harus muncul dari order serta matching aktual.

### 4.3 Fairness

Agent dilarang:

- Membaca portfolio atau pending order player.
- Menargetkan player berdasarkan identity.
- Membaca future announcement.
- Menggunakan direct MATS order injection.
- Menghindari fee, settlement, ARA/ARB, lot size, STP, atau risk rule.

Adaptive behavior hanya boleh menggunakan public market data dan state agent sendiri.

### 4.4 Realism Before Unpredictability

Tujuan model bukan membuat BOT mustahil dikalahkan. Prioritasnya:

1. Market behavior masuk akal.
2. Individual action tidak mekanis.
3. Aggregate cause-and-effect tetap dapat dipahami.
4. Tidak ada pola exact yang dapat dieksploitasi tanpa risiko.

Random noise tidak boleh digunakan untuk menutupi model yang salah.

---

## 5. Dokumentasi Model dengan ODD

Setiap versi model ABM sebaiknya memiliki spesifikasi **ODD: Overview, Design Concepts, and Details**.

### 5.1 Overview

- Purpose.
- Entities, state variables, dan scales.
- Process overview dan scheduling.

### 5.2 Design Concepts

- Basic principles.
- Emergence.
- Adaptation.
- Objectives.
- Learning, jika kelak digunakan.
- Prediction.
- Sensing.
- Interaction.
- Stochasticity.
- Collectives.
- Observation.

### 5.3 Details

- Initialization.
- Input data.
- Submodels setiap strategi.
- Parameter distribution.
- Session transition.
- Settlement/recovery behavior.

Setiap perubahan material terhadap strategy rule atau scheduler harus menaikkan `model_version`.

---

## 6. Model Versioning

Setiap simulation run mencatat:

```yaml
model:
  model_version: "abm-1.0.0"
  strategy_bundle_version: "strategies-1.0.0"
  scheduler_version: "scheduler-1.0.0"
  config_schema_version: 1
  rule_snapshot_version: "<BEI rule version>"
  fee_snapshot_version: "<BEI fee version>"
```

Version bump:

- **Major**: Perubahan mekanisme agent/interaksi yang mengubah interpretasi hasil.
- **Minor**: Strategy/submodel baru atau perubahan parameter semantics.
- **Patch**: Bug fix yang tidak mengubah intent model.

Run dengan model version berbeda tidak boleh dibandingkan tanpa label yang jelas.

---

## 7. Experiment Framework

### 7.1 Experiment Definition

Eksperimen didefinisikan sebagai data, bukan hardcoded test:

```yaml
experiment:
  id: "exp-liquidity-001"
  name: "Market maker population sensitivity"
  runtime_mode: deterministic_test
  model_version: "abm-1.0.0"
  repetitions: 30
  sessions_per_run: 50
  warmup_sessions: 10

  population:
    total_active: 500
    market_maker_pct: [2, 5, 8]

  controlled_variables:
    global_sentiment: neutral
    ipo_events: disabled
    human_players: synthetic_baseline

  outputs:
    - spread
    - depth
    - turnover
    - volatility
    - fill_rate
```

### 7.2 Run Manifest

Setiap run wajib merekam:

- Simulation run ID.
- Experiment ID.
- Model/config versions.
- Global dan per-agent seed.
- Session instances.
- Initial portfolio snapshot hash.
- Rule/fee/security snapshot hashes.
- Input event journal.
- Build commit/hash.
- Start/end timestamp.
- Runtime resource metrics.
- Result status dan failure reason.

### 7.3 Repetition

Satu hasil run tidak cukup untuk menyimpulkan perilaku model. Eksperimen stochastic wajib memiliki beberapa repetition dengan seed berbeda.

Jumlah awal yang disarankan:

- Smoke experiment: 3 run.
- Development comparison: 10 run.
- Calibration/validation: minimal 30 run.
- Sensitivity analysis penting: 50–100 run jika resource memungkinkan.

---

## 8. Calibration

Calibration mencari parameter yang menghasilkan karakteristik pasar yang masuk akal, bukan menjamin profit strategy tertentu.

### 8.1 Parameter yang Dikalibrasi

- Strategy population ratio.
- Decision interval.
- Reaction delay.
- Order size distribution.
- Cancel probability.
- Price aggressiveness.
- Momentum/contrarian threshold.
- Market Maker spread/inventory skew.
- Herd susceptibility.
- Sentiment transition.
- Bandar accumulation/markup/distribution window.

### 8.2 Calibration Target

Target dapat berasal dari:

- Target desain Mandala Exchange.
- Statistik synthetic baseline.
- Dataset pasar nyata yang legal dan tersedia.
- Manual operator expectation yang dinyatakan eksplisit.

Jangan menyebut model “realistis terhadap IDX” tanpa dataset dan metode pembanding yang jelas.

### 8.3 Calibration Process

1. Tentukan target metrics dan tolerance.
2. Bekukan model version.
3. Tentukan parameter search space.
4. Jalankan batch experiment.
5. Hitung objective score.
6. Validasi parameter terpilih pada seed dan scenario yang tidak dipakai saat calibration.
7. Simpan hasil sebagai versioned calibration profile.

---

## 9. Validation dan Stylized Facts

Validasi tidak hanya memeriksa apakah service berjalan. Model perlu diperiksa pada level mikro dan makro.

### 9.1 Micro Validation

- Agent tidak melanggar cash/position/risk limit.
- Strategy action sesuai rule dan input yang tersedia.
- Tidak ada look-ahead.
- Reaction delay dan stochastic distribution sesuai konfigurasi.
- State multi-session bertahan setelah restart.
- STP, session rule, fee, dan settlement tetap berlaku.

### 9.2 Macro Validation

Metric pasar yang dapat dianalisis:

- Return distribution dan tail behavior.
- Volatility clustering.
- Autocorrelation return.
- Autocorrelation absolute/squared return.
- Volume–volatility relationship.
- Bid/ask spread distribution.
- Depth dan liquidity concentration.
- Turnover dan trade frequency.
- Price impact terhadap ukuran order.
- Fill/cancel/reject rate.
- Wealth dan inventory distribution antar-agent.
- Bot contribution terhadap total volume.

Tidak semua stylized facts harus langsung cocok dengan pasar nyata. Setiap metric diberi status:

```text
not_evaluated | expected | partially_matched | matched | intentionally_different
```

### 9.3 Cross-Validation

Parameter yang dikalibrasi pada satu kelompok scenario harus diuji pada scenario lain agar model tidak overfit terhadap satu kondisi.

---

## 10. Emergence Metrics

Emergent behavior dinilai dengan metric, bukan hanya pengamatan chart.

### 10.1 Liquidity

- Median spread dalam tick.
- Time-with-two-sided-quote.
- Depth pada N level.
- Order book recovery time setelah large trade.
- Empty-book duration.

### 10.2 Price Discovery

- Waktu mencapai equilibrium setelah event.
- Overshoot dan recovery.
- Price impact per nilai order.
- Deviation terhadap reference/fair-value proxy.

### 10.3 Herding

- Concentration side BUY/SELL per window.
- Cross-agent action correlation.
- Cascade size dan duration.
- Persentase agent yang bereaksi terhadap initial shock.

### 10.4 Stability

- Frequency ARA/ARB.
- Halt/suspend frequency.
- Flash movement frequency.
- Reject dan breaker frequency.
- Inventory concentration Market Maker.

### 10.5 Diversity

- Strategy contribution terhadap volume.
- Distribution order size/reaction delay/holding period.
- Agent activity entropy.
- Concentration index per symbol.

---

## 11. Predictability dan Exploitability Testing

### 11.1 Tujuan

Pengujian ini mencari pola mekanis yang dapat ditebak player dari informasi publik. Pengujian tidak boleh menggunakan private BOT state sebagai input predictor.

Baseline HMAC session seed, bounded distribution, population rotation, hysteresis, multi-signal confirmation, dan conditional phase transition sudah wajib sebelum Fase 4 menurut `BOT_STRATEGY_SPEC.md`. Bagian ini menambahkan evaluasi statistik/predictor lanjutan setelah runtime stabil.

### 11.2 Prediction Tasks

- Next action agent: buy/sell/cancel/hold.
- Next action timing bucket.
- Order size bucket.
- Aggregate net-side pressure.
- Market regime transition.

### 11.3 Metric

Karena class distribution dapat tidak seimbang, jangan hanya memakai raw accuracy. Gunakan:

- Balanced accuracy.
- Precision/recall per class.
- Macro F1.
- Log loss.
- Calibration error.
- Mutual information.
- Entropy action/timing/size.

### 11.4 Target Awal

Target berikut adalah guardrail awal dan harus dikalibrasi berdasarkan baseline:

```yaml
predictability_guardrail:
  individual_next_action_balanced_accuracy_max: 0.60
  exact_timing_bucket_accuracy_max: 0.35
  exact_size_bucket_accuracy_max: 0.40
  aggregate_direction_expected_range: [0.55, 0.70]
```

Aggregate direction boleh lebih mudah diprediksi karena cause-and-effect pasar harus tetap masuk akal. Individual action, timing, dan size tidak boleh menjadi jadwal mekanis.

### 11.5 Mitigasi Pola Mekanis

- Parameter berupa bounded distribution, bukan satu nilai global.
- Secret per-session seed:

```text
effective_seed = HMAC(server_secret, bot_id + session_instance_id + model_version)
```

- Population rotation.
- Per-session bounded parameter drift.
- Signal confirmation dari beberapa indikator publik.
- Hysteresis.
- Cooldown acak dalam batas aman.
- Bandar transition berbasis kondisi dan patience window, bukan jumlah sesi exact.
- Market regime laten yang diturunkan dari public data.

Secret seed tidak boleh masuk API player, market event, atau public log.

### 11.6 Anti-Manipulation Guardrail

Bot tidak boleh bereaksi seragam terhadap satu order besar. Signal sebaiknya mempertimbangkan:

- Persistence.
- Volume/frequency.
- Spread/depth.
- Multiple trade confirmation.
- Public aggregate pressure.
- Per-agent susceptibility.

Mitigasi tidak boleh mengidentifikasi atau mendiskriminasi player tertentu.

---

## 12. Sensitivity Analysis

Sensitivity analysis mengukur parameter mana yang paling memengaruhi output.

Tahapan:

1. One-factor-at-a-time untuk smoke analysis.
2. Grid/random sampling untuk interaksi parameter sederhana.
3. Latin Hypercube untuk ruang parameter lebih besar.
4. Global sensitivity seperti Sobol hanya jika kebutuhan dan resource membenarkan.

Output minimal:

- Parameter ranking.
- Effect direction.
- Interaction effect.
- Confidence interval.
- Parameter region yang menyebabkan instability.

Eksperimen besar dijalankan di luar jam penggunaan normal dan tetap mengikuti resource budget laptop.

---

## 13. Data Model Pengembangan Lanjutan

Schema tambahan yang dapat dibuat setelah MVP:

```text
abm_model_versions
- version
- specification
- source_revision
- created_at

abm_experiment_definitions
- id
- name
- model_version
- config
- status

abm_experiment_runs
- id
- experiment_id
- simulation_run_id
- repetition
- seed
- manifest
- status

abm_run_metrics
- run_id
- session_instance_id
- metric_name
- metric_value
- dimensions

abm_calibration_profiles
- id
- model_version
- parameter_set
- objective_definition
- score
- validation_result

abm_validation_results
- run_id
- check_name
- expected_range
- actual_value
- status

abm_predictability_results
- run_id
- predictor_version
- task
- metric
- value
- baseline_value
```

Raw event journal dapat disimpan sebagai compressed file/object artifact agar database utama tidak dipenuhi event eksperimen.

Retention eksperimen harus terpisah dari retention audit operasional.

---

## 14. Analysis Tooling

Simulation engine tetap menggunakan Go. Analisis statistik tidak harus dipaksakan masuk ke runtime BOT.

Pilihan pendekatan:

- Go untuk metric ringan yang dibutuhkan live dashboard.
- Export Parquet/CSV untuk analisis offline.
- Python companion tooling untuk analisis lanjutan menggunakan library matang seperti pandas, NumPy, SciPy, statsmodels, scikit-learn, dan SALib jika fitur tersebut benar-benar mulai dikerjakan.

Tool analisis tidak boleh menjadi dependency startup BOT live.

Sebelum menambah library, buat satu use case dan benchmark yang jelas. Hindari membangun statistical framework manual jika library teruji sudah tersedia.

---

## 15. Performance dan Experiment Isolation

ABM experiment tidak boleh mengganggu runtime player.

Aturan:

- Experiment batch hanya berjalan pada `deterministic_test`.
- Gunakan database/volume atau simulation run namespace terpisah.
- Batasi parallel run berdasarkan CPU/RAM.
- Jangan menjalankan beberapa full-stack simulation secara paralel pada laptop 16 GB.
- Simpan raw event secara batch/compressed.
- Disable dashboard high-frequency refresh saat experiment batch.
- Profiling dilakukan pada 100 → 500 → 1.000 → 2.000 agent.

Budget mode live pada BOT_PRD tetap berlaku. Experiment mode boleh lebih lambat selama tidak menyebabkan OOM, data corruption, atau mengubah production state.

---

## 16. Tahapan Pengembangan

### Tahap ABM-1: Formal Model Specification

- Tulis ODD untuk model dan delapan strategi.
- Tambahkan model version.
- Definisikan metric dictionary.
- Definisikan experiment/run manifest.

**Exit criteria**: Dua engineer dapat membaca specification dan menghasilkan interpretasi rule yang sama.

### Tahap ABM-2: Experiment Runner

- Declarative experiment config.
- Repetition dan seed management.
- Warmup period.
- Automated run manifest.
- Metric export.

**Exit criteria**: Eksperimen yang sama dapat diulang dan menghasilkan hasil identik pada deterministic mode.

### Tahap ABM-3: Calibration & Validation

- Calibration target.
- Batch parameter search.
- Micro/macro validation.
- Calibration profile versioning.
- Cross-validation.

**Exit criteria**: Parameter produksi memiliki alasan dan validation report, bukan hanya hasil tuning manual.

### Tahap ABM-4: Predictability & Exploitability

- Public-data predictor baseline.
- Entropy dan mutual-information metrics.
- Parameter distribution.
- Session seed.
- Population rotation.
- Mechanical-pattern regression test.

**Exit criteria**: Model memenuhi guardrail predictability tanpa kehilangan target realism.

### Tahap ABM-5: Advanced Adaptation

Fitur opsional setelah rule-based ABM tervalidasi:

- Contextual parameter adaptation.
- Multi-armed bandit untuk pemilihan bounded action policy.
- Evolutionary parameter search pada offline experiment.
- Synthetic agent learning.

Adaptive model wajib:

- Tidak memakai private player data.
- Memiliki action/risk boundary.
- Dapat dimatikan.
- Memiliki model version.
- Divalidasi terhadap exploitability dan market stability.

Machine learning tidak boleh ditambahkan hanya untuk membuat BOT terlihat lebih canggih.

---

## 17. Governance

Setiap perubahan model material harus menyertakan:

1. Tujuan perubahan.
2. Model/strategy version.
3. Parameter atau rule yang berubah.
4. Experiment pembanding.
5. Dampak terhadap realism.
6. Dampak terhadap predictability.
7. Dampak terhadap fairness.
8. Dampak terhadap performance.
9. Migration/backward compatibility.
10. Rollback plan.

Dashboard player dan API publik tidak boleh mengekspos:

- Agent strategy identity.
- Per-agent thresholds.
- Secret seed.
- Bandar phase.
- Private decision logs.
- Latent regime internal.

Admin access terhadap informasi tersebut harus teraudit.

---

## 18. Definition of Done ABM Platform

ABM platform dinyatakan matang jika:

1. Model memiliki specification ODD berversi.
2. Simulation run mempunyai manifest lengkap.
3. Deterministic test dapat direplay.
4. Calibration profile dapat dilacak ke experiment.
5. Micro dan macro validation berjalan otomatis.
6. Emergence metrics tersedia per run/session.
7. Predictability regression test hanya memakai public observable data.
8. Fairness invariant selalu diuji.
9. Model comparison menyertakan confidence interval, bukan satu hasil run.
10. Experiment tooling terisolasi dari runtime live.
11. Performance tetap mengikuti gate mesin target.
12. Adaptive/ML component, jika ada, bersifat bounded, versioned, auditable, dan dapat dinonaktifkan.

---

## 19. Posisi terhadap Roadmap BOT

Urutan yang disarankan:

```text
BOT Fase 0–4
  → MVP trading/accounting benar + anti-predictability baseline
BOT Fase 5–7
  → strategi lengkap, admin, scaling, deployment stabil
ABM-1 dan ABM-2
  → specification dan experiment runner
ABM-3
  → calibration dan validation
ABM-4
  → predictability/exploitability hardening
ABM-5
  → advanced adaptation opsional
```

Correctness, settlement consistency, recovery, fairness, dan safety selalu memiliki prioritas lebih tinggi daripada sophistication model.
