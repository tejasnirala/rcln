-- CreateTable
CREATE TABLE "role_designations" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "role_id" UUID NOT NULL,
    "designation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_designations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_designations_role_id_idx" ON "role_designations"("role_id");

-- CreateIndex
CREATE INDEX "role_designations_designation_id_idx" ON "role_designations"("designation_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_designations_organization_id_role_id_designation_id_key" ON "role_designations"("organization_id", "role_id", "designation_id");

-- AddForeignKey
ALTER TABLE "role_designations" ADD CONSTRAINT "role_designations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_designations" ADD CONSTRAINT "role_designations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_designations" ADD CONSTRAINT "role_designations_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written from here down.
-- =============================================================================

-- Platform pairings carry organization_id NULL; a plain unique index does not
-- constrain nullable columns, so the same pairing could be seeded twice.
DROP INDEX IF EXISTS "role_designations_organization_id_role_id_designation_id_key";
CREATE UNIQUE INDEX "role_designations_organization_id_role_id_designation_id_key"
  ON "role_designations" ("organization_id", "role_id", "designation_id")
  NULLS NOT DISTINCT;

-- Platform catalogue + per-tenant extension.
-- ⚠️ READ PERMISSIVE, WRITE STRICT — a NULL-permissive WITH CHECK would let any
-- clinic publish a platform-wide pairing to every tenant. Same as `designations`.
ALTER TABLE role_designations ENABLE   ROW LEVEL SECURITY;
ALTER TABLE role_designations NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_designations;
CREATE POLICY tenant_isolation ON role_designations
  USING      (organization_id IS NULL OR organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- Both parents, both plain FKs, because either may be a platform row with no
-- organization_id to compose with. tenant_isolation constrains the PAIRING and
-- says nothing about what it points at.
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

-- ⚠️ `roles` IS RLS-EXEMPT (system roles have organization_id NULL by design),
-- so an EXISTS against it sees EVERY tenant's custom roles. The organization_id
-- test below is therefore doing the whole job on its own — it is not belt and
-- braces over a policy that would have caught it anyway. Without it, a clinic
-- could pair one of its titles with another clinic's private role and read that
-- role's name back through the join.
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
