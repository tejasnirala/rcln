-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('SUBSCRIPTION_START', 'UPGRADE', 'RENEWAL', 'MANDATE_SETUP', 'INVOICE_PAYMENT');

-- CreateEnum
CREATE TYPE "SubscriptionChangeType" AS ENUM ('SUBSCRIBE', 'UPGRADE', 'RENEW', 'CANCEL_AT_PERIOD_END', 'CANCEL_IMMEDIATE', 'RESUME', 'REACTIVATE', 'TRIAL_EXPIRED', 'PAYMENT_FAILED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('SUBSCRIPTION', 'PRORATION_CREDIT', 'PRORATION_CHARGE', 'TAX', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'INCOMPLETE';

-- AlterTable
ALTER TABLE "subscription_invoice_lines" ADD COLUMN     "kind" "InvoiceLineKind" NOT NULL DEFAULT 'SUBSCRIPTION',
ADD COLUMN     "period_end" DATE,
ADD COLUMN     "period_start" DATE;

-- AlterTable
ALTER TABLE "subscription_invoices" ADD COLUMN     "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "attempt_count" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "paid_at" TIMESTAMPTZ(6),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "voided_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "failure_code" VARCHAR(64),
ADD COLUMN     "failure_message" VARCHAR(500),
ADD COLUMN     "instrument_label" VARCHAR(32),
ADD COLUMN     "payment_intent_id" UUID,
ADD COLUMN     "refunded_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "gateway_ref",
ADD COLUMN     "auto_renew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancel_reason" VARCHAR(500),
ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'INR',
ADD COLUMN     "dunning_attempts" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "ended_at" TIMESTAMPTZ(6),
ADD COLUMN     "grace_period_end" TIMESTAMPTZ(6),
ADD COLUMN     "last_renewal_attempt_at" TIMESTAMPTZ(6),
ADD COLUMN     "mandate_id" UUID,
ADD COLUMN     "provider" VARCHAR(32),
ADD COLUMN     "started_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "payment_mandates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_mandate_id" VARCHAR(128),
    "status" "MandateStatus" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL,
    "max_amount" DECIMAL(14,2) NOT NULL,
    "method" VARCHAR(32),
    "instrument_label" VARCHAR(32),
    "activated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscription_id" UUID,
    "subscription_invoice_id" UUID,
    "mandate_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "provider_charge_id" VARCHAR(128),
    "purpose" "PaymentPurpose" NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "redirect_url" TEXT,
    "return_url" TEXT,
    "method" VARCHAR(32),
    "instrument_label" VARCHAR(32),
    "failure_code" VARCHAR(64),
    "failure_message" VARCHAR(500),
    "settled_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_changes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "change_type" "SubscriptionChangeType" NOT NULL,
    "from_plan_id" UUID,
    "from_plan_price_id" UUID,
    "to_plan_id" UUID,
    "to_plan_price_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "proration_credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "proration_charge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount_due" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscription_invoice_id" UUID,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "reference" VARCHAR(128),
    "organization_id" UUID,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "error" VARCHAR(1000),
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_mandates_organization_id_status_idx" ON "payment_mandates"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_mandates_organization_id_id_key" ON "payment_mandates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_mandates_provider_provider_mandate_id_key" ON "payment_mandates"("provider", "provider_mandate_id");

-- CreateIndex
CREATE INDEX "payment_intents_organization_id_status_idx" ON "payment_intents"("organization_id", "status");

-- CreateIndex
CREATE INDEX "payment_intents_subscription_id_idx" ON "payment_intents"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_organization_id_id_key" ON "payment_intents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_provider_charge_id_key" ON "payment_intents"("provider", "provider_charge_id");

-- CreateIndex
CREATE INDEX "subscription_changes_organization_id_subscription_id_create_idx" ON "subscription_changes"("organization_id", "subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_received_at_idx" ON "payment_webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_reference_idx" ON "payment_webhook_events"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_provider_event_id_key" ON "payment_webhook_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "subscription_invoice_lines_subscription_invoice_id_idx" ON "subscription_invoice_lines"("subscription_invoice_id");

-- CreateIndex
CREATE INDEX "subscription_invoices_subscription_id_created_at_idx" ON "subscription_invoices"("subscription_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_organization_id_id_key" ON "subscription_invoices"("organization_id", "id");

-- CreateIndex
CREATE INDEX "subscription_payments_subscription_invoice_id_idx" ON "subscription_payments"("subscription_invoice_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_id_key" ON "subscriptions"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_mandate_id_fkey" FOREIGN KEY ("organization_id", "mandate_id") REFERENCES "payment_mandates"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_subscription_id_fkey" FOREIGN KEY ("organization_id", "subscription_id") REFERENCES "subscriptions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_subscription_invoice_id_fkey" FOREIGN KEY ("organization_id", "subscription_invoice_id") REFERENCES "subscription_invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_mandate_id_fkey" FOREIGN KEY ("organization_id", "mandate_id") REFERENCES "payment_mandates"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_organization_id_subscription_id_fkey" FOREIGN KEY ("organization_id", "subscription_id") REFERENCES "subscriptions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_organization_id_subscription_invoice__fkey" FOREIGN KEY ("organization_id", "subscription_invoice_id") REFERENCES "subscription_invoices"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ===========================================================================
-- Backfill: the currency an existing subscription is actually billed in.
--
-- The column above lands with DEFAULT 'INR', which is right for every clinic
-- that exists today and wrong the moment one does not. The authority is the
-- plan price the subscription is attached to, so take it from there rather than
-- leaving a default standing in for a fact.
-- ===========================================================================
UPDATE "subscriptions" s
   SET "currency" = p."currency"
  FROM "plan_prices" p
 WHERE p."id" = s."plan_price_id"
   AND p."currency" <> s."currency";

-- Existing subscriptions predate the mandate model, so none of them may be
-- silently switched to unattended debits. auto_renew already defaults to false;
-- this states that the default is a decision and not an accident.
UPDATE "subscriptions" SET "auto_renew" = false WHERE "auto_renew" IS DISTINCT FROM false;

-- ===========================================================================
-- Row-Level Security.
--
-- Prisma Migrate does not generate any of this. It is the relevant stanzas of
-- prisma/rls/enable-rls.sql, appended here so a fresh database built from
-- migrations alone comes up isolated. `pnpm db:rls:check` fails CI if a tenant
-- table ships without a policy — see the header of that file.
--
-- Three new tenant tables, and three EXISTING billing children promoted from
-- "reached via a scoped parent" (true of the code as written, enforced by
-- nothing) to a real parent_isolation policy. `payment_webhook_events` is
-- deliberately left out; the reason is recorded in enable-rls.sql and in the
-- EXEMPT map in scripts/check-rls.ts.
-- ===========================================================================
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'subscription_changes',
    'payment_mandates',
    'payment_intents'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- Explicit: the owner must keep bypassing, so migrations and seeds work.
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

DO $$
DECLARE
  i int;
  child text;
  parent text;
  fk text;
  -- child, parent, foreign key on the child
  parent_scoped text[][] := ARRAY[
    ARRAY['subscription_invoice_lines',     'subscription_invoices', 'subscription_invoice_id'],
    ARRAY['subscription_payments',          'subscription_invoices', 'subscription_invoice_id'],
    ARRAY['subscription_feature_overrides', 'subscriptions',         'subscription_id']
  ];
BEGIN
  FOR i IN 1 .. array_length(parent_scoped, 1) LOOP
    child  := parent_scoped[i][1];
    parent := parent_scoped[i][2];
    fk     := parent_scoped[i][3];

    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', child);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', child);
    EXECUTE format('DROP POLICY IF EXISTS parent_isolation ON %I', child);
    EXECUTE format($f$
      CREATE POLICY parent_isolation ON %1$I
        USING      (EXISTS (SELECT 1 FROM %2$I p
                            WHERE p.id = %1$I.%3$I
                              AND p.organization_id = app_current_org()))
        WITH CHECK  (EXISTS (SELECT 1 FROM %2$I p
                            WHERE p.id = %1$I.%3$I
                              AND p.organization_id = app_current_org()))
    $f$, child, parent, fk);
  END LOOP;
END
$$;
