-- ---------------------------------------------------------------------------
-- The reservation sweep's one cross-tenant question. The twin of
-- `inventory_branches_with_expired_stock`, and the third function of this shape
-- in the repository after `billing_due_subscriptions`.
--
-- THE PROBLEM, IN ONE SENTENCE
--   A sweep has, by definition, no tenant: it asks which branches ANYWHERE on
--   the platform are holding stock for somebody who never came for it. Every
--   table it would read is RLS-enforced and `rcln_app` has NOBYPASSRLS, so the
--   query matches nothing and the sweep silently never runs. Silently is the
--   operative word — no error, no empty-result warning, just reservations that
--   never expire and a clinic that cannot dispense a medicine it can see.
--
-- WHY THIS SHAPE, AND NOT THE ALTERNATIVES
--   · Widening a policy would open `stock_reservations` to every reader for
--     ever, to serve one background job.
--   · Handing the worker an owner connection would give a queue consumer
--     BYPASSRLS on the whole database, which `assertRlsActive()` exists to make
--     impossible by accident.
--   So: a function returning THREE COLUMNS for only the branches actually due,
--   taking no argument that widens it, and unable to be asked anything else.
--
-- ⚠️ `expires_at` IS A `timestamptz`, SO THERE IS NO `AT TIME ZONE` HERE AND ITS
--   ABSENCE IS NOT AN OVERSIGHT. The expiry sweep's function joins `branches`
--   for the timezone because a LOT expires on a calendar DAY, which is a
--   different instant at every clinic. A RESERVATION expires at an INSTANT
--   somebody chose, and an instant is the same instant everywhere — `<= now()`
--   is correct in every timezone. Invariant 6 is satisfied by the column's type.
--
-- ⚠️ `owner_user_id` IS WHY THIS RETURNS AN ACTOR AT ALL. Releasing a
--   reservation writes a `RELEASE` movement, and `stock_ledger.actor_user_id` is
--   NOT NULL on purpose: a movement nobody can be asked about is a movement that
--   ends an audit. An organization with no owner is SKIPPED rather than swept
--   under an invented system id — the same decision the expiry sweep and
--   `InvoicePdfJob.requestedBy` both made.
--
-- ⚠️ `row_limit` IS A CAP, NOT A FILTER. More due branches than the cap means
--   the rest arrive on the NEXT TICK. The sweep is idempotent and the clock runs
--   hourly, so nothing is lost; what must not happen is a caller assuming one
--   call drained it.
--
-- `search_path` is pinned: without it, anyone able to create objects could
-- shadow `stock_reservations` and have the owner read their table instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_branches_with_due_reservations(
  row_limit int DEFAULT 200
)
RETURNS TABLE (branch_id uuid, organization_id uuid, actor_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT DISTINCT
         r."branch_id",
         r."organization_id",
         o."owner_user_id" AS actor_user_id
    FROM "stock_reservations" r
    JOIN "branches"      b ON b."id" = r."branch_id"
    JOIN "organizations" o ON o."id" = r."organization_id"
   WHERE r."status"     = 'ACTIVE'
     AND r."expires_at" <= now()
     AND b."status"     = 'ACTIVE'
     AND b."deleted_at" IS NULL
     AND o."status"     = 'ACTIVE'
     AND o."deleted_at" IS NULL
     AND o."owner_user_id" IS NOT NULL
   ORDER BY r."branch_id"
   LIMIT row_limit
$fn$;

-- ⚠️ `REVOKE ... FROM PUBLIC` DOES NOT REMOVE A ROLE-SPECIFIC GRANT, AND THIS
--   REPOSITORY HAS AN `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
--   TO rcln_app` THAT HANDS OUT ONE AUTOMATICALLY. That was a CRITICAL in the
--   PI-2 review: two SECURITY DEFINER functions read as private and were not.
--   Here `rcln_app` is MEANT to execute it — the worker connects as that role —
--   so the grant is stated deliberately rather than inherited by accident, and
--   the function takes no argument that could widen what it returns.
REVOKE ALL   ON FUNCTION inventory_branches_with_due_reservations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_branches_with_due_reservations(int) TO rcln_app;
