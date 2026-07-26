-- Identity bootstrap: let a user read their OWN membership rows.
--
-- No schema change — this migration is a policy only, which is why it is
-- hand-written rather than generated. Prisma Migrate does not manage RLS.
--
-- WHY
--   authSession.memberships lists every organization the caller belongs to; it
--   is what the account switcher renders and what tells a client which
--   subdomain to navigate to. That list is inherently cross-tenant, so it
--   cannot be read under tenant_isolation: with no app.current_org the query
--   returns nothing, and setting one requires already knowing the answer.
--
--   Without this policy the field is silently always empty — RLS fails closed,
--   so there is no error, just an array that is never populated.
--
-- WHY IT IS SAFE
--   Two conditions, both required:
--     user_id = app_current_user()  -> your own rows only
--     app_current_org() IS NULL     -> only in a transaction claiming no tenant
--
--   PERMISSIVE policies OR with tenant_isolation, so the second condition is
--   what keeps the blast radius at zero: every ordinary request sets
--   app.current_org, which switches this policy off completely. It applies only
--   inside withUserIdentity() in packages/db/src/tenant.ts.
--
--   FOR SELECT with no WITH CHECK: this grants no ability to create, alter or
--   delete a membership.
--
-- Kept in step with packages/db/prisma/rls/enable-rls.sql.

DROP POLICY IF EXISTS own_membership ON memberships;
CREATE POLICY own_membership ON memberships FOR SELECT
  USING (user_id = app_current_user() AND app_current_org() IS NULL);
