-- =============================================================================
-- Null-safe uniqueness.
--
-- Postgres UNIQUE indexes treat NULLs as DISTINCT, so `UNIQUE (organization_id,
-- code)` does NOT stop two system roles both having organization_id NULL and
-- code 'SUPER_ADMIN'. The same hole exists on membership_roles, where a NULL
-- branch_id means "all branches" — the exact row we most need to be unique.
--
-- Postgres 15+ gives us NULLS NOT DISTINCT, which is what we actually meant.
-- =============================================================================

-- --- roles -------------------------------------------------------------------
DROP INDEX IF EXISTS "roles_organization_id_code_key";

CREATE UNIQUE INDEX "roles_organization_id_code_key"
  ON "roles" ("organization_id", "code") NULLS NOT DISTINCT;

-- --- membership_roles --------------------------------------------------------
-- Without this, a user could be granted the same role twice for "all branches".
DROP INDEX IF EXISTS "membership_roles_membership_id_role_id_branch_id_key";

CREATE UNIQUE INDEX "membership_roles_membership_id_role_id_branch_id_key"
  ON "membership_roles" ("membership_id", "role_id", "branch_id") NULLS NOT DISTINCT;

-- --- membership_permission_overrides -----------------------------------------
DROP INDEX IF EXISTS "membership_permission_overrides_membership_id_permission_i_key";

CREATE UNIQUE INDEX "membership_permission_overrides_membership_id_permission_i_key"
  ON "membership_permission_overrides" ("membership_id", "permission_id", "branch_id")
  NULLS NOT DISTINCT;

-- --- setting_values ----------------------------------------------------------
-- scope_id is NULL for PLATFORM-scoped settings; only one such row may exist.
DROP INDEX IF EXISTS "setting_values_setting_key_scope_type_scope_id_key";

CREATE UNIQUE INDEX "setting_values_setting_key_scope_type_scope_id_key"
  ON "setting_values" ("setting_key", "scope_type", "scope_id") NULLS NOT DISTINCT;

-- --- subscription_payments ---------------------------------------------------
DROP INDEX IF EXISTS "subscription_payments_gateway_gateway_payment_id_key";

CREATE UNIQUE INDEX "subscription_payments_gateway_gateway_payment_id_key"
  ON "subscription_payments" ("gateway", "gateway_payment_id") NULLS NOT DISTINCT;

-- -----------------------------------------------------------------------------
-- A tenant must not be able to shadow a system role code, or the effective
-- permission lookup becomes ambiguous.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_shadowed_system_role() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.organization_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM roles
    WHERE organization_id IS NULL AND is_system AND code = NEW.code
  ) THEN
    RAISE EXCEPTION 'role code % is reserved by a system role', NEW.code
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_reject_shadowed_system_role ON roles;
CREATE TRIGGER trg_reject_shadowed_system_role
  BEFORE INSERT OR UPDATE OF code ON roles
  FOR EACH ROW EXECUTE FUNCTION reject_shadowed_system_role();
