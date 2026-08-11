-- Make the tax engine country-neutral rather than India-shaped, and rename the
-- India-named tax identifier columns now that the screens above them have
-- generalised.
--
-- ⚠️ THE TWO RENAMES ARE HAND-WRITTEN AND MUST STAY THAT WAY.
--   `prisma migrate diff` emits `DROP COLUMN "gst_number"` + `ADD COLUMN
--   "tax_id"` for a rename, because a schema diff cannot see that one column
--   BECAME the other. Applying that would silently discard every clinic's tax
--   identifier — the diff reports no error, the migration succeeds, and the
--   column is simply empty afterwards. `ALTER TABLE ... RENAME COLUMN` preserves
--   the values and is the only correct form.

-- CreateEnum
CREATE TYPE "TaxSplit" AS ENUM ('NONE', 'INTRA_STATE_HALVES');

-- AlterEnum
--
-- Safe inside migrate deploy's transaction: nothing here USES the new value.
ALTER TYPE "TaxTreatment" ADD VALUE 'PROVIDER_REQUIRED';

-- ---------------------------------------------------------------------------
-- gst_number -> tax_id, preserving the data.
--
-- The column was always read as "the customer's tax identifier, whatever the
-- country calls it" — `locale.ts` has supplied the label, pattern and example
-- per country (GSTIN, TRN, ABN, VAT number, PAN) since tenancy shipped. Only the
-- name was Indian, and the schema comment has carried a RENAME instruction ever
-- since. Widened 20 -> 32 because an Irish VAT number with the country prefix
-- and a Singaporean GST registration both exceed 20 in their longest forms.
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" RENAME COLUMN "gst_number" TO "tax_id";
ALTER TABLE "organizations" ALTER COLUMN "tax_id" TYPE VARCHAR(32);

ALTER TABLE "branches" RENAME COLUMN "gst_number" TO "tax_id";
ALTER TABLE "branches" ALTER COLUMN "tax_id" TYPE VARCHAR(32);

-- ---------------------------------------------------------------------------
-- What a tax LINE is called, and how one rate becomes several of them.
--
-- ⚠️ THE BUG THIS FIXES PRODUCED CORRECT ARITHMETIC ON A NON-COMPLIANT
--   DOCUMENT, WHICH IS WHY NOTHING CAUGHT IT. `GST` was treated as meaning
--   India, so an Australian clinic's invoice printed a line called `IGST` for an
--   "inter-state supply" — a concept Australian law does not contain — at
--   exactly the right rate and total. Every total-based check passed.
--
--   The line name is per-RULE and not per-country because one country needs
--   several: an Ontario clinic charges one 13% `HST` line, a British Columbia
--   one charges 5% `GST` plus 7% `PST`, and both are Canada.
--
-- Added nullable, backfilled, then made NOT NULL — the three-step form, because
-- a NOT NULL column with no default cannot be added to a table with rows, and a
-- DEFAULT of 'GST' would be a silently wrong label for every VAT country.
-- ---------------------------------------------------------------------------
ALTER TABLE "tax_rules" ADD COLUMN "line_name" VARCHAR(32);
ALTER TABLE "tax_rules" ADD COLUMN "regional_line_name" VARCHAR(32);
ALTER TABLE "tax_rules" ADD COLUMN "split" "TaxSplit" NOT NULL DEFAULT 'NONE';
ALTER TABLE "tax_rules" ADD COLUMN "stacks" BOOLEAN NOT NULL DEFAULT false;

UPDATE "tax_rules" SET "line_name" = CASE WHEN "scheme" = 'VAT' THEN 'VAT' ELSE 'GST' END
 WHERE "line_name" IS NULL;

ALTER TABLE "tax_rules" ALTER COLUMN "line_name" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- A stacking rule is always regional.
--
-- `stacks` means "charge this IN ADDITION to the country-wide rule for the same
-- category" — Canada's provincial PST on top of federal GST. A country-wide rule
-- that stacked would stack on itself: it would be both the base and the addition,
-- and the same rate would be charged twice on one line item.
-- ---------------------------------------------------------------------------
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_stacking_is_regional"
  CHECK (NOT "stacks" OR "region_code" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- A split rule names the tax it is splitting.
--
-- INTRA_STATE_HALVES derives `CGST`/`SGST`/`IGST` from `line_name` by prefix,
-- which is how those names are constructed in law. A `line_name` of 'Sales Tax'
-- would derive 'CSales Tax', so the split only makes sense for a short
-- alphabetic name.
-- ---------------------------------------------------------------------------
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_split_name_is_prefixable"
  CHECK ("split" = 'NONE' OR "line_name" ~ '^[A-Z]{2,8}$');
