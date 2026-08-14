-- ===========================================================================
-- CE-1 · 3 of 4 — the treatment journey, and the backfill that makes it NOT NULL.
--
-- ⚠️ THE TABLE, THE COLUMN, THE BACKFILL AND THE `SET NOT NULL` ARE ALL IN THIS
--   ONE MIGRATION, AND SPLITTING THEM IS THE BUG.
--
--   A deploy that lands the nullable column here and defers the NOT NULL to a
--   later migration leaves a window in which the running application's
--   `createAppointment` writes NULL — and the later migration then fails on live
--   data, in production, with no obvious way forward but to invent an episode
--   for every row that slipped through. Postgres does all four in one
--   transaction; there is no reason to give it less.
--
-- ── THREE QUESTIONS, THREE MECHANISMS (CD-13) ───────────────────────────────
--
--   "what visit did this come from?"  -> appointments.parent_appointment_id
--   "what journey is this part of?"   -> appointments.clinical_episode_id
--   "what did the doctor ASK for?"    -> encounter_follow_up_recommendations
--
--   The first already existed. This migration adds the second. The third is
--   migration 4. See .kb/Consultation/FOLLOW_UP_ARCHITECTURE.md.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "ClinicalEpisodeStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "clinical_episodes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "title" VARCHAR(255),
    "primary_specialty_id" UUID,
    "status" "ClinicalEpisodeStatus" NOT NULL DEFAULT 'OPEN',
    "opened_on" DATE NOT NULL,
    "closed_on" DATE,
    "closure_reason" TEXT,
    "notes" TEXT,
    "opened_by" UUID,
    "closed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "clinical_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clinical_episodes_organization_id_patient_id_opened_on_idx" ON "clinical_episodes"("organization_id", "patient_id", "opened_on");

-- CreateIndex
CREATE INDEX "clinical_episodes_organization_id_status_idx" ON "clinical_episodes"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_episodes_organization_id_code_key" ON "clinical_episodes"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_episodes_organization_id_id_key" ON "clinical_episodes"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "clinical_episodes" ADD CONSTRAINT "clinical_episodes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_episodes" ADD CONSTRAINT "clinical_episodes_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_episodes" ADD CONSTRAINT "clinical_episodes_primary_specialty_id_fkey" FOREIGN KEY ("primary_specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_episodes" ADD CONSTRAINT "clinical_episodes_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_episodes" ADD CONSTRAINT "clinical_episodes_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The column, NULLABLE for the length of this transaction only.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "clinical_episode_id" UUID;

-- ---------------------------------------------------------------------------
-- BACKFILL, step 1 — one episode per existing CHAIN ROOT.
--
-- A chain root is an appointment with no parent. Every existing appointment
-- either is one or descends from one, so this plus step 2 reaches every row.
--
-- ⚠️ THE CODE IS DERIVED, NOT ISSUED FROM `number_sequences`. The counter is
--   per (organization, branch, type, period) and issuing thousands of numbers
--   inside a migration would mean either a loop or a lock held for the whole
--   backfill. A historical episode's code is a stable identifier for something
--   that happened before episodes existed, so `EP-<first 8 of the uuid>` is
--   honest about being generated rather than pretending to be part of a
--   sequence a clinic has been reading. Episodes created from CE-1 onwards DO
--   draw from the counter.
--
-- `opened_on` is the root's scheduled date IN THE BRANCH'S TIMEZONE, not UTC.
-- The container runs UTC, so casting the instant directly would file a 09:00 IST
-- visit under the previous calendar day for every clinic in India.
--
-- `title` is deliberately left NULL: nothing here knows what the journey was
-- about, and inventing one would be a clinical claim.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ce1_root_episodes ON COMMIT DROP AS
SELECT
  gen_random_uuid()                                   AS episode_id,
  a.id                                                AS root_appointment_id,
  a.organization_id,
  a.patient_id,
  (a.scheduled_start AT TIME ZONE b.timezone)::date   AS opened_on
FROM appointments a
JOIN branches b
  ON b.organization_id = a.organization_id
 AND b.id              = a.branch_id
WHERE a.parent_appointment_id IS NULL;

INSERT INTO clinical_episodes
  (id, organization_id, patient_id, code, opened_on, status, created_at, updated_at)
SELECT
  r.episode_id,
  r.organization_id,
  r.patient_id,
  'EP-' || upper(substring(r.episode_id::text FROM 1 FOR 8)),
  r.opened_on,
  'OPEN',
  now(),
  now()
FROM ce1_root_episodes r;

-- ---------------------------------------------------------------------------
-- BACKFILL, step 2 — walk `parent_appointment_id` DOWN from every root.
--
-- A recursive CTE rather than a repeated UPDATE, so the whole tree is resolved
-- in one pass however deep a clinic's follow-up chains happen to run.
--
-- ⚠️ NO CYCLE GUARD, AND THAT IS SAFE HERE RATHER THAN OPTIMISTIC. A cycle needs
--   an appointment to become its own ancestor, which requires an UPDATE to
--   `parent_appointment_id` — a column nothing in the codebase ever updates, set
--   once at INSERT by `createFollowUp`. If that ever changes, this CTE is where
--   it will be discovered, loudly.
-- ---------------------------------------------------------------------------
WITH RECURSIVE chain AS (
  SELECT
    r.root_appointment_id AS appointment_id,
    r.organization_id,
    r.episode_id
  FROM ce1_root_episodes r

  UNION ALL

  SELECT
    a.id,
    a.organization_id,
    c.episode_id
  FROM appointments a
  JOIN chain c
    ON a.parent_appointment_id = c.appointment_id
   AND a.organization_id       = c.organization_id
)
UPDATE appointments a
   SET clinical_episode_id = c.episode_id
  FROM chain c
 WHERE a.id = c.appointment_id;

-- ---------------------------------------------------------------------------
-- BACKFILL, step 3 — prove it, then lock it.
--
-- ⚠️ THE ASSERTION IS NOT DECORATION. `SET NOT NULL` scans the table and would
--   fail on its own, but with a constraint-violation message that names a column
--   and not a cause. This raises a sentence a human can act on, and it fails the
--   migration in the same transaction, so nothing is left half-applied.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM appointments WHERE clinical_episode_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'CE-1 backfill left % appointment(s) with no clinical episode', orphans
      USING HINT = 'A chain whose root is missing, or a cycle in parent_appointment_id.';
  END IF;
END
$$;

ALTER TABLE "appointments" ALTER COLUMN "clinical_episode_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Only now the constraint and the index.
--
-- Restrict, not Cascade: deleting a booking must never silently take the journey
-- it belongs to, which outlives any one visit in it.
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_clinical_episode_id_fkey"
  FOREIGN KEY ("organization_id", "clinical_episode_id")
  REFERENCES "clinical_episodes"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- "Show me this whole treatment journey, in order." One indexed equality where
-- walking the chain would be a recursive CTE on every render.
CREATE INDEX "appointments_organization_id_clinical_episode_id_scheduled__idx"
  ON "appointments"("organization_id", "clinical_episode_id", "scheduled_start");

-- ---------------------------------------------------------------------------
-- RLS — ORG-SCOPED, AND DELIBERATELY NOT BRANCH-SCOPED.
--
-- ⚠️ THE SAME CALL `patients` MAKES, FOR THE SAME REASON. A person who starts
--   treatment at the main branch and continues at the satellite has ONE journey.
--   A branch-scoped episode would split it in two and hide the second half from
--   the first branch — and a clinician reading half a treatment history is
--   exactly the failure ADR-0016 exists to prevent.
--
--   The branch boundary that does apply lives on `appointments`, which is in
--   both loops already. An episode is reachable only through a patient the
--   reader can already see.
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_episodes" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "clinical_episodes" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON clinical_episodes;
CREATE POLICY tenant_isolation ON clinical_episodes
  USING      (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- `primary_specialty_id` is a plain FK into a possibly-platform row, so it needs
-- the same restrictive predicate the scope tables got in migration 2.
DROP POLICY IF EXISTS specialty_visible ON clinical_episodes;
CREATE POLICY specialty_visible ON clinical_episodes AS RESTRICTIVE
  USING (
    primary_specialty_id IS NULL OR EXISTS (
      SELECT 1 FROM specialties s
      WHERE s.id = clinical_episodes.primary_specialty_id
        AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
    )
  )
  WITH CHECK (
    primary_specialty_id IS NULL OR EXISTS (
      SELECT 1 FROM specialties s
      WHERE s.id = clinical_episodes.primary_specialty_id
        AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "clinical_episodes" TO rcln_app;
