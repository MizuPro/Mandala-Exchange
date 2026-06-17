import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import {
  announcementTypes,
  boardTypes,
  brokerStatuses,
  corporateActionStatuses,
  corporateActionTypes,
  ipoStatuses,
  ledgerAssetTypes,
  ledgerEntryTypes,
  listingStatuses,
  marketMechanisms,
  notationTypes,
  sessionStatuses,
  settlementInstructionTypes,
  settlementModes,
  settlementStatuses,
  tradingHaltStatuses
} from "../types/enums.js";

export const listingStatusEnum = pgEnum("listing_status", listingStatuses);
export const boardTypeEnum = pgEnum("board_type", boardTypes);
export const marketMechanismEnum = pgEnum("market_mechanism", marketMechanisms);
export const notationTypeEnum = pgEnum("notation_type", notationTypes);
export const announcementTypeEnum = pgEnum("announcement_type", announcementTypes);
export const sessionStatusEnum = pgEnum("session_status", sessionStatuses);
export const settlementModeEnum = pgEnum("settlement_mode", settlementModes);
export const settlementInstructionTypeEnum = pgEnum("settlement_instruction_type", settlementInstructionTypes);
export const settlementStatusEnum = pgEnum("settlement_status", settlementStatuses);
export const corporateActionTypeEnum = pgEnum("corporate_action_type", corporateActionTypes);
export const corporateActionStatusEnum = pgEnum("corporate_action_status", corporateActionStatuses);
export const tradingHaltStatusEnum = pgEnum("trading_halt_status", tradingHaltStatuses);
export const brokerStatusEnum = pgEnum("broker_status", brokerStatuses);
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", ledgerEntryTypes);
export const ledgerAssetTypeEnum = pgEnum("ledger_asset_type", ledgerAssetTypes);
export const ipoStatusEnum = pgEnum("ipo_status", ipoStatuses);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    entityIdx: index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt)
  })
);

export const issuers = pgTable(
  "issuers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sector: text("sector").notNull(),
    summary: text("summary").notNull().default(""),
    businessDescription: text("business_description").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    codeUq: uniqueIndex("issuers_code_uq").on(table.code)
  })
);

export const listedSecurities = pgTable(
  "listed_securities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuerId: uuid("issuer_id").notNull().references(() => issuers.id),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    board: boardTypeEnum("board").notNull().default("main"),
    sector: text("sector").notNull(),
    sharesOutstanding: numeric("shares_outstanding", { precision: 24, scale: 0 }).notNull(),
    ipoPrice: numeric("ipo_price", { precision: 18, scale: 2 }),
    referencePrice: numeric("reference_price", { precision: 18, scale: 2 }).notNull(),
    previousClose: numeric("previous_close", { precision: 18, scale: 2 }),
    status: listingStatusEnum("status").notNull().default("listed"),
    marketMechanism: marketMechanismEnum("market_mechanism").notNull().default("regular"),
    listedAt: date("listed_at"),
    suspendedReason: text("suspended_reason"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    symbolUq: uniqueIndex("listed_securities_symbol_uq").on(table.symbol),
    issuerIdx: index("listed_securities_issuer_idx").on(table.issuerId),
    statusIdx: index("listed_securities_status_idx").on(table.status)
  })
);

export const specialNotations = pgTable("special_notations", {
  id: uuid("id").primaryKey().defaultRandom(),
  securityId: uuid("security_id").notNull().references(() => listedSecurities.id),
  type: notationTypeEnum("type").notNull(),
  note: text("note").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdBy: text("created_by").notNull().default("system"),
  ...timestamps
});

export const issuerAnnouncements = pgTable("issuer_announcements", {
  id: uuid("id").primaryKey().defaultRandom(),
  issuerId: uuid("issuer_id").notNull().references(() => issuers.id),
  securityId: uuid("security_id").references(() => listedSecurities.id),
  type: announcementTypeEnum("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const financialReports = pgTable(
  "financial_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuerId: uuid("issuer_id").notNull().references(() => issuers.id),
    period: text("period").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    revenue: numeric("revenue", { precision: 24, scale: 2 }).notNull(),
    netIncome: numeric("net_income", { precision: 24, scale: 2 }).notNull(),
    assets: numeric("assets", { precision: 24, scale: 2 }).notNull(),
    liabilities: numeric("liabilities", { precision: 24, scale: 2 }).notNull(),
    equity: numeric("equity", { precision: 24, scale: 2 }).notNull(),
    eps: numeric("eps", { precision: 18, scale: 4 }),
    bookValuePerShare: numeric("book_value_per_share", { precision: 18, scale: 4 }),
    dividendPayout: numeric("dividend_payout", { precision: 18, scale: 4 }),
    ratios: jsonb("ratios").notNull().default(sql`'{}'::jsonb`),
    source: text("source").notNull().default("manual"),
    ...timestamps
  },
  (table) => ({
    issuerPeriodUq: uniqueIndex("financial_reports_issuer_period_uq").on(table.issuerId, table.period)
  })
);

export const brokerMembers = pgTable(
  "broker_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: brokerStatusEnum("status").notNull().default("active"),
    serviceIdentifier: text("service_identifier").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    codeUq: uniqueIndex("broker_members_code_uq").on(table.code),
    serviceIdentifierUq: uniqueIndex("broker_members_service_identifier_uq").on(table.serviceIdentifier)
  })
);

export const tradingRuleProfiles = pgTable("trading_rule_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  board: boardTypeEnum("board").notNull(),
  marketSegment: text("market_segment").notNull().default("regular"),
  isDefault: boolean("is_default").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const lotSizeRules = pgTable("lot_size_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").notNull().references(() => tradingRuleProfiles.id),
  instrumentType: text("instrument_type").notNull().default("stock"),
  lotSize: integer("lot_size").notNull().default(100),
  effectiveDate: date("effective_date").notNull().defaultNow(),
  ...timestamps
});

export const tickSizeRules = pgTable("tick_size_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").notNull().references(() => tradingRuleProfiles.id),
  minPrice: numeric("min_price", { precision: 18, scale: 2 }).notNull(),
  maxPrice: numeric("max_price", { precision: 18, scale: 2 }),
  tickSize: numeric("tick_size", { precision: 18, scale: 2 }).notNull(),
  ...timestamps
});

export const priceBandRules = pgTable("price_band_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").notNull().references(() => tradingRuleProfiles.id),
  minReferencePrice: numeric("min_reference_price", { precision: 18, scale: 2 }).notNull(),
  maxReferencePrice: numeric("max_reference_price", { precision: 18, scale: 2 }),
  araPercent: numeric("ara_percent", { precision: 8, scale: 4 }).notNull(),
  arbPercent: numeric("arb_percent", { precision: 8, scale: 4 }).notNull(),
  minPrice: numeric("min_price", { precision: 18, scale: 2 }).notNull().default("1"),
  ...timestamps
});

export const autoRejectionRules = pgTable("auto_rejection_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").notNull().references(() => tradingRuleProfiles.id),
  maxLotsPerOrder: integer("max_lots_per_order").notNull(),
  maxListedSharesPercent: numeric("max_listed_shares_percent", { precision: 8, scale: 4 }),
  ...timestamps
});

export const sessionTemplates = pgTable("session_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: sessionStatusEnum("status").notNull().default("closed"),
  settlementMode: settlementModeEnum("settlement_mode").notNull().default("end_of_session"),
  settlementDelaySessions: integer("settlement_delay_sessions").notNull().default(0),
  postClosingEnabled: boolean("post_closing_enabled").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const sessionSegments = pgTable("session_segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull().references(() => sessionTemplates.id),
  sequence: integer("sequence").notNull(),
  status: sessionStatusEnum("status").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  allowOrderEntry: boolean("allow_order_entry").notNull().default(false),
  allowCancelAmend: boolean("allow_cancel_amend").notNull().default(false),
  ...timestamps
});

export const tradingHalts = pgTable("trading_halts", {
  id: uuid("id").primaryKey().defaultRandom(),
  securityId: uuid("security_id").references(() => listedSecurities.id),
  status: tradingHaltStatusEnum("status").notNull().default("inactive"),
  reason: text("reason").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const feeSchedules = pgTable("fee_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  brokerBuyRate: numeric("broker_buy_rate", { precision: 10, scale: 6 }).notNull(),
  brokerSellRate: numeric("broker_sell_rate", { precision: 10, scale: 6 }).notNull(),
  exchangeFeeRate: numeric("exchange_fee_rate", { precision: 10, scale: 6 }).notNull(),
  clearingFeeRate: numeric("clearing_fee_rate", { precision: 10, scale: 6 }).notNull(),
  settlementFeeRate: numeric("settlement_fee_rate", { precision: 10, scale: 6 }).notNull(),
  guaranteeFundRate: numeric("guarantee_fund_rate", { precision: 10, scale: 6 }).notNull().default("0"),
  vatRate: numeric("vat_rate", { precision: 10, scale: 6 }).notNull(),
  sellTaxRate: numeric("sell_tax_rate", { precision: 10, scale: 6 }).notNull(),
  minimumFee: numeric("minimum_fee", { precision: 18, scale: 2 }).notNull().default("0"),
  effectiveDate: date("effective_date").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps
});

export const marketIndices = pgTable("market_indices", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  baseValue: numeric("base_value", { precision: 18, scale: 4 }).notNull().default("1000"),
  lastValue: numeric("last_value", { precision: 18, scale: 4 }).notNull().default("1000"),
  sector: text("sector"),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
});

export const marketSummaries = pgTable("market_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  securityId: uuid("security_id").references(() => listedSecurities.id),
  open: numeric("open", { precision: 18, scale: 2 }),
  high: numeric("high", { precision: 18, scale: 2 }),
  low: numeric("low", { precision: 18, scale: 2 }),
  close: numeric("close", { precision: 18, scale: 2 }),
  last: numeric("last", { precision: 18, scale: 2 }),
  volume: numeric("volume", { precision: 24, scale: 0 }).notNull().default("0"),
  value: numeric("value", { precision: 24, scale: 2 }).notNull().default("0"),
  frequency: integer("frequency").notNull().default(0),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const custodyAccounts = pgTable(
  "custody_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brokerId: uuid("broker_id").notNull().references(() => brokerMembers.id),
    investorId: text("investor_id").notNull(),
    sid: text("sid").notNull(),
    sre: text("sre").notNull(),
    rdn: text("rdn").notNull(),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => ({
    brokerInvestorUq: uniqueIndex("custody_accounts_broker_investor_uq").on(table.brokerId, table.investorId),
    sidUq: uniqueIndex("custody_accounts_sid_uq").on(table.sid)
  })
);

export const custodyLedgerEntries = pgTable(
  "custody_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    custodyAccountId: uuid("custody_account_id").notNull().references(() => custodyAccounts.id),
    securityId: uuid("security_id").references(() => listedSecurities.id),
    entryType: ledgerEntryTypeEnum("entry_type").notNull(),
    assetType: ledgerAssetTypeEnum("asset_type").notNull(),
    quantity: numeric("quantity", { precision: 24, scale: 4 }).notNull(),
    cashAmount: numeric("cash_amount", { precision: 24, scale: 2 }),
    positionState: text("position_state").notNull().default("settled"),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    idempotencyUq: uniqueIndex("custody_ledger_entries_idempotency_uq").on(table.idempotencyKey),
    accountIdx: index("custody_ledger_entries_account_idx").on(table.custodyAccountId),
    securityIdx: index("custody_ledger_entries_security_idx").on(table.securityId)
  })
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matsTradeId: text("mats_trade_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    sessionId: text("session_id").notNull(),
    securityId: uuid("security_id").notNull().references(() => listedSecurities.id),
    symbol: text("symbol").notNull(),
    price: numeric("price", { precision: 18, scale: 2 }).notNull(),
    quantity: numeric("quantity", { precision: 24, scale: 0 }).notNull(),
    value: numeric("value", { precision: 24, scale: 2 }).notNull(),
    buyBrokerId: uuid("buy_broker_id").notNull().references(() => brokerMembers.id),
    sellBrokerId: uuid("sell_broker_id").notNull().references(() => brokerMembers.id),
    buyInvestorId: text("buy_investor_id").notNull(),
    sellInvestorId: text("sell_investor_id").notNull(),
    buyOrderId: text("buy_order_id").notNull(),
    sellOrderId: text("sell_order_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    rawPayload: jsonb("raw_payload").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    matsTradeUq: uniqueIndex("trades_mats_trade_uq").on(table.matsTradeId),
    idempotencyUq: uniqueIndex("trades_idempotency_uq").on(table.idempotencyKey),
    sessionIdx: index("trades_session_idx").on(table.sessionId),
    symbolIdx: index("trades_symbol_idx").on(table.symbol)
  })
);

export const settlementBatches = pgTable(
  "settlement_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    mode: settlementModeEnum("mode").notNull().default("end_of_session"),
    status: settlementStatusEnum("status").notNull().default("pending"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notificationStatus: text("notification_status").notNull().default("pending"),
    notificationAttempts: integer("notification_attempts").notNull().default(0),
    lastNotificationError: text("last_notification_error"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sessionUq: uniqueIndex("settlement_batches_session_uq").on(table.sessionId)
  })
);

export const settlementInstructions = pgTable(
  "settlement_instructions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").references(() => settlementBatches.id),
    tradeId: uuid("trade_id").references(() => trades.id),
    type: settlementInstructionTypeEnum("type").notNull(),
    status: settlementStatusEnum("status").notNull().default("pending"),
    fromCustodyAccountId: uuid("from_custody_account_id").references(() => custodyAccounts.id),
    toCustodyAccountId: uuid("to_custody_account_id").references(() => custodyAccounts.id),
    securityId: uuid("security_id").references(() => listedSecurities.id),
    quantity: numeric("quantity", { precision: 24, scale: 4 }).notNull().default("0"),
    cashAmount: numeric("cash_amount", { precision: 24, scale: 2 }).notNull().default("0"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    idempotencyUq: uniqueIndex("settlement_instructions_idempotency_uq").on(table.idempotencyKey),
    batchIdx: index("settlement_instructions_batch_idx").on(table.batchId),
    tradeIdx: index("settlement_instructions_trade_idx").on(table.tradeId)
  })
);

export const corporateActions = pgTable("corporate_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  securityId: uuid("security_id").notNull().references(() => listedSecurities.id),
  type: corporateActionTypeEnum("type").notNull(),
  status: corporateActionStatusEnum("status").notNull().default("draft"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  announcementDate: date("announcement_date"),
  recordingDate: date("recording_date"),
  executionDate: date("execution_date"),
  ratioNumerator: numeric("ratio_numerator", { precision: 18, scale: 6 }),
  ratioDenominator: numeric("ratio_denominator", { precision: 18, scale: 6 }),
  cashAmountPerShare: numeric("cash_amount_per_share", { precision: 18, scale: 4 }),
  exercisePrice: numeric("exercise_price", { precision: 18, scale: 2 }),
  idempotencyKey: text("idempotency_key"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const ipoEvents = pgTable("ipo_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  issuerId: uuid("issuer_id").notNull().references(() => issuers.id),
  securityId: uuid("security_id").references(() => listedSecurities.id),
  offeredShares: numeric("offered_shares", { precision: 24, scale: 0 }).notNull(),
  offeringPrice: numeric("offering_price", { precision: 18, scale: 2 }).notNull(),
  bookbuildingStart: timestamp("bookbuilding_start", { withTimezone: true }),
  bookbuildingEnd: timestamp("bookbuilding_end", { withTimezone: true }),
  subscriptionStart: timestamp("subscription_start", { withTimezone: true }),
  subscriptionEnd: timestamp("subscription_end", { withTimezone: true }),
  listingDate: date("listing_date"),
  status: ipoStatusEnum("status").notNull().default("draft"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  ...timestamps
});

export const ipoSubscriptions = pgTable("ipo_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ipoEventId: uuid("ipo_event_id").notNull().references(() => ipoEvents.id),
  brokerId: uuid("broker_id").notNull().references(() => brokerMembers.id),
  investorId: text("investor_id").notNull(),
  requestedShares: numeric("requested_shares", { precision: 24, scale: 0 }).notNull(),
  status: text("status").notNull().default("submitted"),
  idempotencyKey: text("idempotency_key").notNull(),
  ...timestamps
});

export const ipoAllocations = pgTable("ipo_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ipoSubscriptionId: uuid("ipo_subscription_id").notNull().references(() => ipoSubscriptions.id),
  allocatedShares: numeric("allocated_shares", { precision: 24, scale: 0 }).notNull(),
  allocationValue: numeric("allocation_value", { precision: 24, scale: 2 }).notNull(),
  status: text("status").notNull().default("allocated"),
  ...timestamps
});

export const surveillanceAlerts = pgTable("surveillance_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id"),
  securityId: uuid("security_id").references(() => listedSecurities.id),
  type: text("type").notNull(),
  severity: text("severity").notNull().default("info"),
  message: text("message").notNull(),
  evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const issuerRelations = relations(issuers, ({ many }) => ({
  listedSecurities: many(listedSecurities),
  financialReports: many(financialReports),
  announcements: many(issuerAnnouncements)
}));

export const listedSecurityRelations = relations(listedSecurities, ({ one, many }) => ({
  issuer: one(issuers, { fields: [listedSecurities.issuerId], references: [issuers.id] }),
  notations: many(specialNotations),
  trades: many(trades)
}));
