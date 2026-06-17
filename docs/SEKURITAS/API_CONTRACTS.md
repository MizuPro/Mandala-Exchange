# API Contracts - Mandala Sekuritas

## 1. Kontrak Sekuritas <-> MATS
Sekuritas mengirim request ke MATS untuk order management. MATS mengirim callback/webhook ke Sekuritas untuk order status dan trades.

### Place Order (Sekuritas -> MATS)
`POST /v1/orders`
```json
{
  "client_order_id": "seq-12345",
  "broker_code": "MANDALA",
  "account_id": "broker-account-id",
  "symbol": "BBCA",
  "side": "buy",
  "order_type": "limit",
  "price": 10000,
  "quantity": 100,
  "idempotency_key": "place-seq-12345"
}
```

Untuk market order, `price` tidak dikirim ke MATS:

```json
{
  "client_order_id": "seq-67890",
  "broker_code": "MANDALA",
  "account_id": "broker-account-id",
  "symbol": "BBCA",
  "side": "buy",
  "order_type": "market",
  "quantity": 100,
  "idempotency_key": "place-seq-67890"
}
```

Market order hanya dieksekusi langsung terhadap opposite book yang tersedia. Sisa quantity tidak resting dan akan dibatalkan oleh MATS.

### Amend Order (Sekuritas -> MATS)
`PATCH /v1/orders/{mats_order_id}`
```json
{
  "price": 10100,
  "quantity": 100,
  "idempotency_key": "amend-seq-12345-1"
}
```

### Cancel Order (Sekuritas -> MATS)
`POST /v1/orders/{mats_order_id}/cancel`
```json
{
  "idempotency_key": "cancel-seq-12345-1"
}
```

### Order Status Update (MATS -> Sekuritas Webhook)
`POST /internal/mats/events`

Header: `x-service-token: <MATS_TO_SEKURITAS_TOKEN>`

```json
{
  "mats_order_id": "mats-888",
  "client_order_id": "seq-12345",
  "status": "filled",
  "filled_quantity": 100,
  "remaining_quantity": 0,
  "occurred_at": "2026-06-16T12:00:00Z"
}
```

## 2. Kontrak Sekuritas <-> BEI
Sekuritas mengambil referensi data dari BEI.

Header untuk semua request BEI: `x-service-token: <BEI_SERVICE_TOKEN>`

### Get Listed Securities
`GET /v1/public/securities`

### Get Fee Schedule
`GET /v1/public/fee-schedule`

### Settlement Notification (BEI -> Sekuritas Webhook)
`POST /internal/webhook/bei/settlement`
```json
{
  "date": "2026-06-16",
  "status": "COMPLETED",
  "details": [ ... ]
}
```

### Corporate Action Notification (BEI -> Sekuritas Webhook)
`POST /internal/webhook/bei/corporate-action`

Header: `x-service-token: <BEI_TO_SEKURITAS_TOKEN>`

```json
{
  "event_id": "bei:corporate-action:ca-1:completed",
  "idempotency_key": "bei:corporate-action:ca-1:completed",
  "corporate_action_id": "ca-1",
  "action_type": "cash_dividend",
  "symbol": "BBCA",
  "details": {
    "cash_amount_per_share": "50.00",
    "recording_date": "2026-06-17"
  },
  "entitlements": [
    {
      "broker_account_id": "broker-account-id",
      "broker_code": "MANDALA",
      "asset_type": "cash",
      "cash_amount": "5000.00",
      "idempotency_key": "ledger:ca:ca-1:broker-account-id:cash-dividend"
    }
  ]
}
```

Sekuritas menyimpan `corporate_action_events` dengan unique `idempotency_key`, lalu memperbarui `cash_balances`, `securities_positions`, `ledger_movements`, dan `notifications`.

### Sekuritas Frontend/API Endpoints

- `POST /api/v1/orders`: menerima `order_type: "LIMIT" | "MARKET"`; `price` wajib hanya untuk `LIMIT`.
- `GET /api/v1/orders/:id/amendments`: riwayat amend order.
- `GET /api/v1/portfolio/account`: SID/SRE/RDN dan status account.
- `GET /api/v1/portfolio/fills`: trade fills lokal.
- `GET /api/v1/portfolio/settlement/:sessionId`: proxy settlement BEI.
- `GET /api/v1/portfolio/custody/summary`: proxy custody summary BEI.
- `GET /api/v1/portfolio/custody/reconciliation`: proxy reconciliation BEI.
- `GET /api/v1/market/securities/:symbol`: proxy detail security BEI.
- `GET /api/v1/market/securities/:symbol/fundamentals`: proxy fundamentals BEI.
- `GET /api/v1/market/securities/:symbol/announcements`: proxy announcements BEI.
- `GET /api/v1/market/corporate-actions`: corporate action report BEI.
- `GET /api/v1/market/ipo-events`: IPO events BEI.
- `GET /api/v1/leaderboard`: ranking NAV/return/P&L.
- `GET /api/v1/notifications`: list notifications.
- `PATCH /api/v1/notifications/:id/read`: mark notification as read.

## 3. WebSocket Market Data (MATS -> Frontend)
Frontend terhubung langsung ke WebSocket MATS: `wss://mats.mandala.local/ws`

### Subscribe Market Data
```json
{
  "action": "subscribe",
  "channels": ["orderbook.BBCA", "trades.BBCA", "ticker.BBCA"]
}
```

### Orderbook Snapshot & Update Message
```json
{
  "channel": "orderbook.BBCA",
  "type": "update",
  "data": {
    "bids": [[10000, 500], [9900, 1000]],
    "asks": [[10100, 200], [10200, 800]]
  }
}
```
