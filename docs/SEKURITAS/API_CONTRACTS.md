# API Contracts - Mandala Sekuritas

## 1. Kontrak Sekuritas <-> MATS
Sekuritas mengirim request ke MATS untuk order management. MATS mengirim callback/webhook ke Sekuritas untuk order status dan trades.

### Place Order (Sekuritas -> MATS)
`POST /api/v1/orders`
```json
{
  "client_order_id": "seq-12345",
  "broker_code": "MANDALA",
  "symbol": "BBCA",
  "side": "BUY",
  "price": 10000,
  "quantity": 100,
  "time_in_force": "DAY"
}
```

### Amend Order (Sekuritas -> MATS)
`PUT /api/v1/orders/{mats_order_id}`
```json
{
  "price": 10100,
  "quantity": 100
}
```

### Cancel Order (Sekuritas -> MATS)
`DELETE /api/v1/orders/{mats_order_id}`

### Order Status Update (MATS -> Sekuritas Webhook)
`POST /internal/webhook/mats/order-update`
```json
{
  "mats_order_id": "mats-888",
  "client_order_id": "seq-12345",
  "status": "FILLED",
  "filled_quantity": 100,
  "remaining_quantity": 0,
  "average_price": 10000,
  "timestamp": "2026-06-16T12:00:00Z"
}
```

## 2. Kontrak Sekuritas <-> BEI
Sekuritas mengambil referensi data dari BEI.

### Get Listed Securities
`GET /api/v1/issuers/securities`

### Get Fee Schedule
`GET /api/v1/rules/fees`

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
