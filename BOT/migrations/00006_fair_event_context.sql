-- +goose Up
ALTER TABLE scenario_events
  ADD COLUMN IF NOT EXISTS simulation_run_id UUID REFERENCES simulation_runs(run_id),
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS symbol VARCHAR(20),
  ADD COLUMN IF NOT EXISTS intensity NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS simulation_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bei_announcement_id UUID,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

UPDATE scenario_events
SET event_type = COALESCE(event_type, scenario_type)
WHERE event_type IS NULL;

-- Legacy scenario rows were already internal stress scenarios. Mark them
-- explicitly before enforcing the new invariant.
UPDATE scenario_events SET simulation_only = TRUE WHERE simulation_only = FALSE;

ALTER TABLE scenario_events
  ALTER COLUMN event_type SET NOT NULL;

ALTER TABLE scenario_events
  ADD CONSTRAINT scenario_events_status_check
    CHECK (status IN ('pending','active','completed','cancelled','failed')),
  ADD CONSTRAINT scenario_events_simulation_only_check
    CHECK (simulation_only),
  ADD CONSTRAINT scenario_events_published_source_check
    CHECK (bei_announcement_id IS NULL OR published_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS scenario_events_status_idx
  ON scenario_events(status, triggered_at DESC);

-- +goose Down
DROP INDEX IF EXISTS scenario_events_status_idx;
ALTER TABLE scenario_events DROP CONSTRAINT IF EXISTS scenario_events_published_source_check;
ALTER TABLE scenario_events DROP CONSTRAINT IF EXISTS scenario_events_simulation_only_check;
ALTER TABLE scenario_events DROP CONSTRAINT IF EXISTS scenario_events_status_check;
ALTER TABLE scenario_events
  DROP COLUMN IF EXISTS ended_at,
  DROP COLUMN IF EXISTS payload,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS bei_announcement_id,
  DROP COLUMN IF EXISTS simulation_only,
  DROP COLUMN IF EXISTS intensity,
  DROP COLUMN IF EXISTS symbol,
  DROP COLUMN IF EXISTS event_type,
  DROP COLUMN IF EXISTS simulation_run_id;
