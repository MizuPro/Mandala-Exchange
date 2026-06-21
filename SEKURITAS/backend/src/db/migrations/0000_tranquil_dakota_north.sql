CREATE TABLE "broker_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_type" text DEFAULT 'HUMAN' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cash_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"available" numeric DEFAULT '0' NOT NULL,
	"reserved" numeric DEFAULT '0' NOT NULL,
	"pending" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "corporate_action_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"corporate_action_id" text NOT NULL,
	"action_type" text NOT NULL,
	"symbol" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'processed' NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fee_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"order_id" uuid,
	"trade_id" text,
	"amount" numeric NOT NULL,
	"fee_type" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"nav" numeric NOT NULL,
	"return_pct" numeric NOT NULL,
	"realized_pl" numeric NOT NULL,
	"snapshot_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ledger_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"symbol" text,
	"amount" numeric NOT NULL,
	"balance_after" numeric NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"old_price" numeric NOT NULL,
	"old_original_quantity" integer NOT NULL,
	"new_price" numeric NOT NULL,
	"new_original_quantity" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_order_id" text NOT NULL,
	"mats_order_id" text,
	"broker_account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"order_type" text DEFAULT 'limit' NOT NULL,
	"price" numeric NOT NULL,
	"original_quantity" integer NOT NULL,
	"filled_quantity" integer DEFAULT 0 NOT NULL,
	"remaining_quantity" integer NOT NULL,
	"reserved_amount" numeric DEFAULT '0' NOT NULL,
	"submission_status" text DEFAULT 'pending' NOT NULL,
	"place_idempotency_key" text,
	"last_submission_error" text,
	"last_action_status" text,
	"last_action_reason" text,
	"last_mats_event_sequence" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"reject_reason" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "orders_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "rdn_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"rdn" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "rdn_references_rdn_unique" UNIQUE("rdn")
);
--> statement-breakpoint
CREATE TABLE "securities_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"average_price" numeric DEFAULT '0' NOT NULL,
	"realized_pl" numeric DEFAULT '0' NOT NULL,
	"unrealized_pl" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "settlement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"trade_id" text,
	"mats_order_id" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric NOT NULL,
	"quantity" integer NOT NULL,
	"gross_value" numeric NOT NULL,
	"total_fee" numeric NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "settlement_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"mats_order_id" text NOT NULL,
	"trade_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sid_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"sid" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "sid_references_sid_unique" UNIQUE("sid")
);
--> statement-breakpoint
CREATE TABLE "sre_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"sre" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "sre_references_sre_unique" UNIQUE("sre")
);
--> statement-breakpoint
CREATE TABLE "trade_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"trade_id" text NOT NULL,
	"price" numeric NOT NULL,
	"quantity" integer NOT NULL,
	"timestamp" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_account_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bank_mandala_tx_id" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_balances" ADD CONSTRAINT "cash_balances_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_ledgers" ADD CONSTRAINT "fee_ledgers_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_ledgers" ADD CONSTRAINT "fee_ledgers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_movements" ADD CONSTRAINT "ledger_movements_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_amendments" ADD CONSTRAINT "order_amendments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rdn_references" ADD CONSTRAINT "rdn_references_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "securities_positions" ADD CONSTRAINT "securities_positions_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_events" ADD CONSTRAINT "settlement_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sid_references" ADD CONSTRAINT "sid_references_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sre_references" ADD CONSTRAINT "sre_references_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_fills" ADD CONSTRAINT "trade_fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_broker_account_id_broker_accounts_id_fk" FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_balances_broker_account_uq" ON "cash_balances" USING btree ("broker_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_action_events_idempotency_uq" ON "corporate_action_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "corporate_action_events_action_idx" ON "corporate_action_events" USING btree ("action_type","symbol");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_account_date_idx" ON "leaderboard_snapshots" USING btree ("broker_account_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_uq" ON "notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_account_created_idx" ON "notifications" USING btree ("broker_account_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_mats_order_uq" ON "orders" USING btree ("mats_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "securities_positions_account_symbol_uq" ON "securities_positions" USING btree ("broker_account_id","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_events_idempotency_uq" ON "settlement_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_inbox_idempotency_uq" ON "settlement_inbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "settlement_inbox_order_status_idx" ON "settlement_inbox" USING btree ("mats_order_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_fills_order_trade_uq" ON "trade_fills" USING btree ("order_id","trade_id");