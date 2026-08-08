-- ---------------------------------------------------------------------------
-- data_access_logs is append-only, by the same two independent layers that
-- protect audit_logs. See the audit_immutability migration for the full
-- reasoning; the short version, and why it applies with MORE force here:
--
--   audit_logs records what staff CHANGED. data_access_logs records what they
--   LOOKED AT. The second is the only evidence that exists for the failure mode
--   this product actually has — a member of staff reading the records of a
--   patient who is not theirs. Nothing about that read is otherwise visible: it
--   mutates nothing, breaks nothing, and appears in no other table. If the
--   application can erase these rows, the one control over curiosity-browsing of
--   PHI is a control the browser can switch off.
--
-- A NEW FUNCTION RATHER THAN A GENERALISED ONE
--   `audit_logs_are_append_only()` does the same job, and reusing it would mean
--   editing the applied audit_immutability migration — which Prisma checksums,
--   so the whole migration history would fail to validate. Four duplicated lines
--   is the cheaper mistake.
--
-- INSERT is kept: `recordDataAccess` writes through rcln_app inside the same
-- transaction as the read it describes.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON data_access_logs FROM rcln_app;

/*
 * Layer two, independent of the grant above.
 *
 * The REVOKE is a fact about the CURRENT grant. Re-running the blanket
 * `GRANT ... ON ALL TABLES` from infra/postgres/init — exactly what a "fix the
 * permissions" script does — makes the table quietly writable again with nothing
 * failing anywhere. This trigger does not depend on the grant being right.
 *
 * IT EXEMPTS THE TABLE OWNER, deliberately, for the same two concrete reasons as
 * on audit_logs: `actor_user_id` is ON DELETE SET NULL from users (an UPDATE on
 * this table), and `organization_id` is ON DELETE CASCADE from organizations.
 * A blanket refusal would make deleting any user who has ever read a record
 * fail — which the integration suites do, as the owner, in cleanup.
 */
CREATE OR REPLACE FUNCTION data_access_logs_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- The table's own owner passes, exactly as it does under RLS ENABLE.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'data_access_logs is append-only: % is not permitted', TG_OP
    USING HINT = 'A PHI-read trail is evidence. See the data_access_log_immutability migration.';
END
$$;

DROP TRIGGER IF EXISTS data_access_logs_no_update ON data_access_logs;
CREATE TRIGGER data_access_logs_no_update
  BEFORE UPDATE ON data_access_logs
  FOR EACH ROW EXECUTE FUNCTION data_access_logs_are_append_only();

DROP TRIGGER IF EXISTS data_access_logs_no_delete ON data_access_logs;
CREATE TRIGGER data_access_logs_no_delete
  BEFORE DELETE ON data_access_logs
  FOR EACH ROW EXECUTE FUNCTION data_access_logs_are_append_only();
