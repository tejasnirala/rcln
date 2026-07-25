-- =============================================================================
-- Runs ONCE, on first boot of an empty postgres volume.
--
-- The whole point of this file: create TWO roles.
--
--   rcln_owner  owns every table. Runs migrations and seeds. BYPASSES RLS
--               (Postgres always exempts a table's owner from its policies).
--   rcln_app    owns nothing. What the API and worker connect as at runtime.
--               RLS is ENFORCED for it.
--
-- If the application ever connects as rcln_owner (or postgres), every RLS
-- policy is silently skipped and tenant isolation becomes a no-op with no
-- error and no log line. That is the single most common way teams ship RLS
-- that does nothing at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid, column encryption
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy patient name/phone search
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- appointment overlap exclusion constraint
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rcln_owner') THEN
    CREATE ROLE rcln_owner LOGIN PASSWORD 'owner_password';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rcln_app') THEN
    CREATE ROLE rcln_app LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

-- Belt and braces: make it explicit and greppable.
-- CREATEDB on the owner is needed only so `prisma migrate dev` can build its
-- shadow database locally. Production uses `prisma migrate deploy`, which needs
-- no shadow DB — do NOT grant CREATEDB there.
ALTER ROLE rcln_owner NOSUPERUSER NOBYPASSRLS CREATEDB;
ALTER ROLE rcln_app   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- ---------------------------------------------------------------------------
-- Ownership + grants
-- ---------------------------------------------------------------------------
ALTER SCHEMA public OWNER TO rcln_owner;

-- Database name comes from POSTGRES_DB, so grant it dynamically.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO rcln_app',   current_database());
  EXECUTE format('GRANT ALL     ON DATABASE %I TO rcln_owner', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO rcln_app;

-- The app can read/write rows but can never alter structure.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO rcln_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO rcln_app;

-- Same grants apply automatically to every table a future migration creates.
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rcln_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rcln_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rcln_app;

-- Nobody but these two gets in.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
