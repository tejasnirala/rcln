import { PrismaClient } from '@rcln/db/generated';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const { Pool } = pg;

/**
 * The base client. Connects as `rcln_app` — the non-owner role for which RLS is
 * ENFORCED. Do not export this from the package index; services must go through
 * `forTenant()` so the session variables the policies read are actually set.
 */

export interface DbConfig {
  /** App-role connection string. NOT the owner/migration URL. */
  url: string;
  maxConnections?: number;
  logQueries?: boolean;
}

let pool: pg.Pool | undefined;
let client: PrismaClient | undefined;

export function createDbClient(config: DbConfig): PrismaClient {
  if (client) return client;

  pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Never let a runaway query hold a connection and its RLS session state.
    statement_timeout: 30_000,
  });

  client = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: config.logQueries ? ['warn', 'error'] : ['error'],
  });

  return client;
}

export function getDbClient(): PrismaClient {
  if (!client) {
    throw new Error('Database client not initialised. Call createDbClient(config) at startup.');
  }
  return client;
}

/**
 * Refuse to boot on a connection where RLS would not apply.
 *
 * Policies are ENABLE, not FORCE, so the table owner bypasses them. That is
 * intentional — migrations and seeds need it. The failure mode it creates is
 * severe and silent: point DATABASE_URL at the owner (or a superuser) and every
 * tenant policy stops applying, with no error and no log line. Queries just
 * start returning other clinics' rows.
 *
 * So we check at startup instead. Call this once, before serving traffic.
 */
export async function assertRlsActive(): Promise<void> {
  const prisma = getDbClient();

  const rows = await prisma.$queryRawUnsafe<
    { current_user: string; is_superuser: boolean; bypassrls: boolean }[]
  >(`
    SELECT current_user,
           (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user) AS is_superuser,
           (SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user) AS bypassrls
  `);

  const row = rows[0];
  if (!row) throw new Error('Could not determine the current database role');
  const { current_user: role, is_superuser, bypassrls } = row;

  if (is_superuser) {
    throw new Error(
      `Refusing to start: connected as superuser "${role}". Superusers bypass every RLS policy — tenant isolation would not exist. Point DATABASE_URL at the application role.`
    );
  }

  if (bypassrls) {
    throw new Error(
      `Refusing to start: role "${role}" has BYPASSRLS. Tenant isolation would not exist. Run: ALTER ROLE ${role} NOBYPASSRLS;`
    );
  }

  const ownedTenantTables = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT count(*)::bigint AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND pg_get_userbyid(c.relowner) = current_user
  `);

  const owned = Number(ownedTenantTables[0]?.count ?? 0);
  if (owned > 0) {
    throw new Error(
      `Refusing to start: role "${role}" owns ${owned} RLS-protected table(s). A table's owner bypasses its policies unless FORCE is set. Connect as the non-owner application role.`
    );
  }
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect();
  await pool?.end();
  client = undefined;
  pool = undefined;
}

export type { PrismaClient };
