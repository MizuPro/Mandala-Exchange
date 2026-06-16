# MATS Service

MATS (Mandala Automated Trading System) owns order acceptance from Sekuritas, order validation against BEI rules, in-memory order books, continuous matching, trade generation, and market data contracts.

## Quick Start

```bash
cp .env.example .env
docker compose up -d
go mod tidy
go run ./cmd/mats
```

`GET /health` is public. All `/v1/*` endpoints require `x-service-token`.

## Main Endpoints

- `POST /v1/orders`
- `PATCH /v1/orders/{orderId}`
- `POST /v1/orders/{orderId}/cancel`
- `GET /v1/orders/{orderId}`
- `POST /v1/admin/sync/bei`
- `GET /v1/admin/books/{symbol}`
- `GET /v1/admin/auction/{symbol}/indicative`
- `POST /v1/admin/auction/{symbol}/uncross`
- `POST /v1/admin/session/status`
- `POST /v1/admin/session/random-closing`
- `GET /v1/market-data/ws`

MATS consumes BEI endpoints documented in `docs/api-contracts.md`.

## Verification

```bash
go test ./...
```

The integration test suite starts fake BEI and fake Sekuritas endpoints to verify order flow, reject flow, trade capture, and WebSocket snapshot behavior locally.
