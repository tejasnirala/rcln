import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// One .env at the repo root, not one per package — prisma commands run with
// cwd=packages/db, so the path is explicit.
loadEnv({ path: new URL('../../.env', import.meta.url).pathname });

/**
 * Migrations and seeds connect as the OWNER role (DIRECT_DATABASE_URL).
 * The owner bypasses RLS by design — that is how migrations create policies.
 *
 * The running application must NEVER use this URL. It connects as rcln_app via
 * DATABASE_URL through the pg adapter in src/client.ts, where RLS is enforced.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'],
  },
});
