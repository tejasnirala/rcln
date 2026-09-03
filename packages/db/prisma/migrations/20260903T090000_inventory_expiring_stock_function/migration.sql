-- ---------------------------------------------------------------------------
-- The expiry ALERT's one cross-tenant question (PI-24).
--
-- The twin of `inventory_branches_with_expired_stock`, asking the opposite
-- question: not "what has expired" but "what is ABOUT to", which is the only
-- window in which anybody can still act — use it first, move it to a busier
-- branch, return it to the supplier.
--
-- ⚠️ IT IS A FUNCTION FOR THE SAME REASON ITS TWIN IS, AND SKIPPING THAT WOULD
--   FAIL SILENTLY. `rcln_app` has NOBYPASSRLS, so a plain cross-tenant SELECT
--   from the worker matches zero rows and the alert simply never fires — no
--   error, no log, nothing to notice. That is precisely what happened to the
--   billing scheduler before `billing_due_subscriptions` existed.
--
-- ⚠️ `owner_user_id` FOR THE SAME REASON TOO. The notification job carries an
--   actor because the consumer opens a tenant context with it, and
--   `app.current_user` is what the audit triggers read. An organization with no
--   owner is skipped rather than attributed to a fiction.
--
-- ⚠️ `AT TIME ZONE b.timezone`, NOT `CURRENT_DATE`. Invariant 6. The window is
--   the branch's own days: a lot expiring on the 31st is good THROUGH the 31st
--   where the clinic is, and comparing against the container's UTC day alerts an
--   Auckland clinic a day early.
--
-- ⚠️ STRICTLY AFTER TODAY. Already-expired stock belongs to the SWEEP, which
--   moves it out of the dispensable pool. Counting it here would mail a branch
--   about stock it can no longer do anything with, and the number would climb
--   while they did everything right.
--
-- `search_path` is pinned: without it, anyone able to create objects could
-- shadow `batches` and have the owner read their table instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_branches_with_expiring_stock(
  within_days int DEFAULT 30,
  row_limit   int DEFAULT 200
)
RETURNS TABLE (branch_id uuid, organization_id uuid, actor_user_id uuid, batch_count int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT sb."branch_id",
         sb."organization_id",
         o."owner_user_id"                  AS actor_user_id,
         COUNT(DISTINCT sb."batch_id")::int AS batch_count
    FROM "stock_balances" sb
    JOIN "batches"       bt ON bt."id" = sb."batch_id"
    JOIN "branches"       b ON b."id"  = sb."branch_id"
    JOIN "organizations"  o ON o."id"  = sb."organization_id"
   WHERE sb."status"     = 'AVAILABLE'
     AND sb."quantity"   > 0
     AND bt."expires_on" IS NOT NULL
     AND bt."expires_on" >  (now() AT TIME ZONE b."timezone")::date
     AND bt."expires_on" <= (now() AT TIME ZONE b."timezone")::date
                            + make_interval(days => within_days)
     AND b."status"      = 'ACTIVE'
     AND b."deleted_at"  IS NULL
     AND o."status"      = 'ACTIVE'
     AND o."deleted_at"  IS NULL
     AND o."owner_user_id" IS NOT NULL
   GROUP BY sb."branch_id", sb."organization_id", o."owner_user_id"
   ORDER BY sb."branch_id"
   LIMIT row_limit
$fn$;

REVOKE ALL   ON FUNCTION inventory_branches_with_expiring_stock(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_branches_with_expiring_stock(int, int) TO rcln_app;
