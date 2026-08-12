-- ---------------------------------------------------------------------------
-- The expiry sweep's one cross-tenant question.
--
-- THE PROBLEM
--   The nightly sweep has, by definition, no tenant: it has to ask which
--   branches anywhere on the platform are holding stock that has expired. Every
--   table it would read is RLS-enforced and `rcln_app` has NOBYPASSRLS, so the
--   query matches nothing and the sweep silently never runs — which is exactly
--   what happened to the billing scheduler before
--   `billing_due_subscriptions` was written, and this is that function's twin.
--
-- WHY A SECURITY DEFINER FUNCTION AND NOT THE ALTERNATIVES
--   · Widening a policy would open `stock_balances` to every reader for ever, to
--     serve one background job.
--   · Handing the worker an owner connection would give a queue consumer
--     BYPASSRLS on the whole database, and `assertRlsActive()` exists precisely
--     to stop that being possible by accident.
--   So: a function that returns THREE COLUMNS for only the branches that are
--     actually due, takes no argument that widens it, and cannot be asked
--     anything else. `rcln_app` keeps NOBYPASSRLS.
--
-- ⚠️ `row_limit` IS A CAP, NOT A FILTER, AND ONE CALL DOES NOT DRAIN THE QUEUE.
--   A platform with more due branches than the cap gets the rest on the NEXT
--   TICK — the processor deliberately does not loop within a tick, because the
--   sweep is idempotent and the clock runs hourly, so nothing is lost and no
--   single job runs unboundedly long. What must not happen is a caller ASSUMING
--   one call drained it and reporting the sweep as finished.
--
-- ⚠️ `owner_user_id` IS WHY THE FUNCTION EXISTS RATHER THAN A PLAIN LIST OF
--   BRANCHES. `stock_ledger.actor_user_id` is NOT NULL on purpose — a movement
--   nobody can be asked about is a movement that ends an audit — so the sweep
--   needs a REAL user to attribute its work to, and an organization with no
--   owner is skipped rather than attributed to a fiction. This is the same
--   decision `InvoicePdfJob.requestedBy` forced, made the same way.
--
-- ⚠️ `AT TIME ZONE b.timezone`, NOT `CURRENT_DATE`. Invariant 6. A lot dated the
--   31st is good THROUGH the 31st at the clinic; comparing against the
--   container's UTC day expires an Auckland clinic's stock thirteen hours early.
--   Strictly `<`, for the same reason.
--
-- `search_path` is pinned: without it, anyone able to create objects could
-- shadow `batches` and have the owner read their table instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_branches_with_expired_stock(
  row_limit int DEFAULT 200
)
RETURNS TABLE (branch_id uuid, organization_id uuid, actor_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT DISTINCT
         sb."branch_id",
         sb."organization_id",
         o."owner_user_id" AS actor_user_id
    FROM "stock_balances" sb
    JOIN "batches"       bt ON bt."id" = sb."batch_id"
    JOIN "branches"       b ON b."id"  = sb."branch_id"
    JOIN "organizations"  o ON o."id"  = sb."organization_id"
   WHERE sb."status"     = 'AVAILABLE'
     AND sb."quantity"   > 0
     AND bt."expires_on" IS NOT NULL
     AND bt."expires_on" < (now() AT TIME ZONE b."timezone")::date
     AND b."status"      = 'ACTIVE'
     AND b."deleted_at"  IS NULL
     AND o."status"      = 'ACTIVE'
     AND o."deleted_at"  IS NULL
     -- An organization with no owner has nobody to attribute the movements to.
     -- Skipped rather than swept under an invented actor.
     AND o."owner_user_id" IS NOT NULL
   ORDER BY sb."branch_id"
   LIMIT row_limit
$fn$;

REVOKE ALL   ON FUNCTION inventory_branches_with_expired_stock(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_branches_with_expired_stock(int) TO rcln_app;
