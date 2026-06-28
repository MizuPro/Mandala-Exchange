# BOT State Machines and Accounting Semantics

**Versi**: 1.0  
**Tanggal**: 2026-06-29  
**Status**: Normatif untuk Fase 0–3  

## 1. Prinsip

- Sekuritas adalah source of truth account, cash, position, reservation, dan order investor.
- BEI adalah source of truth custody dan session instance.
- MATS adalah source of truth matching/order book.
- State BOT adalah cache keputusan dan strategy memory; reconciliation selalu bergerak dari source of truth menuju BOT.
- Semua transition dipicu event berversi dan harus idempotent.

## 2. Service Readiness

```text
starting
  → migrating
  → dependency_check
  → syncing_rules
  → syncing_accounts
  → ready
  ↔ degraded
  → halted
  → shutting_down
  → stopped
```

### 2.1 Ready Conditions

Semua kondisi wajib benar:

- Database BOT sehat dan migration version cocok.
- BEI securities/rules/fee/session snapshot fresh.
- MATS market WS connected dan initial snapshot universe selesai.
- Sekuritas account event stream connected.
- JWT seluruh bot aktif tersedia atau bot terkait ditandai unavailable.
- Bulk portfolio snapshot selesai.
- Tidak ada event sequence gap.
- Genesis/reconciliation konsisten jika genesis diperlukan.

### 2.2 Degraded

Degraded hanya diperbolehkan jika failure terisolasi, misalnya MDX stale sehingga hanya Index Tracker disabled. Kehilangan session identity, market stream, account stream, atau rule snapshot mengakibatkan global submission pause.

## 3. Bot Lifecycle

```text
provisioning
  → inactive
  → active
  ↔ paused
  → cooldown
  → active
  → disabled
  → bankrupt
```

Transition:

| Dari | Event | Ke | Efek |
|---|---|---|---|
| provisioning | account_ready | inactive | Menunggu snapshot/config |
| inactive | activate | active | Scheduler aktif |
| active | pause | paused | Tidak membuat keputusan/order baru |
| paused | resume | active | Hanya jika dependency/state fresh |
| active | spam/risk cooldown | cooldown | Scheduler dihentikan sementara |
| cooldown | cooldown_elapsed | active | Setelah validation |
| any nonterminal | disable | disabled | Persisten melewati restart |
| active/cooldown | total_insolvency | bankrupt | Terminal |

`bankrupt` hanya dapat diubah melalui recovery admin khusus dengan reason, approval, funding/custody event sah, dan audit log.

## 4. Control Semantics

### 4.1 Pause

- Menghentikan strategy evaluation dan order baru.
- Existing order tetap berada di market.
- Account event dan reconciliation tetap berjalan.

### 4.2 Pause and Cancel

- Lakukan pause.
- Queue cancel untuk semua order cancellable.
- NCP/locked order ditandai `cancel_deferred_by_market_rule`.
- Selesai ketika seluruh order terminal atau tidak cancellable.

### 4.3 Disable

- Sama seperti persistent pause.
- Tidak otomatis aktif setelah restart/session rollover.
- Existing order tidak otomatis dibatalkan kecuali endpoint `disable-and-cancel` dipakai.

### 4.4 Global Kill Switch

1. Hentikan seluruh strategy producer.
2. Blokir order baru kecuali risk/cancel.
3. Cancel seluruh order yang cancellable.
4. Track order locked/NCP sampai expiry/fill.
5. Tetap konsumsi account event dan lakukan reconciliation.
6. Resume membutuhkan explicit admin action setelah readiness check.

## 5. Local Order State

```text
decision_created
  → queued
  → submitting
  → submit_unknown
  → accepted/open
  → partially_filled
  → filled
  → cancelled
  → rejected
  → expired
```

Terminal: `filled | cancelled | rejected | expired`.

Aturan:

- `client_order_id` stabil selama retry.
- Local queue expiry menghasilkan `expired_before_submit`, bukan order resmi.
- `submit_unknown` tidak boleh langsung disubmit ulang dengan ID baru.
- Entity version lebih kecil/sama dari yang sudah diproses diabaikan.
- Terminal state tidak boleh kembali ke nonterminal.
- Partial fill quantity monotonik naik; remaining quantity monotonik turun.

## 6. Cash Accounting

```text
available
  → reserved       saat buy order diterima Sekuritas
  → pending        saat fill menunggu settlement
  → settled/used   saat settlement
```

Cancel/reject/expiry melepaskan unused reserved kembali ke available.

Untuk partial fill:

- Filled portion bergerak menuju pending/settled sesuai lifecycle Sekuritas.
- Unfilled portion tetap reserved.
- Fee reserve disesuaikan berdasarkan remaining exposure.

BOT hanya menghitung estimasi buying power. Nilai resmi selalu berasal dari event/snapshot Sekuritas.

## 7. Position Accounting

Sell:

```text
available_shares
  → reserved_shares
  → pending_out
  → settled_out
```

Buy:

```text
cash reserved
  → pending_shares
  → available_shares setelah settlement
```

BOT dilarang menjual `reserved_shares` atau `pending_shares` dan dilarang memakai sell proceeds yang masih pending.

## 8. Rounding dan Valuation

- Order price dan quantity integer.
- Quantity wajib kelipatan active lot size, tetapi disimpan/dikirim sebagai lembar.
- Fee resmi dihitung Sekuritas dari versioned BEI fee schedule.
- BOT tidak membukukan fee final berdasarkan estimasi sendiri.
- Fee/tax decimal disimpan `NUMERIC(24,6)`.
- Jika fee perlu menjadi debit rupiah bulat, rounding mengikuti fungsi resmi Sekuritas dan dicantumkan dalam fee schedule.
- Average price memakai weighted-average cost setelah settlement.
- Realized P&L diakui ketika disposal settlement selesai.
- Unrealized P&L memakai last price dan diberi status estimate.
- Max exposure menghitung available + reserved + pending exposure agar order baru tidak melampaui limit.

## 9. Market Order Reservation

Buying power market order dihitung oleh Sekuritas menggunakan worst-case executable price dalam price band ditambah fee buffer. BOT boleh membuat estimasi untuk pre-check, tetapi response Sekuritas menentukan reservation resmi.

Jika book tidak cukup:

- Filled portion mengikuti settlement lifecycle.
- Unfilled market quantity menjadi terminal sesuai aturan MATS.
- Unused reservation dilepas idempotently.

## 10. Amend Semantics

- Amend quantity tidak boleh di bawah filled quantity.
- Kenaikan buy price/quantity harus menambah reservation secara atomik sebelum amend dikirim ke MATS.
- Penurunan exposure melepaskan reservation setelah amend accepted.
- Jika MATS amend gagal, reservation kembali ke state sebelum amend.
- Concurrent fill dan amend diselesaikan dengan entity version dan transaction lock Sekuritas.

## 11. Reconciliation State Machine

```text
healthy
  → suspected_gap
  → paused_for_reconciliation
  → snapshot_loading
  → replaying_after_snapshot
  → verified
  → healthy
  ↘ failed/manual_intervention
```

Prosedur:

1. Catat gap/account terdampak.
2. Pause order baru.
3. Ambil consistent snapshot dengan `as_of_sequence`.
4. Replace cache account terkait.
5. Replay mulai `as_of_sequence + 1`.
6. Bandingkan cash, position, open order, dan reservation.
7. Resume hanya jika mismatch nol.

BOT tidak boleh menulis koreksi ke Sekuritas berdasarkan cache lokal.

## 12. Session Lifecycle

```text
created
  → pre_open
  → opening_auction
  → continuous
  → pre_close
  → non_cancellation
  → closing_auction
  → post_trading
  → closed
  → finalized
```

- BEI membuat dan menyimpan instance.
- MATS menjadi executor segment dengan lease/leader tunggal.
- Restart MATS mengambil active instance/version.
- Segment transition memakai expected version.
- Close memicu expiry dan finality idempotent.
- Instance berikutnya hanya dibuat/diaktifkan setelah instance lama closed/finalized sesuai policy BEI.
- Daily reset BOT terjadi tepat sekali saat instance baru aktif.

## 13. Genesis Saga State

```text
pending
  → validating
  → sekuritas_ledger_pending
  → bei_custody_pending
  → reconciling
  → completed
  ↘ retry_wait
  ↘ compensating
  ↘ failed
```

- Coordinator: Sekuritas.
- Setiap step memiliki idempotency key turunan dari genesis run.
- Tidak ada destructive rollback; compensation memakai reversal ledger.
- `completed` immutable.
- Payload hash berbeda pada run/key sama menghasilkan conflict.
- Scheduler BOT tidak ready sebelum completed + mismatch nol.

## 14. IPO Subscription State

```text
requested
  → cash_reserved
  → submitted_to_bei
  → allocated
  → settled
  ↘ rejected
  ↘ cancelled
```

- Reserve berdasarkan requested shares × offering price.
- Allocation dapat lebih kecil dari requested.
- Actual allocation didebit.
- Sisa reserve di-refund.
- Duplicate allocation event diabaikan.

## 15. Shutdown dan Restart

Graceful shutdown:

1. Set readiness false.
2. Hentikan strategy producer.
3. Hentikan penerimaan admin mutation baru.
4. Drain queue maksimal sesuai timeout; stale item dibuang.
5. Risk/cancel dapat diproses sampai deadline.
6. Flush decision log/checkpoint/state strategy.
7. Tutup stream, HTTP pool, Redis, dan DB.

Default shutdown tidak membatalkan seluruh order. Gunakan explicit `pause-and-cancel` atau kill switch jika order harus ditarik.

Restart:

1. Tidak mengasumsikan cache lama benar.
2. Muat strategy state/checkpoint.
3. Ambil source-of-truth snapshot.
4. Replay event.
5. Reconcile.
6. Resume scheduler setelah ready.

## 16. Invariants

Invariant yang wajib selalu benar:

```text
cash available/reserved/pending tidak negatif
position available/reserved/pending tidak negatif
filled_quantity + remaining_quantity <= original_quantity
terminal order tidak kembali aktif
event sequence checkpoint monotonik
session virtual_day_index monotonik
genesis completed maksimal satu kali
self trade count = 0
duplicate official order count = 0
reconciliation mismatch sebelum resume = 0
```

## 17. Required Tests

- Pause versus pause-and-cancel.
- Kill switch saat continuous dan NCP.
- Fill bersamaan dengan cancel/amend.
- Timeout submit dan unknown resolution.
- Duplicate/out-of-order event.
- Snapshot saat event terus masuk.
- Settlement dan corporate action saat BOT restart.
- MATS restart di setiap segment sesi.
- Concurrent session transition.
- Genesis failure pada setiap state.
- IPO partial allocation dan duplicate webhook.
- Bankruptcy dan audited recovery.
