ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'LIMIT';

ALTER TABLE order_amendments
  ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now();

CREATE TABLE IF NOT EXISTS corporate_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  corporate_action_id text NOT NULL,
  action_type text NOT NULL,
  symbol text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processed',
  processed_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS corporate_action_events_idempotency_uq
  ON corporate_action_events (idempotency_key);

CREATE INDEX IF NOT EXISTS corporate_action_events_action_idx
  ON corporate_action_events (action_type, symbol);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  reference_type text,
  reference_id text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_uq
  ON notifications (idempotency_key);

CREATE INDEX IF NOT EXISTS notifications_account_created_idx
  ON notifications (broker_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_user_read_idx
  ON notifications (user_id, read_at);

CREATE INDEX IF NOT EXISTS leaderboard_snapshots_account_date_idx
  ON leaderboard_snapshots (broker_account_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS order_amendments_order_created_idx
  ON order_amendments (order_id, created_at DESC);
