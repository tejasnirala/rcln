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
-- Refuses any tenant attempt to change or remove a PLATFORM row (one with a
-- NULL organization_id) on a platform-extensible table. Attached as a BEFORE
-- UPDATE OR DELETE trigger by the platform_extensible loop below, which is also
-- where the two holes it closes are described.
--
-- ⚠️ THE GUARD IS `app_current_org() IS NOT NULL`, NOT THE ROLE. A trigger is
--   not RLS: it fires for rcln_owner too, and rcln_owner is precisely who has
--   to write platform rows — the seeds, the migrations. What distinguishes a
--   tenant is that a tenant has an org in its session; the seeds set no session
--   variable at all, so they pass straight through. Testing `current_user` or
--   `session_user` instead would break the moment a platform task runs under a
--   different role, and would say nothing about whether the caller is acting on
--   a clinic's behalf.
--
-- ⚠️ SECURITY INVOKER, AND search_path PINNED. It reads no table and needs no
--   privilege, so it is deliberately NOT a SECURITY DEFINER — nothing here
--   should become privileged surface. The pinned search_path is the standard
--   precaution for a function that runs under someone else's statement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_platform_row_mutation() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.organization_id IS NULL AND app_current_org() IS NOT NULL THEN
    RAISE EXCEPTION
      'platform row % on % is not writable by a tenant', OLD.id, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'Clone it into your own organization and edit the clone.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

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
    'subscription_changes',
    'payment_mandates',
    'payment_intents',
    'usage_counters',
    -- The clinic's OWN tax position, for the invoices it raises against its
    -- patients.
    --
    -- ⚠️ THE OPPOSITE DECISION FROM `tax_registrations`, AND DELIBERATELY SO.
    -- That table is EXEMPT because it holds rcln's numbers and is read inside a
    -- tenant transaction: a policy on it returns zero rows, zero rows reads as
    -- NOT_REGISTERED, and every subscription invoice silently comes out
    -- untaxed. None of that reasoning transfers to these three, whose rows
    -- belong to the very organization reading them — so they get an ordinary
    -- policy, and without one a clinic reads another clinic's GSTIN and rate
    -- card.
    --
    -- The link table is not exempt for holding only ids: both are tenant ids,
    -- and reading another org's row says which of its branches bills under
    -- which of its registrations.
    'issuer_tax_registrations',
    'issuer_tax_registration_branches',
    'tax_rules',
    'audit_logs',
    -- Read-side PHI trail. Same org isolation as audit_logs, and append-only by
    -- the same two independent layers — see the data_access_log_immutability
    -- migration.
    'data_access_logs',
    -- Document numbering. Deliberately org-scoped ONLY: a branch_isolation
    -- policy here would make ON CONFLICT DO UPDATE raise a duplicate-key error
    -- instead of finding the hidden counter row. See the NumberSequence model.
    'number_sequences',
    -- Doctors. `specialties` and `qualifications` are NOT here — they allow a
    -- NULL organization_id and get their own stanza below.
    'doctor_profiles',
    'doctor_specialties',
    'doctor_qualifications',
    'doctor_branch_settings',
    -- What an appointment costs. ALSO in the branch_scoped array below, and the
    -- NULL-tolerant predicate there is load-bearing rather than incidental:
    -- `branch_id IS NULL` is this table's way of saying "the clinic's default,
    -- everywhere", so a branch-scoped receptionist must be able to read it or
    -- the resolver falls through to unpriced and the bill says "no rate card".
    'fee_schedule_entries',
    -- What the clinic pays the doctor. Org-scoped only and no branch_id at all:
    -- one employment contract per person (see the model). Gated in the
    -- application by `doctor.compensation.read`, which RLS knows nothing about —
    -- this policy answers "whose organization", not "whose business".
    'doctor_compensation',
    'doctor_schedules',
    -- Org-scoped only, no branch_isolation: branch_id NULL means "every branch",
    -- and hiding a doctor's leave from a branch-scoped reader would make the
    -- availability engine offer slots on a day they are away. See the model.
    'doctor_schedule_exceptions',
    -- PHI.
    --
    -- ⚠️ `patients` IS DELIBERATELY NOT BRANCH-SCOPED, and that is not an
    -- oversight to be "fixed" later. A person is one person across a hospital
    -- group: their allergy list has to follow them into whichever branch they
    -- walk into, and a front desk that cannot see head office already
    -- registered them will register them again. Two UHIDs for one human being
    -- is a clinical safety failure — the second record has no allergies on it.
    --
    -- The branch boundary lives on `patient_registrations` instead, which is
    -- the row that answers "does this person attend our clinic?". See the
    -- branch_scoped array below and ADR-0016.
    'patients',
    'patient_registrations',
    -- Address, kin, allergies, problems and medicines all follow the person for
    -- the same reason `patients` does.
    'patient_addresses',
    'patient_contacts',
    'patient_allergies',
    'patient_conditions',
    'patient_medications',
    -- Scheduling. `appointments` IS branch-scoped as well (see the array below)
    -- — unlike `patients`, a booking belongs to the clinic it was made at, and
    -- the argument that keeps identity org-wide does not apply to it.
    'appointments',
    -- Every move of a booking. Carries organization_id AND branch_id copied
    -- from the appointment for the same reason `appointment_vitals` does, and
    -- is in the branch_scoped array below as well. ⚠️ Its `reason` column is
    -- PHI, so the branch half is not optional: a move explained by "chemo on
    -- Thursdays" must not be readable from another branch.
    'appointment_reschedules',
    -- Observations taken at a visit. Carries its own organization_id AND
    -- branch_id rather than hanging off the appointment, so it is an ordinary
    -- member of both loops instead of a hand-written parent predicate. Contrast
    -- `appointment_status_history`, which has neither and pays for it below.
    'appointment_vitals',
    -- Patient invoicing. ALL FOUR are also in the branch_scoped array below,
    -- and the children are here rather than in the parent_scoped loop for a
    -- specific reason: that loop's predicate asks the ORGANIZATION question
    -- only, and their parent is branch-scoped. A child of a branch-scoped
    -- parent that inherits only the org half is exactly the hole
    -- `appointment_status_history` had to restate by hand. Carrying
    -- organization_id AND branch_id on every row makes them ordinary members of
    -- both loops instead, with the composite FK stopping the columns from
    -- disagreeing with the invoice they belong to.
    --
    -- ⚠️ An invoice line is PHI-adjacent: "MRI Brain with contrast" is a
    -- clinical fact about a named person, and it is answerable by primary key.
    'invoices',
    'invoice_items',
    'invoice_taxes',
    'invoice_documents'
    -- ⚠️ `appointment_status_history` IS NOT HERE, and putting it back is a
    --    security regression. Permissive policies OR together, so an org-only
    --    `tenant_isolation` beside its hand-written `parent_isolation` would
    --    re-open the branch boundary the latter exists to close. Its single
    --    policy is written out below the parent_scoped loop and asks the
    --    organization question itself.
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
-- Clinical masters: platform catalogue + per-tenant extension.
--
-- ⚠️ READ IS PERMISSIVE, WRITE IS NOT. This is NOT the `files` policy above.
--
-- `files` permits a NULL organization_id in its WITH CHECK, which is right for
-- an asset the platform uploads on a tenant's behalf. Reproducing that here
-- would let ANY CLINIC INSERT A PLATFORM-WIDE SPECIALTY — a row with
-- organization_id NULL, instantly visible to every other tenant on the
-- platform, writable by anyone with doctor.master.manage. That is a
-- cross-tenant write dressed up as a catalogue entry.
--
-- So: USING allows reading platform rows, WITH CHECK insists every row a tenant
-- writes carries its own organization_id. Platform rows are seeded by
-- rcln_owner, which bypasses RLS.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  platform_extensible text[] := ARRAY[
    'specialties',
    'qualifications',
    'designations',
    'role_designations',
    -- ---------------------------------------------------------------------
    -- The product catalogue (PI-1). Thirteen tables, all the same class.
    --
    -- ⚠️ INCLUDING THE CHILDREN, WHICH IS NOT THE CALL THE INVOICE CHILDREN
    --   MADE, AND THE DIFFERENCE IS THE PARENT'S TENANCY CLASS. An invoice is
    --   BRANCH-scoped, so its children carry organization_id AND branch_id and
    --   join both loops. A product is PLATFORM-EXTENSIBLE, so its children
    --   carry a NULLABLE organization_id that mirrors the parent's: a platform
    --   product's packaging is platform data every clinic reads, and a tenant
    --   product's packaging is that tenant's.
    --
    --   What stops the two disagreeing is the composite FK
    --   `(organization_id, product_id) -> products(organization_id, id)`, which
    --   also makes it impossible for a clinic to bolt its own packaging,
    --   identifier or tax classification onto a PLATFORM product — the tenant
    --   row would have to name an organization_id the platform row does not
    --   have. A clinic that wants its own variant clones the product.
    --
    --   The one hole a composite FK cannot close is a NULL: under MATCH SIMPLE
    --   a constraint with any NULL component is not checked at all. The WITH
    --   CHECK below is what closes it, by refusing a tenant the NULL in the
    --   first place. Both layers, as everywhere else in this file.
    'units_of_measure',
    'unit_conversions',
    'product_categories',
    'manufacturers',
    'active_ingredients',
    'compositions',
    'composition_ingredients',
    'storage_requirement_profiles',
    'products',
    'product_packagings',
    'product_identifiers',
    'product_tax_classifications',
    'medicine_details'
  ];
BEGIN
  FOREACH t IN ARRAY platform_extensible LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (organization_id IS NULL OR organization_id = app_current_org())
        WITH CHECK (organization_id = app_current_org())
    $f$, t);

    -- -----------------------------------------------------------------------
    -- ⚠️ THE POLICY ABOVE DOES NOT PROTECT A PLATFORM ROW FROM DELETE OR FROM
    --   CAPTURE, AND NEITHER HOLE IS VISIBLE FROM READING IT AS A SENTENCE.
    --   USING governs which EXISTING rows a statement may touch, and USING
    --   permits `organization_id IS NULL`:
    --
    --     DELETE FROM products WHERE organization_id IS NULL;
    --       Postgres applies NO WITH CHECK to DELETE — there is no new row to
    --       check — so USING is the entire test, and it passes. Any clinic
    --       could delete the platform catalogue for every clinic.
    --
    --     UPDATE products SET organization_id = '<mine>' WHERE id = '<platform>';
    --       USING sees the OLD row (NULL org — permitted) and WITH CHECK sees
    --       the NEW row (its own org — permitted). Neither clause ever compares
    --       the two, so the tenant captures the row, removing it from everyone
    --       else. A plain `SET name = ...` is caught, because the row stays
    --       NULL and fails WITH CHECK; changing the owner is what slips past.
    --
    --   ⚠️ A `RESTRICTIVE ... FOR UPDATE/DELETE USING (organization_id =
    --     app_current_org())` PAIR CLOSES BOTH AND IS THE WRONG FIX. A row a
    --     RESTRICTIVE USING excludes is not refused, it is NOT SEEN: the
    --     statement matches zero rows and reports success. The clinic presses
    --     Save on a platform product and is told it worked. That is strictly
    --     worse than today, where WITH CHECK RAISES and the service turns the
    --     error into a sentence — a property tenant-isolation.test.ts pins on
    --     purpose. A trigger refuses instead of hiding, so it keeps it.
    --
    --   The API already refuses all of this first (`assertMutable` in the
    --   product services). This is the second layer, and the realistic failure
    --   it exists for is a service added in a later phase that forgets the
    --   first — not a compromised database role.
    -- -----------------------------------------------------------------------
    EXECUTE format('DROP TRIGGER IF EXISTS platform_rows_immutable ON %I', t);
    EXECUTE format($f$
      CREATE TRIGGER platform_rows_immutable
        BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION refuse_platform_row_mutation()
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The doctor join tables point at TWO parents, and only one of them is
-- constrained by a composite FK.
--
-- `doctor_specialties.specialty_id` is a plain FK to `specialties(id)`, because
-- a specialty may be a platform row with no organization_id to compose with.
-- tenant_isolation therefore constrains the DOCTOR side and says nothing about
-- the SPECIALTY side — a tenant could otherwise attach another tenant's private
-- specialty to its own doctor and read the name back out of it.
--
-- Same shape, and the same reasoning, as `branch_in_same_org` on
-- invitation_branches. RESTRICTIVE so it ANDs with tenant_isolation.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS specialty_visible ON doctor_specialties;
CREATE POLICY specialty_visible ON doctor_specialties AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = doctor_specialties.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = doctor_specialties.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS qualification_visible ON doctor_qualifications;
CREATE POLICY qualification_visible ON doctor_qualifications AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM qualifications q
    WHERE q.id = doctor_qualifications.qualification_id
      AND (q.organization_id IS NULL OR q.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM qualifications q
    WHERE q.id = doctor_qualifications.qualification_id
      AND (q.organization_id IS NULL OR q.organization_id = app_current_org())
  ));

-- Same reasoning for the designation attached to an invitation and to a staff
-- profile. Both columns are nullable, so the policy permits NULL — an invite
-- with no designation is legitimate.
DROP POLICY IF EXISTS designation_visible ON invitations;
CREATE POLICY designation_visible ON invitations AS RESTRICTIVE
  USING (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = invitations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ))
  WITH CHECK (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = invitations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ));

-- Both parents of a role↔title pairing, both plain FKs.
DROP POLICY IF EXISTS designation_visible ON role_designations;
CREATE POLICY designation_visible ON role_designations AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = role_designations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = role_designations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ));

-- ⚠️ `roles` IS RLS-EXEMPT, so this EXISTS sees every tenant's custom roles and
-- the organization_id test is doing the whole job on its own. Without it a
-- clinic could pair one of its titles with another clinic's private role and
-- read that role's name back through the join.
DROP POLICY IF EXISTS role_visible ON role_designations;
CREATE POLICY role_visible ON role_designations AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_designations.role_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_designations.role_id
      AND (r.organization_id IS NULL OR r.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS designation_visible ON staff_profiles;
CREATE POLICY designation_visible ON staff_profiles AS RESTRICTIVE
  USING (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = staff_profiles.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ))
  WITH CHECK (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = staff_profiles.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- The product catalogue's visibility policies (PI-1). THE highest-risk item in
-- that phase, and the same shape as `specialty_visible` immediately above.
--
-- Every foreign key below points at a table whose rows MAY be platform rows, so
-- it cannot be a composite `(organization_id, id)` FK — there is no
-- organization_id on the target to compose with. `tenant_isolation` therefore
-- constrains the row's OWN organization_id and says nothing whatsoever about
-- what it points AT. Without these, a clinic attaches another clinic's private
-- category, ingredient, composition or unit to its own product and reads the
-- name back out through the join.
--
-- RESTRICTIVE so each ANDs with tenant_isolation. ⚠️ A PERMISSIVE policy here
--   would OR instead, WIDENING access rather than narrowing it — the exact
--   opposite of the intent, and it would typecheck, deploy and pass every
--   single-tenant test.
--
-- Written as a loop rather than eleven copies of the same EXISTS, because the
-- copies are where one of them ends up subtly different. Nullable foreign keys
-- permit NULL: a product with no manufacturer recorded is legitimate, and a
-- policy refusing it would make the column unusable.
--
-- ⚠️ KEEP IN STEP WITH THE `product_platform_core` MIGRATION, which carries an
--   identical block. `db:rls:check` catches a table with NO policy; nothing
--   catches these two files disagreeing about WHICH policy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  i int;
  child text;
  fk text;
  parent text;
  policy_name text;
  nullable boolean;
  predicate text;
  -- child table, FK column on the child, parent table, policy name, FK nullable
  visible text[][] := ARRAY[
    ARRAY['unit_conversions',        'from_unit_id',       'units_of_measure',             'from_unit_visible',       'f'],
    ARRAY['unit_conversions',        'to_unit_id',         'units_of_measure',             'to_unit_visible',         'f'],
    -- ⚠️ THERE IS DELIBERATELY NO `parent_visible` ON `product_categories`, AND
    --   IT IS NOT AN OMISSION TO BE HELPFULLY FIXED. `parent_id` is a SELF
    --   reference, and a policy on a table may not read that same table:
    --   Postgres evaluates policy expressions with row security disabled on the
    --   tables they REFERENCE, which is what makes every entry in this array
    --   safe, but a self-reference has no such escape and raises
    --   "infinite recursion detected in policy for relation product_categories".
    --
    --   It was added once, and it did not fail in one place: `category_visible`
    --   below reads `product_categories`, so the recursion propagated to EVERY
    --   read of `products` for every tenant. See the
    --   `drop_category_parent_visible` migration for the full reasoning and for
    --   why a SECURITY DEFINER helper is not worth it here. `specialties` has
    --   the same gap for the same reason.
    ARRAY['composition_ingredients', 'ingredient_id',      'active_ingredients',           'ingredient_visible',      'f'],
    ARRAY['composition_ingredients', 'strength_unit_id',   'units_of_measure',             'strength_unit_visible',   'f'],
    ARRAY['products',                'category_id',        'product_categories',           'category_visible',        't'],
    ARRAY['products',                'manufacturer_id',    'manufacturers',                'manufacturer_visible',    't'],
    ARRAY['products',                'composition_id',     'compositions',                 'composition_visible',     't'],
    ARRAY['products',                'storage_profile_id', 'storage_requirement_profiles', 'storage_profile_visible', 't'],
    ARRAY['products',                'base_unit_id',       'units_of_measure',             'base_unit_visible',       'f'],
    ARRAY['product_packagings',      'unit_id',            'units_of_measure',             'unit_visible',            'f']
  ];
BEGIN
  FOR i IN 1 .. array_length(visible, 1) LOOP
    child       := visible[i][1];
    fk          := visible[i][2];
    parent      := visible[i][3];
    policy_name := visible[i][4];
    nullable    := visible[i][5]::boolean;

    predicate := format(
      '%s EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND (p.organization_id IS NULL OR p.organization_id = app_current_org()))',
      CASE WHEN nullable THEN format('%I.%I IS NULL OR', child, fk) ELSE '' END,
      parent, child, fk
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, child);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      policy_name, child, predicate, predicate
    );
  END LOOP;
END
$$;

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
    'membership_permission_overrides',
    -- Working hours belong to one branch and branch_id is NOT NULL, so a
    -- branch-scoped reader seeing only its own is correct. Contrast
    -- doctor_schedule_exceptions, which is deliberately NOT here.
    'doctor_schedules',
    -- Which clinic a patient attends, and their branch-local MRN. branch_id is
    -- NOT NULL, so this policy is absolute: a receptionist scoped to one branch
    -- cannot read another branch's registration list or its MRN series. This is
    -- the ONLY branch boundary in the patient domain — see the note against
    -- `patients` above for why the identity row is not here.
    'patient_registrations',
    -- A booking is made at one branch and branch_id is NOT NULL, so this is
    -- absolute. Note this is the opposite call from `patients` and the same one
    -- as `patient_registrations`: identity follows the person, attendance
    -- belongs to the clinic, and an appointment is attendance.
    'appointments',
    -- branch_id is NOT NULL and is copied from the appointment by the service,
    -- so this is absolute: a reading taken at another branch is invisible here
    -- even to someone who guesses its primary key.
    'appointment_vitals',
    -- Same shape, same reasoning, and the reason text is PHI.
    'appointment_reschedules',
    -- ⚠️ THE ONLY TABLE HERE WHOSE NULL BRANCH IS MEANINGFUL RATHER THAN
    -- TOLERATED. Everywhere else in this array branch_id is NOT NULL and the
    -- `branch_id IS NULL OR ...` predicate never fires; here NULL is how the
    -- clinic states a default that applies at every branch, and this policy
    -- letting it through is what makes inheritance work for a branch-scoped
    -- caller. A branch's OWN row stays invisible to other branches, which is
    -- correct: what one site charges is not another site's business.
    'fee_schedule_entries',
    -- An invoice is raised AT a branch: that branch is the place of supply, the
    -- number series and the till it was paid into. branch_id is NOT NULL on all
    -- four tables, so this policy is absolute — a cashier scoped to one branch
    -- cannot read another branch's takings, and the children are scoped in
    -- their own right rather than through the parent (see the org_scoped note).
    'invoices',
    'invoice_items',
    'invoice_taxes',
    'invoice_documents'
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
-- The predicate is an EXISTS against the parent's organization_id.
--
-- ⚠️ THE SUBQUERY IS **NOT** SUBJECT TO THE PARENT'S RLS. This comment used to
--   claim it was, and the claim is false: Postgres evaluates policy expressions
--   with row security disabled on the tables they reference, because a policy
--   that read its own table would otherwise recurse forever. It happens not to
--   matter for the children below, because each predicate spells the
--   organization test out itself rather than leaning on the parent's policy to
--   apply it.
--
--   It matters enormously for a child of a BRANCH-scoped parent, which is why
--   `appointment_status_history` is not in the loop and restates the branch
--   predicate by hand. Measured, not reasoned about — see the
--   `status_history_branch_predicate` migration for the counts.
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
    ARRAY['staff_profiles',         'memberships', 'membership_id'],
    -- The billing children. These sat on the EXEMPT list reading "reached via a
    -- scoped parent", which was the same true-of-the-code-as-written reasoning
    -- the branch children were exempted on — and it is enforced by nothing. An
    -- invoice line carries what a clinic paid and for what; a payment row
    -- carries the tail of the instrument it paid with. Both are answerable by
    -- primary key, so both are now answered by the database instead.
    ARRAY['subscription_invoice_lines',      'subscription_invoices', 'subscription_invoice_id'],
    ARRAY['subscription_payments',           'subscription_invoices', 'subscription_invoice_id'],
    ARRAY['subscription_feature_overrides',  'subscriptions',         'subscription_id']
    -- ⚠️ `appointment_status_history` IS NOT IN THIS LOOP. It hangs off a
    --    BRANCH-SCOPED parent, and the loop's predicate only asks the
    --    organization question — see the note below the loop for why the
    --    branch half cannot be inherited. Its policy is written out by hand
    --    after this block.
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
-- The appointment status trail: a child of a BRANCH-scoped parent, so the branch
-- predicate is restated rather than inherited. See the warning above the loop
-- and the `status_history_branch_predicate` migration.
--
-- ⚠️ IF `appointments.branch_isolation` CHANGES, CHANGE THIS TOO.
ALTER TABLE appointment_status_history ENABLE   ROW LEVEL SECURITY;
ALTER TABLE appointment_status_history NO FORCE ROW LEVEL SECURITY;
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

DROP POLICY IF EXISTS branch_in_same_org ON invitation_branches;
CREATE POLICY branch_in_same_org ON invitation_branches AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM branches b
                      WHERE b.id = invitation_branches.branch_id
                        AND b.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM branches b
                      WHERE b.id = invitation_branches.branch_id
                        AND b.organization_id = app_current_org()));

-- ---------------------------------------------------------------------------
-- invoice_documents.file_id is a PLAIN foreign key, and this policy is what
-- replaces the composite one ADR-0004 would otherwise require.
--
-- ⚠️ THE COMPOSITE FK IS NOT AVAILABLE HERE, AND NOT BY OVERSIGHT.
--   `files.organization_id` is NULLABLE — platform assets share the table — so
--   a FK from invoice_documents' NOT NULL organization_id cannot reference
--   (files.organization_id, files.id). Without this policy an invoice could
--   point at another tenant's PDF: tenant_isolation checks the row's OWN
--   organization_id, which would be perfectly correct, and says nothing at all
--   about the file it cites.
--
--   Note this is STRICTER than `files`' own tenant_isolation, which permits a
--   NULL organization_id so platform assets are readable by everyone. An
--   invoice document is never a platform asset, so NULL is refused outright —
--   the same distinction the explicit organizationId pin in `getDocument`
--   exists to make.
--
-- RESTRICTIVE so it ANDs with tenant_isolation and branch_isolation.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS file_in_same_org ON invoice_documents;
CREATE POLICY file_in_same_org ON invoice_documents AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM files f
                      WHERE f.id = invoice_documents.file_id
                        AND f.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM files f
                      WHERE f.id = invoice_documents.file_id
                        AND f.organization_id = app_current_org()));

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
--   payment_webhook_events
--                      a provider POSTs these to a public endpoint with no
--                      host, no session and no tenant. WHICH organization a
--                      delivery concerns is only known after the signature
--                      verifies and the reference resolves, so a policy
--                      requiring app.current_org would make the table
--                      unwritable by the only endpoint that writes it — the
--                      same circularity as organization_domains.
--
--                      Deduplication must be global for the same reason: a
--                      replayed delivery has to collide on
--                      (provider, provider_event_id) whether or not we can
--                      work out whose it is. That unique index is the only
--                      thing between a re-sent charge.succeeded and a second
--                      free month.
--
--                      It carries an organization_id, resolved after the fact
--                      for the console — a label, not a scoping column. No
--                      tenant-facing route reads this table.
--   demo_requests      submitted from the public marketing site by someone who
--                      has no organization yet. There is no organization_id to
--                      scope by, and a policy requiring app.current_org would
--                      make the table unwritable by the only endpoint that
--                      writes it. Gated in the application layer instead: one
--                      public, rate-limited, write-only route; reads are for
--                      platform admins. Contact details only, never PHI.
--   tax_registrations  describes the SUPPLIER — rcln — and not any clinic. One
--                      set of rows for the whole platform, exactly like `plans`.
--                      There is no organization_id because the question it
--                      answers ("where are WE registered to collect tax?") has
--                      nothing to do with whose invoice is being raised.
--
--                      Scoping it would be worse than pointless: the tax engine
--                      runs inside a tenant transaction, so a policy requiring a
--                      matching organization_id would return zero rows, and zero
--                      rows means NOT_REGISTERED, which means every invoice
--                      silently comes out untaxed. Read-only to the application;
--                      rows are written by seed and by platform admins.
--   tax_rule_defaults  the published rate cards rcln maintains per country. The
--                      law of a jurisdiction, identical for every clinic in it,
--                      exactly like `plans` — there is nothing tenant-specific
--                      in a row, so there is no organization_id to scope by.
--
--                      ⚠️ EVERY TENANT READS IT INSIDE ITS OWN TRANSACTION, to
--                      price its own invoices. A tenant_isolation policy would
--                      therefore return zero rows for everyone, every category
--                      would fall through to UNRATED, and no clinic on the
--                      platform could issue an invoice. Fail-closed, unlike
--                      tax_registrations above where the same mistake silently
--                      untaxes everything — but broken platform-wide either way.
--
--                      A clinic's OWN overrides live in `tax_rules`, which is
--                      org-scoped and carries a policy. The two are separate
--                      tables precisely so this one can be exempt without
--                      widening that one.
--
-- Access to these is gated in the application layer. `check-rls.ts` holds the
-- same list, so adding a table without a policy fails CI until it is either
-- given one or consciously added to the exemption list.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Webhook reference lookup: the one payment intent a verified webhook names.
--
-- Same shape and same reasoning as own_membership above. A provider POSTs to a
-- public endpoint with no host, no session and no user; the organization the
-- delivery concerns is written on an RLS-enforced row we therefore cannot read.
-- Narrowed on both axes rather than exempted:
--
--   id = app_payment_reference()   the single row whose uuid you already have
--   app_current_org() IS NULL      and only in a transaction claiming no tenant
--
-- The second condition switches the policy off for every ordinary request, which
-- is what makes it safe to add alongside tenant_isolation. FOR SELECT only, so
-- it grants no ability to write — the handler re-enters through withTenant once
-- it knows the organization. See withPaymentReference() in src/tenant.ts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_payment_reference() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.payment_reference', true), '')::uuid $$;

DROP POLICY IF EXISTS webhook_reference_lookup ON payment_intents;
CREATE POLICY webhook_reference_lookup ON payment_intents FOR SELECT
  USING (app_current_org() IS NULL AND id = app_payment_reference());

DROP POLICY IF EXISTS webhook_reference_lookup ON payment_mandates;
CREATE POLICY webhook_reference_lookup ON payment_mandates FOR SELECT
  USING (app_current_org() IS NULL AND id = app_payment_reference());

-- ---------------------------------------------------------------------------
-- The billing scheduler's one cross-tenant question.
--
-- `subscriptions` is RLS-enforced, so the worker's hourly sweep — which by
-- definition has no tenant — matched nothing and renewals silently never ran.
-- Answered by a SECURITY DEFINER function rather than by widening a policy or
-- handing the worker an owner connection: it returns three columns for only the
-- rows that are actually due, and takes no argument that widens it. `rcln_app`
-- keeps NOBYPASSRLS. The alternatives, and why each was rejected, are recorded
-- in the 20260805140000_billing_due_sweep_function migration.
--
-- `search_path` is pinned: without it, anyone able to create objects could
-- shadow `subscriptions` and have the owner read their table instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_due_subscriptions(
  at_time    timestamptz,
  row_limit  int DEFAULT 200
)
RETURNS TABLE (id uuid, organization_id uuid, reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT s.id,
         s.organization_id,
         CASE
           WHEN s.cancel_at_period_end AND s.current_period_end <= at_time THEN 'CANCEL'
           WHEN s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL
                AND s.trial_ends_at <= at_time THEN 'TRIAL_END'
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
$fn$;

REVOKE ALL ON FUNCTION billing_due_subscriptions(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_due_subscriptions(timestamptz, int) TO rcln_app;
