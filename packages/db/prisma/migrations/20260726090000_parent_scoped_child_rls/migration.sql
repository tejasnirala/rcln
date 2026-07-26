-- Row-level security for the four tables that have no organization_id of their
-- own and hang off a tenant table instead.
--
-- No schema change — this migration is policies only, which is why it is
-- hand-written rather than generated. Prisma Migrate does not manage RLS.
--
-- WHY
--   branch_operating_hours, branch_closures, invitation_branches and
--   staff_profiles were exempt from RLS on the reasoning that they are only ever
--   reached through a scoped parent — a nested write on branches, invitations or
--   memberships. That was true of the code, and enforced by nothing. A single
--
--     tx.branchOperatingHour.update({ where: { id } })
--
--   written in any later service is a cross-tenant write. It raises no error,
--   logs nothing, and breaks no test that looks at one tenant. Phase 1's branch
--   and invitation slices are the first code to write to these tables, so the
--   convention gets moved into the database before there is code relying on it.
--
-- HOW
--   EXISTS against the parent's organization_id. The subquery is itself subject
--   to the parent's own RLS, which asks the same question — so the two agree
--   rather than layering two different answers.
--
--   ENABLE, not FORCE, exactly as every other policy here: the owner role must
--   keep bypassing so migrations, seeds and support tooling work without a
--   tenant context. Isolation comes from rcln_app being a non-owner with
--   NOBYPASSRLS. See ADR-0003.
--
-- Kept in step with packages/db/prisma/rls/enable-rls.sql.

DO $$
DECLARE
  i int;
  child text;
  parent text;
  fk text;
  -- child, parent, foreign key on the child
  parent_scoped text[][] := ARRAY[
    ARRAY['branch_operating_hours', 'branches',    'branch_id'],
    ARRAY['branch_closures',        'branches',    'branch_id'],
    ARRAY['invitation_branches',    'invitations', 'invitation_id'],
    ARRAY['staff_profiles',         'memberships', 'membership_id']
  ];
BEGIN
  FOR i IN 1 .. array_length(parent_scoped, 1) LOOP
    child  := parent_scoped[i][1];
    parent := parent_scoped[i][2];
    fk     := parent_scoped[i][3];

    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', child);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', child);
    EXECUTE format('DROP POLICY IF EXISTS parent_isolation ON %I', child);
    EXECUTE format($f$
      CREATE POLICY parent_isolation ON %1$I
        USING      (EXISTS (SELECT 1 FROM %2$I p
                            WHERE p.id = %1$I.%3$I
                              AND p.organization_id = app_current_org()))
        WITH CHECK (EXISTS (SELECT 1 FROM %2$I p
                            WHERE p.id = %1$I.%3$I
                              AND p.organization_id = app_current_org()))
    $f$, child, parent, fk);
  END LOOP;
END
$$;

-- invitation_branches points at two tenant tables, and its branch_id is a plain
-- FK to branches(id) — not one of the composite (organization_id, id) FKs that
-- make a cross-tenant reference unrepresentable elsewhere (ADR-0004). So the
-- invitation being in your org does not by itself prove the branch is. Check the
-- second parent too, RESTRICTIVE so it ANDs with parent_isolation above.
DROP POLICY IF EXISTS branch_in_same_org ON invitation_branches;
CREATE POLICY branch_in_same_org ON invitation_branches AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM branches b
                      WHERE b.id = invitation_branches.branch_id
                        AND b.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM branches b
                      WHERE b.id = invitation_branches.branch_id
                        AND b.organization_id = app_current_org()));
