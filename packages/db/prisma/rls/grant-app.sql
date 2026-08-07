-- =============================================================================
-- What `rcln_app` is allowed to do, re-established from scratch.
--
-- ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM infra/postgres/init.
--   That script runs ONCE, on first boot of an empty Postgres volume. It is not
--   re-run by anything, ever. But `prisma migrate reset` issues
--
--     DROP SCHEMA public CASCADE; CREATE SCHEMA public;
--
--   which takes the schema's grants AND the `ALTER DEFAULT PRIVILEGES` rules
--   down with it. Migrations then replay as `rcln_owner` and rebuild every
--   table — owned by the owner, granted to nobody.
--
--   The result is an application that cannot read its own database, reported as
--   `permission denied for schema public` from whatever query happens to run
--   first. It looks like a Prisma problem and is not one.
--
-- ⚠️ THE REVOKES AT THE BOTTOM ARE NOT OPTIONAL AND MUST STAY LAST.
--   `GRANT ... ON ALL TABLES` at the top hands `rcln_app` UPDATE and DELETE on
--   `audit_logs` and `data_access_logs` — the two tables whose whole value is
--   that nobody can rewrite them. The migrations that created them revoked
--   those rights; re-granting silently undoes it, and nothing anywhere fails.
--   That exact sequence is called out in the audit_immutability and
--   data_access_log_immutability migrations as the thing to watch for.
--
--   The append-only TRIGGERS on both tables survive a reset independently, so
--   the guarantee is not lost even if this file is forgotten — but a guarantee
--   resting on one layer instead of two is a guarantee that has already half
--   failed. Restore both.
--
-- Idempotent. Safe to run against a healthy database.
--
-- Run: pnpm --filter @rcln/db grants   (or automatically, after db:reset)
-- =============================================================================

-- The reset recreates `public` owned by whoever ran it, which is `rcln_owner`
-- via DIRECT_DATABASE_URL. Stated anyway: if a superuser ever performs the
-- reset instead, the schema comes back owned by `postgres` and every later
-- migration fails on ownership rather than on anything to do with the change.
ALTER SCHEMA public OWNER TO rcln_owner;

GRANT USAGE ON SCHEMA public TO rcln_app;

-- The app reads and writes rows. It can never alter structure — no CREATE on
-- the schema, no ownership of anything. That split is what makes RLS ENABLE
-- (rather than FORCE) safe: see ADR-0003.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO rcln_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO rcln_app;

-- So a table created by a FUTURE migration arrives already granted. These rules
-- are stored per (role, schema) and are dropped with the schema, which is why
-- they have to be re-declared here and not only in the init script.
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rcln_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rcln_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rcln_app;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Append-only, layer one: take back what the blanket grant just handed over.
--
-- INSERT and SELECT are kept on both. `recordAudit` and `recordDataAccess`
-- write through `rcln_app` inside the transaction they describe, and the
-- history drawer and the compliance screens read through it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON audit_logs FROM rcln_app;
  END IF;
  IF to_regclass('public.data_access_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON data_access_logs FROM rcln_app;
  END IF;
  -- The appointment status trail. Same reasoning: "seen at 10:41, not 11:55" is
  -- a claim a clinic may one day have to stand behind, and a row that can be
  -- edited afterwards is evidence of nothing.
  IF to_regclass('public.appointment_status_history') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON appointment_status_history FROM rcln_app;
  END IF;
END
$$;
