-- +goose Up
ALTER TABLE config_versions ADD COLUMN IF NOT EXISTS config_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE config_versions ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'database';
ALTER TABLE config_versions ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_payload_hash_uq
  ON config_versions(payload_hash) WHERE payload_hash IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS config_versions_payload_hash_uq;
ALTER TABLE config_versions DROP COLUMN IF EXISTS payload_hash;
ALTER TABLE config_versions DROP COLUMN IF EXISTS source;
ALTER TABLE config_versions DROP COLUMN IF EXISTS config_data;
