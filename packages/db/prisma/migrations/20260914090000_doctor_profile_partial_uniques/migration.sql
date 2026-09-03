-- Two unique indexes on `doctor_profiles` refused rows they were never meant to
-- refuse, and both surfaced as a bare P2002 — "A record with this value already
-- exists", naming no column at all.
--
-- 1. (organization_id, registration_number) NULLS NOT DISTINCT
--
--    The column is nullable precisely because "a profile can be created before
--    the council number is to hand" — the doctors migration says so in as many
--    words, immediately above the index that made it impossible. NULLS NOT
--    DISTINCT means two NULLs COLLIDE, so a clinic could hold exactly ONE
--    doctor awaiting a council number; the second was refused on (org, NULL).
--    That pass applied NULLS NOT DISTINCT across every nullable unique in the
--    migration, which is right for `qualifications.code` and for
--    `doctor_qualifications.institute` ("MD, institute unknown" must not be
--    recordable twice) and wrong here: a NULL council number is "not known
--    yet", not a value two doctors share.
--
-- 2. (organization_id, user_id)
--
--    `archiveDoctor` soft-deletes — status ARCHIVED, `deleted_at` stamped — and
--    the create path's own pre-check reads `deleted_at IS NULL`. So
--    re-registering someone who had been archived passed the friendly check
--    ("That person already has a doctor profile") and then died on the index
--    one statement later. A doctor who left and came back was unrecordable.
--
-- Both become PARTIAL, which is what each was already trying to say. The
-- guarantees that matter are unchanged: two doctors in one clinic still cannot
-- share a council number, and one person still cannot hold two LIVE profiles at
-- one clinic while remaining free to consult at another (that is `user_id`
-- being unique PER ORGANIZATION, which the doctors suite pins).
--
-- ⚠️ PRISMA CANNOT EXPRESS A `WHERE` CLAUSE ON AN INDEX, so these are renamed
--   off Prisma's generated names and their `@@unique` attributes are dropped
--   from the model — otherwise the next `migrate dev` would diff the model
--   against the database and silently recreate the total indexes, reinstating
--   both bugs. `doctor_specialties_one_primary`, in the same table's migration,
--   is the existing precedent for a SQL-only unique index. The model carries a
--   note pointing here.

DROP INDEX "doctor_profiles_organization_id_registration_number_key";

CREATE UNIQUE INDEX "doctor_profiles_council_number_unique"
  ON "doctor_profiles" ("organization_id", "registration_number")
  WHERE "registration_number" IS NOT NULL AND "deleted_at" IS NULL;

DROP INDEX "doctor_profiles_organization_id_user_id_key";

CREATE UNIQUE INDEX "doctor_profiles_live_user_unique"
  ON "doctor_profiles" ("organization_id", "user_id")
  WHERE "deleted_at" IS NULL;
