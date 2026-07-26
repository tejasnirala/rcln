-- =============================================================================
-- Row-Level Security policies.
--
-- Prisma Migrate does NOT generate these. After every `prisma migrate dev` that
-- adds a tenant table, append this file's contents (or the new table's stanza)
-- to the generated migration.sql before committing. `pnpm db:rls:check` fails
-- CI if a tenant table ships without a policy.
--
-- Session variables, set per transaction by packages/db/src/tenant.ts:
--   app.current_org    uuid    the tenant
--   app.branch_scope   uuid[]  branches this request may touch
--   app.current_user   uuid    the acting user
--   app.impersonator   uuid    set when a platform admin is inside a tenant
--
-- All four are read with `current_setting(..., true)` — the `true` means
-- "return NULL if unset" instead of raising. Unset therefore matches NO rows:
-- the policies fail closed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_branch_scope() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.branch_scope', true), '')::uuid[], '{}'::uuid[]) $$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.current_user', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Org-scoped tables: one predicate, applied to both read and write.
--
-- Deliberately ENABLE, not FORCE.
--   ENABLE -> policies apply to everyone EXCEPT the table owner.
--   FORCE  -> policies apply to the owner as well.
--
-- FORCE sounds safer and is the wrong choice here. The owner role exists
-- precisely to run migrations, seeds and support tooling, none of which have a
-- tenant context; under FORCE every one of them fails. Isolation is guaranteed
-- instead by the role split: the application connects as rcln_app, which owns
-- nothing and has NOBYPASSRLS, so policies always apply to it.
--
-- The risk FORCE was covering — someone pointing DATABASE_URL at the owner —
-- is handled by assertRlsActive() in src/client.ts, which refuses to boot the
-- app on an owner connection. That fails loudly at startup instead of silently
-- at query time.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'branches',
    'memberships',
    'membership_roles',
    'membership_permission_overrides',
    'invitations',
    'subscriptions',
    'subscription_invoices',
    'usage_counters',
    'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- Explicit: the owner must keep bypassing, so migrations and seeds work.
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- `files` is org-scoped but allows NULL organization_id for platform assets.
ALTER TABLE files ENABLE   ROW LEVEL SECURITY;
ALTER TABLE files NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING      (organization_id IS NULL OR organization_id = app_current_org())
  WITH CHECK (organization_id IS NULL OR organization_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Branch scoping, layered on top of org isolation.
--
-- A branch-scoped row is visible when its branch is in app.branch_scope. Rows
-- with a NULL branch_id are org-wide (e.g. a membership_role granting access to
-- every branch) and stay visible to any member of the org.
--
-- PERMISSIVE policies OR together, so this is written as a RESTRICTIVE policy:
-- it ANDs with tenant_isolation. Both must pass.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  branch_scoped text[] := ARRAY[
    'membership_roles',
    'membership_permission_overrides'
  ];
BEGIN
  FOREACH t IN ARRAY branch_scoped LOOP
    EXECUTE format('DROP POLICY IF EXISTS branch_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY branch_isolation ON %I AS RESTRICTIVE
        USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
        WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Parent-scoped children: tables with no organization_id of their own.
--
-- These hang off a tenant table and were originally exempt, on the reasoning
-- that they are only ever reached through a scoped parent. That reasoning is
-- true of the code as written and enforced by nothing: one
--
--   tx.branchOperatingHour.update({ where: { id } })
--
-- written later is a cross-tenant write that raises no error and fails no
-- single-tenant test. So the reasoning is moved into the database, where it
-- holds regardless of how the service layer is written.
--
-- The predicate is an EXISTS against the parent's organization_id. Note the
-- subquery is itself subject to the parent's RLS — which asks the same
-- question, so the two agree rather than fighting.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Identity bootstrap: your own membership rows.
--
-- "Which organizations do I belong to?" is the question whose answer tells you
-- which tenants exist for you, so it cannot itself be tenant-scoped. Under
-- tenant_isolation alone it is unanswerable: with no app.current_org the read
-- returns nothing, and setting one requires already knowing the answer. That is
-- the same circularity organization_domains has, but memberships must NOT be
-- exempted outright — the rows carry who works where, across every clinic.
--
-- So the policy is narrowed on both axes instead:
--
--   user_id = app_current_user()   your own rows, never anybody else's
--   app_current_org() IS NULL      and only in a transaction claiming no tenant
--
-- The second condition is what makes this safe to add. PERMISSIVE policies OR
-- together, so without it this would widen every ordinary request. With it, the
-- policy switches OFF the moment a tenant context exists — which is always,
-- except inside withUserIdentity() in packages/db/src/tenant.ts.
--
-- Read-only: no WITH CHECK, so this grants no ability to write a membership.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS own_membership ON memberships;
CREATE POLICY own_membership ON memberships FOR SELECT
  USING (user_id = app_current_user() AND app_current_org() IS NULL);

-- ---------------------------------------------------------------------------
-- Deliberately NOT tenant-scoped, with the reason recorded.
--
--   organizations       resolved by hostname BEFORE a tenant context exists
--   organization_domains the host -> tenant lookup itself. Putting this under
--                        tenant_isolation is circular: the query that
--                        establishes app.current_org cannot require
--                        app.current_org to already be set. Reads are by exact
--                        domain only, which leaks nothing an attacker cannot
--                        already learn by resolving DNS.
--   users              global identity; one login spans organizations
--   sessions           looked up by refresh-token hash pre-context
--   auth_tokens        OTP verification happens pre-context
--   user_identities    SSO callback happens pre-context
--   roles              system roles have organization_id NULL by design
--   permissions        static catalogue
--   role_permissions   joins two non-tenant tables
--   plans / plan_*     platform-wide product catalogue
--   setting_*          scoped by (scope_type, scope_id), not organization_id
--   demo_requests      submitted from the public marketing site by someone who
--                      has no organization yet. There is no organization_id to
--                      scope by, and a policy requiring app.current_org would
--                      make the table unwritable by the only endpoint that
--                      writes it. Gated in the application layer instead: one
--                      public, rate-limited, write-only route; reads are for
--                      platform admins. Contact details only, never PHI.
--
-- Access to these is gated in the application layer. `check-rls.ts` holds the
-- same list, so adding a table without a policy fails CI until it is either
-- given one or consciously added to the exemption list.
-- ---------------------------------------------------------------------------
