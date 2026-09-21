-- ---------------------------------------------------------------------------
-- PI-8 — Billing & Tax integration.
--
-- Three tenant tables (`charge_policy_rules`, `product_prices`,
-- `charge_requests`), one parent-scoped child
-- (`membership_professional_registrations`), the credit-note columns on
-- `invoices`, and the endorsed-repeat columns on `encounter_prescriptions`.
--
-- ⚠️ TWO STATEMENTS WERE DELETED FROM THE GENERATED DIFF BY HAND, AND THE NEXT
--   PERSON TO RUN `prisma migrate diff` IN THIS REPOSITORY WILL SEE THEM AGAIN:
--
--     ALTER TABLE "encounter_investigations" ALTER COLUMN "item_id" DROP NOT NULL;
--     ALTER TABLE "encounter_procedures"     ALTER COLUMN "item_id" DROP NOT NULL;
--
--   CE-4 added those NOT NULLs by hand and the schema file does not declare
--   them, so every diff proposes dropping them. They are nothing to do with this
--   phase. Delete them from whatever the tool generates. PI-7's migration header
--   says the same thing, for the same reason.
--
-- ⚠️ THE ORDER BELOW MATTERS. Generated DDL first, then the constraints Prisma
--   cannot express, then the RLS block. A policy created before its table exists
--   raises; a CHECK added after rows exist would need a validation pass.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A new disclosure resource (PI-8).
--
-- ⚠️ ITS OWN MEMBER RATHER THAN `INVOICE` OR `PRESCRIPTION`. A charge request
--   names a patient beside a MEDICINE and a price, which an invoice line does
--   not carry as a distinct fact, and it records what was SUPPLIED rather than
--   what was written. Same reasoning that keeps `VITALS` and `ENCOUNTER` apart
--   from `MEDICAL_HISTORY`, and the precedent is PI-2's
--   `..091000_data_access_resource_inventory_serial`.
--
-- ⚠️ `ALTER TYPE ... ADD VALUE` CANNOT RUN INSIDE A TRANSACTION BLOCK ON
--   POSTGRES BEFORE 12, AND IS FINE ON 16 — which this repository pins. It is
--   first in the file regardless, because a new enum value is not usable by
--   other statements in the SAME transaction on some versions, and nothing below
--   references it.
-- ---------------------------------------------------------------------------
ALTER TYPE "DataAccessResource" ADD VALUE IF NOT EXISTS 'CHARGE_REQUEST';

-- CreateEnum
CREATE TYPE "ProfessionalRegistrationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChargePolicy" AS ENUM ('NEVER_BILL', 'INCLUDED_IN_SERVICE', 'SEPARATELY_BILLABLE', 'OPTIONAL', 'CONTRACT_DEFINED', 'JURISDICTION_CONFIGURED');

-- CreateEnum
CREATE TYPE "ChargePolicyScope" AS ENUM ('PRODUCT', 'PRODUCT_CATEGORY', 'PRODUCT_TYPE', 'DEFAULT');

-- CreateEnum
CREATE TYPE "ChargeRequestStatus" AS ENUM ('PENDING', 'SUPPRESSED', 'INVOICED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargeRequestKind" AS ENUM ('SUPPLY', 'REVERSAL');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- AlterTable

-- AlterTable
ALTER TABLE "encounter_prescriptions" ADD COLUMN     "repeats_authorised" BOOLEAN,
ADD COLUMN     "repeats_authorised_limit" SMALLINT;

-- AlterTable

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "credited_invoice_id" UUID,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'INVOICE';

-- CreateTable
CREATE TABLE "membership_professional_registrations" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "licence_type" VARCHAR(64) NOT NULL,
    "registration_number" VARCHAR(128) NOT NULL,
    "jurisdiction_code" VARCHAR(10),
    "authority_name" VARCHAR(255),
    "issued_on" DATE,
    "expires_on" DATE,
    "status" "ProfessionalRegistrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "membership_professional_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_policy_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "product_category_id" UUID,
    "product_type" "ProductType",
    "policy" "ChargePolicy" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "charge_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "product_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "source_type" "InvoiceSourceType" NOT NULL,
    "kind" "ChargeRequestKind" NOT NULL DEFAULT 'SUPPLY',
    "status" "ChargeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "dispense_line_id" UUID,
    "dispense_return_line_id" UUID,
    "product_id" UUID NOT NULL,
    "patient_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_id" UUID NOT NULL,
    "policy" "ChargePolicy" NOT NULL,
    "policy_scope" "ChargePolicyScope" NOT NULL,
    "policy_rule_id" UUID,
    "description" VARCHAR(255) NOT NULL,
    "unit_price" DECIMAL(14,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "tax_category" VARCHAR(64),
    "item_code" VARCHAR(32),
    "invoice_id" UUID,
    "suppressed_reason" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "charge_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "membership_professional_registrations_membership_id_status_idx" ON "membership_professional_registrations"("membership_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "membership_professional_registrations_membership_id_licence_key" ON "membership_professional_registrations"("membership_id", "licence_type");

-- CreateIndex
CREATE INDEX "charge_policy_rules_organization_id_product_id_idx" ON "charge_policy_rules"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "charge_policy_rules_organization_id_product_category_id_idx" ON "charge_policy_rules"("organization_id", "product_category_id");

-- CreateIndex
CREATE INDEX "charge_policy_rules_organization_id_product_type_idx" ON "charge_policy_rules"("organization_id", "product_type");

-- CreateIndex
CREATE UNIQUE INDEX "charge_policy_rules_organization_id_product_id_product_cate_key" ON "charge_policy_rules"("organization_id", "product_id", "product_category_id", "product_type");

-- CreateIndex
CREATE UNIQUE INDEX "charge_policy_rules_organization_id_id_key" ON "charge_policy_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_prices_organization_id_product_id_idx" ON "product_prices"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_organization_id_product_id_branch_id_currenc_key" ON "product_prices"("organization_id", "product_id", "branch_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_organization_id_id_key" ON "product_prices"("organization_id", "id");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_dispense_line_id_idx" ON "charge_requests"("organization_id", "dispense_line_id");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_dispense_return_line_id_idx" ON "charge_requests"("organization_id", "dispense_return_line_id");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_branch_id_status_occurred_a_idx" ON "charge_requests"("organization_id", "branch_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_patient_id_occurred_at_idx" ON "charge_requests"("organization_id", "patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_invoice_id_idx" ON "charge_requests"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_requests_organization_id_id_key" ON "charge_requests"("organization_id", "id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_credited_invoice_id_idx" ON "invoices"("organization_id", "credited_invoice_id");

-- AddForeignKey
ALTER TABLE "membership_professional_registrations" ADD CONSTRAINT "membership_professional_registrations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_policy_rules" ADD CONSTRAINT "charge_policy_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_policy_rules" ADD CONSTRAINT "charge_policy_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_policy_rules" ADD CONSTRAINT "charge_policy_rules_product_category_id_fkey" FOREIGN KEY ("product_category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_policy_rules" ADD CONSTRAINT "charge_policy_rules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_dispense_line_id_fkey" FOREIGN KEY ("organization_id", "dispense_line_id") REFERENCES "dispense_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_dispense_return_line_id_fkey" FOREIGN KEY ("organization_id", "dispense_return_line_id") REFERENCES "dispense_return_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_policy_rule_id_fkey" FOREIGN KEY ("organization_id", "policy_rule_id") REFERENCES "charge_policy_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_credited_invoice_id_fkey" FOREIGN KEY ("organization_id", "credited_invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------
-- The line a credit-note line reverses.
--
-- ⚠️ WITHOUT IT THE PER-LINE CREDIT CAP CANNOT AGGREGATE ACROSS NOTES.
--   `resolveLines` caps a credited quantity against the ORIGINAL line, and with
--   no link back there was nothing to sum over earlier notes — so a two-line
--   bill could be credited twice on line A and never on line B. The TOTAL stayed
--   bounded by `assertWithinRemaining`, so no clinic could refund more than it
--   charged; the document simply said more of A came back than went out.
--
-- ⚠️ IT IS NOT COVERED BY A CHECK, DELIBERATELY. The rule it wants is "non-null
--   only when the parent invoice's kind is CREDIT_NOTE" — a fact about ANOTHER
--   ROW, which a CHECK cannot see. A trigger was refused: this is provenance
--   rather than a money column, the service is its only writer, and the failure
--   mode is a broken link rather than a wrong figure.
--
-- ⚠️ AND IT IS NOT IN `invoices_lifecycle_guard`'s FROZEN ALLOW-LIST BY NAME —
--   it does not need to be. That list is an ALLOW-list of columns that MAY move
--   after issue, so a column added today is immutable from ISSUED by default,
--   which is exactly right for provenance on a statutory document.
--
-- Composite-FK'd (ADR-0004): a note can never cite another clinic's line.
-- RESTRICT because an issued invoice's lines are frozen, so the cited row cannot
-- move under it; a DRAFT's lines are deleted on every reprice, and a credit note
-- only ever cites an ISSUED invoice.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoice_items" ADD COLUMN "credited_invoice_item_id" UUID;

CREATE INDEX "invoice_items_organization_id_credited_invoice_item_id_idx"
  ON "invoice_items" ("organization_id", "credited_invoice_item_id");

ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_organization_id_credited_invoice_item_id_fkey"
  FOREIGN KEY ("organization_id", "credited_invoice_item_id")
  REFERENCES "invoice_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ===========================================================================
-- The uniques Prisma declared with the wrong NULL semantics
--
-- ⚠️ A PLAIN UNIQUE DOES NOT CONSTRAIN NULLs, AND EVERY SCOPING COLUMN ON THESE
--   TWO TABLES IS NULLABLE. Without NULLS NOT DISTINCT a clinic holds two
--   different org-wide prices for one product, or two different answers to "is
--   this product billed?", and the PLANNER decides which one a patient gets.
--   `fee_schedule_entries` needed exactly this and for exactly this reason.
-- ===========================================================================
-- ⚠️ DROP INDEX, NOT DROP CONSTRAINT. Prisma emits `@@unique` as a unique INDEX
--   rather than a table constraint, so `ALTER TABLE ... DROP CONSTRAINT` raises
--   42704 here. The index NAME is kept identical so `migrate diff` still sees the
--   declared unique and proposes nothing — dropping and recreating under a new
--   name would make every future diff try to "fix" it back.
DROP INDEX "charge_policy_rules_organization_id_product_id_product_cate_key";
CREATE UNIQUE INDEX "charge_policy_rules_organization_id_product_id_product_cate_key"
  ON "charge_policy_rules" ("organization_id", "product_id", "product_category_id", "product_type")
  NULLS NOT DISTINCT;

DROP INDEX "product_prices_organization_id_product_id_branch_id_currenc_key";
CREATE UNIQUE INDEX "product_prices_organization_id_product_id_branch_id_currenc_key"
  ON "product_prices" ("organization_id", "product_id", "branch_id", "currency")
  NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- One charge request per supplied line.
--
-- ⚠️ THE IDEMPOTENCY GUARANTEE, NOT A TIDINESS ONE. Without it a retried post,
--   or a second code path added later that forgets to check, bills the same
--   medicine twice — and the second invoice looks entirely ordinary.
--
-- ⚠️ PARTIAL, WHICH PRISMA CANNOT DECLARE, so it is created by hand here and
--   deliberately NOT in the model — a declared TOTAL unique would be a lie about
--   the shape and would make `migrate diff` propose renaming this index on every
--   run. Same treatment `invoice_documents_current_per_type_key` gets.
--
--   It has to be partial because an `INVENTORY` charge request carries no
--   dispense line at all (clinical consumption is PI-9 and its table does not
--   exist), and NULLS NOT DISTINCT would let a clinic hold exactly one of those.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "charge_requests_one_per_dispense_line_key"
  ON "charge_requests" ("organization_id", "dispense_line_id")
  WHERE "dispense_line_id" IS NOT NULL;

CREATE UNIQUE INDEX "charge_requests_one_per_return_line_key"
  ON "charge_requests" ("organization_id", "dispense_return_line_id")
  WHERE "dispense_return_line_id" IS NOT NULL;

-- ===========================================================================
-- CHECK constraints
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A policy rule sits at EXACTLY ONE tier of the precedence chain.
--
-- A rule naming both a product and a type would have two places in the chain,
-- and the resolver would have to pick one — which is a coin toss dressed as a
-- rule. Refused here rather than in the service, because the service is not the
-- only thing that will ever write this table.
-- ---------------------------------------------------------------------------
ALTER TABLE "charge_policy_rules" ADD CONSTRAINT "charge_policy_rules_exactly_one_scope" CHECK (
  (("product_id" IS NOT NULL)::int
   + ("product_category_id" IS NOT NULL)::int
   + ("product_type" IS NOT NULL)::int) = 1
);

-- A price is a positive number. Zero is expressible and means "supplied free of
-- charge", which is a real commercial position; negative is not one.
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_amount_not_negative"
  CHECK ("amount" >= 0);

-- ---------------------------------------------------------------------------
-- A charge request comes from a source this programme actually hands over.
--
-- APPOINTMENT is the one that matters: `appointment-billing.service.ts` already
-- owns that path, and a second door into it through the charge queue would be a
-- second way to bill one visit — which is the exact failure that file's
-- `FOR UPDATE` on the appointment row exists to prevent, bypassed.
-- ---------------------------------------------------------------------------
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_source_is_supported" CHECK (
  "source_type" IN ('PHARMACY', 'INVENTORY')
);

-- ---------------------------------------------------------------------------
-- A pharmacy request cites the right kind of line for its direction.
--
-- A SUPPLY points at a `dispense_line`; a REVERSAL points at a
-- `dispense_return_line`. Neither ever points at both, and pointing at the wrong
-- one would make a return increase what a patient owes.
--
-- An INVENTORY request carries neither yet — PI-9's consumption table does not
-- exist, and its column arrives in the migration that creates it. Until then
-- that branch of the CHECK is what says so out loud rather than leaving the
-- combination silently legal.
-- ---------------------------------------------------------------------------
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_reference_matches_kind" CHECK (
  ("source_type" = 'PHARMACY' AND "kind" = 'SUPPLY'
     AND "dispense_line_id" IS NOT NULL AND "dispense_return_line_id" IS NULL)
  OR ("source_type" = 'PHARMACY' AND "kind" = 'REVERSAL'
     AND "dispense_return_line_id" IS NOT NULL AND "dispense_line_id" IS NULL)
  OR ("source_type" <> 'PHARMACY'
     AND "dispense_line_id" IS NULL AND "dispense_return_line_id" IS NULL)
);

-- Quantities are positive on both sides. A REVERSAL's quantity is POSITIVE and
-- its direction lives in `kind`, for the reason `stock_ledger` keeps the sign
-- out of the quantity: a negative in a money-adjacent column is one missing
-- minus sign away from a credit that charges.
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_quantities_positive" CHECK (
  "quantity_base" > 0 AND "quantity" > 0
);

-- A price that exists is not negative. NULL is the visible configuration gap and
-- is deliberately allowed — see the model.
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_price_not_negative" CHECK (
  "unit_price" IS NULL OR "unit_price" >= 0
);

-- ---------------------------------------------------------------------------
-- The three terminal states each carry what they claim.
--
-- ⚠️ "WE DID NOT BILL THIS" WITH NO REASON IS INDISTINGUISHABLE FROM A BUG, and
--   the whole argument for `charge_requests` being a row rather than a function
--   call is that a suppression is a decision somebody can see. A SUPPRESSED row
--   with a NULL reason would defeat the table.
--
--   `INVOICED` requires the invoice, and DELIBERATELY NOT AN ITEM. The design
--   document asks for an `invoice_item_id` here; `finalizeInvoice` re-prices a
--   draft by DELETING every `invoice_items` row and writing them again, so an
--   item id changes at least once between the draft being raised and the
--   document being issued. See the column comment on `charge_requests`.
-- ---------------------------------------------------------------------------
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_status_is_explained" CHECK (
  ("status" = 'SUPPRESSED' AND "suppressed_reason" IS NOT NULL)
  OR ("status" = 'INVOICED' AND "invoice_id" IS NOT NULL)
  OR ("status" IN ('PENDING', 'CANCELLED'))
);

-- A human decision is attributed or it did not happen.
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_decision_is_attributed" CHECK (
  ("decided_by_id" IS NULL AND "decided_at" IS NULL)
  OR ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)
);

-- A rule-produced policy cites its rule; a DEFAULT one cannot.
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_policy_scope_matches_rule" CHECK (
  ("policy_scope" = 'DEFAULT' AND "policy_rule_id" IS NULL)
  OR ("policy_scope" <> 'DEFAULT' AND "policy_rule_id" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- A credit note credits something; an invoice credits nothing.
--
-- ⚠️ THIS IS WHAT MAKES `InvoiceKind` A DISCRIMINATOR RATHER THAN A LABEL. A
--   CREDIT_NOTE with a NULL `credited_invoice_id` is a reversal of nothing, and
--   an INVOICE carrying one is a charge pretending to be a correction. Both
--   would pass every service check written today and break the arithmetic that
--   asks what a patient owes — Σ INVOICE − Σ CREDIT_NOTE.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_note_cites_its_invoice" CHECK (
  ("kind" = 'CREDIT_NOTE' AND "credited_invoice_id" IS NOT NULL)
  OR ("kind" = 'INVOICE' AND "credited_invoice_id" IS NULL)
);

-- ---------------------------------------------------------------------------
-- An endorsed repeat, on the clinical record (KNOWN_ISSUES #8).
--
-- ⚠️ A LIMIT WITHOUT AN ENDORSEMENT IS MEANINGLESS, AND A LIMIT OF ZERO IS A
--   REFUSAL WEARING AN ENDORSEMENT'S CLOTHES. Both are refused. What is
--   deliberately ALLOWED is `repeats_authorised = true` with a NULL limit: that
--   is a prescriber who endorsed a repeat without saying how many, and the
--   engine resolves it `UNDETERMINED` — which refuses. Making it illegal here
--   would force whoever keys it in to invent a number.
-- ---------------------------------------------------------------------------
ALTER TABLE "encounter_prescriptions" ADD CONSTRAINT "encounter_prescriptions_repeat_limit_needs_endorsement" CHECK (
  "repeats_authorised_limit" IS NULL
  OR ("repeats_authorised" IS TRUE AND "repeats_authorised_limit" > 0)
);

-- A registration's dates run forwards.
ALTER TABLE "membership_professional_registrations"
  ADD CONSTRAINT "membership_professional_registrations_dates_ordered" CHECK (
    "issued_on" IS NULL OR "expires_on" IS NULL OR "expires_on" >= "issued_on"
  );

-- ===========================================================================
-- RLS
--
-- ⚠️ A TENANT TABLE WITHOUT A POLICY PRODUCES NO ERROR AND BREAKS NO
--   SINGLE-TENANT TEST. It just starts returning other clinics' rows — and
--   `charge_requests` holds a named patient beside a named medicine and a price.
--   `db:rls:check` fails until these exist, deliberately.
--
-- The wording below is kept identical to `enable-rls.sql` so the two files can
-- be diffed by eye.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The org predicate, on all three.
--
-- ⚠️ `charge_policy_rules` IS ORG-SCOPED ONLY AND IS NOT IN THE BRANCH LOOP
--   BELOW. It has no `branch_id` column — a clinic's answer to "is this billed?"
--   is the ORGANIZATION's commercial position, the same call `suppliers` makes —
--   so the branch predicate would name a column that does not exist and the
--   CREATE POLICY would raise at migration time. PI-3 discovered the same thing
--   about `stock_transfers`.
--
--   THE COST, STATED: a branch-scoped member reads the whole organization's
--   charge policy. Intended — they need to know what is chargeable — and it is
--   why nothing branch-confidential may be added to that table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  charging_tables text[] := ARRAY[
    'charge_policy_rules',
    'product_prices',
    'charge_requests'
  ];
BEGIN
  FOREACH t IN ARRAY charging_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- ENABLE, not FORCE: the owner must keep bypassing so migrations and seeds
    -- work (ADR-0003).
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

-- ---------------------------------------------------------------------------
-- The branch predicate, on the two that have a branch.
--
-- `product_prices.branch_id` IS NULLABLE — NULL is the organization-wide default
-- every branch inherits — so the `IS NULL OR` half is live here rather than dead
-- code, unlike the pharmacy tables. `charge_requests.branch_id` is NOT NULL, so
-- for it the policy is absolute: a supply happened at one counter, and a branch
-- a pharmacist does not work at is not their register to read.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  branch_tables text[] := ARRAY[
    'product_prices',
    'charge_requests'
  ];
BEGIN
  FOREACH t IN ARRAY branch_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS branch_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY branch_isolation ON %I AS RESTRICTIVE
        USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
        WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The RESTRICTIVE `*_visible` policies — KI-3, the risk that `db:rls:check`
-- structurally cannot see.
--
-- ⚠️ `tenant_isolation` CONSTRAINS THE CHILD SIDE AND SAYS NOTHING ABOUT THE
--   PARENT SIDE. `products`, `product_categories` and `units_of_measure` are all
--   platform-extensible — a NULL `organization_id` means a platform row every
--   tenant may read — so a plain FK from a tenant row can name ANOTHER TENANT'S
--   PRIVATE product, and the name comes straight back out through the join on
--   the screen that renders it. The table has a policy; it just does not have
--   enough of one, which is exactly why the check cannot catch it.
--
-- The shape is `batches`' and `encounter_prescriptions`', and it is named the
-- same on purpose.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS product_visible ON charge_policy_rules;
CREATE POLICY product_visible ON charge_policy_rules AS RESTRICTIVE
  USING (
    "product_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = charge_policy_rules.product_id
        AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
    )
  )
  WITH CHECK (
    "product_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = charge_policy_rules.product_id
        AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
    )
  );

DROP POLICY IF EXISTS category_visible ON charge_policy_rules;
CREATE POLICY category_visible ON charge_policy_rules AS RESTRICTIVE
  USING (
    "product_category_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM product_categories c
      WHERE c.id = charge_policy_rules.product_category_id
        AND (c.organization_id IS NULL OR c.organization_id = app_current_org())
    )
  )
  WITH CHECK (
    "product_category_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM product_categories c
      WHERE c.id = charge_policy_rules.product_category_id
        AND (c.organization_id IS NULL OR c.organization_id = app_current_org())
    )
  );

DROP POLICY IF EXISTS product_visible ON product_prices;
CREATE POLICY product_visible ON product_prices AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = product_prices.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = product_prices.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON product_prices;
CREATE POLICY unit_visible ON product_prices AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = product_prices.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = product_prices.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS product_visible ON charge_requests;
CREATE POLICY product_visible ON charge_requests AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = charge_requests.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = charge_requests.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON charge_requests;
CREATE POLICY unit_visible ON charge_requests AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = charge_requests.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = charge_requests.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- ⚠️ A PI-7 GAP, CLOSED HERE RATHER THAN LEFT FOR A LATER PHASE TO FIND.
--
--   `dispense_lines.product_id` and `.unit_id` are plain FKs into the same two
--   platform-extensible tables, and PI-7 shipped without either `*_visible`
--   policy. It is the same hole as above and the same class KI-3 describes: a
--   clinic could attach another clinic's private product to its own dispense
--   line and read the name back through the join the dispense detail screen
--   makes. Nothing in this phase depends on it being closed; it is one policy
--   pair next to five identical ones, and leaving a known cross-tenant read open
--   because it is somebody else's diff is not a trade-off worth taking.
--
--   `encounter_prescriptions` already carries `product_visible` (CE-4), which is
--   what makes the omission on `dispense_lines` an oversight rather than a
--   decision.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_visible ON dispense_lines;
CREATE POLICY product_visible ON dispense_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = dispense_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = dispense_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON dispense_lines;
CREATE POLICY unit_visible ON dispense_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = dispense_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = dispense_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- ⚠️ THE SECOND PLAIN FK ON `dispense_lines`, AND THE ONE PI-8 ALMOST SHIPPED
--   WITHOUT. `product_visible` above names `product_id`. `substituted_for_product_id`
--   is a SECOND plain FK into the same platform-extensible table, it is accepted
--   straight from the client (`dispenseLineRequest.substitutedForProductId`), it
--   is written with no validation, and it is JOINED FOR ITS NAME and rendered on
--   the dispense detail screen.
--
--   Exploit, before this: clinic A posts a dispense whose
--   `substituted_for_product_id` is clinic B's PRIVATE product uuid.
--   `tenant_isolation` is satisfied — the row is A's — and B's product name comes
--   straight back on A's screen. Textbook KI-3, and PI-8 made it materially more
--   reachable by adding the substitute picker to the dispensing workspace.
--
--   The model comment at `pharmacy.prisma` says "Plain FKs into possibly-platform
--   rows — `product_visible`, `unit_visible`", PLURAL, describing a policy set
--   that did not cover both columns. It does now.
--
-- ⚠️ NULLABLE, so the `IS NULL OR` half is live: most lines substitute nothing.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS substituted_product_visible ON dispense_lines;
CREATE POLICY substituted_product_visible ON dispense_lines AS RESTRICTIVE
  USING (
    "substituted_for_product_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = dispense_lines.substituted_for_product_id
        AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
    )
  )
  WITH CHECK (
    "substituted_for_product_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = dispense_lines.substituted_for_product_id
        AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
    )
  );

-- ---------------------------------------------------------------------------
-- `regulatory_decisions.product_id` — the same class, PI-7 vintage.
--
-- Lower risk than the two above because `recordDecision` derives the id
-- server-side rather than taking it from a request, so there is no direct write
-- path a client controls. Added anyway: "the service happens not to pass an
-- attacker-controlled id today" is the class of guarantee this schema exists to
-- replace, and the decision snapshot is joined to a product name on the
-- dispense detail screen like everything else here.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_visible ON regulatory_decisions;
CREATE POLICY product_visible ON regulatory_decisions AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = regulatory_decisions.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = regulatory_decisions.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- `membership_professional_registrations` — a parent-scoped child.
--
-- No `organization_id` of its own, exactly like `staff_profiles`, and protected
-- the same way: an EXISTS against the parent membership's organization.
--
-- ⚠️ THE SUBQUERY IS **NOT** SUBJECT TO `memberships`' OWN RLS — Postgres
--   evaluates policy expressions with row security disabled on the tables they
--   reference — so the organization test is spelled out here rather than leaned
--   on. That is the whole reason the `parent_scoped` loop's predicates are
--   written the way they are; see the note above it in `enable-rls.sql`.
--
--   The parent is ORG-scoped, not branch-scoped, so there is no branch half to
--   restate. A licence is a fact about a person, not about a site.
-- ---------------------------------------------------------------------------
ALTER TABLE "membership_professional_registrations" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "membership_professional_registrations" NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parent_isolation ON membership_professional_registrations;
CREATE POLICY parent_isolation ON membership_professional_registrations
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.id = membership_professional_registrations.membership_id
      AND m.organization_id = app_current_org()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.id = membership_professional_registrations.membership_id
      AND m.organization_id = app_current_org()
  ));

-- ---------------------------------------------------------------------------
-- Grants. The application connects as rcln_app, which owns nothing.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "charge_policy_rules",
  "product_prices",
  "charge_requests",
  "membership_professional_registrations"
TO rcln_app;
