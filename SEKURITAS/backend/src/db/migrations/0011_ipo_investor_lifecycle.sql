CREATE TABLE IF NOT EXISTS ipo_investor_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ipo_event_id uuid NOT NULL,
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  idempotency_key text NOT NULL UNIQUE,
  requested_shares integer NOT NULL CHECK(requested_shares > 0),
  offering_price_idr numeric NOT NULL CHECK(offering_price_idr > 0),
  reserved_cash_idr numeric NOT NULL CHECK(reserved_cash_idr >= 0),
  allocated_shares integer NOT NULL DEFAULT 0 CHECK(allocated_shares >= 0),
  actual_debit_idr numeric NOT NULL DEFAULT 0 CHECK(actual_debit_idr >= 0),
  official_fee_idr numeric NOT NULL DEFAULT 0 CHECK(official_fee_idr >= 0),
  status text NOT NULL,
  bei_subscription_id text,
  event_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ipo_investor_subscriptions_account_event_idx
  ON ipo_investor_subscriptions(broker_account_id, ipo_event_id);
