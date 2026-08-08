-- appointment_status_history is append-only, by the SAME mechanism as
-- audit_logs and data_access_logs — an owner-exempt trigger, not a rule.
--
-- WHY THIS IS A SECOND MIGRATION RATHER THAN AN EDIT
--   The appointments migration is applied, and Prisma checksums it. Editing one
--   in place makes every environment that already ran it fail to migrate with a
--   checksum mismatch that reads as corruption.
--
-- WHY THE RULES IT REPLACES WERE WRONG, PRECISELY
--   `ON DELETE TO … DO INSTEAD NOTHING` silently swallows the delete — including
--   the one Postgres itself issues to satisfy `ON DELETE CASCADE` from
--   `organizations`. The cascade then finds the child rows still there and
--   aborts the whole delete with
--
--     referential integrity query on "organizations" from constraint
--     "appointment_status_history_organization_id_fkey" gave unexpected result
--
--   — which is not a message anybody traces back to an immutability rule. An
--   organization could never be hard-deleted again, and the integration suites
--   do exactly that in cleanup. A rule also fails silently in the ordinary case:
--   a forbidden UPDATE "succeeds" and changes nothing, so a bug that tries to
--   rewrite history looks like it worked.
--
--   The trigger raises instead, and exempts the table owner for the same reason
--   RLS is ENABLE rather than FORCE: the owner is what migrations, seeds and
--   cascades run as. `rcln_app` is blocked by the REVOKE in grant-app.sql AND by
--   this trigger, which is the two independent layers the other two trails have.
DROP RULE IF EXISTS "appointment_status_history_no_update" ON "appointment_status_history";
DROP RULE IF EXISTS "appointment_status_history_no_delete" ON "appointment_status_history";

CREATE OR REPLACE FUNCTION appointment_status_history_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- The table's own owner passes, exactly as it does under RLS ENABLE.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'appointment_status_history is append-only: % is not permitted', TG_OP
    USING HINT = 'When somebody was seen is evidence. See the audit_immutability migration.';
END
$$;

DROP TRIGGER IF EXISTS appointment_status_history_no_update ON appointment_status_history;
CREATE TRIGGER appointment_status_history_no_update
  BEFORE UPDATE ON appointment_status_history
  FOR EACH ROW EXECUTE FUNCTION appointment_status_history_is_append_only();

DROP TRIGGER IF EXISTS appointment_status_history_no_delete ON appointment_status_history;
CREATE TRIGGER appointment_status_history_no_delete
  BEFORE DELETE ON appointment_status_history
  FOR EACH ROW EXECUTE FUNCTION appointment_status_history_is_append_only();

-- The branch policy shipped with a USING clause and no WITH CHECK. Postgres
-- falls back to USING for the write check when WITH CHECK is absent, so this
-- changed no behaviour — but it left the policy spelled differently from the
-- shared `branch_scoped` loop in prisma/rls/enable-rls.sql, and two spellings of
-- one policy is how the file that is supposed to be the source of truth stops
-- being it.
DROP POLICY IF EXISTS branch_isolation ON appointments;
CREATE POLICY branch_isolation ON appointments AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));
