-- Keep the previous version of a reading when it is corrected.
--
-- ⚠️ THE VALUES LIVE HERE AND NOT IN `audit_logs`, AND THAT IS THE WHOLE POINT.
--   A medical record has to be able to answer "who changed this blood pressure
--   from 180 to 120, and when" years later — but `audit_logs` is read through
--   `audit.record.read`, a compliance code held by people with no clinical
--   access at all, so a measurement in that table is a disclosure with a
--   timestamp. Putting the prior version on `appointment_vitals` itself means it
--   inherits the RLS policy, the branch scoping and the composite FKs that
--   already protect the reading, and it is read behind `clinical.vitals.record`
--   by an endpoint that writes a `data_access_logs` row like every other read of
--   clinical content.
--
-- ⚠️ A ROW WITH `revision_of_id` SET IS NOT AN OBSERVATION. It never appears on a
--   chart and never counts towards a trend. Every query that renders readings
--   filters `revision_of_id IS NULL`; one that forgets will count a measurement
--   once per time somebody fixed a typo in it.
--
-- No RLS change is needed: the policy on `appointment_vitals` is row-level and
-- column-agnostic, and these rows carry the same `organization_id` and
-- `branch_id` as the reading they are a version of.
ALTER TABLE "appointment_vitals"
  ADD COLUMN "revision_of_id" UUID,
  ADD COLUMN "superseded_at"  TIMESTAMPTZ(6),
  ADD COLUMN "superseded_by"  UUID;

-- Composite, so a version cannot point at a reading in another tenant (ADR-0004).
ALTER TABLE "appointment_vitals"
  ADD CONSTRAINT "appointment_vitals_revision_of_fkey"
  FOREIGN KEY ("organization_id", "revision_of_id")
  REFERENCES "appointment_vitals" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Who amended it. SetNull: the nurse may leave; the version stays.
ALTER TABLE "appointment_vitals"
  ADD CONSTRAINT "appointment_vitals_superseded_by_fkey"
  FOREIGN KEY ("superseded_by") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One reading's earlier versions, oldest first.
CREATE INDEX "appointment_vitals_organization_id_revision_of_id_supersed_idx"
  ON "appointment_vitals" ("organization_id", "revision_of_id", "superseded_at");
