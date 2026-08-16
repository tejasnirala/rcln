-- ===========================================================================
-- CE-1 · 4 of 4 — what the doctor ASKED the patient to do.
--
-- ⚠️ A RECOMMENDATION IS NOT AN APPOINTMENT, AND THAT SPLIT IS THE POINT (CD-13).
--
--   "Come back after 15 days" has nowhere to live today. The only way to express
--   it is to BOOK — which asserts a slot the patient never agreed to, burns a
--   number from a branch counter the clinic reads as a sequence, and puts a
--   booking on the day board nobody is expecting.
--
--   And the split is what makes a RECALL LIST possible at all. "Who was told to
--   come back and hasn't?" is unanswerable if a recommendation and a booking are
--   the same row, because an unbooked recommendation would simply not exist.
--
-- ⚠️ `encounter_id` IS NULLABLE ONLY UNTIL CE-3. `encounters` does not exist
--   yet. The migration that creates it adds the foreign key and makes this
--   column NOT NULL in the same transaction. Nothing writes to this table before
--   CE-4, so the window is a documentation state and not a data state.
--
-- ⚠️ PHI: `reason`, `notes` and `cancelled_reason` are clinical free text. All
--   three belong in REDACTED_KEYS and none of them ever reaches an audit row.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "FollowUpIntervalUnit" AS ENUM ('DAYS', 'WEEKS', 'MONTHS');

-- CreateEnum
CREATE TYPE "FollowUpType" AS ENUM ('ROUTINE', 'PROCEDURE_REVIEW', 'LAB_REVIEW', 'POST_OPERATIVE', 'OTHER');

-- CreateTable
CREATE TABLE "encounter_follow_up_recommendations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "interval_value" SMALLINT,
    "interval_unit" "FollowUpIntervalUnit",
    "recommended_date" DATE,
    "follow_up_type" "FollowUpType" NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT,
    "notes" TEXT,
    "fulfilled_by_appointment_id" UUID,
    "fulfilled_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancelled_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "encounter_follow_up_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_follow_up_recommendations_organization_id_patient_idx" ON "encounter_follow_up_recommendations"("organization_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "encounter_follow_up_recommendations_organization_id_branch__idx" ON "encounter_follow_up_recommendations"("organization_id", "branch_id", "recommended_date");

-- AddForeignKey
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_organization_id_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_organization_id_patien_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_organization_id_appoin_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- ⚠️ RESTRICT, not Cascade. Deleting the booking that FULFILLED a recommendation
--   must not take the clinical advice with it: the advice was given, and the
--   booking is only what happened next.
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_organization_id_fulfil_fkey" FOREIGN KEY ("organization_id", "fulfilled_by_appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "encounter_follow_up_recommendations" ADD CONSTRAINT "encounter_follow_up_recommendations_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- EXACTLY ONE WAY OF SAYING WHEN.
--
-- "In 15 days" and "on 4 September" are both legitimate ways for a doctor to put
-- it, and both must be storable — but storing BOTH invites them to disagree, and
-- the recall list would then have to pick a winner, silently, forever.
--
-- ⚠️ AND `is_required = false` CARRIES NEITHER. "No follow-up needed" is a real
--   clinical decision worth recording, not an absence — a screen that only wrote
--   a row when a follow-up WAS needed could not tell "the doctor decided against
--   one" from "the doctor forgot". So the constraint has three legs, not two.
--
-- ⚠️ `interval_unit` AND `interval_value` TRAVEL TOGETHER. A value with no unit
--   is 15 of nothing, and a unit with no value is days of nothing. Both are the
--   sort of half-written row a form can produce on a mis-click.
-- ---------------------------------------------------------------------------
ALTER TABLE "encounter_follow_up_recommendations"
  ADD CONSTRAINT "follow_up_recommendation_when_is_stated" CHECK (
    (
      -- No follow-up needed: no timing at all.
      "is_required" = false
      AND "interval_value" IS NULL
      AND "interval_unit"  IS NULL
      AND "recommended_date" IS NULL
    ) OR (
      -- An interval.
      "is_required" = true
      AND "interval_value" IS NOT NULL
      AND "interval_unit"  IS NOT NULL
      AND "recommended_date" IS NULL
      AND "interval_value" > 0
    ) OR (
      -- Or a date. Never both.
      "is_required" = true
      AND "recommended_date" IS NOT NULL
      AND "interval_value" IS NULL
      AND "interval_unit"  IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Fulfilment and cancellation each need their timestamp, and they are mutually
-- exclusive: a recommendation the patient declined cannot also have been booked.
-- Same reasoning as `stock_reservations`' released-at pairing — a terminal state
-- with no time is one nobody can put on a timeline.
-- ---------------------------------------------------------------------------
ALTER TABLE "encounter_follow_up_recommendations"
  ADD CONSTRAINT "follow_up_recommendation_outcome_is_coherent" CHECK (
    ("fulfilled_by_appointment_id" IS NULL) = ("fulfilled_at" IS NULL)
    AND ("cancelled_at" IS NULL OR "fulfilled_at" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- ONE APPOINTMENT FULFILS AT MOST ONE RECOMMENDATION.
--
-- Prisma cannot express a partial unique index. Without this, a booking could be
-- posted against two recommendations and both would report themselves satisfied
-- by the same visit — and re-posting the same booking would not be idempotent,
-- which is what a retried request does.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "follow_up_recommendation_one_fulfilment"
  ON "encounter_follow_up_recommendations" ("organization_id", "fulfilled_by_appointment_id")
  WHERE "fulfilled_by_appointment_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- THE RECALL LIST.
--
-- "Who was told to come back and hasn't?" — outstanding only, soonest first.
-- The predicate is the whole point: without it this query scans every
-- recommendation the clinic has ever made, and the overwhelming majority of them
-- are settled.
-- ---------------------------------------------------------------------------
CREATE INDEX "follow_up_recommendation_outstanding_idx"
  ON "encounter_follow_up_recommendations" ("organization_id", "branch_id", "recommended_date")
  WHERE "fulfilled_by_appointment_id" IS NULL
    AND "cancelled_at" IS NULL
    AND "deleted_at"   IS NULL
    AND "is_required"  = true;

-- ---------------------------------------------------------------------------
-- RLS — org AND branch scoped, both NOT NULL.
--
-- ⚠️ IT CARRIES ITS OWN `branch_id` RATHER THAN INHERITING THROUGH THE
--   APPOINTMENT. This is the call the invoice children made and the one
--   `appointment_status_history` did not: a child of a branch-scoped parent that
--   inherits only the ORG half re-opens the branch boundary, and this row's
--   `reason` is clinical free text about a named person. The composite FK to
--   `appointments(organization_id, id)` stops the two disagreeing.
-- ---------------------------------------------------------------------------
ALTER TABLE "encounter_follow_up_recommendations" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "encounter_follow_up_recommendations" NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON encounter_follow_up_recommendations;
CREATE POLICY tenant_isolation ON encounter_follow_up_recommendations
  USING      (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- RESTRICTIVE, so it ANDs with the org predicate above. An empty branch scope
-- matches nothing, which is the fail-closed direction.
DROP POLICY IF EXISTS branch_isolation ON encounter_follow_up_recommendations;
CREATE POLICY branch_isolation ON encounter_follow_up_recommendations AS RESTRICTIVE
  USING      (branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id = ANY (app_branch_scope()));

GRANT SELECT, INSERT, UPDATE, DELETE ON "encounter_follow_up_recommendations" TO rcln_app;
