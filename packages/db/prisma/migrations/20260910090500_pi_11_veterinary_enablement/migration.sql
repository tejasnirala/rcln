-- ---------------------------------------------------------------------------
-- PI-11 — Veterinary enablement
--
-- ⚠️ THIS PHASE ADDS NO TABLE. That is the headline, not an omission. CD-4 landed
--   `patients.subject_type` and the `animal_profiles` extension row in CE-1 and
--   deliberately built nothing on top of them — §42.7 forbade veterinary
--   functionality at the time. The table has therefore existed, empty and
--   unreachable, ever since: no contract field, no service, no route, no screen.
--   PI-11 is the enablement layer, and the schema work it needs is three columns.
--
-- ⚠️ NO NEW RLS POLICY IS REQUIRED AND `db:rls:check` MUST STILL PASS.
--   `animal_profiles` already carries its org policy from the CE-1 migration, and
--   `patient_contacts` carries its own. The one new foreign key is COMPOSITE —
--   (organization_id, guardian_contact_id) — so it needs no `*_visible` check
--   for the reason `recall_batches.batch_id` needed none in PI-10: the tenant
--   column is inside the key, and a cross-tenant reference is unrepresentable
--   rather than merely unchecked (ADR-0004).
--
-- ⚠️ TWO STATEMENTS WERE DELETED FROM WHAT `migrate diff` GENERATED, and they
--   must be deleted from anything it generates in future: it wants to
--   `ALTER COLUMN "item_id" DROP NOT NULL` on `encounter_procedures` and
--   `encounter_investigations`, because CE-4 tightened both by hand and the
--   Prisma model cannot say "required relation, nullable scalar". PI-7's, PI-8's,
--   PI-9's and PI-10's migration headers all say exactly the same thing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The owner, as a row rather than as two strings (ADR-0017).
--
-- ADR-0017 says "the owner is an existing contact". CD-4 shipped free text
-- instead, because it was building a placeholder rather than a feature. Both now
-- exist and they are mutually exclusive, enforced below: a clinic that has
-- recorded the owner as a `patient_contacts` row points at it, and one that has
-- a name on a scrap of paper writes the name. Two spellings of one owner is how
-- a recall notice gets posted to the wrong address.
--
-- ⚠️ THE FK IS COMPOSITE AND IT CONSTRAINS THE TENANT, NOT THE PARENT. It makes
--   another CLINIC's contact unrepresentable; it does NOT stop an animal naming
--   a different animal's owner within the same clinic. That second check is in
--   `animal-profile.service.ts` and there is a test for it.
--
-- `SET NULL`: deleting the contact must not delete the animal.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "patient_contacts_organization_id_id_key" ON "patient_contacts"("organization_id", "id");

ALTER TABLE "animal_profiles" ADD COLUMN "guardian_contact_id" UUID;

CREATE INDEX "animal_profiles_organization_id_guardian_contact_id_idx" ON "animal_profiles"("organization_id", "guardian_contact_id");

ALTER TABLE "animal_profiles"
  ADD CONSTRAINT "animal_profiles_organization_id_guardian_contact_id_fkey"
  FOREIGN KEY ("organization_id", "guardian_contact_id")
  REFERENCES "patient_contacts"("organization_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. When the animal was weighed.
--
-- ⚠️ A WEIGHT WITH NO DATE IS A DOSING HAZARD, WHICH IS THE WHOLE REASON THIS
--   COLUMN EXISTS. `weight_kg` has carried the schema comment "a dose is
--   calculated from it" since CE-1, and PI-11 is the phase that actually
--   calculates one. A puppy weighed at eight weeks and dosed at eight months is
--   the error the calculator has to be able to see, and a bare `weight_kg`
--   cannot distinguish "weighed this morning" from "weighed in 2023".
--   `updated_at` is not an answer: correcting the spelling of the breed moves it.
--
-- A DATE and not a timestamp, for the reason `patients.deceased_on` is one — the
-- hour an animal was weighed changes no decision.
-- ---------------------------------------------------------------------------
ALTER TABLE "animal_profiles" ADD COLUMN "weight_recorded_on" DATE;

-- ---------------------------------------------------------------------------
-- 3. The two CHECK constraints Prisma cannot express.
--
-- Both are hand-written here for the reason every other CHECK in this programme
-- is: the Prisma schema has no vocabulary for a cross-column invariant, so the
-- only place it can be stated is SQL, and a rule that lives only in a service is
-- a rule that a fixture, a backfill or a second service will eventually skip.
-- ---------------------------------------------------------------------------

-- One owner, recorded one way.
ALTER TABLE "animal_profiles"
  ADD CONSTRAINT "animal_profiles_one_guardian_form"
  CHECK ("guardian_contact_id" IS NULL OR ("guardian_name" IS NULL AND "guardian_phone" IS NULL));

-- A date with no weight against it says nothing, and reads on screen as though
-- somebody weighed the animal. Existing rows are unaffected: both columns are
-- NULL on every one of them, because nothing has ever written to this table.
ALTER TABLE "animal_profiles"
  ADD CONSTRAINT "animal_profiles_weight_date_needs_weight"
  CHECK ("weight_recorded_on" IS NULL OR "weight_kg" IS NOT NULL);
