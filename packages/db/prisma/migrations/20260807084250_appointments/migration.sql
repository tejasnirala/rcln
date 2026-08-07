-- CreateEnum
CREATE TYPE "AppointmentVisitType" AS ENUM ('NEW', 'FOLLOW_UP', 'WALK_IN', 'TELECONSULT', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('FRONT_DESK', 'ONLINE', 'PHONE', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- ⚠️ `DROP INDEX "patients_phone_trgm_idx"` WAS GENERATED HERE AND DELETED.
--   Prisma Migrate diffs the schema against the database and does not know
--   about hand-written indexes, so every future migration will offer to drop
--   that one again — it is a GIN trigram index on a plain column, which the
--   introspector can see but the schema file cannot declare. (The sibling
--   `patients_name_trgm_idx` is an EXPRESSION index, which Prisma cannot see at
--   all, so it is never proposed for dropping — the inconsistency is Prisma's,
--   not ours.) Letting it through turns every phone search into a sequential
--   scan whose cost grows with the PLATFORM, because RLS filters after the
--   scan. Delete the line, every time.

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "patient_registration_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "appointment_number" VARCHAR(32) NOT NULL,
    "scheduled_start" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(6) NOT NULL,
    "visit_type" "AppointmentVisitType" NOT NULL DEFAULT 'NEW',
    "source" "AppointmentSource" NOT NULL DEFAULT 'FRONT_DESK',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "reason" TEXT,
    "checked_in_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "booked_by" UUID,
    "cancelled_by" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_status_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "from_status" "AppointmentStatus",
    "to_status" "AppointmentStatus" NOT NULL,
    "changed_by" UUID,
    "note" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_organization_id_branch_id_scheduled_start_idx" ON "appointments"("organization_id", "branch_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "appointments_organization_id_doctor_profile_id_scheduled_st_idx" ON "appointments"("organization_id", "doctor_profile_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "appointments_organization_id_patient_id_scheduled_start_idx" ON "appointments"("organization_id", "patient_id", "scheduled_start");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_organization_id_branch_id_appointment_number_key" ON "appointments"("organization_id", "branch_id", "appointment_number");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_organization_id_id_key" ON "appointments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "appointment_status_history_organization_id_appointment_id_c_idx" ON "appointment_status_history"("organization_id", "appointment_id", "changed_at");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_patient_registration_id_fkey" FOREIGN KEY ("organization_id", "patient_registration_id") REFERENCES "patient_registrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_doctor_profile_id_fkey" FOREIGN KEY ("organization_id", "doctor_profile_id") REFERENCES "doctor_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_fkey" FOREIGN KEY ("booked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Everything below is hand-written. Prisma Migrate cannot express any of it,
-- and it is the half that makes double-booking impossible rather than unlikely.
--
-- ⚠️ Nothing here is re-derivable from schema.prisma. A later `migrate dev` that
-- proposes DROP CONSTRAINT / DROP INDEX naming anything below is proposing to
-- delete it — see the note at the top of this file.
-- =============================================================================

-- --- Extensions ---------------------------------------------------------------
-- ⚠️ HERE, not only in the doctors migration and not only in the init script.
--   Extensions are PER-DATABASE, and `prisma migrate dev` replays every
--   migration into a FRESH SHADOW DATABASE. The doctors migration already
--   creates it, so this is belt and braces — but the EXCLUDE below is the thing
--   that fails, with `data type uuid has no default operator class for access
--   method "gist"`, if it is ever reordered away.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- --- CHECK constraints --------------------------------------------------------
ALTER TABLE "appointments"
  -- A zero-length or inverted slot produces an empty tstzrange, and an empty
  -- range overlaps NOTHING — so the EXCLUDE constraint below would silently
  -- stop protecting exactly the row that got it wrong.
  ADD CONSTRAINT "appointments_end_after_start"
    CHECK ("scheduled_end" > "scheduled_start"),
  -- The two terminal states each need their own evidence. A cancellation with
  -- nobody's name on it is the row a clinic cannot explain to the patient who
  -- turned up anyway.
  ADD CONSTRAINT "appointments_cancelled_has_canceller"
    CHECK ("status" <> 'CANCELLED' OR "cancelled_by" IS NOT NULL),
  -- Timestamps follow status, not the other way round: a CHECKED_IN row with no
  -- `checked_in_at` makes every waiting-time report silently wrong.
  ADD CONSTRAINT "appointments_checked_in_has_time"
    CHECK ("status" NOT IN ('CHECKED_IN', 'IN_PROGRESS', 'COMPLETED')
           OR "checked_in_at" IS NOT NULL),
  ADD CONSTRAINT "appointments_completed_has_time"
    CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL);

-- --- No double-booking --------------------------------------------------------
-- The one constraint this table exists to carry.
--
-- Two receptionists clicking the same 10:20 within the same millisecond both
-- read the slot as free — an availability check cannot win that race, because
-- under READ COMMITTED neither transaction can see the other's uncommitted
-- insert. The service checks first anyway, so the ordinary case gets a sentence
-- instead of a constraint name; this is what makes the extraordinary case
-- impossible rather than rare.
--
-- `organization_id` leads the key even though `doctor_profile_id` is already
-- unique across tenants: it keeps the index prefix aligned with every other
-- access path on this table, and it means the constraint cannot be defeated by
-- a cross-tenant doctor id that composite FKs already make unrepresentable.
--
-- ⚠️ THE PREDICATE IS THE SEMANTICS. CANCELLED and NO_SHOW are excluded, which
--   is what makes cancelling free the slot — with no UPDATE anywhere to
--   remember to write. Adding a status to the enum without deciding which side
--   of this WHERE it belongs on is how a released slot stays blocked forever.
--
--   Deliberately NOT partial on `deleted_at`: a soft-deleted row still reading
--   as BOOKED is a bug, and keeping its slot held is the safer failure.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_doctor_overlap"
  EXCLUDE USING gist (
    "organization_id"   WITH =,
    "doctor_profile_id" WITH =,
    tstzrange("scheduled_start", "scheduled_end", '[)') WITH &&
  ) WHERE ("status" NOT IN ('CANCELLED', 'NO_SHOW'));

-- --- The status trail is append-only ------------------------------------------
-- Same two independent layers as `audit_logs` and `data_access_logs`: a rule
-- that refuses UPDATE and DELETE for everyone including the owner, and the
-- grants that never hand rcln_app either privilege. A trail that can be edited
-- is not evidence of anything.
CREATE RULE "appointment_status_history_no_update" AS
  ON UPDATE TO "appointment_status_history" DO INSTEAD NOTHING;
CREATE RULE "appointment_status_history_no_delete" AS
  ON DELETE TO "appointment_status_history" DO INSTEAD NOTHING;

-- =============================================================================
-- Row-Level Security — copied from packages/db/prisma/rls/enable-rls.sql.
--
-- ⚠️ MORE PHI. An appointment names a patient, a doctor and a reason, and the
-- three together disclose more than any one of them: "cardiology, Tuesday" is a
-- diagnosis with extra steps. A missing policy raises no error, breaks no
-- single-tenant test, and starts returning other clinics' bookings.
--
-- ⚠️ `appointments` IS BRANCH-SCOPED AS WELL AS ORG-SCOPED — the OPPOSITE call
--   from `patients` and the same one as `patient_registrations`. Identity
--   follows the person across a hospital group; ATTENDANCE belongs to the
--   clinic it happened at, and a booking is attendance. See ADR-0016.
-- =============================================================================

DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'appointments',
    'appointment_status_history'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- branch_id is NOT NULL here, so the policy is absolute. The `IS NULL OR` limb
-- is dead code and kept anyway, so this is character-for-character the policy
-- the shared `branch_scoped` loop in enable-rls.sql writes. Two spellings of one
-- policy is how the file that is supposed to be the source of truth stops being
-- it.
DROP POLICY IF EXISTS branch_isolation ON appointments;
CREATE POLICY branch_isolation ON appointments AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));

-- The status trail carries no branch_id, deliberately. This EXISTS is itself
-- subject to the parent's RLS — including the RESTRICTIVE branch_isolation
-- above — so the branch boundary composes instead of being restated here and
-- drifting from it later.
DROP POLICY IF EXISTS parent_isolation ON appointment_status_history;
CREATE POLICY parent_isolation ON appointment_status_history
  USING      (EXISTS (SELECT 1 FROM appointments p
                      WHERE p.id = appointment_status_history.appointment_id
                        AND p.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM appointments p
                      WHERE p.id = appointment_status_history.appointment_id
                        AND p.organization_id = app_current_org()));
