/**
 * Shared fixture for THE most important suite in this repository.
 *
 * The suite seeds two organizations and asserts that a connection scoped to one
 * can never see or write the other's rows. Every new tenant table should gain a
 * case in one of the sibling files — RLS produces no error when a policy is
 * missing, so this suite is the only thing standing between a forgotten policy
 * and a cross-clinic data leak.
 *
 * Runs against a real Postgres with real migrations. Never mock Prisma here.
 *
 * It used to be one 5,400-line file. It is now one file per domain, so a change
 * to the inventory policies reruns the inventory cases rather than all of them.
 * This module is what keeps them identical: the same two organizations, the same
 * three branches, the same two connections, seeded and torn down per file.
 *
 * Every case file must call `useIsolationHarness()` once at the top. `owner` and
 * `app` are lazy proxies over the real clients — they are imported at module load
 * and only resolve when a query runs, which is after `beforeAll` connected them.
 * A file that forgets the call gets a named error rather than `undefined.query`.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../../.env', import.meta.url).pathname });

export const ORG_A = '11111111-1111-1111-1111-11111111aaaa';
export const ORG_B = '22222222-2222-2222-2222-22222222bbbb';
export const BRANCH_A = 'aaaaaaaa-0000-0000-0000-0000000000a1';
export const BRANCH_B1 = 'bbbbbbbb-0000-0000-0000-0000000000b1';
export const BRANCH_B2 = 'bbbbbbbb-0000-0000-0000-0000000000b2';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
const appUrl = process.env['DATABASE_URL'];

let ownerClient: Client | undefined;
let appClient: Client | undefined;

/**
 * A stand-in for a client that does not exist yet.
 *
 * Case files are written against bare `owner` / `app`, which are bound at import
 * time — before `beforeAll` has connected anything. The proxy defers the lookup
 * to the moment a property is actually read, which is inside a test.
 */
function lazyClient(pick: () => Client | undefined, label: string): Client {
  return new Proxy({} as Client, {
    get(_target, property) {
      const client = pick();
      if (!client) {
        throw new Error(
          `tenant-isolation: the ${label} connection is not open. ` +
            'Call useIsolationHarness() once at the top of the case file.'
        );
      }
      const value = Reflect.get(client as object, property) as unknown;
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

/** Connects as `rcln_owner`: migrations' role, bypasses RLS. Seeds the fixtures. */
export const owner = lazyClient(() => ownerClient, 'owner');

/** Connects as `rcln_app`: the application's role, RLS enforced. The subject. */
export const app = lazyClient(() => appClient, 'app');

/** Run a unit of work with the tenant session variables set, as the app does. */
export async function asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
    const result = await fn();
    await app.query('COMMIT');
    return result;
  } catch (err) {
    await app.query('ROLLBACK');
    throw err;
  }
}

/**
 * Registers the connect/seed and teardown hooks for one case file.
 *
 * Seeding is `ON CONFLICT DO NOTHING` and teardown deletes both organizations,
 * so the files are independent in either order. Jest runs this project with
 * `maxWorkers: 1` (see jest.config.ts), which is what makes a shared pair of
 * fixed organization ids safe across files rather than a race.
 */
export function useIsolationHarness(): void {
  beforeAll(async () => {
    if (!ownerUrl || !appUrl) {
      throw new Error('DATABASE_URL and DIRECT_DATABASE_URL must be set to run this suite');
    }

    ownerClient = new Client({ connectionString: ownerUrl });
    appClient = new Client({ connectionString: appUrl });
    await ownerClient.connect();
    await appClient.connect();

    await owner.query(
      `INSERT INTO organizations (id, slug, legal_name, display_name, org_type, status, updated_at)
     VALUES ($1,'iso-a','Isolation A','Isolation A','CLINIC','ACTIVE',now()),
            ($2,'iso-b','Isolation B','Isolation B','HOSPITAL','ACTIVE',now())
     ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO branches (id, organization_id, code, name, updated_at)
     VALUES ($1,$4,'MAIN','A Main',now()),
            ($2,$5,'B1','B One',now()),
            ($3,$5,'B2','B Two',now())
     ON CONFLICT (id) DO NOTHING`,
      [BRANCH_A, BRANCH_B1, BRANCH_B2, ORG_A, ORG_B]
    );
  });

  afterAll(async () => {
    await ownerClient?.query('DELETE FROM branches WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await ownerClient?.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]);
    await ownerClient?.end();
    await appClient?.end();
    ownerClient = undefined;
    appClient = undefined;
  });
}
