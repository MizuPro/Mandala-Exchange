CREATE TABLE IF NOT EXISTS "withdrawal_bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broker_account_id" uuid NOT NULL,
  "bank_code" text DEFAULT 'MANDALA' NOT NULL,
  "bank_name" text NOT NULL,
  "account_number" text NOT NULL,
  "account_holder_name" text NOT NULL,
  "status" text DEFAULT 'verified' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "is_primary" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'withdrawal_bank_accounts_broker_account_id_broker_accounts_id_fk'
  ) THEN
    ALTER TABLE "withdrawal_bank_accounts"
      ADD CONSTRAINT "withdrawal_bank_accounts_broker_account_id_broker_accounts_id_fk"
      FOREIGN KEY ("broker_account_id") REFERENCES "public"."broker_accounts"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawal_bank_accounts_broker_account_idx"
  ON "withdrawal_bank_accounts" USING btree ("broker_account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawal_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broker_account_id" uuid NOT NULL REFERENCES "broker_accounts"("id"),
  "amount" numeric NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "bank_mandala_tx_id" text,
  "error_message" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "withdrawal_requests"
  ADD COLUMN IF NOT EXISTS "destination_bank_name" text;
--> statement-breakpoint
ALTER TABLE "withdrawal_requests"
  ADD COLUMN IF NOT EXISTS "destination_account_number" text;
--> statement-breakpoint
ALTER TABLE "withdrawal_requests"
  ADD COLUMN IF NOT EXISTS "destination_account_holder_name" text;
