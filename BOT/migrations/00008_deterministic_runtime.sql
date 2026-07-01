-- +goose Up
ALTER TABLE simulation_runs
  ADD COLUMN IF NOT EXISTS config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS virtual_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'running',
  ADD COLUMN IF NOT EXISTS model_version VARCHAR(64) NOT NULL DEFAULT 'bot-v1';

ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_mode_check
  CHECK (mode IN ('live', 'deterministic_test'));
ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_status_check
  CHECK (status IN ('running', 'completed', 'failed'));

CREATE TABLE simulation_bot_seeds (
  run_id UUID NOT NULL REFERENCES simulation_runs(run_id) ON DELETE CASCADE,
  bot_id VARCHAR(100) NOT NULL,
  seed BIGINT NOT NULL,
  PRIMARY KEY (run_id, bot_id)
);

CREATE TABLE simulation_journal (
  run_id UUID NOT NULL REFERENCES simulation_runs(run_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('input', 'scheduler', 'decision', 'order')),
  event_sequence BIGINT CHECK (event_sequence IS NULL OR event_sequence >= 0),
  virtual_time TIMESTAMPTZ NOT NULL,
  bot_id VARCHAR(100),
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE INDEX simulation_journal_event_idx
  ON simulation_journal(run_id, event_sequence)
  WHERE event_sequence IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS simulation_journal_event_idx;
DROP TABLE IF EXISTS simulation_journal;
DROP TABLE IF EXISTS simulation_bot_seeds;
ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_status_check;
ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_mode_check;
ALTER TABLE simulation_runs
  DROP COLUMN IF EXISTS model_version,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS virtual_time,
  DROP COLUMN IF EXISTS config_snapshot;
