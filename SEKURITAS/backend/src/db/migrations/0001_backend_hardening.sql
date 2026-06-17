ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS reserved_amount numeric NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS cash_balances_broker_account_uq
  ON cash_balances (broker_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS securities_positions_account_symbol_uq
  ON securities_positions (broker_account_id, symbol);

CREATE UNIQUE INDEX IF NOT EXISTS orders_mats_order_uq
  ON orders (mats_order_id)
  WHERE mats_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trade_fills_trade_uq
  ON trade_fills (trade_id);

CREATE TABLE IF NOT EXISTS settlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id),
  trade_id text,
  mats_order_id text NOT NULL,
  side text NOT NULL,
  price numeric NOT NULL,
  quantity integer NOT NULL,
  gross_value numeric NOT NULL,
  total_fee numeric NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_events_idempotency_uq
  ON settlement_events (idempotency_key);
