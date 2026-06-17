CREATE TABLE IF NOT EXISTS settlement_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  mats_order_id text NOT NULL,
  trade_id text,
  status text NOT NULL DEFAULT 'received',
  payload_hash text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_inbox_idempotency_uq
  ON settlement_inbox (idempotency_key);

CREATE INDEX IF NOT EXISTS settlement_inbox_order_status_idx
  ON settlement_inbox (mats_order_id, status);
