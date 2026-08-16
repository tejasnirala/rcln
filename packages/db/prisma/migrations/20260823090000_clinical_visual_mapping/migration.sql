-- CreateEnum
CREATE TYPE "VisualMapRenderer" AS ENUM ('SVG', 'IMAGE_MAP');

-- AlterTable
--
-- ⚠️ `prisma migrate diff` ALSO WANTED TO DROP NOT NULL FROM `item_id` ON
--   `encounter_procedures` AND `encounter_investigations`, AND BOTH WERE
--   DELETED BY HAND. Those columns are NOT NULL in the database because the
--   CE-4 migration said so; Prisma believes them nullable only because a
--   required relation may not include a nullable scalar, which is a modelling
--   limitation and not a schema change. Leaving the generated lines in would
--   have quietly made a free-text procedure representable — the exact thing
--   SCHEMA.md records the CE-4 decision about.
ALTER TABLE "encounter_procedures" ADD COLUMN "visual_region_id" UUID;

-- CreateTable
CREATE TABLE "visual_maps" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "renderer" "VisualMapRenderer" NOT NULL DEFAULT 'SVG',
    "asset_key" VARCHAR(120),
    "care_context_id" UUID NOT NULL,
    "specialty_id" UUID,
    "view_box" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "visual_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_regions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "map_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "parent_id" UUID,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "visual_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_findings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "section_key" VARCHAR(64) NOT NULL,
    "visual_region_id" UUID NOT NULL,
    "finding_item_id" UUID NOT NULL,
    "diagnosis_id" UUID,
    "severity" "ClinicalSeverity",
    "notes" TEXT,
    "metadata" JSONB,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinical_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visual_maps_organization_id_care_context_id_is_active_idx" ON "visual_maps"("organization_id", "care_context_id", "is_active");

-- CreateIndex
CREATE INDEX "visual_maps_organization_id_specialty_id_idx" ON "visual_maps"("organization_id", "specialty_id");

-- CreateIndex
CREATE UNIQUE INDEX "visual_maps_organization_id_code_key" ON "visual_maps"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "visual_maps_organization_id_id_key" ON "visual_maps"("organization_id", "id");

-- CreateIndex
CREATE INDEX "visual_regions_organization_id_map_id_display_order_idx" ON "visual_regions"("organization_id", "map_id", "display_order");

-- CreateIndex
CREATE INDEX "visual_regions_parent_id_idx" ON "visual_regions"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "visual_regions_organization_id_map_id_code_key" ON "visual_regions"("organization_id", "map_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "visual_regions_organization_id_id_key" ON "visual_regions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "clinical_findings_organization_id_encounter_id_display_orde_idx" ON "clinical_findings"("organization_id", "encounter_id", "display_order");

-- CreateIndex
CREATE INDEX "clinical_findings_organization_id_visual_region_id_idx" ON "clinical_findings"("organization_id", "visual_region_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_findings_organization_id_encounter_id_section_key__key" ON "clinical_findings"("organization_id", "encounter_id", "section_key", "visual_region_id", "finding_item_id");

-- AddForeignKey
ALTER TABLE "encounter_procedures" ADD CONSTRAINT "encounter_procedures_visual_region_id_fkey" FOREIGN KEY ("visual_region_id") REFERENCES "visual_regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_maps" ADD CONSTRAINT "visual_maps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_maps" ADD CONSTRAINT "visual_maps_care_context_id_fkey" FOREIGN KEY ("care_context_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_maps" ADD CONSTRAINT "visual_maps_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_regions" ADD CONSTRAINT "visual_regions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_regions" ADD CONSTRAINT "visual_regions_organization_id_map_id_fkey" FOREIGN KEY ("organization_id", "map_id") REFERENCES "visual_maps"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_regions" ADD CONSTRAINT "visual_regions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "visual_regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_organization_id_encounter_id_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "encounters"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_visual_region_id_fkey" FOREIGN KEY ("visual_region_id") REFERENCES "visual_regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_finding_item_id_fkey" FOREIGN KEY ("finding_item_id") REFERENCES "clinical_master_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_findings" ADD CONSTRAINT "clinical_findings_organization_id_diagnosis_id_fkey" FOREIGN KEY ("organization_id", "diagnosis_id") REFERENCES "encounter_diagnoses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN. Prisma Migrate can express none of it.
--
-- CE-6 — the visual mapping engine.
--
--   visual_maps       PLATFORM-EXTENSIBLE. A chart is a picture of a BODY.
--   visual_regions    PLATFORM-EXTENSIBLE. Its places, FDI-coded for the
--                     odontogram (CD-11).
--   clinical_findings ORG + BRANCH SCOPED, PHI. What was found on one, at one
--                     visit, about one named person.
--
-- ⚠️ ONE MIGRATION, AND IT NEEDS NO SPLIT. `VisualMapRenderer` is a BRAND-NEW
--   type rather than an `ALTER TYPE … ADD VALUE`, so nothing here runs into
--   CD-9's enum trap — the same situation CE-2 was in.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT on both BUSINESS keys.
--
-- Both contain `organization_id`, which is NULL on a platform row. Under
-- Postgres's default two rows with a NULL organization_id are unique against
-- each other WHATEVER the other columns say — so the platform maps would not be
-- unique against themselves and the seed's `findFirst` would create a second
-- HUMAN_DENTAL on its second run, with thirty-two more regions under it.
--
-- ⚠️ THE `(organization_id, id)` COMPOSITE-FK TARGETS ARE LEFT ALONE, exactly as
--   CE-1, CE-2 and CE-4 left theirs. `id` is the primary key, so that index is
--   already unique whatever NULLs the first column holds — and the rewrite would
--   fail anyway, because Postgres refuses to drop an index a foreign key
--   depends on.
-- ---------------------------------------------------------------------------
DROP INDEX "visual_maps_organization_id_code_key";
CREATE UNIQUE INDEX "visual_maps_organization_id_code_key"
  ON "visual_maps" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "visual_regions_organization_id_map_id_code_key";
CREATE UNIQUE INDEX "visual_regions_organization_id_map_id_code_key"
  ON "visual_regions" ("organization_id", "map_id", "code") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- A MAP HAS A COORDINATE SPACE AND IT IS FOUR NUMBERS.
--
-- `view_box` is what every region's geometry is expressed in, so a map with a
-- malformed one is a map whose regions cannot be laid out at all. The engine
-- refuses it in `@rcln/clinical`; this refuses it in the database, which is
-- where a row written by a seed, a fixture or a future import also passes.
-- ---------------------------------------------------------------------------
ALTER TABLE "visual_maps"
  ADD CONSTRAINT "visual_maps_view_box_is_four_numbers"
  CHECK ("view_box" ~ '^-?[0-9]+(\.[0-9]+)? -?[0-9]+(\.[0-9]+)? [0-9]+(\.[0-9]+)? [0-9]+(\.[0-9]+)?$');

-- ---------------------------------------------------------------------------
-- AN IMAGE_MAP NEEDS ITS IMAGE.
--
-- ⚠️ AND AN SVG MAP MUST NOT CARRY ONE. Two ways to say what a map is drawn
--   over is one way too many: a row claiming SVG with an asset_key set is a
--   configuration whose renderer and whose asset disagree, and whichever the
--   screen believes, the other is silently ignored.
-- ---------------------------------------------------------------------------
ALTER TABLE "visual_maps"
  ADD CONSTRAINT "visual_maps_asset_matches_renderer"
  CHECK (
    ("renderer" = 'IMAGE_MAP' AND "asset_key" IS NOT NULL)
    OR ("renderer" = 'SVG' AND "asset_key" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- A REGION'S PARENT BELONGS TO THE SAME MAP.
--
-- ⚠️ THE FOREIGN KEY DOES NOT SAY THIS. `parent_id` references
--   `visual_regions(id)` alone — a plain self-reference — so a quadrant of the
--   dental chart could be made the parent of a scalp zone, and the grouping
--   walk would then produce a tree spanning two pictures. A trigger says it
--   because a CHECK cannot read another row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_cross_map_region_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_map uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT map_id INTO parent_map FROM visual_regions WHERE id = NEW.parent_id;
  IF parent_map IS DISTINCT FROM NEW.map_id THEN
    RAISE EXCEPTION 'a visual region may only be grouped under a region of the same map'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS region_parent_same_map ON visual_regions;
CREATE TRIGGER region_parent_same_map
  BEFORE INSERT OR UPDATE ON visual_regions
  FOR EACH ROW EXECUTE FUNCTION refuse_cross_map_region_parent();

-- ---------------------------------------------------------------------------
-- RLS — the two map tables are PLATFORM-EXTENSIBLE.
--
-- ⚠️ `specialties`' POLICY, NOT `files`'. `files` permits a NULL
--   organization_id in its WITH CHECK, which is right for an asset the platform
--   uploads on a tenant's behalf — reproducing it here would let ANY CLINIC
--   PUBLISH A PLATFORM-WIDE CHART, visible to every other tenant and writable
--   by anyone holding `clinical.visual_map.manage`. Read is permissive; write
--   is not.
--
-- ⚠️ AND THE `platform_rows_immutable` TRIGGER IS NOT OPTIONAL. The policy above
--   protects a platform row from neither DELETE nor CAPTURE — see the long note
--   in `prisma/rls/enable-rls.sql`. Without the trigger any clinic could delete
--   the odontogram for every clinic on the platform.
--
-- The canonical copy of these policies is `prisma/rls/enable-rls.sql`; this is
-- the stanza for the three new tables, as the convention requires.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  platform_extensible text[] := ARRAY['visual_maps', 'visual_regions'];
BEGIN
  FOREACH t IN ARRAY platform_extensible LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (organization_id IS NULL OR organization_id = app_current_org())
        WITH CHECK (organization_id = app_current_org())
    $f$, t);

    EXECUTE format('DROP TRIGGER IF EXISTS platform_rows_immutable ON %I', t);
    EXECUTE format($f$
      CREATE TRIGGER platform_rows_immutable
        BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION refuse_platform_row_mutation()
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- RLS — the findings are ORG + BRANCH SCOPED, both loops.
--
-- ⚠️ `branch_id` IS NOT NULL, SO THE BRANCH POLICY IS ABSOLUTE and the
--   `branch_id IS NULL OR` half is dead code — as it is for the eight CE-4
--   tables. A doctor scoped to one site cannot read what another site found on
--   a patient's chart, even by guessing a primary key.
--
-- ⚠️ AND THE CE-5 HAZARD DOES NOT RECUR HERE. The visit history nests a
--   BRANCH-scoped child under an ORG-scoped parent and had to say so in its own
--   isolation file; a finding's parent is the ENCOUNTER, which is branch-scoped
--   itself. Checked rather than assumed — see the isolation case.
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_findings" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "clinical_findings" NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON clinical_findings;
CREATE POLICY tenant_isolation ON clinical_findings
  USING      (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

DROP POLICY IF EXISTS branch_isolation ON clinical_findings;
CREATE POLICY branch_isolation ON clinical_findings AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));

-- ---------------------------------------------------------------------------
-- A FINDING CITES A WORD AND A REGION; A PROCEDURE MAY CITE A REGION.
--
-- Neither pointer can be composite-FK'd: both parents allow a NULL
-- organization_id so the platform can ship them, and these rows' is NOT NULL.
-- `tenant_isolation` therefore constrains the FINDING and says nothing at all
-- about what it points at — so without these a clinic files a finding against
-- ANOTHER TENANT'S private region or private word and reads the label back out
-- of the join.
--
-- ⚠️ WRITTEN OUT RATHER THAN JOINING THE `cites_an_item` LOOP, because the
--   column is `finding_item_id` and not `item_id`. It is named for what it
--   holds — a FINDING_TYPE, which is not a diagnosis.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS item_visible ON clinical_findings;
CREATE POLICY item_visible ON clinical_findings AS RESTRICTIVE
  USING (finding_item_id IS NULL OR EXISTS (
    SELECT 1 FROM clinical_master_items i
    WHERE i.id = clinical_findings.finding_item_id
      AND (i.organization_id IS NULL OR i.organization_id = app_current_org())
  ))
  WITH CHECK (finding_item_id IS NULL OR EXISTS (
    SELECT 1 FROM clinical_master_items i
    WHERE i.id = clinical_findings.finding_item_id
      AND (i.organization_id IS NULL OR i.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS region_visible ON clinical_findings;
CREATE POLICY region_visible ON clinical_findings AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM visual_regions r
    WHERE r.id = clinical_findings.visual_region_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM visual_regions r
    WHERE r.id = clinical_findings.visual_region_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ));

-- The CE-4 table that grew a pointer at the same place. Nullable — most
-- procedures are nowhere on a chart at all.
DROP POLICY IF EXISTS region_visible ON encounter_procedures;
CREATE POLICY region_visible ON encounter_procedures AS RESTRICTIVE
  USING (visual_region_id IS NULL OR EXISTS (
    SELECT 1 FROM visual_regions r
    WHERE r.id = encounter_procedures.visual_region_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ))
  WITH CHECK (visual_region_id IS NULL OR EXISTS (
    SELECT 1 FROM visual_regions r
    WHERE r.id = encounter_procedures.visual_region_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- THE MAP'S TWO TAXONOMY POINTERS.
--
-- Identical shape and reasoning to `specialty_visible` on
-- `consultation_templates`, including the nullable half: `specialty_id` NULL
-- means the map is offered across the whole care context, and a policy that
-- required a node would make that row unwritable.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS specialty_visible ON visual_maps;
CREATE POLICY specialty_visible ON visual_maps AS RESTRICTIVE
  USING (
    EXISTS (
      SELECT 1 FROM specialties s
      WHERE s.id = visual_maps.care_context_id
        AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
    )
    AND (
      visual_maps.specialty_id IS NULL
      OR EXISTS (
        SELECT 1 FROM specialties s
        WHERE s.id = visual_maps.specialty_id
          AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM specialties s
      WHERE s.id = visual_maps.care_context_id
        AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
    )
    AND (
      visual_maps.specialty_id IS NULL
      OR EXISTS (
        SELECT 1 FROM specialties s
        WHERE s.id = visual_maps.specialty_id
          AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Grants. Ordinary CRUD on all three: a map is edited in place by whoever holds
-- `clinical.visual_map.manage`, and a finding is written and removed while the
-- consultation is a DRAFT. Immutability begins at FINALIZED and the service is
-- what enforces it — the same arrangement the eight CE-4 tables have.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "visual_maps",
  "visual_regions",
  "clinical_findings"
TO rcln_app;
