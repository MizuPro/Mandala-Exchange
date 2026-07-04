# BOT Strategy and Anti-Predictability Specification

**Versi**: 1.0  
**Tanggal**: 2026-06-29  
**Status**: Normatif untuk Fase 3–5  

## 1. Tujuan

Dokumen ini menetapkan schema machine-valid, unit, bounded stochastic behavior, dan guardrail fairness untuk delapan strategi autonomous serta Panic Seller scenario actor.

## 2. Aturan Umum

- Semua parameter memiliki type, unit, default, minimum, dan maximum.
- Range ditulis sebagai object, bukan string `"1-5"`.
- Nilai persentase menggunakan decimal fraction pada config (`0.015` = 1,5%).
- Quantity config boleh memakai lot; sebelum API call dikonversi menjadi lembar memakai active lot size.
- Interval strategy memakai virtual seconds/minutes dan dikonversi oleh virtual clock.
- Config tervalidasi sebelum dipersist/diaktifkan.
- Perubahan parameter material default berlaku pada session berikutnya; emergency risk limit boleh berlaku langsung.

## 3. Distribution Schema

```yaml
distribution:
  type: uniform        # fixed | uniform | normal | lognormal | weighted_choice
  min: 1
  max: 5
  mean: 3
  stddev: 1
  clamp: true
```

Field yang tidak relevan terhadap type ditolak validation, bukan diabaikan diam-diam.

## 4. Common Bot Config

```yaml
id: "noise-0001"
name: "Noise 0001"
strategy: "noise_trader"
tier: "retail"
status: "active"
initial_cash_idr: 25000000
symbols_universe:
  type: "all_active"       # all_active | random_n | sector | fixed
  count: null
  sector: null
  symbols: []

risk:
  max_order_size_lots: 20
  max_symbol_exposure_pct: 0.30
  max_daily_loss_pct: 0.05
  max_weekly_loss_pct: 0.15
  max_orders_per_minute: 10
  max_cancel_rate: 0.50

human:
  reaction_delay_virtual_seconds:
    type: "uniform"
    min: 5
    max: 45
  decision_abort_probability: 0.10
  overreaction_probability: 0.15
  overreaction_multiplier:
    type: "uniform"
    min: 1.20
    max: 2.00
  inactive_session_probability: 0.05

random:
  base_seed: null
  session_seed_mode: "hmac"

config_version: 1
```

Validation:

- Probability `[0,1]`.
- Exposure/loss percentage `(0,1]`.
- Lot/order/interval positif.
- Fixed symbol wajib aktif dan dikenal BEI.
- Unknown field ditolak pada strict mode.

## 5. Session Seed dan Population Rotation

Effective seed:

```text
HMAC-SHA256(server_secret,
  model_version + bot_id + session_instance_id + config_version)
```

- Secret tidak disimpan pada config bot dan tidak diekspos.
- Deterministic test menyimpan/referensikan seed secara aman dalam run artifact.
- Live mode menggunakan server secret aktif dengan version.
- Rotasi secret tidak mengubah run yang sudah dimulai.

Population:

- 2.000 akun boleh terdaftar.
- Default 300–500 aktif per session.
- Selection menggunakan bounded distribution yang mempertahankan target strategy ratio.
- Bot yang mempunyai open order/state wajib mengikuti lifecycle cleanup sebelum dinonaktifkan dari rotation.
- Market Maker minimum coverage dapat dipin agar simbol prioritas tidak kehilangan quote.

## 6. Bounded Parameter Drift

Per session, parameter terpilih dapat berubah:

```yaml
session_drift:
  enabled: true
  max_relative_change: 0.10
  mean_reversion: 0.30
```

- Drift dibatasi terhadap validated base range.
- Risk limit, account balance, fee, dan market rule tidak boleh didrift.
- Drift dicatat dalam simulation run/config snapshot.

## 7. Noise Trader

```yaml
strategy_params:
  decision_interval_virtual_minutes:
    type: "uniform"
    min: 5
    max: 20
  order_size_lots:
    type: "uniform"
    min: 1
    max: 5
  buy_probability: 0.50
  max_price_deviation_pct: 0.02
  cancel_probability: 0.30
  cancel_after_virtual_minutes:
    type: "uniform"
    min: 5
    max: 15
```

Guardrail:

- Side probability dipengaruhi inventory dan sentiment dalam batas tertentu.
- Price tetap valid tick/ARA/ARB.
- Sell hanya dari available shares.

## 8. Momentum Trader

```yaml
strategy_params:
  lookback_virtual_minutes:
    type: "uniform"
    min: 10
    max: 30
  buy_trigger_pct:
    type: "normal"
    mean: 0.015
    stddev: 0.004
    min: 0.007
    max: 0.028
  sell_trigger_pct:
    type: "normal"
    mean: -0.015
    stddev: 0.004
    min: -0.028
    max: -0.007
  confirmation:
    minimum_trade_count: 3
    minimum_persistence_virtual_seconds: 15
    require_volume_signal_probability: 0.70
  entry_hysteresis_pct: 0.003
  cooldown_virtual_minutes:
    type: "uniform"
    min: 10
    max: 40
  take_profit_pct: 0.03
  stop_loss_pct: 0.02
```

Satu trade/order besar tidak cukup memicu seluruh Momentum agent. Confirmation menggunakan data publik dan susceptibility per-agent.

## 9. Contrarian

```yaml
strategy_params:
  dip_trigger_from_high_pct:
    type: "normal"
    mean: -0.03
    stddev: 0.008
    min: -0.06
    max: -0.015
  accumulation_lots:
    type: "uniform"
    min: 5
    max: 20
  recovery_target_pct:
    type: "uniform"
    min: 0.015
    max: 0.04
  patience_virtual_minutes:
    type: "uniform"
    min: 30
    max: 120
  max_position_lots: 200
```

Reference basis (`intraday_high | previous_close | weighted`) harus tercatat dalam decision context.

## 10. Market Maker

```yaml
strategy_params:
  symbol: "BBCA"
  levels: 3
  spread_ticks:
    type: "uniform"
    min: 2
    max: 6
  level_size_lots:
    type: "uniform"
    min: 5
    max: 25
  refresh_virtual_seconds:
    type: "uniform"
    min: 20
    max: 45
  max_inventory_lots: 100
  inventory_skew_strength: 0.50
  fee_aware: true
  self_trade_prevention: "cancel_newest"
```

Guardrail:

- Tidak menjamin infinite liquidity.
- Quote tunduk cash/inventory/rate limit.
- Widen/withdraw saat volatility/halt/degraded.
- Outstanding order direkonsiliasi sebelum re-quote.
- MATS STP tetap menjadi jaminan terakhir.

## 11. Value Investor

```yaml
strategy_params:
  fair_value_method: "ma_closed_sessions"
  fair_value_lookback_sessions: 200
  minimum_history_sessions: 30
  insufficient_history_behavior: "disable_symbol"
  margin_of_safety:
    type: "uniform"
    min: 0.10
    max: 0.20
  sell_premium:
    type: "uniform"
    min: 0.15
    max: 0.30
  order_size_lots:
    type: "uniform"
    min: 20
    max: 50
  max_portfolio_pct_per_stock: 0.30
  evaluation_frequency_sessions: 1
```

MA hanya memakai closed session, tanpa look-ahead.

## 12. Bandar

```yaml
strategy_params:
  symbol: "GOTO"
  accumulation_target_lots: 5000
  accumulation_price:
    min_idr: 80
    max_idr: 120
  accumulation_lots_per_session:
    type: "uniform"
    min: 100
    max: 300
  markup_eligibility:
    minimum_sessions: 8
    maximum_patience_sessions: 18
    minimum_target_completion_pct: 0.80
    require_liquidity_condition: true
  markup_lots:
    type: "uniform"
    min: 200
    max: 500
  distribution_start_premium:
    type: "uniform"
    min: 0.20
    max: 0.40
  distribution_lots:
    type: "uniform"
    min: 200
    max: 800
```

Transition tidak terjadi tepat pada satu jumlah sesi. Syarat inventory, liquidity, sentiment publik, patience window, dan stochastic eligibility harus terpenuhi.

## 13. Event-Driven / IPO Hunter

```yaml
strategy_params:
  monitored_events:
    - dividend_announcement
    - ex_dividend
    - earnings
    - stock_split
    - rights_issue
    - ipo_subscription
    - ipo_listing
  reaction_delay_virtual_minutes:
    type: "uniform"
    min: 2
    max: 30
  reaction_probability: 0.80
  order_size_lots:
    type: "uniform"
    min: 20
    max: 100
  minimum_publication_age_virtual_seconds: 1
```

- Reaction timer dimulai setelah `published_at`.
- IPO subscription hanya melalui Sekuritas.
- Event `simulation_only` tidak digunakan pada normal live mode.

## 14. Index Tracker

```yaml
strategy_params:
  target_index: "MDX"
  tracking_error_tolerance_pct: 0.02
  rebalance_frequency_sessions: 5
  twap:
    slice_lots:
      type: "uniform"
      min: 10
      max: 50
    slice_interval_virtual_minutes:
      type: "uniform"
      min: 5
      max: 20
  stale_composition_behavior: "disable_strategy"
```

Weight memakai versioned MDX composition. Rebalance run menyimpan composition version.

## 15. Panic Seller Scenario Actor

```yaml
scenario_actor:
  type: "panic_seller"
  simulation_only: true
  symbols:
    type: "all_active"
  duration_virtual_minutes:
    min: 15
    max: 30
  sell_intensity: "high"
  max_total_sell_lots: 5000
  cleanup_behavior: "cancel_remaining"
```

Scenario actor tetap tunduk inventory, rate limit, session rule, STP, dan kill switch.

## 16. Predictability Baseline

Baseline wajib selesai sebelum Fase 4:

- HMAC per-session seed.
- Bounded distribution untuk threshold, interval, dan size.
- Population rotation.
- Bounded parameter drift.
- Multi-signal confirmation.
- Hysteresis dan random cooldown.
- Conditional Bandar phase transition.
- Secret/config/decision state tidak tersedia pada player API.

Advanced predictor, entropy, mutual information, dan calibration tetap berada pada ABM roadmap.

## 17. Fairness Invariants

- Tidak ada signal dari identity/portfolio/private order player.
- Tidak ada future announcement.
- Semua market input berasal dari public observable data.
- Parameter adaptation tidak menargetkan player tertentu.
- Strategy tidak mendapat bypass fee, settlement, rules, atau queue.
- Decision log privat hanya tersedia untuk admin teraudit.

## 18. Config Change Semantics

| Perubahan | Berlaku |
|---|---|
| Risk tightening | Segera |
| Emergency disable/pause | Segera |
| Strategy threshold/distribution | Session berikutnya |
| Symbol universe | Session berikutnya setelah cleanup |
| Population ratio | Session berikutnya |
| Model/strategy schema version | Run/session baru |

Concurrent update memakai expected `config_version`; stale version menghasilkan `409`.

## 19. Strategy Test Minimum

Untuk setiap strategi:

- Config schema validation dan boundary.
- Deterministic seed replay.
- No look-ahead.
- Insufficient data.
- Empty/thin order book.
- ARA/ARB dan invalid tick.
- Halt/suspend/NCP.
- Insufficient cash/inventory.
- Partial fill/cancel/expiry.
- Restart dan state recovery.
- Event gap/reconciliation.
- Distribution sample berada dalam bound.
- Tidak ada self-trade.
- Tidak ada private player input.
