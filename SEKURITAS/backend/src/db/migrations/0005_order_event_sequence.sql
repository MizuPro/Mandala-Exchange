ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS last_mats_event_sequence integer NOT NULL DEFAULT 0;
