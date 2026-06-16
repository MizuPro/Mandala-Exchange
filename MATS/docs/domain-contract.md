# MATS Domain Contract

## Service Boundary

- MATS owns order intake from broker services, order validation against BEI-published rules, order book state, continuous matching, auction contracts, IEP/IEV contracts, trade generation, order status events, and market data feeds.
- BEI owns issuer/security master data, trading rules, broker registry, official trade capture, settlement, custody ledger, corporate action, and market summary authority.
- Sekuritas owns player identity, buying power, share reservation, client order state, fee estimates, portfolio UI, and reconciliation.
- Bot accounts must enter through Sekuritas and are not allowed to bypass MATS broker controls.

## Core Entities

- `Order`: broker-routed limit order with broker code, account id, symbol, side, price, quantity, idempotency key, sequence number, status, and reject reason.
- `OrderAmendment`: idempotent request to update price and/or total quantity for an open order.
- `OrderBook`: per-symbol in-memory book using price-time priority. Buy priority is highest price then lowest sequence. Sell priority is lowest price then lowest sequence.
- `Trade`: match output with trade id, global sequence number, symbol, price, quantity, buy/sell order ids, broker/account metadata, session id, timestamp, and idempotency key for BEI capture.
- `Session`: active market state imported from BEI. MVP continuous matching accepts new orders only during `continuous`.
- `MarketData`: derived public feed for best bid/ask, full depth, trade tape, IEP, IEV, session state, halt state, special notation, and market summary.
- `Auction`: opening/closing collection and uncrossing model. The initial algorithm is documented as contract-first and implemented after continuous matching.
- `PriceBand`: BEI-provided ARA/ARB rule selected by board, market segment, and reference price.
- `OrderExpiry`: MVP day/session order. Open remaining quantity expires at session end.

## Status Enums

- Order side: `buy`, `sell`.
- Order type: `limit`.
- Order status: `accepted`, `rejected`, `open`, `amended`, `partially_filled`, `filled`, `cancelled`, `expired`, `locked_non_cancellable`.
- Session status: `closed`, `pre_open`, `opening_auction`, `continuous`, `pre_close`, `random_closing`, `closing_auction`, `non_cancellation`, `post_closing`, `halted`.
- Listing status consumed from BEI: `listed`, `suspended`, `delisted`.
- Market mechanism consumed from BEI: `regular`, `call_auction`, `cash`, `negotiated`.

## Validation Ownership

- MATS validates broker activity, session state, symbol listing status, symbol halt/suspend markers, market mechanism, tick size, lot size, ARA/ARB price band, auto rejection volume, quantity, short selling flag, margin flag, and duplicate idempotency.
- Sekuritas validates cash, share availability, user auth, email verification, reservation, and fee/buying-power impact.
- BEI remains the final source for official rules and official captured trades.
