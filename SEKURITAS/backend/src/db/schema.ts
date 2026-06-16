import { pgTable, text, timestamp, boolean, numeric, integer, uuid, serial, varchar, jsonb } from "drizzle-orm/pg-core";

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
});

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
});

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  client_order_id: text("client_order_id").notNull().unique(),
  mats_order_id: text("mats_order_id"),
  broker_account_id: uuid("broker_account_id").references(() => broker_accounts.id).notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // BUY, SELL
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  filled_quantity: integer("filled_quantity").notNull().default(0),
  remaining_quantity: integer("remaining_quantity").notNull(),
  status: text("status").notNull(), // PENDING, ACCEPTED, REJECTED, CANCELLED, FILLED, EXPIRED
  reject_reason: text("reject_reason"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const order_amendments = pgTable("order_amendments", {
  id: uuid("id").primaryKey().defaultRandom(),
  order_id: uuid("order_id").references(() => orders.id).notNull(),
  old_price: numeric("old_price").notNull(),
  old_quantity: integer("old_quantity").notNull(),
  new_price: numeric("new_price").notNull(),
  new_quantity: integer("new_quantity").notNull(),
  status: text("status").notNull(), // PENDING, ACCEPTED, REJECTED
  created_at: timestamp("created_at").defaultNow(),
});

export const trade_fills = pgTable("trade_fills", {
  id: uuid("id").primaryKey().defaultRandom(),
  order_id: uuid("order_id").references(() => orders.id).notNull(),
  trade_id: text("trade_id").notNull(),
  price: numeric("price").notNull(),
  quantity: integer("quantity").notNull(),
  timestamp: timestamp("timestamp").notNull(),
});

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
});
