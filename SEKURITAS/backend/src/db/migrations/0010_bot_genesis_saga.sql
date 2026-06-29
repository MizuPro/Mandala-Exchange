CREATE TABLE IF NOT EXISTS bot_genesis_runs (
  genesis_run_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  status text NOT NULL,
  sekuritas_checkpoint uuid NOT NULL DEFAULT gen_random_uuid(),
  bei_custody_checkpoint text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS bot_genesis_cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  genesis_run_id uuid NOT NULL REFERENCES bot_genesis_runs(genesis_run_id),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  amount_idr numeric NOT NULL CHECK(amount_idr >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_genesis_cash_entries_run_account_uq UNIQUE(genesis_run_id, broker_account_id)
);
