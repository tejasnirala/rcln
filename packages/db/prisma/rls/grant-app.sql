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

  -- -------------------------------------------------------------------------
  -- Inventory (PI-2). The ledger is append-only for the same reason as the two
  -- trails above; the balance cache is stricter still.
  --
  -- ⚠️ `stock_balances` LOSES INSERT TOO, NOT ONLY UPDATE AND DELETE. It is a
  --   CACHE maintained by a SECURITY DEFINER trigger on `stock_ledger`, and
  --   PI-ADR-004 rule 2 — "nothing at all writes stock_balances" — is a GRANT
  --   rather than an agreement only for as long as this stays here. With INSERT
  --   left standing, any code path in the application could state a quantity
  --   directly, which is the one number the append-only ledger exists to make
  --   unforgeable.
  --
  -- ⚠️ THIS FILE'S OWN HEADER PREDICTED THIS AND PI-2 STILL SHIPPED WITHOUT IT.
  --   The migrations revoked all four rights; `GRANT ... ON ALL TABLES` above
  --   handed them straight back on every `db:reset`, and nothing failed locally
  --   because a reset had not been run since. CI caught it on a schema built
  --   from empty, which is precisely the case the header names. The lesson is
  --   that a REVOKE in a migration is necessary and NOT sufficient — it has to
  --   be repeated here, or it survives exactly until the next reset.
  -- -------------------------------------------------------------------------
  IF to_regclass('public.stock_ledger') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON stock_ledger FROM rcln_app;
  END IF;
  IF to_regclass('public.stock_balances') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON stock_balances FROM rcln_app;
  END IF;
  -- The regulatory decision snapshot (PI-7, PI-ADR-008).
  --
  -- ⚠️ ADDED IN PI-8, AND ITS ABSENCE HERE WAS A REAL HOLE RATHER THAN AN
  --   OVERSIGHT NOBODY COULD HIT. `20260825090000_pharmacy_dispensing` revokes
  --   these in the migration, and `ALTER DEFAULT PRIVILEGES` above re-grants them
  --   on the next `db:reset` — which is exactly what this file's own header says
  --   about migration-level REVOKEs, and exactly why every other append-only
  --   table is restated here. The isolation case that catches it only fails
  --   AFTER a reset, so PI-7 shipped green.
  --
  --   A trigger refuses both anyway. That is the second layer, not a reason to
  --   skip this one: a decision a clinic can rewrite after the fact is worth
  --   nothing as evidence to an inspector, and neither layer alone survives a
  --   stray GRANT or a dropped trigger.
  --
  --   ⚠️ INSERT IS KEPT. `recordDecision` writes through `rcln_app` inside the
  --     transaction that acts on the answer.
  IF to_regclass('public.regulatory_decisions') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON regulatory_decisions FROM rcln_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- And the two SECURITY DEFINER functions that maintain the balance cache.
--
-- ⚠️ `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS` ABOVE HANDS EVERY
--   FUNCTION TO `rcln_app` AT CREATION, so revoking these in their migration is
--   undone by the same reset that undoes the table REVOKEs. And these are worse
--   than a writable table: `stock_balances_apply_delta` is SECURITY DEFINER, so
--   it runs as the owner and bypasses RLS, and it takes the organization,
--   branch, location and delta AS ARGUMENTS. Callable by the request-path role,
--   it is an arbitrary cross-tenant write into the balance cache.
--
-- ⚠️ AND `REVOKE ... FROM PUBLIC` IS NOT ENOUGH — `rcln_app` MUST BE NAMED. The
--   grant that matters here is role-specific, not the PUBLIC one; revoking only
--   PUBLIC leaves it standing. That was a CRITICAL in the PI-2 security review
--   and it is the reason this stanza spells the role out.
--
-- The trigger keeps working: a trigger function is invoked by the executor on
-- behalf of the statement, and EXECUTE is not checked for it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.stock_balances_apply_delta(uuid, uuid, uuid, uuid, uuid, uuid, "StockStatus", numeric)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION stock_balances_apply_delta(uuid, uuid, uuid, uuid, uuid, uuid, "StockStatus", numeric)
      FROM PUBLIC, rcln_app;
  END IF;
  IF to_regprocedure('public.stock_balances_apply()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION stock_balances_apply() FROM PUBLIC, rcln_app;
  END IF;
END
$$;
