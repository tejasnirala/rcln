-- ---------------------------------------------------------------------------
-- PI-11 — make the weight/date constraint symmetric.
--
-- ⚠️ `..090500` GUARDED ONE DIRECTION AND THE WRONG ONE WAS LEFT OPEN. It wrote
--
--     CHECK (weight_recorded_on IS NULL OR weight_kg IS NOT NULL)
--
--   which refuses a DATE with no weight — a row that says nothing — and happily
--   accepts a WEIGHT with no date, which is the state the whole feature exists to
--   prevent. A weight nobody can date is a weight a dose gets calculated from
--   without anybody being able to see that it was taken eight months ago.
--
--   The contract has refused both directions since it was written, and
--   `animalProfileData` maps the pair to NULL together — so the gap was only ever
--   reachable by a fixture, a backfill or a second service, which is precisely
--   the set of writers a CHECK exists to catch. The tenant-isolation suite found
--   it: `refuses a weight with no day it was taken` resolved instead of
--   rejecting.
--
-- ⚠️ THE OLD CONSTRAINT IS DROPPED AND REPLACED RATHER THAN ADDED TO. Two
--   overlapping CHECKs on one pair of columns is two places to read before
--   knowing what the pair may hold, and the error message would name whichever
--   fired first.
--
-- ⚠️ AND `..090500` IS NOT EDITED. Prisma checksums an applied migration; the
--   correction is a migration of its own, which is also the honest record —
--   somebody reading this directory should be able to see that the first version
--   was wrong.
--
-- No backfill and no data risk: `animal_profiles` had never been written to
-- before this phase, so there is no row on the platform in the state now
-- forbidden.
-- ---------------------------------------------------------------------------

ALTER TABLE "animal_profiles"
  DROP CONSTRAINT "animal_profiles_weight_date_needs_weight";

-- One answer, both halves or neither.
ALTER TABLE "animal_profiles"
  ADD CONSTRAINT "animal_profiles_weight_and_date_together"
  CHECK (("weight_kg" IS NULL) = ("weight_recorded_on" IS NULL));
