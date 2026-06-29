import { pgTable, text, timestamp, boolean, numeric, integer, bigint, uuid, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

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

export const withdrawal_bank_accounts = pgTable("withdrawal_bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  bank_code: text("bank_code").notNull().default("MANDALA"),
  bank_name: text("bank_name").notNull(),
  account_number: text("account_number").notNull(),
  account_holder_name: text("account_holder_name").notNull(),
  status: text("status").notNull().default("verified"), // verified, pending_verification, rejected
  source: text("source").notNull().default("manual"), // bank_mandala, manual
  is_primary: boolean("is_primary").notNull().default(true),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  brokerAccountIdx: index("withdrawal_bank_accounts_broker_account_idx").on(table.broker_account_id),
}));

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
  side: text("side").notNull(), // buy, sell
  order_type: text("order_type").notNull().default("limit"), // limit, market
  price: numeric("price").notNull(),
  original_quantity: integer("original_quantity").notNull(),
  filled_quantity: integer("filled_quantity").notNull().default(0),
  remaining_quantity: integer("remaining_quantity").notNull(),
  reserved_amount: numeric("reserved_amount").notNull().default("0"),
  submission_status: text("submission_status").notNull().default("pending"), // pending, submitted, unknown, failed
  place_idempotency_key: text("place_idempotency_key"),
  last_submission_error: text("last_submission_error"),
  last_action_status: text("last_action_status"),
  last_action_reason: text("last_action_reason"),
  last_mats_event_sequence: integer("last_mats_event_sequence").notNull().default(0),
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
  old_original_quantity: integer("old_original_quantity").notNull(),
  new_price: numeric("new_price").notNull(),
  new_original_quantity: integer("new_original_quantity").notNull(),
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
  tradeUq: uniqueIndex("trade_fills_order_trade_uq").on(table.order_id, table.trade_id),
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

export const settlement_inbox = pgTable("settlement_inbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").notNull(),
  mats_order_id: text("mats_order_id").notNull(),
  trade_id: text("trade_id"),
  status: text("status").notNull().default("received"),
  payload_hash: text("payload_hash").notNull(),
  payload: jsonb("payload").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  processed_at: timestamp("processed_at"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => ({
  idempotencyUq: uniqueIndex("settlement_inbox_idempotency_uq").on(table.idempotency_key),
  orderStatusIdx: index("settlement_inbox_order_status_idx").on(table.mats_order_id, table.status),
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

export const withdrawal_requests = pgTable("withdrawal_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  amount: numeric("amount").notNull(),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  destination_bank_name: text("destination_bank_name"),
  destination_account_number: text("destination_account_number"),
  destination_account_holder_name: text("destination_account_holder_name"),
  bank_mandala_tx_id: text("bank_mandala_tx_id"),
  error_message: text("error_message"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const bot_metadata = pgTable("bot_metadata", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  external_bot_id: text("external_bot_id").notNull().unique(),
  strategy: text("strategy").notNull(),
  tier: text("tier").notNull(),
  created_at: timestamp("created_at").defaultNow(),
}, (table) => ({
  brokerAccountUq: uniqueIndex("bot_metadata_broker_account_uq").on(table.broker_account_id),
}));

export const internal_idempotency = pgTable("internal_idempotency", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").notNull().unique(),
  route: text("route").notNull(),
  payload_hash: text("payload_hash").notNull(),
  response_status: integer("response_status").notNull(),
  response_body: jsonb("response_body").notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

export const bot_account_events = pgTable("bot_account_events", {
  sequence: bigint("sequence", { mode: "number" }).primaryKey(),
  event_id: uuid("event_id").notNull().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  event_type: text("event_type").notNull(),
  entity_id: text("entity_id").notNull(),
  entity_version: integer("entity_version").notNull(),
  correlation_id: text("correlation_id").notNull(),
  payload: jsonb("payload").notNull().default({}),
  occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventIdUq: uniqueIndex("bot_account_events_event_id_uq").on(table.event_id),
  entityVersionUq: uniqueIndex("bot_account_events_entity_version_uq").on(table.entity_id, table.entity_version, table.event_type),
  accountSequenceIdx: index("bot_account_events_account_sequence_idx").on(table.broker_account_id, table.sequence),
  createdAtIdx: index("bot_account_events_created_at_idx").on(table.created_at),
}));

export const bot_audit_logs = pgTable("bot_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  correlation_id: text("correlation_id").notNull(),
  entity_id: text("entity_id"),
  details: jsonb("details").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  actionCreatedIdx: index("bot_audit_logs_action_created_idx").on(table.action, table.created_at),
}));

export const bot_genesis_runs = pgTable("bot_genesis_runs", {
  genesis_run_id: uuid("genesis_run_id").primaryKey(),
  payload_hash: text("payload_hash").notNull(),
  status: text("status").notNull(),
  sekuritas_checkpoint: uuid("sekuritas_checkpoint").notNull().defaultRandom(),
  bei_custody_checkpoint: text("bei_custody_checkpoint"),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
});

export const bot_genesis_cash_entries = pgTable("bot_genesis_cash_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  genesis_run_id: uuid("genesis_run_id").references(() => bot_genesis_runs.genesis_run_id).notNull(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  amount_idr: numeric("amount_idr").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runAccountUq: uniqueIndex("bot_genesis_cash_entries_run_account_uq").on(table.genesis_run_id, table.broker_account_id),
}));

export const bot_genesis_position_entries = pgTable("bot_genesis_position_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  genesis_run_id: uuid("genesis_run_id").references(() => bot_genesis_runs.genesis_run_id).notNull(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  symbol: text("symbol").notNull(),
  quantity_shares: integer("quantity_shares").notNull(),
  average_price_idr: numeric("average_price_idr").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runAccountSymbolUq: uniqueIndex("bot_genesis_position_entries_uq").on(table.genesis_run_id, table.broker_account_id, table.symbol),
}));

export const ipo_investor_subscriptions = pgTable("ipo_investor_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ipo_event_id: uuid("ipo_event_id").notNull(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  idempotency_key: text("idempotency_key").notNull(),
  requested_shares: integer("requested_shares").notNull(),
  offering_price_idr: numeric("offering_price_idr").notNull(),
  reserved_cash_idr: numeric("reserved_cash_idr").notNull(),
  allocated_shares: integer("allocated_shares").notNull().default(0),
  actual_debit_idr: numeric("actual_debit_idr").notNull().default("0"),
  official_fee_idr: numeric("official_fee_idr").notNull().default("0"),
  status: text("status").notNull(),
  bei_subscription_id: text("bei_subscription_id"),
  event_version: integer("event_version").notNull().default(1),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idempotencyUq: uniqueIndex("ipo_investor_subscriptions_idempotency_uq").on(table.idempotency_key),
  accountEventIdx: index("ipo_investor_subscriptions_account_event_idx").on(table.broker_account_id, table.ipo_event_id),
}));

export const bot_ipo_subscriptions = pgTable("bot_ipo_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  symbol: text("symbol").notNull(),
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  total_amount: numeric("total_amount").notNull(),
  status: text("status").notNull().default("pending"), // pending, allocated, rejected
  created_at: timestamp("created_at").defaultNow(),
});
