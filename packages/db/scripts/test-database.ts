/**
 * The one place that says where test data goes.
 *
 * Development and tests share a Postgres server, a Redis and a set of
 * credentials — they must not share a DATABASE. Until this existed, `pnpm test`
 * wrote its fixtures into the same `rcln` the browser was reading: every run
 * left behind a few dozen organizations, patients and invoices that nobody
 * created through the UI, and the honest records became impossible to pick out
 * of the noise.
 *
 * The test URL is DERIVED from the development one rather than configured
 * separately, so it always follows the host, port and credentials that are
 * already working. Inside compose that resolves to `postgres:5432`; on a native
 * run, to `localhost`. One variable to get right instead of three.
 *
 * ⚠️ NOTHING CREATES THIS DATABASE ON ITS OWN. `pnpm db:test:setup` does
 *   (create → migrate → grants → seed), and the `migrate` compose service runs
 *   it on every `docker compose up`, so a schema change reaches the test
 *   database at the same moment it reaches the development one. A test database
 *   one migration behind fails in ways that read as application bugs.
 */

/**
 * Override with `TEST_DATABASE_NAME` if `rcl_testing` collides with something
 * on a shared server. It is read once, here, and never re-read.
 */
export const TEST_DATABASE_NAME = process.env['TEST_DATABASE_NAME'] ?? 'rcl_testing';

/**
 * Same server, same role, same query string — different database.
 *
 * Takes a `postgresql://user:pass@host:port/rcln?schema=public` and returns the
 * identical URL pointed at the test database. The password stays percent-encoded
 * because `URL` never touches what it did not parse.
 */
export function toTestDatabaseUrl(url: string, name: string = TEST_DATABASE_NAME): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
