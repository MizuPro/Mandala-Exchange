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
