ALTER TABLE bot_account_events
  ALTER COLUMN sequence DROP IDENTITY IF EXISTS;
CREATE TABLE IF NOT EXISTS bot_event_sequence_counter (
  id smallint PRIMARY KEY CHECK(id = 1),
  value bigint NOT NULL
);
INSERT INTO bot_event_sequence_counter(id, value)
VALUES (1, COALESCE((SELECT max(sequence) FROM bot_account_events), 0))
ON CONFLICT(id) DO UPDATE
SET value = GREATEST(bot_event_sequence_counter.value, excluded.value);
