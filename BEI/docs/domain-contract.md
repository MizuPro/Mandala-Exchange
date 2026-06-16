# BEI Domain Contract

## Service Boundary

- BEI owns issuer/company profile, listed security, board status, special notation, trading rules, fee schedule, official trade capture, clearing, settlement, custody ledger, corporate action, market summary, reporting, and rule audit.
- MATS owns order acceptance from brokers, order book, auction, continuous matching, IEP/IEV, live market data, and trade generation. MATS consumes BEI rules and posts official trades to BEI.
- Sekuritas owns player identity, cash reservation, securities reservation before order entry, client orders, portfolio UI, fee estimate, leaderboard, and reconciliation against BEI.
- Bot accounts are treated as Sekuritas users and do not bypass broker controls.

## Core Entities

- `issuer`: listed company master data.
- `issuer_announcement`: disclosure, material news, RUPS, dividend, IPO, and corporate action announcements.
- `listed_security`: stock instrument, board, symbol, status, shares outstanding, reference price, and mechanism.
- `special_notation`: watchlist, special monitoring, suspend marker, delisting risk, unusual condition, or admin note.
- `broker_member`: exchange member registry, including Mandala Sekuritas.
- `trading_rule_profile`: board/segment rule group.
- `price_band_rule`, `tick_size_rule`, `lot_size_rule`, `auto_rejection_rule`: validations consumed by MATS and Sekuritas.
- `fee_schedule`: broker commission, exchange levy, clearing, settlement, guarantee fund, VAT, and sell tax.
- `trade`: official MATS trade captured idempotently by BEI.
- `settlement_batch` and `settlement_instruction`: clearing and settlement workflow.
- `custody_account` and `custody_ledger_entry`: final securities/cash movement source of truth.
- `corporate_action` and `ipo_event`: issuer action lifecycle and position adjustment source.
- `market_index`, `market_summary`, `surveillance_alert`: reporting and monitoring data.

## Status Enums

- Listing status: `listed`, `suspended`, `delisted`.
- Board type: `main`, `development`, `acceleration`, `new_economy`, `watchlist`.
- Session status: `closed`, `pre_open`, `opening_auction`, `continuous`, `pre_close`, `random_closing`, `closing_auction`, `non_cancellation`, `post_closing`, `halted`.
- Settlement instruction type: `dvp`, `rvp`, `fop`, `cash_dividend`, `stock_adjustment`, `ipo_allocation`.
- Settlement status: `pending`, `ready`, `processing`, `settled`, `failed`, `cancelled`.
- Corporate action status: `draft`, `announced`, `recording`, `processing`, `completed`, `cancelled`.
- Trading halt status: `inactive`, `active`, `resumed`.
