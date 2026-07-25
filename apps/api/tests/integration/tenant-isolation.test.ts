/**
 * THE most important test file in this repository.
 *
 * It seeds two organizations and asserts that a connection scoped to one can
 * never see or write the other's rows. Every new tenant table should gain a
 * case here — RLS produces no error when it is missing, so this suite is the
 * only thing standing between a forgotten policy and a cross-clinic data leak.
 *
 * Runs against a real Postgres with real migrations. Never mock Prisma here.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const ORG_A = '11111111-1111-1111-1111-11111111aaaa';
const ORG_B = '22222222-2222-2222-2222-22222222bbbb';
const BRANCH_A = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const BRANCH_B1 = 'bbbbbbbb-0000-0000-0000-0000000000b1';
const BRANCH_B2 = 'bbbbbbbb-0000-0000-0000-0000000000b2';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
const appUrl = process.env['DATABASE_URL'];

let owner: Client;
let app: Client;

/** Run a unit of work with the tenant session variables set, as the app does. */
async function asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
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

beforeAll(async () => {
  if (!ownerUrl || !appUrl) {
    throw new Error('DATABASE_URL and DIRECT_DATABASE_URL must be set to run this suite');
  }

  owner = new Client({ connectionString: ownerUrl });
  app = new Client({ connectionString: appUrl });
  await owner.connect();
  await app.connect();

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
  await owner?.query('DELETE FROM branches WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
  await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]);
  await owner?.end();
  await app?.end();
});

describe('RLS is actually in force', () => {
  it('runs the app as a role that cannot bypass RLS', async () => {
    const { rows } = await app.query<{ super: boolean; bypass: boolean; role: string }>(
      `SELECT current_user AS role,
              (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
    );
    expect(rows[0]?.super).toBe(false);
    expect(rows[0]?.bypass).toBe(false);
  });

  it('the app role owns no tables (an owner bypasses its own policies)', async () => {
    const { rows } = await app.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
         AND pg_get_userbyid(c.relowner) = current_user`
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM branches');
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows organization A only its own branch', async () => {
    const names = await asTenant(ORG_A, async () => {
      const { rows } = await app.query<{ name: string }>('SELECT name FROM branches ORDER BY name');
      return rows.map((r) => r.name);
    });
    expect(names).toEqual(['A Main']);
  });

  it('shows organization B only its own branches', async () => {
    const names = await asTenant(ORG_B, async () => {
      const { rows } = await app.query<{ name: string }>('SELECT name FROM branches ORDER BY name');
      return rows.map((r) => r.name);
    });
    expect(names).toEqual(['B One', 'B Two']);
  });

  it('cannot read another tenant even when its id is known', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM branches WHERE id = $1', [BRANCH_B1]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a row into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO branches (id, organization_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, 'X', 'Smuggled', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects updating another tenant’s row', async () => {
    const updated = await asTenant(ORG_A, async () => {
      const res = await app.query('UPDATE branches SET name = $1 WHERE id = $2', [
        'hijacked',
        BRANCH_B1,
      ]);
      return res.rowCount;
    });
    // Invisible rows cannot be updated, so this is a silent no-op, not an error.
    expect(updated).toBe(0);
  });

  it('rejects deleting another tenant’s row', async () => {
    const deleted = await asTenant(ORG_A, async () => {
      const res = await app.query('DELETE FROM branches WHERE id = $1', [BRANCH_B1]);
      return res.rowCount;
    });
    expect(deleted).toBe(0);
  });

  it('does not leak context across transactions', async () => {
    await asTenant(ORG_B, async () => {
      await app.query('SELECT 1');
    });
    // set_config(..., true) is transaction-local, so the next statement sees nothing.
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM branches');
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('composite foreign keys', () => {
  it('prevents attaching a branch from another tenant', async () => {
    // Even the owner cannot do this — foreign keys bind every role.
    await owner.query(
      `INSERT INTO users (id, email, full_name, status, updated_at)
       VALUES ('dddddddd-0000-0000-0000-0000000000d1','iso@example.com','Iso User','ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`
    );
    await owner.query(
      `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
       VALUES ('cccccccc-0000-0000-0000-0000000000c1','dddddddd-0000-0000-0000-0000000000d1',$1,'ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A]
    );

    await expect(
      owner.query(
        `INSERT INTO membership_roles (id, membership_id, organization_id, role_id, branch_id)
         SELECT gen_random_uuid(),'cccccccc-0000-0000-0000-0000000000c1',$1,r.id,$2
         FROM roles r WHERE r.code='DOCTOR' AND r.organization_id IS NULL`,
        [ORG_A, BRANCH_B1]
      )
    ).rejects.toThrow(/foreign key constraint/i);

    await owner.query(`DELETE FROM memberships WHERE id='cccccccc-0000-0000-0000-0000000000c1'`);
    await owner.query(`DELETE FROM users WHERE id='dddddddd-0000-0000-0000-0000000000d1'`);
  });
});
