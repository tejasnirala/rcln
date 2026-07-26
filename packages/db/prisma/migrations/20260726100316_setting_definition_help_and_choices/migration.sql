-- Two columns on the setting CATALOGUE, which is platform data.
--
-- NO RLS POLICY IS APPENDED HERE, AND THAT IS CORRECT. `setting_definitions`
-- has no organization_id: every clinic reads the same twelve rows, and it is on
-- the EXEMPT list in packages/db/scripts/check-rls.ts as "static catalogue".
-- Contrast `setting_values`, which holds the answers and is scoped by
-- (scope_type, scope_id) in application code — see setting.service.ts.
--
-- Both columns are nullable, so no backfill: an existing row with no help text
-- and no closed set behaves exactly as it did. `allowed_values` NULL means "any
-- value of data_type", which is what all twelve seeded rows meant until now.

-- AlterTable
ALTER TABLE "setting_definitions" ADD COLUMN     "allowed_values" JSONB,
ADD COLUMN     "help_text" VARCHAR(1024);
