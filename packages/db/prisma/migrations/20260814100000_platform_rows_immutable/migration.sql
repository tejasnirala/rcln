-- Platform rows become unwritable by a tenant at the DATABASE, not only in the
-- service layer.
--
-- ── THE GAP ─────────────────────────────────────────────────────────────────
-- Every platform-extensible table carries one policy:
--
--   CREATE POLICY tenant_isolation ON <t>
--     USING      (organization_id IS NULL OR organization_id = app_current_org())
--     WITH CHECK (organization_id = app_current_org());
--
-- Read-permissive, write-strict. That reads as "a tenant may see platform rows
-- but may only write its own", and for INSERT it is exactly true. For the two
-- commands that act on an EXISTING row it is not, because USING — which permits
-- `organization_id IS NULL` — is what selects those rows.
--
-- ⚠️ DELETE HAS NO WITH CHECK. Postgres applies WITH CHECK only where there is
--   a new row to check, so on DELETE the USING clause is the whole test:
--
--     DELETE FROM products WHERE organization_id IS NULL;
--
--   passed, under any tenant, for anyone holding product.definition.manage.
--
-- ⚠️ UPDATE PASSED BOTH CLAUSES WHILE CHANGING OWNERSHIP. USING is evaluated
--   against the OLD row and WITH CHECK against the NEW one:
--
--     UPDATE products SET organization_id = '<mine>' WHERE id = '<platform id>';
--
--   is old-row-NULL (permitted by USING) and new-row-mine (permitted by WITH
--   CHECK). Neither clause ever compares the two, so the tenant captures the
--   row — and captures it AWAY from every other tenant on the platform. Note
--   that a plain `SET name = ...` was already refused: the row stays NULL and
--   fails WITH CHECK. Changing the owner is the case that slipped past.
--
-- ── WHY A TRIGGER AND NOT A RESTRICTIVE POLICY ──────────────────────────────
-- A `RESTRICTIVE ... FOR UPDATE/DELETE USING (organization_id =
-- app_current_org())` pair closes both holes in four lines, and is the wrong
-- fix. A row a RESTRICTIVE USING excludes is not REFUSED, it is NOT SEEN: the
-- statement matches zero rows and reports success. The clinic presses Save on a
-- platform product and is told it worked. Today's behaviour is better than
-- that — WITH CHECK raises, and the service turns the error into a sentence —
-- and tenant-isolation.test.ts pins the raise deliberately. A trigger refuses
-- rather than hides, so the fix keeps the property instead of trading it away.
--
-- ── WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────────
-- Neither hole was reachable through the API: `assertMutable` refuses a
-- platform row on every mutating path (product.service.ts, catalogue.service.ts,
-- unit.service.ts). This restores the second layer, which is the one that has to
-- hold when a service forgets the first — and a service added in PI-2..PI-25
-- forgetting it is the realistic failure, not a compromised database role.
--
-- Applies to all seventeen platform-extensible tables, so `specialties`,
-- `qualifications`, `designations` and `role_designations` are fixed too. They
-- have carried this gap since they shipped; it is one loop, and leaving four
-- tables on the old behaviour would leave the next reader guessing which class
-- they are in.
--
-- Mirrored in prisma/rls/enable-rls.sql — the two must not drift.

CREATE OR REPLACE FUNCTION refuse_platform_row_mutation() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS
$$
BEGIN
  -- ⚠️ THE GUARD IS `app_current_org() IS NOT NULL`, NOT THE ROLE. A trigger is
  --   not RLS: it fires for rcln_owner too, and rcln_owner is exactly who must
  --   write platform rows — the seeds and the migrations. What distinguishes a
  --   tenant is that a tenant has an org in its session; the seeds set no
  --   session variable at all and pass straight through. Testing `current_user`
  --   would break the moment a platform task runs under another role, and says
  --   nothing about whether the caller acts on a clinic's behalf.
  IF OLD.organization_id IS NULL AND app_current_org() IS NOT NULL THEN
    RAISE EXCEPTION
      'platform row % on % is not writable by a tenant', OLD.id, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'Clone it into your own organization and edit the clone.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DO $$
DECLARE
  t text;
  platform_extensible text[] := ARRAY[
    'specialties',
    'qualifications',
    'designations',
    'role_designations',
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
    EXECUTE format('DROP TRIGGER IF EXISTS platform_rows_immutable ON %I', t);
    EXECUTE format($f$
      CREATE TRIGGER platform_rows_immutable
        BEFORE UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION refuse_platform_row_mutation()
    $f$, t);
  END LOOP;
END
$$;
