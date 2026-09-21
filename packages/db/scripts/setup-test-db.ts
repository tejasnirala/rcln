/**
 * Build the test database from nothing, and bring it level with development.
 *
 * Idempotent. Run it as often as you like:
 *
 *   pnpm db:test:setup                                   (native)
 *   docker compose exec api pnpm db:test:setup           (compose)
 *
 * It also runs inside the one-shot `migrate` service on every
 * `docker compose up`, which is what keeps the test database from drifting a
 * migration behind the development one.
 *
 * Four steps, in this order and no other:
 *
 * Pass `--fresh` to drop and rebuild it first. Worth knowing about before you
 * need it: a setup that fails halfway leaves Postgres holding a FAILED migration
 * record, and `migrate deploy` then refuses to do anything at all — P3009,
 * "migrate found failed migrations in the target database", on every later run.
 * The test database is disposable, so the answer there is to throw it away
 * rather than to hand-repair `_prisma_migrations`.
 *
 *   1. CREATE DATABASE + the four extensions. A new database is cloned from
 *      `template1`, which has none of them — `infra/postgres/init` installed
 *      them into `rcln` only, and that script never runs again.
 *   2. `prisma migrate deploy` — deploy, not dev: no shadow database, no
 *      prompts, and it will not invent a migration from a drifted schema.
 *   3. `apply-grants` — the same grant/revoke pass `db:reset` ends with. Without
 *      it `rcln_app` owns nothing and may read nothing, and every test fails on
 *      `permission denied for schema public`.
 *   4. `seed` — permissions, system roles, plans, the setting catalogue. The
 *      suites authenticate as real roles, so an unseeded test database fails on
 *      authorization rather than on anything a test asserts.
 *
 * ⚠️ IT NEVER TOUCHES THE DEVELOPMENT DATABASE. Every child process is handed
 *   an explicitly rewritten DATABASE_URL and DIRECT_DATABASE_URL; dotenv does
 *   not overwrite a variable that is already set, so the `.env` at the repo root
 *   cannot pull any of them back to `rcln`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { TEST_DATABASE_NAME, toTestDatabaseUrl } from './test-database.js';

// Single .env at the repo root; this script runs with cwd=packages/db.
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

const { Client } = pg;

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * A database name is an identifier, and an identifier cannot be a bind
 * parameter — it is interpolated into the DDL below. So it is checked here
 * rather than trusted, because `TEST_DATABASE_NAME` comes from the environment.
 */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `TEST_DATABASE_NAME must be letters, digits and underscores only — got "${name}"`
    );
  }
}

/** Run a workspace command with the test URLs pinned over whatever .env says. */
function run(label: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.warn(`\n→ ${label}`);
  const result = spawnSync('pnpm', args, { cwd: packageRoot, stdio: 'inherit', env });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${String(result.status ?? 'signal')})`);
  }
}

async function main(): Promise<void> {
  const ownerUrl = process.env['DIRECT_DATABASE_URL'];
  const appUrl = process.env['DATABASE_URL'];
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set (the rcln_owner connection)');
  if (!appUrl) throw new Error('DATABASE_URL must be set (the rcln_app connection)');

  assertSafeName(TEST_DATABASE_NAME);

  const fresh = process.argv.includes('--fresh');

  const testOwnerUrl = toTestDatabaseUrl(ownerUrl);
  const testAppUrl = toTestDatabaseUrl(appUrl);
  const appRole = new URL(appUrl).username;

  console.warn(`\nPreparing the test database "${TEST_DATABASE_NAME}"…`);

  /*
   * CREATE DATABASE cannot run inside a transaction and cannot run from the
   * database being created, so this connects to `postgres` — the maintenance
   * database every server has. `rcln_owner` holds CREATEDB (see
   * infra/postgres/init/01-roles-and-extensions.sql).
   */
  const maintenance = new Client({ connectionString: toTestDatabaseUrl(ownerUrl, 'postgres') });
  await maintenance.connect();
  try {
    if (fresh) {
      /* WITH (FORCE) closes whatever is still connected — a jest worker that
         outlived its run, or a Prisma Studio left open. Without it the drop
         fails on "database is being accessed by other users", and the role
         doing the dropping is not a superuser and so cannot terminate them. */
      await maintenance.query(`DROP DATABASE IF EXISTS "${TEST_DATABASE_NAME}" WITH (FORCE)`);
      console.warn(`  dropped database ${TEST_DATABASE_NAME}`);
    }

    const existing = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      await maintenance.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
      console.warn(`  created database ${TEST_DATABASE_NAME}`);
    } else {
      console.warn(`  database ${TEST_DATABASE_NAME} already exists`);
    }
  } finally {
    await maintenance.end();
  }

  /*
   * Extensions and the database-level grants — the part of
   * infra/postgres/init/01-roles-and-extensions.sql that is per-database rather
   * than per-server. The roles themselves already exist; they are a property of
   * the server, not of any one database.
   *
   * All four extensions are TRUSTED in Postgres 13+, so the database owner may
   * install them without being a superuser.
   */
  const owner = new Client({ connectionString: testOwnerUrl });
  await owner.connect();
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await owner.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    await owner.query('CREATE EXTENSION IF NOT EXISTS "btree_gist"');
    await owner.query('CREATE EXTENSION IF NOT EXISTS "citext"');
    await owner.query(`REVOKE ALL ON DATABASE "${TEST_DATABASE_NAME}" FROM PUBLIC`);
    await owner.query(`GRANT CONNECT ON DATABASE "${TEST_DATABASE_NAME}" TO ${appRole}`);
  } finally {
    await owner.end();
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: testAppUrl,
    DIRECT_DATABASE_URL: testOwnerUrl,
  };

  run('prisma migrate deploy', ['exec', 'prisma', 'migrate', 'deploy'], env);
  run('grants', ['exec', 'tsx', 'scripts/apply-grants.ts'], env);
  run('seed', ['exec', 'tsx', 'prisma/seed.ts'], env);

  console.warn(`\n✓ Test database "${TEST_DATABASE_NAME}" is ready.\n`);
}

main().catch((err: unknown) => {
  console.error('\nTest database setup failed:', err);
  process.exit(1);
});
