-- =============================================================================
-- Null-safe uniqueness on tax_registrations.
--
-- `region_code` is NULL for a country-wide registration — which is the COMMON
-- case, not the edge one: most VAT regimes issue a single national number and
-- only India and the US register per subdivision.
--
-- Postgres treats NULLs as DISTINCT in a UNIQUE index, so the index Prisma
-- generated does not constrain those rows at all: two country-wide GST
-- registrations for IN could both exist, and the tax engine picks one by
-- whichever the planner returns first. Two different registration numbers on
-- otherwise identical invoices, with nothing failing anywhere.
--
-- This is the same hole ADR-0004 and the 20260725060000 migration exist for.
-- Written as a separate migration rather than by editing the previous one,
-- because that one has been applied and Prisma checksums it.
-- =============================================================================

DROP INDEX IF EXISTS "tax_registrations_country_code_region_code_scheme_key";

CREATE UNIQUE INDEX "tax_registrations_country_code_region_code_scheme_key"
  ON "tax_registrations" ("country_code", "region_code", "scheme") NULLS NOT DISTINCT;

-- A registration that has lapsed or been removed must not be picked up by the
-- engine, and the lookup is always "the live one for this place".
CREATE INDEX "tax_registrations_live_idx"
  ON "tax_registrations" ("country_code", "region_code")
  WHERE "deleted_at" IS NULL;
