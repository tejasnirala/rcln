/**
 * Re-establish what `rcln_app` may do, and verify it took.
 *
 * `prisma migrate reset` drops and recreates the `public` schema, which takes
 * every grant and every `ALTER DEFAULT PRIVILEGES` rule with it. Migrations
 * then replay as `rcln_owner` and rebuild the tables owned by the owner and
 * granted to nobody, so the application cannot read its own database. The
 * symptom is `permission denied for schema public` from whichever query runs
 * first, which reads as a Prisma fault and is not one.
 *
 * This runs automatically after `pnpm db:reset`. Run it by hand after any other
 * operation that recreates the schema.
 *
 * ⚠️ IT ALSO CHECKS ITS OWN WORK, because the failure it is undoing is silent.
 *   The blanket `GRANT ... ON ALL TABLES` inside the SQL hands `rcln_app`
 *   UPDATE and DELETE on `audit_logs` and `data_access_logs` — the two tables
 *   whose value is that nobody can rewrite them — and the REVOKEs at the bottom
 *   take them back. If those two statements were ever reordered or lost, every
 *   test would still pass and the immutability guarantee would be down to one
 *   layer instead of two. So the grants are read back out of the catalogue and
 *   the script exits non-zero if they are wrong.
 *
 * Run: pnpm --filter @rcln/db grants
 */
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

// Single .env at the repo root; this script runs with cwd=packages/db.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const { Client } = pg;

/** Tables that must never be UPDATE-able or DELETE-able by the app role. */
const APPEND_ONLY = ['audit_logs', 'data_access_logs', 'appointment_status_history'];

interface GrantRow {
  table_name: string;
  privilege_type: string;
}

async function main(): Promise<void> {
  /*
   * The OWNER connection, deliberately. `rcln_app` cannot grant itself
   * anything, which is the point of the role split (ADR-0003) — and after a
   * reset it cannot even connect to the schema to try.
   */
  const url = process.env['DIRECT_DATABASE_URL'];
  if (!url) throw new Error('DIRECT_DATABASE_URL must be set (the rcln_owner connection)');

  const sql = await readFile(new URL('../prisma/rls/grant-app.sql', import.meta.url), 'utf8');

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(sql);

    // --- verify -------------------------------------------------------------

    const { rows: schema } = await client.query<{ ok: boolean }>(
      `SELECT has_schema_privilege('rcln_app', 'public', 'USAGE') AS ok`
    );
    if (!schema[0]?.ok) {
      throw new Error('rcln_app still has no USAGE on schema public');
    }

    const { rows: writable } = await client.query<GrantRow>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'rcln_app'
          AND table_name = ANY($1)
          AND privilege_type IN ('UPDATE', 'DELETE')`,
      [APPEND_ONLY]
    );
    if (writable.length > 0) {
      const detail = writable.map((r) => `${r.table_name}.${r.privilege_type}`).join(', ');
      throw new Error(
        `append-only tables are writable by rcln_app: ${detail}. ` +
          'The REVOKEs at the bottom of grant-app.sql did not run, or a later ' +
          'GRANT re-opened them.'
      );
    }

    const { rows: readable } = await client.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM information_schema.role_table_grants
        WHERE grantee = 'rcln_app' AND privilege_type = 'SELECT'`
    );

    console.log(
      `✓ grants applied — rcln_app can read ${readable[0]?.n ?? '0'} table(s); ` +
        `${String(APPEND_ONLY.length)} append-only table(s) remain insert-only.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
