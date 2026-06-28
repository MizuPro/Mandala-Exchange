# BOT Cross-Service API Contracts

**Versi**: 1.0  
**Tanggal**: 2026-06-29  
**Status**: Normatif untuk Fase 0  
**Dokumen induk**: `BOT_PRD.md`  

## 1. Aturan Umum

- Semua endpoint internal hanya bind ke loopback/jaringan internal.
- Header autentikasi: `x-service-token`.
- Semua mutation menerima `Idempotency-Key` maksimal 128 karakter.
- Payload menggunakan JSON UTF-8 dan timestamp RFC3339 UTC.
- Uang nominal dikirim sebagai string decimal atau integer rupiah sesuai schema; tidak memakai JSON float.
- Quantity lintas layanan selalu dalam **lembar**, bukan lot.
- Identifier akun/session memakai UUID; `external_bot_id` memakai string stabil maksimal 64 karakter.
- Response error selalu memakai envelope yang sama.
- Mutation menggunakan delivery semantics at-least-once dan wajib aman terhadap retry.

### 1.1 Error Envelope

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency key was previously used with a different payload",
    "retryable": false,
    "correlation_id": "uuid",
    "details": {}
  }
}
```

Error code minimum:

```text
UNAUTHORIZED
FORBIDDEN_SCOPE
VALIDATION_ERROR
ACCOUNT_NOT_BOT
BOT_ALREADY_PROVISIONED
BOT_NOT_FOUND
IDEMPOTENCY_CONFLICT
GENESIS_ALREADY_COMPLETED
GENESIS_IN_PROGRESS
GENESIS_PARTIAL_FAILURE
SESSION_INSTANCE_NOT_ACTIVE
SNAPSHOT_NOT_CONSISTENT
EVENT_SEQUENCE_TOO_OLD
EVENT_STREAM_UNAVAILABLE
TOKEN_REVOKED
DEPENDENCY_UNAVAILABLE
ORDER_SUBMIT_UNKNOWN
IPO_NOT_OPEN
INSUFFICIENT_BUYING_POWER
```

HTTP mapping:

| Kondisi | HTTP |
|---|---:|
| Validation | 400 |
| Authentication | 401 |
| Scope/operation forbidden | 403 |
| Not found | 404 |
| State/idempotency conflict | 409 |
| Sequence replay expired | 410 |
| Rate limited | 429 |
| Dependency/transient failure | 503 |

## 2. Idempotency

Server menyimpan:

- Idempotency key.
- Caller identity.
- Route.
- Canonical payload hash.
- Response status/body.
- Created/expired time.

Retry dengan key dan payload yang sama mengembalikan response sebelumnya. Key sama dengan payload berbeda menghasilkan `409 IDEMPOTENCY_CONFLICT`.

Retention minimum:

- Provisioning/genesis: permanen selama data terkait hidup.
- Order/IPO mutation: minimal 7 hari real-time.
- Admin scenario mutation: minimal 30 hari real-time.

## 3. Batch Provisioning

```http
POST /api/v1/internal/bots/provision
x-service-token: ...
Idempotency-Key: provision-2026-001
```

Request:

```json
{
  "bots": [
    {
      "external_bot_id": "noise-0001",
      "email": "noise-0001@bot.internal",
      "display_name": "Noise 0001",
      "tier": "retail",
      "strategy": "noise_trader",
      "initial_cash_idr": 25000000
    }
  ]
}
```

Response `200` selalu memuat hasil per item; partial failure bukan HTTP failure:

```json
{
  "results": [
    {
      "external_bot_id": "noise-0001",
      "status": "created",
      "user_id": "uuid",
      "account_id": "uuid",
      "error": null
    }
  ]
}
```

Status item: `created | existing | failed`. Unique key berada pada `external_bot_id` dan email.

## 4. BOT JWT Issuance

```http
POST /api/v1/internal/bots/tokens
x-service-token: ...
Idempotency-Key: token-batch-uuid
```

Request menerima maksimal 100 account per batch:

```json
{
  "account_ids": ["uuid"]
}
```

Response:

```json
{
  "tokens": [
    {
      "account_id": "uuid",
      "user_id": "uuid",
      "token": "<jwt>",
      "issued_at": "2026-06-29T00:00:00Z",
      "expires_at": "2026-06-29T01:00:00Z"
    }
  ]
}
```

- Default lifetime 1 jam.
- Refresh dimulai 10 menit sebelum expiry dengan jitter.
- Account suspended/revoked tidak mendapat token.
- Rotasi signing key mendukung overlap verification.
- Token tidak boleh muncul dalam log, metric label, decision snapshot, atau error details.

## 5. Genesis Seeding

```http
POST /api/v1/internal/bots/genesis
x-service-token: ...
Idempotency-Key: genesis-v1
```

Request:

```json
{
  "genesis_run_id": "uuid",
  "accounts": [
    {
      "external_bot_id": "mm-bbca-001",
      "account_id": "uuid",
      "cash_idr": 5000000000,
      "positions": [
        {
          "symbol": "BBCA",
          "quantity_shares": 100000,
          "average_price_idr": 9000
        }
      ]
    }
  ]
}
```

Response:

```json
{
  "genesis_run_id": "uuid",
  "status": "completed",
  "payload_hash": "sha256",
  "sekuritas_checkpoint": "uuid",
  "bei_custody_checkpoint": "uuid",
  "reconciliation": {
    "accounts_checked": 1,
    "mismatch_count": 0
  }
}
```

Status: `pending | processing | completed | failed | compensating`.

Sekuritas menjadi saga coordinator. Urutan:

1. Validasi seluruh account BOT dan payload.
2. Simpan saga + outbox.
3. Bentuk cash/position opening ledger secara idempotent.
4. Minta BEI membentuk opening custody ledger.
5. Reconcile kedua sisi.
6. Tandai completed.

Jika BEI sukses dan Sekuritas gagal, saga melanjutkan retry dengan idempotency key yang sama. Compensation hanya melalui reversal ledger, bukan delete row. Production genesis membutuhkan explicit admin approval.

## 6. Bulk Portfolio Snapshot

```http
POST /api/v1/internal/bots/portfolio-snapshot
x-service-token: ...
```

Request:

```json
{
  "account_ids": ["uuid"],
  "include_open_orders": true
}
```

Response:

```json
{
  "as_of_sequence": 91203,
  "generated_at": "2026-06-29T00:00:00Z",
  "accounts": [
    {
      "account_id": "uuid",
      "cash": {
        "available_idr": "10000000",
        "reserved_idr": "1000000",
        "pending_idr": "500000"
      },
      "positions": [
        {
          "symbol": "BBCA",
          "available_shares": 1000,
          "reserved_shares": 100,
          "pending_shares": 200,
          "average_price_idr": "9000"
        }
      ],
      "open_orders": []
    }
  ]
}
```

Snapshot harus konsisten pada satu transaction boundary. Setelah snapshot diterima, consumer memulai/replay event dari `as_of_sequence + 1`.

Batch maksimum default 100 account. BOT melakukan pagination/batching untuk populasi lebih besar.

## 7. Sequenced BOT Account Event Stream

```http
GET /api/v1/internal/bots/events/ws?after_sequence=91203
x-service-token: ...
```

### 7.1 Event Envelope

```json
{
  "event_id": "uuid",
  "sequence": 91204,
  "account_id": "uuid",
  "event_type": "order_partially_filled",
  "entity_id": "order-uuid",
  "entity_version": 4,
  "occurred_at": "2026-06-29T00:00:01Z",
  "correlation_id": "uuid",
  "payload": {}
}
```

Keputusan:

- Sequence bersifat **global monotonik** untuk seluruh event akun BOT.
- Delivery `at-least-once`; duplicate event wajib diabaikan berdasarkan `event_id` atau entity version.
- Event hanya untuk account dengan `account_type=BOT`.
- Retention minimum 24 jam dan minimal 100.000 event.
- Heartbeat setiap 15 detik membawa `latest_sequence`.
- Consumer buffer penuh menyebabkan koneksi ditutup dengan reason `slow_consumer`; event tidak dibuang diam-diam.
- Jika `after_sequence` sudah di luar retention, server mengembalikan `410 EVENT_SEQUENCE_TOO_OLD` dan BOT wajib mengambil snapshot baru.

Event minimum:

```text
order_accepted
order_rejected
order_amended
order_partially_filled
order_filled
order_cancelled
order_expired
order_submit_unknown_resolved
settlement_completed
corporate_action_applied
ipo_subscription_updated
account_suspended
account_reactivated
```

## 8. Order Idempotency dan Unknown Outcome

Semua place order BOT membawa `client_order_id` unik:

```text
bot:<external_bot_id>:<session_instance_id>:<monotonic_local_sequence>
```

Aturan:

1. Retry place order memakai `client_order_id` yang sama.
2. HTTP timeout sebelum response menghasilkan local status `submit_unknown`.
3. BOT tidak boleh membuat order pengganti secara buta.
4. BOT melakukan lookup/reconciliation berdasarkan `client_order_id`.
5. Jika Sekuritas memastikan order tidak pernah dibuat, retry diperbolehkan dengan ID sama.
6. Amend/cancel membawa idempotency key sendiri.
7. Reservation hanya dibuat sekali untuk satu `client_order_id`.

Sekuritas perlu menyediakan lookup:

```http
GET /api/v1/orders/by-client-id/:clientOrderId
Authorization: Bearer <bot-jwt>
```

## 9. IPO Subscription

### 9.1 IPO Event Lifecycle

BEI menjadi source of truth lifecycle event:

```text
draft
  → bookbuilding
  → subscription
  → allocation
  → listed

draft | bookbuilding | subscription | allocation
  → cancelled
```

- `draft`: belum menerima subscription.
- `bookbuilding`: informasi sudah dipublikasikan, tetapi subscription final belum dibuka.
- `subscription`: Sekuritas boleh menerima dan meneruskan pemesanan.
- `allocation`: subscription/cancel investor ditutup; BEI menghitung penjatahan.
- `listed`: pending shares hasil allocation menjadi available untuk order reguler.
- `cancelled`: terminal; reserve, debit, dan custody yang sudah terbentuk dipulihkan melalui refund/reversal idempotent.

Event minimum:

```json
{
  "id": "uuid",
  "symbol": "MOSE",
  "status": "subscription",
  "offering_price_idr": "200",
  "offered_shares": 50000,
  "subscription_lot_size": 100,
  "subscription_start": "2026-06-29T00:00:00Z",
  "subscription_end": "2026-06-30T00:00:00Z",
  "listing_at": "2026-07-01T00:00:00Z",
  "version": 3
}
```

### 9.2 Subscription Request

```http
POST /api/v1/ipo-events/:id/subscriptions
Authorization: Bearer <user-or-bot-jwt>
Idempotency-Key: ...
```

Request:

```json
{
  "requested_shares": 10000
}
```

Response:

```json
{
  "subscription_id": "uuid",
  "status": "reserved",
  "requested_shares": 10000,
  "offering_price_idr": "200",
  "reserved_cash_idr": "2000000"
}
```

Lifecycle:

```text
requested
  → cash_reserved
  → submitted_to_bei
  → allocated
  → settled

requested → rejected
cash_reserved → cancelled/refunded
submitted_to_bei → rejected/refunded
allocated → reversed/refunded
```

### 9.3 Validation

Sekuritas wajib memvalidasi:

- Event berstatus `subscription` dan current time berada dalam subscription window.
- `requested_shares > 0` dan merupakan kelipatan `subscription_lot_size`.
- Cash available cukup untuk full requested shares ditambah fee IPO jika fee schedule menetapkannya.
- Account aktif dan boleh mengikuti IPO.
- Idempotency key tidak pernah dipakai dengan payload berbeda.

Fee IPO berasal dari versioned fee schedule. Jika tidak ada fee IPO, default-nya nol; trading fee reguler tidak boleh diasumsikan berlaku.

### 9.4 Reserve, Allocation, dan Refund

Saat request:

```text
maximum_cost = requested_shares × offering_price + estimated_ipo_fee
cash.available -= maximum_cost
cash.reserved  += maximum_cost
```

Contoh allocation 25%:

```text
requested shares = 10.000
offering price   = Rp200
reserved cash    = Rp2.000.000
allocated shares = 2.500
actual cost      = Rp500.000
refund           = Rp1.500.000
```

Saat allocation:

```text
cash.reserved -= full original reserve
actual allocation cost + official fee dibukukan sebagai debit
cash.available += unused reserve/refund
position.pending += allocated shares
```

Allocation nol me-refund seluruh reserve.

### 9.5 Cancellation

Investor boleh cancel hanya jika event masih `subscription`, belum melewati `subscription_end`, dan allocation belum dimulai.

```text
subscription → cancelled
cash.reserved → cash.available
```

Setelah event masuk `allocation`, investor tidak boleh cancel sendiri.

### 9.6 Listing dan Share Availability

Allocation tidak langsung membuat saham dapat dijual:

```text
allocated:
  position.pending += allocated_shares
  position.available tidak berubah

listed:
  position.pending -= allocated_shares
  position.available += allocated_shares
```

Transition listing wajib idempotent. Player/BOT baru boleh menjual setelah shares berstatus available.

### 9.7 IPO Cancellation dan Reversal

Jika cancelled sebelum allocation:

- Semua subscription menjadi cancelled.
- Seluruh cash reserved kembali ke available.
- Tidak ada custody allocation.

Jika cancelled setelah allocation:

- BEI membuat reversal custody ledger.
- Sekuritas membuat reversal debit/fee.
- Pending shares dikurangi.
- Cash dikembalikan.
- Ledger lama tidak dihapus.

Jika shares sudah available karena listing, pembatalan tidak memakai flow biasa dan membutuhkan exceptional corporate-action/reversal process.

### 9.8 Failure Semantics

| Kegagalan | State/Aksi |
|---|---|
| Reserve sukses, submit BEI timeout | Tetap `cash_reserved`; retry idempotent |
| BEI menerima, response hilang | Lookup dengan idempotency key; jangan membuat subscription baru |
| Submit BEI gagal permanen | `rejected`; release seluruh reserve |
| Allocation sukses, webhook gagal | BEI outbox retry |
| Allocation webhook duplikat | Abaikan berdasarkan event/idempotency key |
| Sekuritas restart | Lanjutkan dari persisted state/outbox |
| Custody dan Sekuritas mismatch | Jangan tandai settled; reconcile/manual intervention |

### 9.9 Invariants

```text
reserved cash tidak negatif
allocated shares <= requested shares
total allocation <= offered shares
actual debit = allocation value + official IPO fee
refund = original reserve - actual debit
duplicate allocation tidak mengubah saldo dua kali
pending shares tidak dapat dijual
available shares bertambah tepat sekali saat listed
```

## 10. Session Instance Contract

BEI menjadi owner dan persistence authority session instance.

Minimum model:

```json
{
  "session_instance_id": "uuid",
  "session_template_id": "uuid",
  "virtual_day_index": 42,
  "status": "continuous",
  "segment_sequence": 3,
  "virtual_duration_seconds": 21600,
  "real_duration_seconds": 1800,
  "real_time_remaining_seconds": 900,
  "started_at": "2026-06-29T00:00:00Z",
  "expected_end_at": "2026-06-29T00:30:00Z",
  "version": 10
}
```

- Hanya satu instance aktif.
- `virtual_day_index` unique dan monotonik.
- MATS mengambil/mengaktifkan instance dari BEI.
- Restart MATS melanjutkan instance aktif.
- Create/activate/advance/close bersifat idempotent.
- Rollover memakai DB lock atau lease agar hanya satu leader memajukan sesi.
- Finality untuk instance yang sudah closed aman diulang.

## 11. MDX Composition

```http
GET /v1/indices/MDX/composition
x-service-token: ...
```

Response:

```json
{
  "index_code": "MDX",
  "version": 12,
  "effective_at": "2026-06-29T00:00:00Z",
  "methodology": "float_adjusted_market_cap",
  "components": [
    {
      "symbol": "BBCA",
      "weight": "0.125000"
    }
  ]
}
```

Jumlah weight harus sama dengan 1 dalam tolerance decimal yang ditentukan. Perubahan composition menaikkan version.

## 12. Freshness Contract

Default:

```yaml
freshness:
  market_heartbeat_timeout_seconds: 30
  account_event_timeout_seconds: 30
  rule_snapshot_max_age_seconds: 300
  fee_snapshot_max_age_seconds: 300
  session_snapshot_max_age_seconds: 10
  index_composition_max_age_seconds: 300
```

| Kondisi | Aksi |
|---|---|
| Market heartbeat stale | Pause seluruh strategy submission |
| Account event stale | Pause account terkait; global pause jika stream putus |
| Rule/fee stale | Fail-closed order baru |
| Session stale | Global pause |
| MDX stale | Disable Index Tracker saja |

## 13. Contract Test Minimum

- Same idempotency key/same payload.
- Same key/different payload.
- Partial batch provisioning.
- Token revoked/suspended account.
- Genesis failure di setiap saga step.
- Snapshot + concurrent event tanpa gap.
- Duplicate/out-of-order event.
- Replay within retention dan expired retention.
- Unknown order response setelah HTTP timeout.
- Duplicate IPO allocation.
- IPO cancel sebelum allocation.
- IPO partial/zero allocation, refund, dan listing transition.
- IPO cancellation setelah allocation dengan reversal.
- MATS restart di tengah session.
- Concurrent session rollover.
- MDX weight/version validation.
