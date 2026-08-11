-- Clinical taxonomy: turn `specialties` into a first-class hierarchical
-- classification tree, and `doctor_specialties` into a classification record
-- rather than a bare link row.
--
-- WHY THIS EXTENDS `specialties` RATHER THAN ADDING `clinical_taxonomy_nodes`
--   The table was ALREADY an adjacency list — self-FK on parent_id, platform
--   rows at organization_id NULL, codes stable across re-seeds — and it was
--   already joined many-to-many to doctors with a primary flag. A second
--   taxonomy table would have meant two answers to "what is this doctor trained
--   in", a data migration off a table that `procedures.specialty_id` is planned
--   to reference, and a second RLS stanza to keep in step with this one. The
--   node type, ordering and traversal it was missing are columns and queries,
--   not a new table.
--
-- NO RLS CHANGES ARE NEEDED HERE, AND THAT IS CHECKED, NOT ASSUMED.
--   Both tables already carry policies: `specialties` is in the
--   `platform_extensible` array in prisma/rls/enable-rls.sql (read permissive on
--   organization_id IS NULL, write NOT), and `doctor_specialties` is in
--   `org_scoped` plus the RESTRICTIVE `specialty_visible` policy that constrains
--   its second parent. This migration adds no table, so it adds no policy.
--   `pnpm db:rls:check` still has to pass.

-- CreateEnum
CREATE TYPE "TaxonomyNodeType" AS ENUM ('DOMAIN', 'DEPARTMENT', 'SPECIALTY', 'SUB_SPECIALTY', 'FOCUS_AREA', 'EXPERTISE');

-- CreateEnum
CREATE TYPE "SpecialtyProficiency" AS ENUM ('PRACTISING', 'SPECIALIST', 'EXPERT');

-- DropForeignKey
ALTER TABLE "specialties" DROP CONSTRAINT "specialties_parent_id_fkey";

-- AlterTable
ALTER TABLE "doctor_specialties" ADD COLUMN     "effective_from" DATE,
ADD COLUMN     "effective_to" DATE,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "proficiency" "SpecialtyProficiency";

-- `updated_at` is NOT NULL with no default, and the table has rows. Nullable →
-- backfill → SET NOT NULL, in one migration.
--
-- Backfilled from `created_at`, not now(): these rows have genuinely not been
-- updated since they were written, and stamping them with the deploy timestamp
-- would be a lie that any "recently changed classifications" report believes.
ALTER TABLE "doctor_specialties" ADD COLUMN "updated_at" TIMESTAMPTZ(6);
UPDATE "doctor_specialties" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "doctor_specialties" ALTER COLUMN "updated_at" SET NOT NULL;

-- AlterTable
--
-- Every existing row becomes type SPECIALTY. That is the honest default for the
-- ~48 seeded rows: they are a flat list of specialties with a few sub-specialty
-- children. The seed re-types and re-parents them under DOMAIN roots in the same
-- release, keyed by `code`, which is why no data migration is needed here.
ALTER TABLE "specialties" ADD COLUMN     "description" TEXT,
ADD COLUMN     "display_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "type" "TaxonomyNodeType" NOT NULL DEFAULT 'SPECIALTY';

-- CreateIndex
--
-- Descendant and ancestor walks are recursive CTEs over parent_id. Without this
-- index each LEVEL of the recursion is a sequential scan of the whole table.
CREATE INDEX "specialties_parent_id_idx" ON "specialties"("parent_id");

-- CreateIndex
CREATE INDEX "specialties_organization_id_type_idx" ON "specialties"("organization_id", "type");

-- AddForeignKey
--
-- ⚠️ RESTRICT, NOT SET NULL — this is a behaviour change and it is the point.
--   Under SET NULL, deleting "Cardiology" did not fail: it silently promoted
--   Interventional Cardiology and Electrophysiology to root nodes, where they
--   render in the UI as peers of "Medical" and "Dental". No error, no log line,
--   and the doctors attached to them stop being reachable by a Cardiology
--   filter. RESTRICT makes the caller deal with the subtree explicitly.
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Acyclicity. Prisma Migrate cannot express this.
--
-- A cycle in an adjacency list is not a bad row, it is a hang: every ancestor
-- walk, every descendant walk and every breadcrumb render recurses until the
-- statement timeout. `WITH RECURSIVE` will happily spin forever on A → B → A.
--
-- ⚠️ DELIBERATELY *NOT* OWNER-EXEMPT, unlike the append-only triggers on
--   audit_logs and appointment_status_history. Those exempt the owner because
--   migrations, seeds and ON DELETE CASCADE legitimately need to write there.
--   A cycle is never legitimate — not from the app, not from a seed, not from a
--   migration. The seed's second pass sets parent_id on 48 rows and this is
--   exactly the guard that catches a typo'd parent code that closes a loop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION specialties_reject_cycle() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  cursor_id uuid;
  hops      int := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'specialty % cannot be its own parent', NEW.id
      USING HINT = 'A taxonomy node''s parent must be a different node.';
  END IF;

  -- Walk up from the proposed parent. Termination: either we reach a root
  -- (parent_id IS NULL), or we arrive back at NEW.id, which is the cycle. The
  -- hop counter is a backstop for a cycle that ALREADY exists further up the
  -- chain and therefore does not pass through NEW.id — without it this loop
  -- would itself hang on pre-existing corruption.
  cursor_id := NEW.parent_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'specialty % cannot be a descendant of itself', NEW.id
        USING HINT = format('Re-parenting it under %s would close a cycle.', NEW.parent_id);
    END IF;

    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION 'specialty ancestor walk exceeded 64 levels from %', NEW.id
        USING HINT = 'The tree is almost certainly already cyclic. Inspect parent_id.';
    END IF;

    SELECT parent_id INTO cursor_id FROM specialties WHERE id = cursor_id;
  END LOOP;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS specialties_no_cycle ON specialties;
CREATE TRIGGER specialties_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON specialties
  FOR EACH ROW EXECUTE FUNCTION specialties_reject_cycle();

-- ---------------------------------------------------------------------------
-- No two live siblings may share a name.
--
-- Case-insensitive: "Cardiology" and "cardiology" under one parent is a
-- duplicate a clinic has to resolve by hand later, not two nodes.
--
-- ⚠️ NULLS NOT DISTINCT is load-bearing TWICE here, for two different columns.
--   organization_id NULL is the platform catalogue — without it, the platform
--   rows are unconstrained among themselves, which is where duplicates would
--   actually come from. parent_id NULL is the set of roots — without it,
--   "Medical" could be inserted as a root twice.
--
-- Partial on deleted_at: a soft-deleted node must not block a clinic re-creating
-- a specialty with the same name, and its own uniqueness is already spent.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "specialties_sibling_name_key"
  ON "specialties" ("organization_id", "parent_id", lower("name"))
  NULLS NOT DISTINCT
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- At most one primary classification per doctor.
--
-- The service already only ever sets is_primary on one row, so this constrains
-- nothing today — which is exactly when to add it. The failure it prevents is a
-- partial write or a future second code path leaving two primaries, after which
-- `specialties.find(s => s.isPrimary)` starts returning whichever row Postgres
-- happened to hand back first and the doctor's headline specialty changes
-- between two page loads with no write in between.
--
-- Zero primaries stays legal: primarySpecialtyId is optional on the contract.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "doctor_specialties_one_primary_key"
  ON "doctor_specialties" ("organization_id", "doctor_profile_id")
  WHERE "is_primary";
