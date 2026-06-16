import "dotenv/config";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

const enumStatements = [
  "CREATE TYPE listing_status AS ENUM ('listed','suspended','delisted')",
  "CREATE TYPE board_type AS ENUM ('main','development','acceleration','new_economy','watchlist')",
  "CREATE TYPE market_mechanism AS ENUM ('regular','call_auction','cash','negotiated')",
  "CREATE TYPE notation_type AS ENUM ('watchlist','special_monitoring','suspend','delisting_risk','unusual_condition','admin_note')",
  "CREATE TYPE announcement_type AS ENUM ('financial_report','material_disclosure','news','rups','dividend','rights_issue','ipo','corporate_action')",
  "CREATE TYPE session_status AS ENUM ('closed','pre_open','opening_auction','continuous','pre_close','random_closing','closing_auction','non_cancellation','post_closing','halted')",
  "CREATE TYPE settlement_mode AS ENUM ('instant','end_of_session','t_plus_1_session','t_plus_n_session')",
  "CREATE TYPE settlement_instruction_type AS ENUM ('dvp','rvp','fop','cash_dividend','stock_adjustment','ipo_allocation')",
  "CREATE TYPE settlement_status AS ENUM ('pending','ready','processing','settled','failed','cancelled')",
  "CREATE TYPE corporate_action_type AS ENUM ('cash_dividend','stock_split','reverse_split','bonus_share','rights_issue','warrant')",
  "CREATE TYPE corporate_action_status AS ENUM ('draft','announced','recording','processing','completed','cancelled')",
  "CREATE TYPE trading_halt_status AS ENUM ('inactive','active','resumed')",
  "CREATE TYPE broker_status AS ENUM ('active','suspended','inactive')",
  "CREATE TYPE ledger_entry_type AS ENUM ('ipo_allocation','trade_settlement','cash_settlement','cash_dividend','stock_split','reverse_split','bonus_share','rights_issue','warrant','adjustment','reversal')",
  "CREATE TYPE ledger_asset_type AS ENUM ('cash','security','right','warrant')",
  "CREATE TYPE ipo_status AS ENUM ('draft','bookbuilding','subscription','allocation','listed','cancelled')"
];

const tableSql = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS issuers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  sector text NOT NULL,
  summary text NOT NULL DEFAULT '',
  business_description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listed_securities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL REFERENCES issuers(id),
  symbol text NOT NULL UNIQUE,
  name text NOT NULL,
  board board_type NOT NULL DEFAULT 'main',
  sector text NOT NULL,
  shares_outstanding numeric(24,0) NOT NULL,
  ipo_price numeric(18,2),
  reference_price numeric(18,2) NOT NULL,
  previous_close numeric(18,2),
  status listing_status NOT NULL DEFAULT 'listed',
  market_mechanism market_mechanism NOT NULL DEFAULT 'regular',
  listed_at date,
  suspended_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listed_securities_issuer_idx ON listed_securities(issuer_id);
CREATE INDEX IF NOT EXISTS listed_securities_status_idx ON listed_securities(status);

CREATE TABLE IF NOT EXISTS special_notations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES listed_securities(id),
  type notation_type NOT NULL,
  note text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issuer_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL REFERENCES issuers(id),
  security_id uuid REFERENCES listed_securities(id),
  type announcement_type NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL REFERENCES issuers(id),
  period text NOT NULL,
  period_end_date date NOT NULL,
  revenue numeric(24,2) NOT NULL,
  net_income numeric(24,2) NOT NULL,
  assets numeric(24,2) NOT NULL,
  liabilities numeric(24,2) NOT NULL,
  equity numeric(24,2) NOT NULL,
  eps numeric(18,4),
  book_value_per_share numeric(18,4),
  dividend_payout numeric(18,4),
  ratios jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer_id, period)
);

CREATE TABLE IF NOT EXISTS broker_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  status broker_status NOT NULL DEFAULT 'active',
  service_identifier text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_rule_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  board board_type NOT NULL,
  market_segment text NOT NULL DEFAULT 'regular',
  is_default boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lot_size_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES trading_rule_profiles(id),
  instrument_type text NOT NULL DEFAULT 'stock',
  lot_size integer NOT NULL DEFAULT 100,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tick_size_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES trading_rule_profiles(id),
  min_price numeric(18,2) NOT NULL,
  max_price numeric(18,2),
  tick_size numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_band_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES trading_rule_profiles(id),
  min_reference_price numeric(18,2) NOT NULL,
  max_reference_price numeric(18,2),
  ara_percent numeric(8,4) NOT NULL,
  arb_percent numeric(8,4) NOT NULL,
  min_price numeric(18,2) NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_rejection_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES trading_rule_profiles(id),
  max_lots_per_order integer NOT NULL,
  max_listed_shares_percent numeric(8,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status session_status NOT NULL DEFAULT 'closed',
  settlement_mode settlement_mode NOT NULL DEFAULT 'end_of_session',
  settlement_delay_sessions integer NOT NULL DEFAULT 0,
  post_closing_enabled boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES session_templates(id),
  sequence integer NOT NULL,
  status session_status NOT NULL,
  duration_seconds integer NOT NULL,
  allow_order_entry boolean NOT NULL DEFAULT false,
  allow_cancel_amend boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_halts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid REFERENCES listed_securities(id),
  status trading_halt_status NOT NULL DEFAULT 'inactive',
  reason text NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  broker_buy_rate numeric(10,6) NOT NULL,
  broker_sell_rate numeric(10,6) NOT NULL,
  exchange_fee_rate numeric(10,6) NOT NULL,
  clearing_fee_rate numeric(10,6) NOT NULL,
  settlement_fee_rate numeric(10,6) NOT NULL,
  guarantee_fund_rate numeric(10,6) NOT NULL DEFAULT 0,
  vat_rate numeric(10,6) NOT NULL,
  sell_tax_rate numeric(10,6) NOT NULL,
  minimum_fee numeric(18,2) NOT NULL DEFAULT 0,
  effective_date date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_indices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  base_value numeric(18,4) NOT NULL DEFAULT 1000,
  last_value numeric(18,4) NOT NULL DEFAULT 1000,
  sector text,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  security_id uuid REFERENCES listed_securities(id),
  open numeric(18,2),
  high numeric(18,2),
  low numeric(18,2),
  close numeric(18,2),
  last numeric(18,2),
  volume numeric(24,0) NOT NULL DEFAULT 0,
  value numeric(24,2) NOT NULL DEFAULT 0,
  frequency integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL REFERENCES broker_members(id),
  investor_id text NOT NULL,
  sid text NOT NULL UNIQUE,
  sre text NOT NULL,
  rdn text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broker_id, investor_id)
);

CREATE TABLE IF NOT EXISTS custody_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_account_id uuid NOT NULL REFERENCES custody_accounts(id),
  security_id uuid REFERENCES listed_securities(id),
  entry_type ledger_entry_type NOT NULL,
  asset_type ledger_asset_type NOT NULL,
  quantity numeric(24,4) NOT NULL,
  cash_amount numeric(24,2),
  position_state text NOT NULL DEFAULT 'settled',
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custody_ledger_entries_account_idx ON custody_ledger_entries(custody_account_id);
CREATE INDEX IF NOT EXISTS custody_ledger_entries_security_idx ON custody_ledger_entries(security_id);

CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mats_trade_id text NOT NULL UNIQUE,
  sequence_number integer NOT NULL,
  session_id text NOT NULL,
  security_id uuid NOT NULL REFERENCES listed_securities(id),
  symbol text NOT NULL,
  price numeric(18,2) NOT NULL,
  quantity numeric(24,0) NOT NULL,
  value numeric(24,2) NOT NULL,
  buy_broker_id uuid NOT NULL REFERENCES broker_members(id),
  sell_broker_id uuid NOT NULL REFERENCES broker_members(id),
  buy_investor_id text NOT NULL,
  sell_investor_id text NOT NULL,
  buy_order_id text NOT NULL,
  sell_order_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trades_session_idx ON trades(session_id);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades(symbol);

CREATE TABLE IF NOT EXISTS settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  mode settlement_mode NOT NULL DEFAULT 'end_of_session',
  status settlement_status NOT NULL DEFAULT 'pending',
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlement_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES settlement_batches(id),
  trade_id uuid REFERENCES trades(id),
  type settlement_instruction_type NOT NULL,
  status settlement_status NOT NULL DEFAULT 'pending',
  from_custody_account_id uuid REFERENCES custody_accounts(id),
  to_custody_account_id uuid REFERENCES custody_accounts(id),
  security_id uuid REFERENCES listed_securities(id),
  quantity numeric(24,4) NOT NULL DEFAULT 0,
  cash_amount numeric(24,2) NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_instructions_batch_idx ON settlement_instructions(batch_id);
CREATE INDEX IF NOT EXISTS settlement_instructions_trade_idx ON settlement_instructions(trade_id);

CREATE TABLE IF NOT EXISTS corporate_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES listed_securities(id),
  type corporate_action_type NOT NULL,
  status corporate_action_status NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  announcement_date date,
  recording_date date,
  execution_date date,
  ratio_numerator numeric(18,6),
  ratio_denominator numeric(18,6),
  cash_amount_per_share numeric(18,4),
  exercise_price numeric(18,2),
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ipo_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL REFERENCES issuers(id),
  security_id uuid REFERENCES listed_securities(id),
  offered_shares numeric(24,0) NOT NULL,
  offering_price numeric(18,2) NOT NULL,
  bookbuilding_start timestamptz,
  bookbuilding_end timestamptz,
  subscription_start timestamptz,
  subscription_end timestamptz,
  listing_date date,
  status ipo_status NOT NULL DEFAULT 'draft',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ipo_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ipo_event_id uuid NOT NULL REFERENCES ipo_events(id),
  broker_id uuid NOT NULL REFERENCES broker_members(id),
  investor_id text NOT NULL,
  requested_shares numeric(24,0) NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ipo_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ipo_subscription_id uuid NOT NULL REFERENCES ipo_subscriptions(id),
  allocated_shares numeric(24,0) NOT NULL,
  allocation_value numeric(24,2) NOT NULL,
  status text NOT NULL DEFAULT 'allocated',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surveillance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  security_id uuid REFERENCES listed_securities(id),
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

async function createEnums(pool: pg.Pool) {
  for (const statement of enumStatements) {
    const enumName = statement.match(/CREATE TYPE ([a-z_]+)/)?.[1];
    if (!enumName) continue;
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${enumName}') THEN
          ${statement};
        END IF;
      END
      $$;
    `);
  }
}

async function main() {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await createEnums(pool);
    await pool.query(tableSql);
    console.log("BEI database migration completed");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
