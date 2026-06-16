# MATS API Contracts

All `/v1/*` endpoints require `x-service-token`. Request handlers also accept `x-correlation-id`; MATS echoes it when producing events.

## REST: Order Gateway

### `POST /v1/orders`

Places a limit order from Sekuritas.

```json
{
  "client_order_id": "SEC-ORDER-1",
  "broker_code": "MDLA",
  "account_id": "INV-1",
  "symbol": "MNDL",
  "side": "buy",
  "order_type": "limit",
  "price": 100,
  "quantity": 100,
  "idempotency_key": "place-SEC-ORDER-1",
  "is_short_sell": false,
  "is_margin": false
}
```

Response:

```json
{
  "order": { "id": "MATS-O-1", "status": "open" },
  "trades": []
}
```

Rejects include an order with status `rejected` and explicit `reject_reason`.

### `PATCH /v1/orders/{orderId}`

Amends price and/or total quantity of an open order. Quantity is total original quantity after amendment, not delta.

```json
{
  "price": 102,
  "quantity": 200,
  "idempotency_key": "amend-SEC-ORDER-1-1"
}
```

### `POST /v1/orders/{orderId}/cancel`

Cancels remaining open quantity.

```json
{
  "idempotency_key": "cancel-SEC-ORDER-1-1"
}
```

### `GET /v1/orders/{orderId}`

Returns current MATS order state.

## REST: Admin Control

- `POST /v1/admin/sync/bei`: manually refreshes securities, rules, and active session from BEI.
- `GET /v1/admin/books/{symbol}`: returns current full-depth snapshot for debugging.
- `POST /v1/admin/session/status`: manually sets session state.
- `POST /v1/admin/session/halt`: market-wide halt.
- `POST /v1/admin/session/resume`: market-wide resume.
- `POST /v1/admin/session/random-closing`: starts simplified random closing and transitions to closing auction after a random delay.
- `POST /v1/admin/symbols/{symbol}/suspend`: operational symbol suspend.
- `POST /v1/admin/symbols/{symbol}/resume`: operational symbol resume.
- `POST /v1/admin/orders/expire`: expires all remaining open orders.
- `GET /v1/admin/auction/{symbol}/indicative`: returns current IEP/IEV.
- `POST /v1/admin/auction/{symbol}/uncross`: runs auction uncrossing at IEP.

## REST: Health

- `GET /health`: public liveness with database and rules-cache status.

## WebSocket Market Data Contract

Endpoint: `GET /v1/market-data/ws?symbols=MNDL,ABCD`

Event envelope:

```json
{
  "type": "depth_snapshot",
  "sequence": 10,
  "symbol": "MNDL",
  "occurred_at": "2026-06-16T10:00:00Z",
  "payload": {}
}
```

Contracted event types:

- `session_state`
- `best_bid_ask`
- `depth_snapshot`
- `last_price`
- `trade_tape`
- `iep_iev`
- `market_halt`
- `special_notation`
- `market_summary`
- `heartbeat`

Snapshot-on-connect is required in the full market data phase. Heartbeat interval target is 15 seconds.

## Auction Contract

Orders placed during `opening_auction` or `closing_auction` are accepted into the order book but are not continuously matched. MATS calculates IEP/IEV by:

1. maximizing executable volume,
2. minimizing imbalance,
3. choosing the price closest to reference price,
4. choosing the lower price as final tie-break.

Uncrossing uses IEP as the trade price and leaves unfilled remaining quantity open until later cancellation, continuous matching, or expiry.

## MATS -> BEI Trade Capture

MATS sends final trades to `POST /v1/trades/capture`:

```json
{
  "matsTradeId": "MATS-T-1",
  "sequenceNumber": 1,
  "sessionId": "SESSION-1",
  "symbol": "MNDL",
  "price": 100,
  "quantity": 100,
  "buyBrokerCode": "MDLA",
  "sellBrokerCode": "MDLA",
  "buyInvestorId": "INV-BUY",
  "sellInvestorId": "INV-SELL",
  "buyOrderId": "MATS-O-1",
  "sellOrderId": "MATS-O-2",
  "occurredAt": "2026-06-16T10:00:00Z",
  "idempotencyKey": "trade-MATS-T-1"
}
```

## MATS -> Sekuritas Order Status Event

Initial delivery is an internal event contract; HTTP callback/retry delivery is implemented in the event delivery phase.

```json
{
  "event_id": "MATS-E-1",
  "sequence": 1,
  "type": "order_status",
  "correlation_id": "req-1",
  "payload": {
    "client_order_id": "SEC-ORDER-1",
    "mats_order_id": "MATS-O-1",
    "status": "partially_filled",
    "filled_quantity": 100,
    "remaining_quantity": 200,
    "reject_reason": null,
    "trades": []
  }
}
```
