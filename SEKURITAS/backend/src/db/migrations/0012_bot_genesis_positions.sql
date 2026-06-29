CREATE TABLE IF NOT EXISTS bot_genesis_position_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  genesis_run_id uuid NOT NULL REFERENCES bot_genesis_runs(genesis_run_id),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  symbol text NOT NULL,
  quantity_shares integer NOT NULL CHECK(quantity_shares >= 0),
  average_price_idr numeric NOT NULL CHECK(average_price_idr >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_genesis_position_entries_uq UNIQUE(genesis_run_id, broker_account_id, symbol)
);
