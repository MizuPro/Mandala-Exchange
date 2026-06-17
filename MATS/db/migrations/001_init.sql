CREATE SEQUENCE IF NOT EXISTS mats_event_sequence START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS mats_orders (
  id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  broker_code TEXT NOT NULL,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price NUMERIC(20, 4) NOT NULL,
  original_quantity NUMERIC(20, 0) NOT NULL,
  remaining_quantity NUMERIC(20, 0) NOT NULL,
  filled_quantity NUMERIC(20, 0) NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  sequence_number BIGINT NOT NULL,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS mats_orders_symbol_status_idx ON mats_orders(symbol, status);
CREATE INDEX IF NOT EXISTS mats_orders_broker_account_idx ON mats_orders(broker_code, account_id);

CREATE TABLE IF NOT EXISTS mats_trades (
  id TEXT PRIMARY KEY,
  sequence_number BIGINT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price NUMERIC(20, 4) NOT NULL,
  quantity NUMERIC(20, 0) NOT NULL,
  buy_order_id TEXT NOT NULL,
  sell_order_id TEXT NOT NULL,
  buy_broker_code TEXT NOT NULL,
  sell_broker_code TEXT NOT NULL,
  buy_account_id TEXT NOT NULL,
  sell_account_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS mats_trades_session_idx ON mats_trades(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS mats_trades_symbol_idx ON mats_trades(symbol, occurred_at);

CREATE TABLE IF NOT EXISTS mats_order_events (
  id TEXT PRIMARY KEY,
  sequence_number BIGINT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  order_id TEXT,
  trade_id TEXT,
  symbol TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mats_order_events_order_idx ON mats_order_events(order_id, sequence_number);
CREATE INDEX IF NOT EXISTS mats_order_events_symbol_idx ON mats_order_events(symbol, sequence_number);

CREATE TABLE IF NOT EXISTS mats_idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 200,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mats_delivery_events (
  id TEXT PRIMARY KEY,
  sequence_number BIGINT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  symbol TEXT,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mats_delivery_events_status_idx ON mats_delivery_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS mats_delivery_events_target_idx ON mats_delivery_events(target, event_type);
