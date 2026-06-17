DROP INDEX IF EXISTS trade_fills_trade_uq;

CREATE UNIQUE INDEX IF NOT EXISTS trade_fills_order_trade_uq
  ON trade_fills (order_id, trade_id);
