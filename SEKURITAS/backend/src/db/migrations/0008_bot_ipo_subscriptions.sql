CREATE TABLE IF NOT EXISTS bot_ipo_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  symbol text NOT NULL,
  price numeric NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  total_amount numeric NOT NULL CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_ipo_subscriptions_account_status_idx
  ON bot_ipo_subscriptions(broker_account_id, status);
