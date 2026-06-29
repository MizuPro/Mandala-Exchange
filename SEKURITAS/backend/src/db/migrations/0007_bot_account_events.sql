CREATE TABLE IF NOT EXISTS bot_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  external_bot_id text NOT NULL UNIQUE,
  strategy text NOT NULL,
  tier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_metadata_broker_account_uq ON bot_metadata(broker_account_id);

CREATE TABLE IF NOT EXISTS internal_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  route text NOT NULL,
  payload_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_account_events (
  sequence integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id),
  event_type text NOT NULL,
  entity_id text NOT NULL,
  entity_version integer NOT NULL,
  correlation_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_account_events_event_id_uq UNIQUE(event_id),
  CONSTRAINT bot_account_events_entity_version_uq UNIQUE(entity_id, entity_version, event_type)
);
CREATE INDEX IF NOT EXISTS bot_account_events_account_sequence_idx
  ON bot_account_events(broker_account_id, sequence);
CREATE INDEX IF NOT EXISTS bot_account_events_created_at_idx
  ON bot_account_events(created_at);
