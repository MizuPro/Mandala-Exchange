# BEI Service

BEI Service adalah market authority internal Mandala Exchange. Service ini mengelola master emiten, saham tercatat, trading rules, broker member, trade capture, settlement, custody ledger, corporate action, reporting, dan surveillance dasar.

## Quick Start

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Endpoint health check tersedia di `GET /health`.

Semua endpoint selain `GET /health` membutuhkan header:

```http
x-service-token: <token-service-yang-sesuai>
```

Auth internal memakai token per service di env `BEI_SERVICE_TOKENS`.

Contoh format:

```env
BEI_SERVICE_TOKENS=[{"name":"admin","token":"replace-with-admin-token","scopes":["admin:*"]},{"name":"mats","token":"replace-with-mats-token","scopes":["market:read","rules:read","broker:read","trade:capture","market-summary:write"]},{"name":"sekuritas","token":"replace-with-sekuritas-token","scopes":["market:read","rules:read","broker:read","settlement:read","custody:read","corporate-action:read","report:read"]},{"name":"readonly","token":"replace-with-readonly-token","scopes":["market:read","rules:read","broker:read","corporate-action:read","report:read"]}]
```

Scope utama:

- `admin:*`: akses operator BEI untuk semua endpoint.
- `mats`: baca rule/security/session, validasi broker, capture trade, dan kirim market summary.
- `sekuritas`: baca market/rules/fee/custody/settlement/corporate action/report.
- `readonly`: akses baca terbatas untuk dashboard atau consumer internal lain.

Token valid tanpa scope yang sesuai akan mendapat `403 Forbidden`. Token kosong atau salah akan mendapat `401 Unauthorized`.

## Boundary

- BEI menjadi sumber kebenaran untuk emiten, listed security, rules, fee schedule, settlement, corporate action, dan custody ledger.
- MATS mengelola order book, matching, market data realtime, dan mengirim trade final ke BEI.
- Sekuritas mengelola user/player, cash reservation, share reservation, order gateway, dan UI portfolio.
- Bot tetap masuk lewat Sekuritas, bukan langsung ke MATS atau BEI.
