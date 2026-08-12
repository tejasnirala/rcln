-- ===========================================================================
-- Fixes from the PI-2 security review. One CRITICAL, one MEDIUM, one LOW.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- ⚠️ CRITICAL. `REVOKE ALL ON FUNCTION ... FROM PUBLIC` DID NOT REVOKE IT FROM
--   `rcln_app`, AND THE WHOLE POINT OF THE BALANCE DESIGN DEPENDED ON IT DOING SO.
--
--   `infra/postgres/init/01-roles-and-extensions.sql` carries
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
--       GRANT EXECUTE ON FUNCTIONS TO rcln_app;
--
--   so every function a migration creates is granted to the application role AT
--   CREATION, as a role-specific grant. Revoking from PUBLIC removes a different
--   grant and leaves that one standing. Measured, not reasoned about:
--
--     SELECT has_function_privilege('rcln_app','stock_balances_apply_delta(...)','EXECUTE')
--     -> true
--
--   and calling it as `rcln_app` with no tenant context at all reached the
--   INSERT, failing only on a foreign key.
--
--   WHY THAT IS CRITICAL AND NOT MERELY UNTIDY. `stock_balances_apply_delta` is
--   SECURITY DEFINER, so it runs as the owner and bypasses RLS on
--   `stock_balances` — and it takes the organization, branch, location, status
--   and delta AS ARGUMENTS. The request-path role therefore held an arbitrary
--   cross-tenant write into the balance cache: `p_delta` on the UPDATE arm can
--   restate any clinic's quantity to anything, which is the one number the
--   append-only ledger exists to make unforgeable. The `REVOKE INSERT, UPDATE,
--   DELETE ON stock_balances` in the inventory_foundation migration was
--   nullified by the function it was written to make safe, and that migration's
--   own comment — "Neither function is callable by the application" — was false
--   as deployed.
--
--   Both functions are named explicitly. `stock_balances_apply` is the trigger
--   function: it reads only NEW and so is far less dangerous, but it has no
--   business being callable either, and leaving one of a pair revoked is how the
--   next reader concludes the other was deliberate.
--
-- ⚠️ THE TRIGGER STILL WORKS. A trigger function is invoked by the executor on
--   behalf of the statement, not by the caller, and EXECUTE is not checked for
--   it. Proven by the isolation and ledger suites, which exercise the trigger on
--   every movement they record.
--
-- ⚠️ AND `billing_due_subscriptions` AND `inventory_branches_with_expired_stock`
--   ARE DELIBERATELY LEFT GRANTED. Both are read-only, both take no argument
--   that widens them, and both are called from the worker — which connects as
--   `rcln_app`. See the note in enable-rls.sql.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION stock_balances_apply_delta(uuid, uuid, uuid, uuid, uuid, uuid, "StockStatus", numeric)
  FROM PUBLIC, rcln_app;

REVOKE ALL ON FUNCTION stock_balances_apply()
  FROM PUBLIC, rcln_app;

-- ---------------------------------------------------------------------------
-- The eighth plain foreign key, which the `*_visible` loop could not express.
--
-- `stock_ledger.actor_user_id` points at `users`, which is RLS-EXEMPT and has no
-- `organization_id` — so there is no `p.organization_id IS NULL OR ...` shape to
-- reuse. `tenant_isolation` constrains the movement's own organization and says
-- nothing about whose user id it names, so a tenant could write a ledger row
-- naming ANY user uuid and read `users.full_name` straight back out through the
-- join `listLedger` already performs and returns as `actorName`.
--
-- Not reachable through the HTTP path today — `recordMovementIn` sets
-- `actorUserId: ctx.userId` and never accepts one from a caller — so this is
-- defence in depth, and it is exactly the kind of gap a later phase's
-- bulk-import or backdating endpoint walks into.
--
-- ⚠️ THE PREDICATE IS A MEMBERSHIP TEST, NOT AN IDENTITY TEST. It asks "does
--   this person work at this clinic", not "is this you" — a storekeeper records
--   movements, and a later phase will legitimately attribute one to a colleague
--   (a countersigned controlled-drug entry, an imported goods receipt). Pinning
--   it to `app_current_user()` would refuse those and would refuse the expiry
--   sweep, which attributes to the organization's owner.
--
-- ⚠️ THE SUBQUERY IS NOT SUBJECT TO `memberships`' OWN RLS — Postgres evaluates
--   policy expressions with row security disabled on the tables they reference —
--   so the explicit `organization_id = app_current_org()` is doing the entire
--   job here, exactly as `role_visible` on `role_designations` does against the
--   RLS-exempt `roles`.
--
-- RESTRICTIVE, so it ANDs with tenant_isolation and branch_isolation.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS actor_is_member ON "stock_ledger";
CREATE POLICY actor_is_member ON "stock_ledger" AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM "memberships" m
                      WHERE m."user_id"         = "stock_ledger"."actor_user_id"
                        AND m."organization_id" = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM "memberships" m
                      WHERE m."user_id"         = "stock_ledger"."actor_user_id"
                        AND m."organization_id" = app_current_org()));

-- ---------------------------------------------------------------------------
-- Pin the sweep function's search_path the way every other function in this
-- phase pins it.
--
-- `public` alone was the weaker of the two forms the phase used, while the
-- function's own header claims the pin protects against object shadowing.
-- `rcln_app` cannot CREATE in `public` so this was not exploitable; a comment
-- that overstates its protection is worth correcting anyway.
-- ---------------------------------------------------------------------------
ALTER FUNCTION inventory_branches_with_expired_stock(int)
  SET search_path = pg_catalog, public;
