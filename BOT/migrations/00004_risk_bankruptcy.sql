-- +goose Up
CREATE TABLE IF NOT EXISTS bot_risk_state (
    bot_id VARCHAR(100) PRIMARY KEY REFERENCES bots(external_bot_id) ON DELETE CASCADE,
    account_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'liquidating', 'disabled', 'bankrupt')),
    session_instance_id UUID,
    virtual_day_index INTEGER NOT NULL DEFAULT 0 CHECK (virtual_day_index >= 0),
    daily_baseline_idr BIGINT NOT NULL DEFAULT 0 CHECK (daily_baseline_idr >= 0),
    weekly_baseline_idr BIGINT NOT NULL DEFAULT 0 CHECK (weekly_baseline_idr >= 0),
    week_start_day_index INTEGER NOT NULL DEFAULT 0 CHECK (week_start_day_index >= 0),
    last_equity_idr BIGINT NOT NULL DEFAULT 0 CHECK (last_equity_idr >= 0),
    disabled_reason TEXT NOT NULL DEFAULT '',
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bot_risk_state_status_idx ON bot_risk_state(status);

ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_status_check;
ALTER TABLE bots ADD CONSTRAINT bots_status_check
  CHECK (status IN ('provisioning','inactive','active','paused','cooldown','disabled','bankrupt','halted'));

-- +goose Down
ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_status_check;
DROP INDEX IF EXISTS bot_risk_state_status_idx;
DROP TABLE IF EXISTS bot_risk_state;
