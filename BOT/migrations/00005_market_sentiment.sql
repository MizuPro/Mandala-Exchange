-- +goose Up
CREATE TABLE IF NOT EXISTS market_sentiment (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    session_instance_id UUID,
    overall VARCHAR(10) NOT NULL
      CHECK (overall IN ('bearish', 'neutral', 'bullish')),
    volatility_regime VARCHAR(10) NOT NULL
      CHECK (volatility_regime IN ('low', 'medium', 'high')),
    sector_sentiment JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_override BOOLEAN NOT NULL DEFAULT FALSE,
    valid_until TIMESTAMPTZ,
    source VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((is_override AND valid_until IS NOT NULL) OR
           (NOT is_override AND valid_until IS NULL))
);
CREATE INDEX IF NOT EXISTS market_sentiment_session_idx
  ON market_sentiment(session_instance_id, version DESC);
CREATE INDEX IF NOT EXISTS market_sentiment_override_expiry_idx
  ON market_sentiment(valid_until DESC) WHERE is_override;

-- +goose Down
DROP INDEX IF EXISTS market_sentiment_override_expiry_idx;
DROP INDEX IF EXISTS market_sentiment_session_idx;
DROP TABLE IF EXISTS market_sentiment;
