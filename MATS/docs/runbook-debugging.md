# MATS Order and Trade Debugging Runbook

## 1. Health and Rule Cache

```bash
curl http://localhost:8082/health
```

Check:
- database status is `ok`
- rules cache has securities and rule profiles
- session status is expected

Manual BEI sync:

```bash
curl -X POST http://localhost:8082/v1/admin/sync/bei \
  -H "x-service-token: $MATS_ADMIN_TOKEN"
```

## 2. Order Placement

Submit a buy/sell order through Sekuritas in normal use. For local debugging:

```bash
curl -X POST http://localhost:8082/v1/orders \
  -H "content-type: application/json" \
  -H "x-service-token: $MATS_SEKURITAS_TOKEN" \
  -H "idempotency-key: debug-order-1" \
  -d '{"client_order_id":"debug-1","broker_code":"MDLA","account_id":"INV-1","symbol":"MNDL","side":"buy","order_type":"limit","price":100,"quantity":100,"idempotency_key":"debug-order-1"}'
```

Inspect an order:

```bash
curl http://localhost:8082/v1/orders/MATS-O-1 \
  -H "x-service-token: $MATS_SEKURITAS_TOKEN"
```

## 3. Order Book and Market Data

Book snapshot:

```bash
curl http://localhost:8082/v1/admin/books/MNDL \
  -H "x-service-token: $MATS_ADMIN_TOKEN"
```

WebSocket:

```bash
wscat -H "x-service-token: $MATS_MARKET_TOKEN" \
  -c "ws://localhost:8082/v1/market-data/ws?symbols=MNDL"
```

Expected events include `session_state`, `depth_snapshot`, `best_bid_ask`, `trade_tape`, `last_price`, `market_summary`, and `heartbeat`.

## 4. Auction Debugging

Set auction session:

```bash
curl -X POST http://localhost:8082/v1/admin/session/status \
  -H "content-type: application/json" \
  -H "x-service-token: $MATS_ADMIN_TOKEN" \
  -d '{"status":"opening_auction"}'
```

Read IEP/IEV:

```bash
curl http://localhost:8082/v1/admin/auction/MNDL/indicative \
  -H "x-service-token: $MATS_ADMIN_TOKEN"
```

Run uncrossing:

```bash
curl -X POST http://localhost:8082/v1/admin/auction/MNDL/uncross \
  -H "x-service-token: $MATS_ADMIN_TOKEN"
```

## 5. Delivery and Dead Letter

Inspect failed deliveries:

```bash
curl "http://localhost:8082/v1/admin/delivery-events?status=dead" \
  -H "x-service-token: $MATS_ADMIN_TOKEN"
```

Common causes:
- `BEI_SERVICE_TOKEN` invalid or missing BEI `trade:capture` scope
- `SEKURITAS_EVENTS_URL` not configured
- Sekuritas callback endpoint unavailable
- trade payload rejected by BEI due to symbol, broker, or idempotency mismatch

## 6. Local Verification

```bash
go test ./...
```

Integration tests use fake BEI and fake Sekuritas endpoints, so they can run before the Sekuritas service exists.
