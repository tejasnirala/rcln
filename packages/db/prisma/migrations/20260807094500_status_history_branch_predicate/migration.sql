-- ⚠️ RLS IS **NOT** APPLIED TO TABLES REFERENCED INSIDE A POLICY EXPRESSION.
--
-- The `parent_scoped` block in prisma/rls/enable-rls.sql says the EXISTS
-- subquery "is itself subject to the parent's RLS — which asks the same
-- question, so the two agree rather than fighting". For the ORGANIZATION half
-- that is true by accident: the predicate spells `p.organization_id =
-- app_current_org()` out itself, so it does not depend on the parent's policy
-- running. For the BRANCH half it is simply false. Postgres evaluates policy
-- expressions with row security disabled on the tables they reference —
-- otherwise a policy that reads its own table would recurse forever — so the
-- RESTRICTIVE `branch_isolation` on `appointments` never runs inside the
-- subquery.
--
-- Measured, not reasoned about. As `rcln_app`, with a branch scope naming no
-- real branch:
--
--   SELECT count(*) FROM appointments;               -- 0
--   SELECT count(*) FROM appointment_status_history; -- 9
--
-- Nine rows saying when nine patients at another branch were seen, readable by
-- a receptionist scoped away from that branch. Nothing raised; the count was
-- simply wrong, which is what every RLS mistake looks like.
--
-- So the branch predicate is RESTATED here rather than inherited. Restating a
-- rule is a real cost — two places to change — and it is the only option that
-- works. The alternative, a `branch_id` column on the trail itself, is worse:
-- it can drift from its appointment, and then the two disagree about which
-- clinic a visit belonged to.
--
-- ⚠️ IF `appointments.branch_isolation` EVER CHANGES, CHANGE THIS TOO. The
--    isolation suite has a case for each half; both must stay.
DROP POLICY IF EXISTS parent_isolation ON appointment_status_history;
CREATE POLICY parent_isolation ON appointment_status_history
  USING      (EXISTS (SELECT 1 FROM appointments p
                      WHERE p.id = appointment_status_history.appointment_id
                        AND p.organization_id = app_current_org()
                        AND (p.branch_id IS NULL
                             OR p.branch_id = ANY (app_branch_scope()))))
  WITH CHECK (EXISTS (SELECT 1 FROM appointments p
                      WHERE p.id = appointment_status_history.appointment_id
                        AND p.organization_id = app_current_org()
                        AND (p.branch_id IS NULL
                             OR p.branch_id = ANY (app_branch_scope()))));
