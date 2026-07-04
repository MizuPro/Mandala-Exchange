# BOT Cross-Service Contract Freeze v1

**Frozen**: 2026-06-29  
**Normative sources**: `BOT_API_CONTRACTS.md`, `BOT_STATE_MACHINES.md`

## Boundaries

- BOT reads market/rule/session/corporate-action data from BEI and MATS.
- BOT provisions, authenticates, submits investor mutations, snapshots, and consumes account events only through Sekuritas.
- BOT has no BEI/Sekuritas database access and cannot inject orders directly into MATS.
- Sekuritas owns investor cash, position, reservation, order, settlement, and IPO subscription state.
- BEI owns session instances, rules, fees, IPO events, and custody.
- MATS owns matching, order books, STP, and operational market events.

## Frozen endpoints

- BEI: securities, rules, fee schedule, active session instance, MDX composition, IPO lifecycle, and internal genesis custody.
- MATS: authenticated market WebSocket and Sekuritas-only order gateway.
- Sekuritas: BOT provision, token issuance, genesis, portfolio snapshot, account-event WebSocket, order lookup, and investor IPO subscription.

All mutation retries use stable idempotency keys. Quantities crossing service boundaries are shares. Money is integer rupiah or decimal string and is never represented by persisted floating-point values.

## Delivery and recovery

- Account events use a global monotonically increasing sequence and at-least-once delivery.
- Consumers ignore duplicate event IDs/entity versions.
- Snapshot and `as_of_sequence` share a repeatable-read transaction boundary.
- Event retention is at least 24 hours and 100,000 events.
- A sequence outside retention closes the stream with `EVENT_SEQUENCE_TOO_OLD`; BOT reloads a snapshot.
- Unknown order submission is reconciled by stable `client_order_id`; blind replacement orders are forbidden.

## Migration and compatibility

- Sekuritas migrations `0007`–`0012` add BOT events, audit, genesis saga ledgers, and IPO lifecycle state without deleting existing financial history.
- BEI migration additions use `IF NOT EXISTS`; historical duplicate IPO allocation rows are preserved. New allocations use a nullable, unique `allocation_key`.
- BOT migrations are managed by Goose and do not auto-migrate at runtime.
- Existing user JWT remains accepted. BOT JWT adds `account_id`, `account_type=BOT`, scoped claims, issuer/audience, and a one-hour lifetime.

Any incompatible request/response, state, sequence, quantity-unit, money-type, or ownership change requires a new contract version and migration note.

## Validation evidence

- BEI typecheck/unit tests.
- MATS unit tests including STP and session behavior.
- Sekuritas build/unit tests.
- Real database migrations.
- Real BEI–Sekuritas provisioning, short-lived JWT, retry-safe genesis, cash/custody reconciliation, snapshot, account-event replay, IPO cancel, partial/zero allocation, refund, listing, duplicate allocation, and reversal.
- Genesis partial-failure retry using a real BEI identity that can validate securities but lacks custody-write scope.
