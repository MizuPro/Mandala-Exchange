-- +goose Up
ALTER TABLE bots ADD COLUMN IF NOT EXISTS sekuritas_account_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS bots_sekuritas_account_id_uq
  ON bots(sekuritas_account_id)
  WHERE sekuritas_account_id IS NOT NULL;
ALTER TABLE event_checkpoints ADD COLUMN IF NOT EXISTS global_sequence BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE event_checkpoints DROP COLUMN IF EXISTS global_sequence;
DROP INDEX IF EXISTS bots_sekuritas_account_id_uq;
ALTER TABLE bots DROP COLUMN IF EXISTS sekuritas_account_id;
