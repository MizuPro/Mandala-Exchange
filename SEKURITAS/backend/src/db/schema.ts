import { pgTable, text, timestamp, boolean, numeric, integer, uuid, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  status: text("status").notNull().default("unverified"), // unverified, verified, suspended
  created_at: timestamp("created_at").defaultNow(),
});

export const email_verifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").references(() => users.id).notNull(),
  token: text("token").notNull(),
  expires_at: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  created_at: timestamp("created_at").defaultNow(),
});

export const broker_accounts = pgTable("broker_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").references(() => users.id).notNull(),
  account_type: text("account_type").notNull().default("HUMAN"), // HUMAN, BOT
  status: text("status").notNull().default("ACTIVE"), // ACTIVE, SUSPENDED
  created_at: timestamp("created_at").defaultNow(),
});

export const sid_references = pgTable("sid_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  sid: text("sid").notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

export const sre_references = pgTable("sre_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  sre: text("sre").notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

export const rdn_references = pgTable("rdn_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  rdn: text("rdn").notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

export const cash_balances = pgTable("cash_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  available: numeric("available").notNull().default("0"),
  reserved: numeric("reserved").notNull().default("0"),
  pending: numeric("pending").notNull().default("0"),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  brokerAccountUq: uniqueIndex("cash_balances_broker_account_uq").on(table.broker_account_id),
}));

export const securities_positions = pgTable("securities_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  symbol: text("symbol").notNull(),
  available: integer("available").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
  pending: integer("pending").notNull().default(0),
  average_price: numeric("average_price").notNull().default("0"),
  realized_pl: numeric("realized_pl").notNull().default("0"),
  unrealized_pl: numeric("unrealized_pl").notNull().default("0"),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  brokerAccountSymbolUq: uniqueIndex("securities_positions_account_symbol_uq").on(table.broker_account_id, table.symbol),
}));

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  client_order_id: text("client_order_id").notNull().unique(),
  mats_order_id: text("mats_order_id"),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // BUY, SELL
  order_type: text("order_type").notNull().default("LIMIT"), // LIMIT, MARKET
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  filled_quantity: integer("filled_quantity").notNull().default(0),
  remaining_quantity: integer("remaining_quantity").notNull(),
  reserved_amount: numeric("reserved_amount").notNull().default("0"),
  submission_status: text("submission_status").notNull().default("pending"), // pending, submitted, unknown, failed
  place_idempotency_key: text("place_idempotency_key"),
  last_submission_error: text("last_submission_error"),
  last_action_status: text("last_action_status"),
  last_action_reason: text("last_action_reason"),
  status: text("status").notNull(), // pending, accepted, rejected, cancelled, filled, expired
  reject_reason: text("reject_reason"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  matsOrderUq: uniqueIndex("orders_mats_order_uq").on(table.mats_order_id),
}));

export const order_amendments = pgTable("order_amendments", {
  id: uuid("id").primaryKey().defaultRandom(),
  order_id: uuid("order_id").references(() => orders.id).notNull(),
  old_price: numeric("old_price").notNull(),
  old_quantity: integer("old_quantity").notNull(),
  new_price: numeric("new_price").notNull(),
  new_quantity: integer("new_quantity").notNull(),
  status: text("status").notNull(), // pending, accepted, rejected
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const trade_fills = pgTable("trade_fills", {
  id: uuid("id").primaryKey().defaultRandom(),
  order_id: uuid("order_id").references(() => orders.id).notNull(),
  trade_id: text("trade_id").notNull(),
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  timestamp: timestamp("timestamp").notNull(),
}, (table) => ({
  tradeUq: uniqueIndex("trade_fills_trade_uq").on(table.trade_id),
}));

export const fee_ledgers = pgTable("fee_ledgers", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  order_id: uuid("order_id").references(() => orders.id),
  trade_id: text("trade_id"),
  amount: numeric("amount").notNull(),
  fee_type: text("fee_type").notNull(), // BROKER, LEVY, CLEARING, VAT, WHT
  description: text("description"),
  created_at: timestamp("created_at").defaultNow(),
});

export const ledger_movements = pgTable("ledger_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  asset_type: text("asset_type").notNull(), // CASH, SECURITIES
  symbol: text("symbol"), // NULL if CASH
  amount: numeric("amount").notNull(),
  balance_after: numeric("balance_after").notNull(),
  reference_type: text("reference_type").notNull(), // DEPOSIT, WITHDRAWAL, TRADE, FEE, CORPORATE_ACTION
  reference_id: text("reference_id"),
  created_at: timestamp("created_at").defaultNow(),
});

export const leaderboard_snapshots = pgTable("leaderboard_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  nav: numeric("nav").notNull(),
  return_pct: numeric("return_pct").notNull(),
  realized_pl: numeric("realized_pl").notNull(),
  snapshot_date: timestamp("snapshot_date").notNull(),
  created_at: timestamp("created_at").defaultNow(),
}, (table) => ({
  brokerAccountDateIdx: index("leaderboard_snapshots_account_date_idx").on(table.broker_account_id, table.snapshot_date),
}));

export const settlement_events = pgTable("settlement_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").notNull(),
  order_id: uuid("order_id").references(() => orders.id).notNull(),
  trade_id: text("trade_id"),
  mats_order_id: text("mats_order_id").notNull(),
  side: text("side").notNull(),
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  gross_value: numeric("gross_value").notNull(),
  total_fee: numeric("total_fee").notNull(),
  payload_hash: text("payload_hash").notNull(),
  created_at: timestamp("created_at").defaultNow(),
}, (table) => ({
  idempotencyUq: uniqueIndex("settlement_events_idempotency_uq").on(table.idempotency_key),
}));

export const corporate_action_events = pgTable("corporate_action_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").notNull(),
  corporate_action_id: text("corporate_action_id").notNull(),
  action_type: text("action_type").notNull(),
  symbol: text("symbol").notNull(),
  payload_hash: text("payload_hash").notNull(),
  status: text("status").notNull().default("processed"),
  processed_at: timestamp("processed_at"),
  created_at: timestamp("created_at").defaultNow(),
}, (table) => ({
  idempotencyUq: uniqueIndex("corporate_action_events_idempotency_uq").on(table.idempotency_key),
  actionIdx: index("corporate_action_events_action_idx").on(table.action_type, table.symbol),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").references(() => users.id).notNull(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  reference_type: text("reference_type"),
  reference_id: text("reference_id"),
  idempotency_key: text("idempotency_key").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  read_at: timestamp("read_at"),
  created_at: timestamp("created_at").defaultNow(),
}, (table) => ({
  idempotencyUq: uniqueIndex("notifications_idempotency_uq").on(table.idempotency_key),
  accountCreatedIdx: index("notifications_account_created_idx").on(table.broker_account_id, table.created_at),
  userReadIdx: index("notifications_user_read_idx").on(table.user_id, table.read_at),
}));
