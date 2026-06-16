# BEI Internal API Contracts

All endpoints except `GET /health` require `x-service-token`.

Tokens are configured per service through `BEI_SERVICE_TOKENS`. A valid token maps to a service identity and scopes. Invalid or missing token returns `401`; valid token without the required scope returns `403`.

## Scope Model

- `admin:*`: full BEI operator access.
- `market:read`: issuer, listed security, fundamental, and public market data reads.
- `market-summary:write`: market summary submission from MATS.
- `rules:read`: trading rules, session template, and fee schedule reads.
- `broker:read`: broker validation and broker registry reads.
- `trade:capture`: official trade capture from MATS.
- `trade:read`: official trade read access.
- `settlement:read` / `settlement:write`: settlement status reads and settlement processing.
- `custody:read`: custody account, position summary, and reconciliation reads.
- `corporate-action:read` / `corporate-action:write`: corporate action and IPO read/write processing.
- `report:read`: reports for trades, settlement, fee/tax, market summary, and custody movement.
- `surveillance:read` / `surveillance:write`: surveillance alert reads and scan execution.

## MATS Consumes

- `GET /v1/integration/mats/rules`
- `GET /v1/integration/mats/securities`
- `GET /v1/integration/mats/sessions/active`
- `GET /v1/brokers/:code/validate`
- `POST /v1/trades/capture`
- `POST /v1/market-summaries`

Expected scopes: `market:read`, `rules:read`, `broker:read`, `trade:capture`, `market-summary:write`.

## Sekuritas Consumes

- `GET /v1/public/securities`
- `GET /v1/public/securities/:symbol`
- `GET /v1/public/securities/:symbol/fundamentals`
- `GET /v1/public/fee-schedule`
- `GET /v1/custody/accounts/:brokerCode/:investorId/summary`
- `GET /v1/settlement/session/:sessionId`
- `GET /v1/corporate-actions`
- `GET /v1/reports/trades/:sessionId`
- `GET /v1/reports/settlements/:sessionId`

Expected scopes: `market:read`, `rules:read`, `broker:read`, `settlement:read`, `custody:read`, `corporate-action:read`, `report:read`.

## Admin/Operator Consumes

- CRUD issuer, listed security, special notation, issuer announcement, financial report.
- CRUD trading rule profile, tick size, lot size, price band, session template, fee schedule, trading halt.
- Broker registry management.
- IPO and corporate action processing.
- Settlement batch generation and processing.
- Surveillance scan and alert review.

Expected scope: `admin:*`.
