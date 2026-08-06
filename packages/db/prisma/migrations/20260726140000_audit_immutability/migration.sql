-- ---------------------------------------------------------------------------
-- audit_logs is append-only, and Postgres is what enforces it.
--
-- WHY THIS IS NOT A PERMISSION CODE
--   An audit trail the application can rewrite is not evidence. Every other
--   control in this product is a permission check, and every permission check is
--   application code that a bug, an injected query, or a future endpoint written
--   in a hurry can go around. `rcln_app` simply not holding the privilege cannot
--   be gone around: the strongest form of "no route does this" is "no route can".
--
--   `infra/postgres/init/01-roles-and-extensions.sql` grants SELECT, INSERT,
--   UPDATE, DELETE on every table in the schema, plus the same set as DEFAULT
--   PRIVILEGES for tables created later. This carves audit_logs out of that.
--
-- WHAT IS STILL POSSIBLE, AND BY WHOM
--   `rcln_owner` keeps everything. That is deliberate and it is the same reasoning
--   as RLS being ENABLE rather than FORCE (see prisma/rls/enable-rls.sql): the
--   owner role exists to run migrations and maintenance, and the model comment on
--   AuditLog says this table is to be partitioned by month once it grows — which
--   is DDL, and impossible for a role that cannot touch it.
--
--   So a deletion is not impossible; it is a deliberate act by someone holding the
--   owner credential, outside the application, leaving a trace in the database's
--   own logs rather than happening behind a button. That is the intended
--   difference. A super-admin "delete history" endpoint would put the one actor
--   with the most reach — a platform admin can enter any clinic and change
--   anything (ADR-0012) — in charge of erasing the record of having done so, and
--   the audit trail is the ONLY control that ADR rests on.
--
-- INSERT is kept, obviously: `recordAudit` writes through `rcln_app` inside the
-- transaction it describes.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON audit_logs FROM rcln_app;

/*
 * The second, independent layer.
 *
 * The REVOKE above is a fact about the CURRENT grant. Re-run the blanket
 * `GRANT ... ON ALL TABLES` from the init script — which is exactly what a "fix
 * the permissions" script does — and audit_logs is quietly writable again with
 * nothing failing anywhere. This trigger does not depend on the grant being right.
 *
 * IT EXEMPTS THE TABLE OWNER, deliberately, and this is the same decision as RLS
 * being ENABLE rather than FORCE (prisma/rls/enable-rls.sql): policies apply to
 * everyone except the owner, because the owner role is what migrations and
 * maintenance run as. Two concrete things break under a trigger with no exemption,
 * and neither is hypothetical:
 *
 *   - `users.id` is referenced by `audit_logs.actor_user_id` ON DELETE SET NULL —
 *     which is an UPDATE on this table. Hard-deleting any user who has ever
 *     touched a record would fail.
 *   - `organizations.id` is referenced ON DELETE CASCADE, so hard-deleting an
 *     organization would fail too.
 *
 * Both of those are how the schema is meant to behave: an actor's account going
 * away must not take the history of what they did with it. The application never
 * hard-deletes either — both are soft-deleted — but the integration suites do, in
 * cleanup, as the owner.
 *
 * So: `rcln_app` cannot rewrite history by grant AND cannot by trigger. The owner
 * can, which is the point — see the note above on why that is a deliberate act
 * rather than a button.
 */
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- The table's own owner passes, exactly as it does under RLS ENABLE.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING HINT = 'History is evidence. See the audit_immutability migration.';
END
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
