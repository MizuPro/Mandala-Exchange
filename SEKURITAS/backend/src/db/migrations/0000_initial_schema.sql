CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'unverified',
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token text NOT NULL,
  expires_at timestamp NOT NULL,
  used boolean DEFAULT false,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  account_type text NOT NULL DEFAULT 'HUMAN',
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sid_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  sid text NOT NULL UNIQUE,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sre_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  sre text NOT NULL UNIQUE,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rdn_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  rdn text NOT NULL UNIQUE,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  available numeric NOT NULL DEFAULT 0,
  reserved numeric NOT NULL DEFAULT 0,
  pending numeric NOT NULL DEFAULT 0,
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_balances_broker_account_uq
  ON cash_balances (broker_account_id);

CREATE TABLE IF NOT EXISTS securities_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  symbol text NOT NULL,
  available integer NOT NULL DEFAULT 0,
  reserved integer NOT NULL DEFAULT 0,
  pending integer NOT NULL DEFAULT 0,
  average_price numeric NOT NULL DEFAULT 0,
  realized_pl numeric NOT NULL DEFAULT 0,
  unrealized_pl numeric NOT NULL DEFAULT 0,
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS securities_positions_account_symbol_uq
  ON securities_positions (broker_account_id, symbol);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id text NOT NULL UNIQUE,
  mats_order_id text,
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  symbol text NOT NULL,
  side text NOT NULL,
  order_type text NOT NULL DEFAULT 'limit',
  price numeric NOT NULL,
  original_quantity integer NOT NULL,
  filled_quantity integer NOT NULL DEFAULT 0,
  remaining_quantity integer NOT NULL,
  reserved_amount numeric NOT NULL DEFAULT 0,
  submission_status text NOT NULL DEFAULT 'pending',
  place_idempotency_key text,
  last_submission_error text,
  last_action_status text,
  last_action_reason text,
  last_mats_event_sequence integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  reject_reason text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_mats_order_uq
  ON orders (mats_order_id);

CREATE TABLE IF NOT EXISTS order_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  old_price numeric NOT NULL,
  old_original_quantity integer NOT NULL,
  new_price numeric NOT NULL,
  new_original_quantity integer NOT NULL,
  status text NOT NULL,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_amendments_order_created_idx
  ON order_amendments (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  trade_id text NOT NULL,
  price numeric NOT NULL,
  quantity integer NOT NULL,
  timestamp timestamp NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS trade_fills_order_trade_uq
  ON trade_fills (order_id, trade_id);

CREATE TABLE IF NOT EXISTS fee_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  order_id uuid REFERENCES orders(id),
  trade_id text,
  amount numeric NOT NULL,
  fee_type text NOT NULL,
  description text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  asset_type text NOT NULL,
  symbol text,
  amount numeric NOT NULL,
  balance_after numeric NOT NULL,
  reference_type text NOT NULL,
  reference_id text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  nav numeric NOT NULL,
  return_pct numeric NOT NULL,
  realized_pl numeric NOT NULL,
  snapshot_date timestamp NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leaderboard_snapshots_account_date_idx
  ON leaderboard_snapshots (broker_account_id, snapshot_date);
