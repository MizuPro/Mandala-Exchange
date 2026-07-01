-- +goose Up
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS strategy_state_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE state_snapshots
  ADD COLUMN IF NOT EXISTS strategy_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS session_instance_id UUID,
  ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_reason VARCHAR(32);

ALTER TABLE state_snapshots
  ADD CONSTRAINT state_snapshots_strategy_type_check
  CHECK (
    strategy_type IS NULL OR
    strategy_type IN ('bandar', 'value_investor', 'index_tracker')
  );

ALTER TABLE state_snapshots
  ADD CONSTRAINT state_snapshots_reason_check
  CHECK (
    snapshot_reason IS NULL OR
    snapshot_reason IN ('transition', 'material_change', 'shutdown')
  );

CREATE INDEX IF NOT EXISTS state_snapshots_latest_idx
  ON state_snapshots(internal_id, state_version DESC);

-- +goose Down
DROP INDEX IF EXISTS state_snapshots_latest_idx;
ALTER TABLE state_snapshots DROP CONSTRAINT IF EXISTS state_snapshots_reason_check;
ALTER TABLE state_snapshots DROP CONSTRAINT IF EXISTS state_snapshots_strategy_type_check;
ALTER TABLE state_snapshots
  DROP COLUMN IF EXISTS snapshot_reason,
  DROP COLUMN IF EXISTS checkpoint,
  DROP COLUMN IF EXISTS session_instance_id,
  DROP COLUMN IF EXISTS strategy_type;
ALTER TABLE bots DROP COLUMN IF EXISTS strategy_state_version;
