-- ---------------------------------------------------------------------------
-- PI-12 — three new enum members, in their own migration.
--
-- ⚠️ SPLIT FROM THE TABLE CHANGES FOR THE REASON PI-10's `..090500` AND PI-11's
--   `..090000` WERE SPLIT, and this time the split is not precautionary: the
--   companion migration REWRITES `dispenses_prescription_has_patient` to name
--   `'ONLINE'`, and Postgres refuses to USE a new enum value in the transaction
--   that added it. Prisma runs each migration inside one transaction, so the two
--   statements in one file would abort with `unsafe use of new value of enum
--   type DispenseKind` — a failure that is invisible until it runs, because the
--   SQL parses and `prisma validate` is happy.
--
-- ⚠️ NONE OF THE THREE ENABLES ANYTHING BY ITSELF. A `DispenseKind` nothing
--   writes, a counter nothing issues from and a data-access resource nothing
--   logs are all inert until the companion migration and the services land.
-- ---------------------------------------------------------------------------

-- Reading an order to be DELIVERED to a named person's home.
--
-- ⚠️ ITS OWN RESOURCE RATHER THAN `PRESCRIPTION`, AND THE REASON IS AN ADDRESS.
--   Every other member of this enum discloses what a clinic knows about
--   somebody's health; this one additionally discloses WHERE THEY LIVE, beside
--   the medicines being sent there. A disclosure review has to be able to see
--   those reads on their own.
ALTER TYPE "DataAccessResource" ADD VALUE 'ONLINE_ORDER';

-- The third supply channel.
--
-- ⚠️ IT RESTATES WHAT THE COLUMN ALWAYS WAS. `PRESCRIPTION` and `COUNTER_SALE`
--   are a COUNTER's two ways of supplying; whether a prescription was presented
--   has always been answered by `encounter_id` being NULL or not. An ONLINE
--   supply may be prescription-backed or not, which is why the rewritten CHECK
--   in the companion migration ties it to a PATIENT and not to an encounter.
ALTER TYPE "DispenseKind" ADD VALUE 'ONLINE';

-- The order counter. Per BRANCH, never resets, issued at CONFIRM and not at
-- create — the shape and the rule every procurement counter follows, because the
-- number goes on a delivery note somebody outside the clinic reads.
ALTER TYPE "NumberSequenceType" ADD VALUE 'ONLINE_ORDER';
