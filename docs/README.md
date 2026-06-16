# Mandala Exchange Documentation

Dokumentasi dipisahkan berdasarkan domain layanan agar boundary setiap sistem lebih jelas.

## Struktur
- `BEI/`: market authority, emiten, aturan pasar, settlement, custody, corporate action, reporting, dan audit aturan BEI-like.
- `MATS/`: Mandala Automated Trading System, order book, matching engine, auction, IEP/IEV, market session, dan market data realtime.
- `SEKURITAS/`: Mandala Sekuritas, akun player, order entry, portfolio, fee, leaderboard, dan frontend trading.
- `BOT/`: konsep bot sebagai automated investor yang tetap melewati Sekuritas dan tunduk pada aturan pasar.

## Dokumen Utama
- `BEI/BEI_PRD.md`
- `BEI/BEI_MAIN_PLAN.md`
- `BEI/BEI_RULES_AUDIT.md`
- `MATS/MATS_PRD.md`
- `MATS/MATS_MAIN_PLAN.md`
- `SEKURITAS/SEKURITAS_PRD.md`
- `SEKURITAS/SEKURITAS_MAIN_PLAN.md`
- `BOT/BOT_PRD.md`

## Tech Stack Ringkas
- Sekuritas Frontend: React + Vite.
- Sekuritas Backend: Node.js + Fastify.
- Sekuritas Database: NeonDB/Neon Postgres.
- BEI Backend: Node.js + Fastify + TypeScript, dengan query layer ringan seperti Drizzle ORM/Kysely.
- BEI Database: PostgreSQL via Docker.
- MATS Backend: Go, dengan HTTP/router ringan dan WebSocket support.
- MATS Database: PostgreSQL via Docker untuk event/order/trade persistence; order book tetap in-memory.
