ALTER TABLE ipo_investor_subscriptions
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS forward_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_forward_error text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

CREATE INDEX IF NOT EXISTS ipo_investor_subscriptions_retry_idx
  ON ipo_investor_subscriptions(status, next_retry_at)
  WHERE status = 'cash_reserved';

CREATE TABLE IF NOT EXISTS ipo_lifecycle_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  ipo_event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ipo_lifecycle_inbox_status_created_idx
  ON ipo_lifecycle_inbox(status, created_at);

ALTER TABLE cash_balances DROP CONSTRAINT IF EXISTS cash_balances_non_negative_check;
ALTER TABLE cash_balances ADD CONSTRAINT cash_balances_non_negative_check
  CHECK (available >= 0 AND reserved >= 0 AND pending >= 0) NOT VALID;

ALTER TABLE securities_positions DROP CONSTRAINT IF EXISTS securities_positions_non_negative_check;
ALTER TABLE securities_positions ADD CONSTRAINT securities_positions_non_negative_check
  CHECK (available >= 0 AND reserved >= 0 AND pending >= 0) NOT VALID;

ALTER TABLE ipo_investor_subscriptions DROP CONSTRAINT IF EXISTS ipo_subscription_allocation_bounds_check;
ALTER TABLE ipo_investor_subscriptions ADD CONSTRAINT ipo_subscription_allocation_bounds_check
  CHECK (
    requested_shares > 0
    AND allocated_shares >= 0
    AND allocated_shares <= requested_shares
    AND reserved_cash_idr >= 0
    AND actual_debit_idr >= 0
    AND official_fee_idr >= 0
    AND actual_debit_idr + official_fee_idr <= reserved_cash_idr
  ) NOT VALID;
