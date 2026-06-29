-- +goose Up
-- +goose StatementBegin

CREATE TABLE config_versions (
    version BIGINT PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE bots (
    internal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_bot_id VARCHAR(100) UNIQUE NOT NULL,
    strategy_type VARCHAR(50) NOT NULL,
    config_version BIGINT REFERENCES config_versions(version),
    status VARCHAR(50) NOT NULL DEFAULT 'halted',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE bot_tokens (
    internal_id UUID PRIMARY KEY REFERENCES bots(internal_id) ON DELETE CASCADE,
    encrypted_jwt TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE simulation_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode VARCHAR(50) NOT NULL,
    global_seed BIGINT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE genesis_runs (
    genesis_run_id UUID PRIMARY KEY,
    status VARCHAR(50) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE state_snapshots (
    internal_id UUID REFERENCES bots(internal_id) ON DELETE CASCADE,
    state_version BIGINT NOT NULL,
    snapshot_data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (internal_id, state_version)
);

CREATE TABLE event_checkpoints (
    internal_id UUID REFERENCES bots(internal_id) ON DELETE CASCADE,
    last_sequence BIGINT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (internal_id)
);

CREATE TABLE bot_decision_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_id UUID REFERENCES bots(internal_id) ON DELETE CASCADE,
    session_instance_id UUID,
    symbol VARCHAR(20),
    action VARCHAR(50) NOT NULL,
    client_order_id VARCHAR(100),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_bot_decision_logs_internal_id ON bot_decision_logs(internal_id);
CREATE INDEX idx_bot_decision_logs_created_at ON bot_decision_logs(created_at);

CREATE TABLE session_performance (
    session_instance_id UUID PRIMARY KEY,
    run_id UUID REFERENCES simulation_runs(run_id),
    metrics JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE sentiment_state (
    id SERIAL PRIMARY KEY,
    global_sentiment NUMERIC NOT NULL,
    sector_sentiment JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE scenario_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_type VARCHAR(100) NOT NULL,
    triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    details JSONB
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS scenario_events;
DROP TABLE IF EXISTS sentiment_state;
DROP TABLE IF EXISTS session_performance;
DROP TABLE IF EXISTS bot_decision_logs;
DROP TABLE IF EXISTS event_checkpoints;
DROP TABLE IF EXISTS state_snapshots;
DROP TABLE IF EXISTS genesis_runs;
DROP TABLE IF EXISTS simulation_runs;
DROP TABLE IF EXISTS bot_tokens;
DROP TABLE IF EXISTS bots;
DROP TABLE IF EXISTS config_versions;
-- +goose StatementEnd
