-- ===========================================================================
-- "Which subscriptions need billing right now?" — the one question a scheduler
-- has to ask across every tenant.
--
-- THE PROBLEM
--   `subscriptions` is RLS-enforced, and rightly so. The billing worker has no
--   tenant: it is looking for the tenants that need attention, which is the
--   question whose answer tells you which tenants those are. Read with no
--   context the policy matches nothing, so the sweep silently found zero
--   subscriptions due — no error, no log, and renewals simply never happened.
--   That is exactly the failure mode RLS is known for, arriving in the one place
--   where nobody is watching a screen.
--
-- WHY NOT THE OBVIOUS FIXES
--   * Give the worker the owner connection. That hands one process BYPASSRLS on
--     every table in the database to answer a question about three columns, and
--     `assertRlsActive()` refuses to boot on an owner connection for good reason.
--   * A policy on `subscriptions` keyed on a session variable, like
--     `webhook_reference_lookup`. That one is safe because the caller must
--     already know a random uuid — it is a capability. There is no secret here,
--     so the equivalent would be a flag any code path could set to read every
--     tenant's subscriptions. Not a control.
--   * Loop over `organizations` and run one scoped query per tenant. Correct,
--     and it needs no new privilege — but it is a transaction per clinic per
--     hour, and the round-trip cost is paid whether or not anything is due.
--
-- THE FIX
--   A SECURITY DEFINER function owned by `rcln_owner`. It runs with the owner's
--   privileges, so it sees across tenants — but it is not a door, it is a
--   question with one answer. It returns three columns for only the rows that
--   are genuinely due, and there is no argument that widens it: no organization
--   filter to omit, no column list to extend, no `WHERE` a caller supplies.
--
--   `search_path` is pinned, which is mandatory for SECURITY DEFINER: without it
--   a caller who can create objects could shadow `subscriptions` with their own
--   table and have the owner read it.
--
--   EXECUTE is revoked from PUBLIC and granted only to `rcln_app`. Adding a
--   column to the return type is a migration with a reviewer on it, which is the
--   property the alternatives above do not have.
--
--   The rows it returns grant nothing by themselves. The worker takes each id
--   and re-enters `withTenant` for that one organization; every read and write
--   that follows is under the ordinary policy.
-- ===========================================================================

CREATE OR REPLACE FUNCTION billing_due_subscriptions(
  at_time    timestamptz,
  row_limit  int DEFAULT 200
)
RETURNS TABLE (id uuid, organization_id uuid, reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id,
         s.organization_id,
         CASE
           -- Asked to leave, and the period they paid for has run out.
           WHEN s.cancel_at_period_end AND s.current_period_end <= at_time THEN 'CANCEL'
           -- Trial ran out with nothing behind it.
           WHEN s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL
                AND s.trial_ends_at <= at_time THEN 'TRIAL_END'
           -- Dunning ran out of road.
           WHEN s.status = 'PAST_DUE' AND s.grace_period_end IS NOT NULL
                AND s.grace_period_end <= at_time THEN 'SUSPEND'
           WHEN s.status = 'PAST_DUE' THEN 'DUNNING'
           ELSE 'RENEWAL'
         END AS reason
    FROM subscriptions s
   WHERE (s.status = 'ACTIVE'   AND s.current_period_end <= at_time)
      OR (s.status = 'PAST_DUE')
      OR (s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= at_time)
   ORDER BY s.current_period_end ASC
   LIMIT row_limit
$$;

REVOKE ALL ON FUNCTION billing_due_subscriptions(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_due_subscriptions(timestamptz, int) TO rcln_app;
