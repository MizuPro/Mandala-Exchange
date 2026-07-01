-- +goose Up
ALTER TABLE bot_decision_logs
    ADD COLUMN IF NOT EXISTS simulation_run_id UUID REFERENCES simulation_runs(run_id),
    ADD COLUMN IF NOT EXISTS virtual_day_index BIGINT,
    ADD COLUMN IF NOT EXISTS strategy VARCHAR(50) NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS session_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS decision_reason TEXT,
    ADD COLUMN IF NOT EXISTS context_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS order_submitted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sekuritas_order_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS order_price_idr BIGINT,
    ADD COLUMN IF NOT EXISTS order_quantity_shares BIGINT,
    ADD COLUMN IF NOT EXISTS order_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS reject_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_decision_logs_session
    ON bot_decision_logs(session_instance_id, internal_id, created_at);

-- Preserve old generic details for backward compatibility. New writes use the
-- typed context_snapshot column; old readers may continue reading details.

-- +goose Down
DROP INDEX IF EXISTS idx_bot_decision_logs_session;
ALTER TABLE bot_decision_logs
    DROP COLUMN IF EXISTS reject_reason,
    DROP COLUMN IF EXISTS order_status,
    DROP COLUMN IF EXISTS order_quantity_shares,
    DROP COLUMN IF EXISTS order_price_idr,
    DROP COLUMN IF EXISTS sekuritas_order_id,
    DROP COLUMN IF EXISTS order_submitted,
    DROP COLUMN IF EXISTS context_snapshot,
    DROP COLUMN IF EXISTS decision_reason,
    DROP COLUMN IF EXISTS session_status,
    DROP COLUMN IF EXISTS strategy,
    DROP COLUMN IF EXISTS virtual_day_index,
    DROP COLUMN IF EXISTS simulation_run_id;
