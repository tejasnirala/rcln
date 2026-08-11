-- The rate cards rcln maintains, which every clinic inherits until it says
-- otherwise.
--
-- ⚠️ INHERITED AT READ TIME, NEVER COPIED INTO A TENANT. The obvious alternative
--   — seeding a clinic's `tax_rules` from this table at registration — turns
--   every rate change into a migration across every tenant, and permanently
--   destroys the difference between "this clinic chose 12%" and "this is a stale
--   copy of our old default". Resolution lives in `rulesFor`. See the model
--   comment for the full reasoning.
--
-- ⚠️ NOT `tax_registrations`, AND THE DISTINCTION DECIDES WHETHER IT MAY BE
--   SEEDED. That table asserts that RCLN IS REGISTERED somewhere — a legal claim
--   — which is why it ships empty. This one says only "in this country, this
--   kind of thing is taxed like this", and it has no effect whatsoever on a
--   clinic that holds no registration of its own. Seeding it charges nobody
--   anything.

-- CreateTable
CREATE TABLE "tax_rule_defaults" (
    "id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(10),
    "scheme" "TaxScheme" NOT NULL,
    "tax_category" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "rate_bps" INTEGER NOT NULL,
    "treatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
    "line_name" VARCHAR(32) NOT NULL,
    "regional_line_name" VARCHAR(32),
    "split" "TaxSplit" NOT NULL DEFAULT 'NONE',
    "stacks" BOOLEAN NOT NULL DEFAULT false,
    "source_note" VARCHAR(500),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tax_rule_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_rule_defaults_country_code_tax_category_effective_from_idx" ON "tax_rule_defaults"("country_code", "tax_category", "effective_from");

-- ===========================================================================
-- HAND-WRITTEN
-- ===========================================================================

-- NULLS NOT DISTINCT, for the same reason as `tax_rules`: a country-wide rate is
-- the COMMON row here, not the corner, and an ordinary unique index does not
-- constrain a NULL `region_code` at all.
CREATE UNIQUE INDEX "tax_rule_defaults_country_code_region_code_scheme_tax_categ_key"
  ON "tax_rule_defaults" ("country_code", "region_code", "scheme", "tax_category", "effective_from")
  NULLS NOT DISTINCT;

-- The same three item-level invariants `tax_rules` carries. Kept identical
-- deliberately: a default that could not be stored as a tenant rule would be a
-- default no clinic could ever override with the same shape.
ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_treatment_is_item_level"
  CHECK ("treatment" IN ('STANDARD', 'ZERO_RATED', 'EXEMPT'));

ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_untaxed_means_zero_rate"
  CHECK ("treatment" = 'STANDARD' OR "rate_bps" = 0);

ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_rate_in_range"
  CHECK ("rate_bps" >= 0 AND "rate_bps" <= 10000);

ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_stacking_is_regional"
  CHECK (NOT "stacks" OR "region_code" IS NOT NULL);

ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_split_name_is_prefixable"
  CHECK ("split" = 'NONE' OR "line_name" ~ '^[A-Z]{2,8}$');

ALTER TABLE "tax_rule_defaults" ADD CONSTRAINT "tax_rule_defaults_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- ---------------------------------------------------------------------------
-- NO RLS POLICY, DELIBERATELY. Listed in EXEMPT in check-rls.ts.
--
-- ⚠️ SAME REASONING AS `tax_registrations`, AND IT IS LOAD-BEARING. Every clinic
--   reads these rows, inside its own tenant transaction, to price its own
--   invoices. A `tenant_isolation` policy would require a matching
--   `organization_id` that this table does not have and must not have — so it
--   would return zero rows for everyone, every category would fall through to
--   UNRATED, and no clinic on the platform could issue an invoice.
--
--   The failure is at least fail-CLOSED, unlike `tax_registrations` where the
--   same mistake silently untaxes everything. It would still break billing
--   platform-wide.
--
-- There is nothing tenant-specific in a row here: it is the published law of a
-- country, identical for every clinic in it, exactly like `plans`.
-- ---------------------------------------------------------------------------
