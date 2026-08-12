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

/**
 * Parent-scoped children (migration 20260726090000).
 *
 * Four tables carry no organization_id and are isolated through their parent
 * instead. They were exempt from RLS until Phase 1 needed to write to them, on
 * the reasoning that nothing reaches them except a nested write on a scoped
 * parent — true of the code, enforced by nothing.
 *
 * These cases are what make that enforcement real, so they must fail without
 * the migration. If they pass with the policies dropped, they are asserting the
 * wrong thing.
 */
describe('parent-scoped children', () => {
  const USER_C = 'dddddddd-0000-0000-0000-0000000000d7';
  const MEM_A = 'cccccccc-0000-0000-0000-0000000000c7';
  const MEM_B = 'cccccccc-0000-0000-0000-0000000000c8';
  const INV_A = 'eeeeeeee-0000-0000-0000-0000000000ea';
  const INV_B = 'eeeeeeee-0000-0000-0000-0000000000eb';

  const countIn = async (table: string): Promise<number> => {
    const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    return Number(rows[0]?.count);
  };

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, email, full_name, status, updated_at)
       VALUES ($1,'child-iso@example.com','Child Iso','ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [USER_C]
    );
    await owner.query(
      `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
       VALUES ($1,$3,$4,'ACTIVE',now()), ($2,$3,$5,'ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [MEM_A, MEM_B, USER_C, ORG_A, ORG_B]
    );

    // One row per child table in each organization.
    await owner.query(
      `INSERT INTO branch_operating_hours (id, branch_id, day_of_week, opens_at, closes_at)
       VALUES (gen_random_uuid(),$1,1,'09:00','17:00'),
              (gen_random_uuid(),$2,1,'10:00','18:00')
       ON CONFLICT (branch_id, day_of_week) DO NOTHING`,
      [BRANCH_A, BRANCH_B1]
    );
    await owner.query(
      `INSERT INTO branch_closures (id, branch_id, closure_date, reason)
       VALUES (gen_random_uuid(),$1,'2026-01-26','Republic Day'),
              (gen_random_uuid(),$2,'2026-01-26','Republic Day')
       ON CONFLICT (branch_id, closure_date) DO NOTHING`,
      [BRANCH_A, BRANCH_B1]
    );
    await owner.query(
      `INSERT INTO invitations (id, organization_id, email, role_id, token, invited_by, expires_at)
       SELECT $1,$2,'inv-a@example.com',r.id,'token-iso-a',$3,now() + interval '7 days'
       FROM roles r WHERE r.code='DOCTOR' AND r.organization_id IS NULL
       ON CONFLICT (id) DO NOTHING`,
      [INV_A, ORG_A, USER_C]
    );
    await owner.query(
      `INSERT INTO invitations (id, organization_id, email, role_id, token, invited_by, expires_at)
       SELECT $1,$2,'inv-b@example.com',r.id,'token-iso-b',$3,now() + interval '7 days'
       FROM roles r WHERE r.code='DOCTOR' AND r.organization_id IS NULL
       ON CONFLICT (id) DO NOTHING`,
      [INV_B, ORG_B, USER_C]
    );
    await owner.query(
      `INSERT INTO invitation_branches (id, invitation_id, branch_id)
       VALUES (gen_random_uuid(),$1,$3), (gen_random_uuid(),$2,$4)
       ON CONFLICT (invitation_id, branch_id) DO NOTHING`,
      [INV_A, INV_B, BRANCH_A, BRANCH_B1]
    );
    await owner.query(
      `INSERT INTO staff_profiles (id, membership_id, employee_code)
       VALUES (gen_random_uuid(),$1,'EMP-A'), (gen_random_uuid(),$2,'EMP-B')
       ON CONFLICT (membership_id) DO NOTHING`,
      [MEM_A, MEM_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM invitation_branches WHERE invitation_id = ANY($1)', [
      [INV_A, INV_B],
    ]);
    await owner.query('DELETE FROM invitations WHERE id = ANY($1)', [[INV_A, INV_B]]);
    await owner.query('DELETE FROM staff_profiles WHERE membership_id = ANY($1)', [[MEM_A, MEM_B]]);
    await owner.query('DELETE FROM memberships WHERE id = ANY($1)', [[MEM_A, MEM_B]]);
    await owner.query('DELETE FROM users WHERE id = $1', [USER_C]);
  });

  it.each([
    ['branch_operating_hours'],
    ['branch_closures'],
    ['invitation_branches'],
    ['staff_profiles'],
  ])('%s fails closed with no tenant context', async (table) => {
    expect(await countIn(table)).toBe(0);
  });

  it.each([
    ['branch_operating_hours'],
    ['branch_closures'],
    ['invitation_branches'],
    ['staff_profiles'],
  ])('%s shows each tenant exactly its own row', async (table) => {
    expect(await asTenant(ORG_A, () => countIn(table))).toBe(1);
    expect(await asTenant(ORG_B, () => countIn(table))).toBe(1);
  });

  it('cannot read another tenant’s operating hours by branch id', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT id FROM branch_operating_hours WHERE branch_id = $1',
        [BRANCH_B1]
      );
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects inserting operating hours onto another tenant’s branch', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO branch_operating_hours (id, branch_id, day_of_week, opens_at, closes_at)
           VALUES (gen_random_uuid(), $1, 5, '00:00', '23:59')`,
          [BRANCH_B1]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects updating another tenant’s operating hours by primary key', async () => {
    // The failure mode this whole migration exists for: an update addressed by
    // the child's own id, never touching the parent. A silent no-op, not an error.
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM branch_operating_hours WHERE branch_id = $1',
      [BRANCH_B1]
    );
    const targetId = rows[0]?.id;
    expect(targetId).toBeDefined();

    const updated = await asTenant(ORG_A, async () => {
      const res = await app.query(
        'UPDATE branch_operating_hours SET is_closed = true WHERE id = $1',
        [targetId]
      );
      return res.rowCount;
    });
    expect(updated).toBe(0);
  });

  it('rejects deleting another tenant’s staff profile by primary key', async () => {
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM staff_profiles WHERE membership_id = $1',
      [MEM_B]
    );
    const deleted = await asTenant(ORG_A, async () => {
      const res = await app.query('DELETE FROM staff_profiles WHERE id = $1', [rows[0]?.id]);
      return res.rowCount;
    });
    expect(deleted).toBe(0);
  });

  it('rejects attaching another tenant’s branch to your own invitation', async () => {
    // invitation_branches has two tenant parents and only a plain FK on
    // branch_id, so parent_isolation on the invitation alone would let this
    // through. The branch_in_same_org RESTRICTIVE policy is what stops it.
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO invitation_branches (id, invitation_id, branch_id)
           VALUES (gen_random_uuid(), $1, $2)`,
          [INV_A, BRANCH_B2]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });
});

/**
 * The `own_membership` policy (migration 20260725170000).
 *
 * It exists because "which organizations do I belong to" cannot be tenant-scoped
 * — answering it is what establishes the tenant. Without it,
 * authSession.memberships is silently always empty.
 *
 * It is also the only policy in the system that grants anything outside a tenant
 * context, so its boundaries are worth pinning down precisely. Both conditions
 * must hold, and it must grant no writes.
 */
describe('own_membership: the identity bootstrap', () => {
  const USER_A = 'dddddddd-0000-0000-0000-0000000000da';
  const USER_B = 'dddddddd-0000-0000-0000-0000000000db';
  const MEMBERSHIP_A = 'cccccccc-0000-0000-0000-0000000000ca';

  /** Set only app.current_user, as withUserIdentity() does. */
  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  const countMemberships = async (): Promise<number> => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM memberships'
    );
    return Number(rows[0]?.count);
  };

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, email, full_name, status, updated_at)
       VALUES ($1,'own-a@example.com','Own A','ACTIVE',now()),
              ($2,'own-b@example.com','Own B','ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, USER_B]
    );
    await owner.query(
      `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
       VALUES ($1,$2,$3,'ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [MEMBERSHIP_A, USER_A, ORG_A]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM memberships WHERE id = $1', [MEMBERSHIP_A]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
  });

  it('shows a user their own membership with no tenant context', async () => {
    const count = await asUser(USER_A, countMemberships);
    expect(count).toBe(1);
  });

  it('shows a different user nothing', async () => {
    const count = await asUser(USER_B, countMemberships);
    expect(count).toBe(0);
  });

  it('switches off entirely once a tenant context exists', async () => {
    // This is the condition that keeps the blast radius at zero: every ordinary
    // request sets app.current_org, so the policy contributes nothing to it.
    await app.query('BEGIN');
    await app.query(
      `SELECT set_config('app.current_user', $1, true),
              set_config('app.current_org',  $2, true)`,
      [USER_A, ORG_B]
    );
    const count = await countMemberships();
    await app.query('COMMIT');

    expect(count).toBe(0);
  });

  it('still fails closed with no identity at all', async () => {
    expect(await countMemberships()).toBe(0);
  });

  it('grants no ability to create a membership', async () => {
    await expect(
      asUser(USER_A, () =>
        app.query(
          `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
          [USER_A, ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('grants no ability to change one', async () => {
    const updated = await asUser(USER_A, async () => {
      const res = await app.query(`UPDATE memberships SET status = 'SUSPENDED'`);
      return res.rowCount;
    });
    // FOR SELECT only — visible, but not writable.
    expect(updated).toBe(0);
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

  /**
   * `memberships.last_branch_id` remembers where someone was working, so that
   * signing in returns them there. It is a preference and the read path never
   * trusts it — but a preference that could name ANOTHER clinic's branch is a
   * cross-tenant reference stored in a tenant table, and ADR-0004 exists so that
   * "we validate it on read" is not the only thing standing in the way.
   */
  it('prevents remembering a branch from another tenant', async () => {
    await owner.query(
      `INSERT INTO users (id, email, full_name, status, updated_at)
       VALUES ('dddddddd-0000-0000-0000-0000000000d2','iso-scope@example.com','Iso Scope','ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`
    );

    // Org A's membership, pointed at org B's branch. The composite FK is
    // (organization_id, last_branch_id) -> branches (organization_id, id), so
    // this pair simply does not exist and the insert cannot be written.
    await expect(
      owner.query(
        `INSERT INTO memberships (id, user_id, organization_id, status, last_branch_id, updated_at)
         VALUES ('cccccccc-0000-0000-0000-0000000000c2','dddddddd-0000-0000-0000-0000000000d2',$1,'ACTIVE',$2,now())`,
        [ORG_A, BRANCH_B1]
      )
    ).rejects.toThrow(/foreign key constraint/i);

    await owner.query(`DELETE FROM users WHERE id='dddddddd-0000-0000-0000-0000000000d2'`);
  });
});

/**
 * `audit_logs` is append-only, and Postgres is what says so.
 *
 * The history screen is the product feature; this is the reason anyone can trust
 * it. An audit trail the application can rewrite is not evidence, and "no endpoint
 * does that" is a claim about code that a bug or a future endpoint can falsify —
 * so the guarantee is a revoked grant plus a trigger, and both are measured.
 *
 * The failure mode is silent in exactly the way a missing RLS policy is: nothing
 * errors, the trail keeps working, and history quietly becomes editable.
 */
describe('audit_logs is append-only', () => {
  const ROW = 'eeeeeeee-0000-0000-0000-0000000000e1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO audit_logs (id, organization_id, action, entity_type, entity_id, after_data)
       VALUES ($1, $2, 'CREATE', 'branch', $3, '{"name":"Before"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ROW, ORG_A, BRANCH_A]
    );
  });

  afterAll(async () => {
    // As the owner, which is the only role that can — see the exemption below.
    await owner.query(`DELETE FROM audit_logs WHERE id = $1`, [ROW]);
  });

  it('lets the app read its own tenant’s history', async () => {
    const rows = await asTenant(ORG_A, () =>
      app.query(`SELECT id FROM audit_logs WHERE id = $1`, [ROW])
    );
    expect(rows.rowCount).toBe(1);
  });

  it('shows the app nothing of another tenant’s history', async () => {
    const rows = await asTenant(ORG_B, () =>
      app.query(`SELECT id FROM audit_logs WHERE id = $1`, [ROW])
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuses an UPDATE from the app, in its own tenant', async () => {
    // In its OWN tenant, with the row visible — so this is the grant and the
    // trigger being tested, not RLS filtering the row out and reporting 0.
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `UPDATE audit_logs SET after_data = '{"name":"Rewritten"}'::jsonb WHERE id = $1`,
          [ROW]
        )
      )
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses a DELETE from the app, in its own tenant', async () => {
    await expect(
      asTenant(ORG_A, () => app.query(`DELETE FROM audit_logs WHERE id = $1`, [ROW]))
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('leaves the row exactly as it was', async () => {
    const rows = await owner.query<{ after_data: { name: string } }>(
      `SELECT after_data FROM audit_logs WHERE id = $1`,
      [ROW]
    );
    expect(rows.rows[0]?.after_data.name).toBe('Before');
  });

  /**
   * The trigger exempts the table owner, and that is deliberate — the same
   * decision as RLS being ENABLE rather than FORCE.
   *
   * Two schema behaviours depend on it: `audit_logs.actor_user_id` is ON DELETE SET
   * NULL from `users` (an UPDATE on this table), and `organization_id` is ON DELETE
   * CASCADE. Without the exemption, hard-deleting any user who had ever touched a
   * record would fail — and an actor's account going away must not take the history
   * of what they did with it.
   */
  it('still lets the owner null an actor, so a user can be deleted', async () => {
    await owner.query('BEGIN');
    try {
      const updated = await owner.query(
        `UPDATE audit_logs SET actor_user_id = NULL WHERE id = $1`,
        [ROW]
      );
      expect(updated.rowCount).toBe(1);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

/**
 * Billing.
 *
 * Five new tables, and every one of them holds something a competitor would pay
 * for: what a clinic is on, what it pays, and the tail of the instrument it pays
 * with. Three carry `organization_id` and get `tenant_isolation`; two hang off a
 * scoped parent and get `parent_isolation` — those two used to sit on the EXEMPT
 * list reading "reached via a scoped parent", which was true of the service layer
 * and enforced by nothing.
 *
 * The last block is the narrow SELECT policy a verified webhook uses to find the
 * one intent it is about. It is the only way to read a payment row without a
 * tenant context, and it must stay exactly one row wide.
 */
describe('billing tables', () => {
  const PLAN = 'ffffffff-0000-0000-0000-00000000f001';
  const PRICE = 'ffffffff-0000-0000-0000-00000000f002';
  const SUB_A = 'ffffffff-0000-0000-0000-00000000fa01';
  const SUB_B = 'ffffffff-0000-0000-0000-00000000fb01';
  const INVOICE_A = 'ffffffff-0000-0000-0000-00000000fa02';
  const INVOICE_B = 'ffffffff-0000-0000-0000-00000000fb02';
  const MANDATE_A = 'ffffffff-0000-0000-0000-00000000fa03';
  const MANDATE_B = 'ffffffff-0000-0000-0000-00000000fb03';
  const INTENT_A = 'ffffffff-0000-0000-0000-00000000fa04';
  const INTENT_B = 'ffffffff-0000-0000-0000-00000000fb04';

  const countIn = async (table: string): Promise<number> => {
    const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    return Number(rows[0]?.count);
  };

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO plans (id, code, name, updated_at)
       VALUES ($1,'ISO_TEST','Isolation Test',now()) ON CONFLICT (id) DO NOTHING`,
      [PLAN]
    );
    await owner.query(
      `INSERT INTO plan_prices (id, plan_id, currency, billing_interval, amount)
       VALUES ($1,$2,'INR','MONTH',1000) ON CONFLICT (id) DO NOTHING`,
      [PRICE, PLAN]
    );

    for (const [sub, org, invoice, mandate, intent] of [
      [SUB_A, ORG_A, INVOICE_A, MANDATE_A, INTENT_A],
      [SUB_B, ORG_B, INVOICE_B, MANDATE_B, INTENT_B],
    ] as const) {
      await owner.query(
        `INSERT INTO payment_mandates
           (id, organization_id, provider, provider_mandate_id, currency, max_amount, updated_at)
         VALUES ($1,$2,'mock',$3,'INR',3000,now()) ON CONFLICT (id) DO NOTHING`,
        [mandate, org, mandate]
      );
      await owner.query(
        `INSERT INTO subscriptions
           (id, organization_id, plan_id, plan_price_id, currency,
            current_period_start, current_period_end, updated_at)
         VALUES ($1,$2,$3,$4,'INR',now(),now() + interval '30 days',now())
         ON CONFLICT (id) DO NOTHING`,
        [sub, org, PLAN, PRICE]
      );
      await owner.query(
        `INSERT INTO subscription_invoices
           (id, organization_id, subscription_id, invoice_number, period_start, period_end,
            currency, subtotal, total, updated_at)
         VALUES ($1,$2,$3,$4,current_date,current_date + 30,'INR',1000,1000,now())
         ON CONFLICT (id) DO NOTHING`,
        [invoice, org, sub, `ISO-${invoice.slice(-6)}`]
      );
      await owner.query(
        `INSERT INTO subscription_invoice_lines
           (id, subscription_invoice_id, description, unit_amount, line_total)
         VALUES (gen_random_uuid(),$1,'Isolation Test',1000,1000)`,
        [invoice]
      );
      await owner.query(
        `INSERT INTO subscription_payments
           (id, subscription_invoice_id, amount, currency, gateway, gateway_payment_id)
         VALUES (gen_random_uuid(),$1,1000,'INR','mock',$2)`,
        [invoice, `pay-${invoice.slice(-6)}`]
      );
      await owner.query(
        `INSERT INTO subscription_feature_overrides (id, subscription_id, feature_key, int_value)
         VALUES (gen_random_uuid(),$1,'max_branches',99)
         ON CONFLICT (subscription_id, feature_key) DO NOTHING`,
        [sub]
      );
      await owner.query(
        `INSERT INTO payment_intents
           (id, organization_id, subscription_id, subscription_invoice_id, provider,
            provider_charge_id, purpose, amount, currency, description, updated_at)
         VALUES ($1,$2,$3,$4,'mock',$5,'SUBSCRIPTION_START',1000,'INR','Isolation Test',now())
         ON CONFLICT (id) DO NOTHING`,
        [intent, org, sub, invoice, intent]
      );
      await owner.query(
        `INSERT INTO subscription_changes
           (id, organization_id, subscription_id, change_type, currency, effective_at)
         VALUES (gen_random_uuid(),$1,$2,'SUBSCRIBE','INR',now())`,
        [org, sub]
      );
    }
  });

  afterAll(async () => {
    await owner.query('DELETE FROM subscription_changes WHERE subscription_id = ANY($1)', [
      [SUB_A, SUB_B],
    ]);
    await owner.query('DELETE FROM payment_intents WHERE id = ANY($1)', [[INTENT_A, INTENT_B]]);
    await owner.query('DELETE FROM subscription_invoices WHERE id = ANY($1)', [
      [INVOICE_A, INVOICE_B],
    ]);
    await owner.query('DELETE FROM subscriptions WHERE id = ANY($1)', [[SUB_A, SUB_B]]);
    await owner.query('DELETE FROM payment_mandates WHERE id = ANY($1)', [[MANDATE_A, MANDATE_B]]);
    await owner.query('DELETE FROM plan_prices WHERE id = $1', [PRICE]);
    await owner.query('DELETE FROM plans WHERE id = $1', [PLAN]);
  });

  const ORG_SCOPED = [
    ['subscriptions'],
    ['subscription_invoices'],
    ['subscription_changes'],
    ['payment_mandates'],
    ['payment_intents'],
  ] as const;

  const PARENT_SCOPED = [
    ['subscription_invoice_lines'],
    ['subscription_payments'],
    ['subscription_feature_overrides'],
  ] as const;

  it.each([...ORG_SCOPED, ...PARENT_SCOPED])(
    '%s fails closed with no tenant context',
    async (table) => {
      expect(await countIn(table)).toBe(0);
    }
  );

  it.each([...ORG_SCOPED, ...PARENT_SCOPED])(
    '%s shows each tenant exactly its own row',
    async (table) => {
      expect(await asTenant(ORG_A, () => countIn(table))).toBe(1);
      expect(await asTenant(ORG_B, () => countIn(table))).toBe(1);
    }
  );

  it('does not leak another tenant’s invoice by primary key', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM subscription_invoices WHERE id = $1', [
        INVOICE_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('does not leak another tenant’s payment instrument by primary key', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT instrument_label FROM subscription_payments WHERE gateway_payment_id = $1',
        [`pay-${INVOICE_B.slice(-6)}`]
      );
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('refuses to write a payment intent into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO payment_intents
             (id, organization_id, provider, purpose, amount, currency, description, updated_at)
           VALUES (gen_random_uuid(),$1,'mock','SUBSCRIPTION_START',1,'INR','x',now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to mark another tenant’s invoice paid', async () => {
    const updated = await asTenant(ORG_A, async () => {
      const result = await app.query(
        `UPDATE subscription_invoices SET status = 'PAID' WHERE id = $1`,
        [INVOICE_B]
      );
      return result.rowCount;
    });
    // Silently zero rather than an error — the row is simply not visible. That
    // is exactly why this suite exists: nothing would have complained.
    expect(updated).toBe(0);
  });

  it('cannot attach another tenant’s mandate to your own subscription', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE subscriptions SET mandate_id = $1 WHERE id = $2', [MANDATE_B, SUB_A])
      )
    ).rejects.toThrow();
  });

  /**
   * The webhook reference lookup.
   *
   * A public endpoint has to find the one intent a verified delivery names, with
   * no tenant context to do it under. The policy that allows it is narrowed on
   * both axes — the exact uuid, and only with no tenant claimed — and these cases
   * are what stop it widening into "read any payment row without a tenant".
   */
  describe('webhook reference lookup', () => {
    const LOOKUP_INTENT = INTENT_A;
    const OTHER_INTENT = INTENT_B;

    async function asWebhook<T>(reference: string, fn: () => Promise<T>): Promise<T> {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.payment_reference', $1, true)`, [reference]);
        const result = await fn();
        await app.query('COMMIT');
        return result;
      } catch (err) {
        await app.query('ROLLBACK');
        throw err;
      }
    }

    const read = async (id: string): Promise<number> => {
      const { rows } = await app.query(
        'SELECT organization_id FROM payment_intents WHERE id = $1',
        [id]
      );
      return rows.length;
    };

    const readAll = async (): Promise<number> => {
      const { rows } = await app.query('SELECT id FROM payment_intents');
      return rows.length;
    };

    it('finds the one intent it names', async () => {
      expect(await asWebhook(LOOKUP_INTENT, () => read(LOOKUP_INTENT))).toBe(1);
    });

    it('grants nothing beyond that single row', async () => {
      // The whole point: naming one reference must not open the table.
      expect(await asWebhook(LOOKUP_INTENT, () => readAll())).toBe(1);
      expect(await asWebhook(LOOKUP_INTENT, () => read(OTHER_INTENT))).toBe(0);
    });

    it('switches off entirely once a tenant context exists', async () => {
      // PERMISSIVE policies OR together, so this is what stops the lookup widening
      // an ordinary request. Org B's intent stays invisible inside org A.
      const found = await asTenant(ORG_A, async () => {
        await app.query(`SELECT set_config('app.payment_reference', $1, true)`, [OTHER_INTENT]);
        return read(OTHER_INTENT);
      });
      expect(found).toBe(0);
    });

    it('grants no ability to write', async () => {
      const updated = await asWebhook(LOOKUP_INTENT, async () => {
        const result = await app.query(
          `UPDATE payment_intents SET status = 'SUCCEEDED' WHERE id = $1`,
          [LOOKUP_INTENT]
        );
        return result.rowCount;
      });
      expect(updated).toBe(0);
    });
  });

  /*
   * tax_registrations: the one table here where the DANGER IS THE OPPOSITE.
   *
   * Everywhere else in this file the failure is a tenant seeing rows it should
   * not. Here it is the application seeing NOTHING: the table says where rcln
   * itself is registered to collect tax, it has no organization_id, and the tax
   * engine reads it from inside a tenant transaction while issuing an invoice.
   *
   * If it ever gained a policy — added by reflex, because "every table needs
   * one" — that read would match zero rows. Zero rows means NOT_REGISTERED,
   * NOT_REGISTERED means no tax, and every invoice would quietly come out
   * untaxed with nothing failing anywhere. That is a revenue and compliance bug
   * that no single-tenant test would catch, which is exactly why it is pinned.
   */
  describe('tax_registrations stays readable inside a tenant context', () => {
    beforeAll(async () => {
      /*
       * `ZZ` on purpose: it is user-assigned in ISO 3166, so no real
       * registration can ever occupy it.
       *
       * The first version used IN/KA/GST with `ON CONFLICT DO NOTHING`, which
       * collided with a genuine registration an operator had added through the
       * console — the insert silently did nothing and the assertion failed on
       * data that was perfectly correct. A fixture must not compete with real
       * rows for a unique key.
       */
      await owner.query(`DELETE FROM tax_registrations WHERE country_code = 'ZZ'`);
      await owner.query(
        `INSERT INTO tax_registrations
           (id, country_code, region_code, scheme, registration_number,
            standard_rate_bps, effective_from, created_at, updated_at)
         VALUES (gen_random_uuid(), 'ZZ', NULL, 'GST', 'TEST-GSTIN', 1800, CURRENT_DATE, now(), now())`
      );
    });

    afterAll(async () => {
      await owner.query(`DELETE FROM tax_registrations WHERE country_code = 'ZZ'`);
    });

    it('is visible to the app role while scoped to a tenant', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT id FROM tax_registrations WHERE registration_number = 'TEST-GSTIN'`
        );
        return rows.length;
      });

      // One row, from inside org A's context. If this is ever 0, tax silently
      // stops being charged everywhere — read the comment above before "fixing".
      expect(found).toBe(1);
    });

    it('is the same set of rows for every tenant', async () => {
      // It describes the supplier, not the customer. Two clinics must not see
      // different registrations, or two invoices for the same supply disagree.
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM tax_registrations');
        return rows.length;
      });
      const forB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query('SELECT id FROM tax_registrations');
        return rows.length;
      });

      expect(forA).toBe(forB);
      expect(forA).toBeGreaterThan(0);
    });
  });
});

/**
 * The Stage 1 spine: number_sequences and data_access_logs.
 *
 * Both are org-scoped and both matter for different reasons.
 *
 *   number_sequences hands out UHIDs and MRNs. A leak across the boundary is
 *   not a read of PHI — it is worse in one specific way: clinic A incrementing
 *   clinic B's counter makes B's next patient number jump, and neither clinic
 *   can explain why.
 *
 *   data_access_logs is the record of who read whose chart. A tenant that could
 *   read another's rows would learn which patients that clinic treats from the
 *   trail built to protect them, and one that could write into another's would
 *   be able to forge an alibi.
 */
describe('number_sequences', () => {
  const SEQ_A = 'eeeeeeee-0000-0000-0000-0000000000e1';
  const SEQ_B = 'eeeeeeee-0000-0000-0000-0000000000e2';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO number_sequences
         (id, organization_id, branch_id, sequence_type, period_key, prefix, padding, last_number, updated_at)
       VALUES ($1, $2, NULL, 'UHID', '', 'P', 6, 41, now()),
              ($3, $4, NULL, 'UHID', '', 'P', 6, 7,  now())
       ON CONFLICT DO NOTHING`,
      [SEQ_A, ORG_A, SEQ_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM number_sequences WHERE id = ANY($1)', [[SEQ_A, SEQ_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM number_sequences'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each organization only its own counter', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query<{ last_number: string }>(
        'SELECT last_number FROM number_sequences'
      );
      return rows.map((r) => Number(r.last_number));
    });
    const forB = await asTenant(ORG_B, async () => {
      const { rows } = await app.query<{ last_number: string }>(
        'SELECT last_number FROM number_sequences'
      );
      return rows.map((r) => Number(r.last_number));
    });

    expect(forA).toEqual([41]);
    expect(forB).toEqual([7]);
  });

  it('cannot read another tenant even when its id is known', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM number_sequences WHERE id = $1', [SEQ_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a counter into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO number_sequences
             (id, organization_id, branch_id, sequence_type, period_key, prefix, padding, last_number, updated_at)
           VALUES (gen_random_uuid(), $1, NULL, 'MRN', '', 'X', 6, 1, now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot advance another tenant's counter", async () => {
    // The concrete harm: B's next patient number jumps and nobody can say why.
    const updated = await asTenant(ORG_A, async () => {
      const res = await app.query(
        'UPDATE number_sequences SET last_number = last_number + 100 WHERE id = $1',
        [SEQ_B]
      );
      return res.rowCount;
    });
    expect(updated).toBe(0);

    const { rows } = await owner.query<{ last_number: string }>(
      'SELECT last_number FROM number_sequences WHERE id = $1',
      [SEQ_B]
    );
    expect(Number(rows[0]?.last_number)).toBe(7);
  });
});

describe('data_access_logs', () => {
  const DAL_A = 'ffffffff-0000-0000-0000-0000000000f1';
  const DAL_B = 'ffffffff-0000-0000-0000-0000000000f2';
  const PATIENT_B = 'ffffffff-0000-0000-0000-0000000000b9';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO data_access_logs
         (id, organization_id, patient_id, access_type, resource, result_count)
       VALUES ($1, $2, NULL,  'VIEW', 'PATIENT', 1),
              ($3, $4, $5,    'VIEW', 'PATIENT', 1)
       ON CONFLICT DO NOTHING`,
      [DAL_A, ORG_A, DAL_B, ORG_B, PATIENT_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM data_access_logs WHERE id = ANY($1)', [[DAL_A, DAL_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM data_access_logs'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each organization only its own trail', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM data_access_logs');
      return rows.length;
    });
    expect(forA).toBe(1);
  });

  it('cannot learn which patients another clinic treats', async () => {
    // The specific disclosure: the trail built to protect patients would
    // otherwise name them to a competitor.
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT patient_id FROM data_access_logs WHERE patient_id IS NOT NULL'
      );
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a read-record into another tenant', async () => {
    // Forging an alibi: "someone at clinic B looked at this, not me".
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO data_access_logs
             (id, organization_id, access_type, resource, result_count)
           VALUES (gen_random_uuid(), $1, 'VIEW', 'PATIENT', 1)`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * Append-only, measured from INSIDE the tenant with the row visible.
   *
   * An out-of-context attempt reports 0 rows and proves nothing — it would pass
   * just as happily against a table with no protection at all. These two run
   * with app.current_org set to the row's own organization, so the refusal is a
   * real refusal.
   */
  it('refuses UPDATE from the app role with the row visible', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE data_access_logs SET result_count = 999 WHERE id = $1', [DAL_A])
      )
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses DELETE from the app role with the row visible', async () => {
    await expect(
      asTenant(ORG_A, () => app.query('DELETE FROM data_access_logs WHERE id = $1', [DAL_A]))
    ).rejects.toThrow(/permission denied|append-only/i);

    const { rows } = await owner.query('SELECT id FROM data_access_logs WHERE id = $1', [DAL_A]);
    expect(rows).toHaveLength(1);
  });
});

/**
 * Doctors, and the two policies that are easy to get subtly wrong.
 *
 *   1. `specialties` and `qualifications` are a PLATFORM catalogue with
 *      per-tenant extension. The policy is read-permissive and WRITE-STRICT,
 *      which is NOT the policy on `files`. Copying the `files` one would let any
 *      clinic insert a row with organization_id NULL — instantly visible to
 *      every other tenant on the platform. That case is measured below.
 *   2. The doctor join tables point at TWO parents, and only the doctor side is
 *      covered by tenant_isolation. Without the RESTRICTIVE `specialty_visible`
 *      policy a clinic could attach another clinic's private specialty to its
 *      own doctor and read the name back out of it.
 */
describe('doctors', () => {
  const DOC_USER_A = 'dddddddd-1111-4111-8111-0000000000a1';
  const DOC_USER_B = 'dddddddd-1111-4111-8111-0000000000b1';
  const DOC_A = 'dddddddd-2222-4222-8222-0000000000a1';
  const DOC_B = 'dddddddd-2222-4222-8222-0000000000b1';
  const SPEC_PLATFORM = 'dddddddd-3333-4333-8333-000000000001';
  const SPEC_PRIVATE_B = 'dddddddd-3333-4333-8333-0000000000b1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Iso Doc A', 'iso-doc-a@example.test', now()),
              ($2, 'Iso Doc B', 'iso-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [DOC_USER_A, DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [DOC_A, ORG_A, DOC_USER_A, DOC_B, ORG_B, DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO specialties (id, organization_id, code, name, updated_at)
       VALUES ($1, NULL, 'ISO_PLATFORM', 'Iso Platform', now()),
              ($2, $3,   'ISO_PRIVATE_B', 'Iso Private B', now())
       ON CONFLICT DO NOTHING`,
      [SPEC_PLATFORM, SPEC_PRIVATE_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[DOC_A, DOC_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[DOC_USER_A, DOC_USER_B]]);
    await owner.query('DELETE FROM specialties WHERE id = ANY($1)', [
      [SPEC_PLATFORM, SPEC_PRIVATE_B],
    ]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM doctor_profiles'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each organization only its own doctors', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM doctor_profiles');
      return rows.map((r) => (r as { id: string }).id);
    });
    expect(forA).toEqual([DOC_A]);
  });

  it('cannot read another tenant’s doctor even when its id is known', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM doctor_profiles WHERE id = $1', [DOC_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a doctor into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, now())`,
          [ORG_B, DOC_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  describe('the platform catalogue', () => {
    it('lets every tenant read the platform rows', async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(`SELECT id FROM specialties WHERE code = 'ISO_PLATFORM'`);
        return rows.length;
      });
      expect(forA).toBe(1);
    });

    it("hides one tenant's private specialty from another", async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(`SELECT id FROM specialties WHERE code = 'ISO_PRIVATE_B'`);
        return rows.length;
      });
      expect(forA).toBe(0);
    });

    /*
     * THE case. A permissive WITH CHECK — the one `files` uses — would let this
     * succeed, and the row would be visible to every tenant on the platform.
     * Nothing else in the system would notice: it is a valid insert into a table
     * the caller is allowed to write.
     */
    it('refuses a tenant writing a PLATFORM-WIDE specialty', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO specialties (id, organization_id, code, name, updated_at)
             VALUES (gen_random_uuid(), NULL, 'SNEAKY_PLATFORM', 'Sneaky', now())`
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('allows a tenant writing its own specialty', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO specialties (id, organization_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, 'ISO_OWN_A', 'Iso Own A', now())`,
          [ORG_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM specialties WHERE code = 'ISO_OWN_A'`);
    });
  });

  describe('the second parent of a join table', () => {
    /*
     * `doctor_specialties.specialty_id` is a plain FK, because a specialty may
     * be a platform row with no organization_id to compose with. tenant_isolation
     * therefore constrains only the DOCTOR side — the RESTRICTIVE
     * `specialty_visible` policy is the entire control on the SPECIALTY side.
     */
    it("refuses attaching another tenant's private specialty to your own doctor", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            // `updated_at` is supplied even though this INSERT is meant to fail:
            // without it the statement can also fail on the NOT NULL constraint,
            // and a test asserting /row-level security/ that passes for a
            // different reason is a test that would keep passing after the
            // policy was dropped.
            `INSERT INTO doctor_specialties
               (id, organization_id, doctor_profile_id, specialty_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, now())`,
            [ORG_A, DOC_A, SPEC_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('allows attaching a platform specialty', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO doctor_specialties
             (id, organization_id, doctor_profile_id, specialty_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now())`,
          [ORG_A, DOC_A, SPEC_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
    });
  });

  /**
   * The taxonomy tree's structural guards, at the DATABASE, under a tenant
   * connection. The service checks these first and returns friendlier errors —
   * these tests exist because the service is not the only thing that writes
   * here, and because a guard nobody exercises is a guard nobody notices losing.
   */
  describe('the classification tree cannot be corrupted', () => {
    const SPEC_A_PARENT = 'dddddddd-3333-4333-8333-0000000000a2';
    const SPEC_A_CHILD = 'dddddddd-3333-4333-8333-0000000000a3';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO specialties (id, organization_id, parent_id, code, name, updated_at)
         VALUES ($1, $2, NULL, 'ISO_TREE_PARENT', 'Iso Tree Parent', now()),
                ($3, $2, $1,   'ISO_TREE_CHILD',  'Iso Tree Child',  now())
         ON CONFLICT DO NOTHING`,
        [SPEC_A_PARENT, ORG_A, SPEC_A_CHILD]
      );
    });

    afterAll(async () => {
      // Child first: parent_id is ON DELETE RESTRICT, which is the point.
      await owner.query('DELETE FROM specialties WHERE id = $1', [SPEC_A_CHILD]);
      await owner.query('DELETE FROM specialties WHERE id = $1', [SPEC_A_PARENT]);
    });

    it('refuses a node that is its own parent', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query('UPDATE specialties SET parent_id = id WHERE id = $1', [SPEC_A_PARENT])
        )
      ).rejects.toThrow(/its own parent/i);
    });

    /*
     * A cycle is not a bad row, it is a hang: `WITH RECURSIVE` spins on A -> B
     * -> A until the statement timeout, so every ancestor walk and every
     * breadcrumb render stops working at once.
     */
    it('refuses a cycle through a descendant', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query('UPDATE specialties SET parent_id = $1 WHERE id = $2', [
            SPEC_A_CHILD,
            SPEC_A_PARENT,
          ])
        )
      ).rejects.toThrow(/descendant of itself/i);
    });

    it('refuses to delete a node that still has children, rather than orphaning them', async () => {
      /*
       * ⚠️ THE FK IS `ON DELETE RESTRICT`, NOT `SET NULL`. Under SET NULL this
       *   DELETE succeeded and silently promoted the child to a ROOT — it would
       *   render beside "Medical" as though it were a clinical domain, with no
       *   error anywhere.
       */
      await expect(
        asTenant(ORG_A, () => app.query('DELETE FROM specialties WHERE id = $1', [SPEC_A_PARENT]))
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it('refuses two live siblings with the same name, ignoring case', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO specialties (id, organization_id, parent_id, code, name, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'ISO_TREE_DUP', 'iso tree child', now())`,
            [ORG_A, SPEC_A_PARENT]
          )
        )
      ).rejects.toThrow(/specialties_sibling_name_key/i);
    });

    /*
     * The scoping half. Without this the suite would pass against a GLOBAL
     * unique on name, which would be wrong: two domains legitimately contain a
     * node of the same name, and so do two different tenants.
     */
    it('allows the same name under a different parent', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO specialties (id, organization_id, parent_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, NULL, 'ISO_TREE_SAME_NAME', 'Iso Tree Child', now())`,
          [ORG_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM specialties WHERE code = 'ISO_TREE_SAME_NAME'`);
    });

    /*
     * ⚠️ THE ASYMMETRY IN `tenant_isolation` IS WHAT MAKES THIS WORK, AND IT IS
     *   EASY TO TALK YOURSELF OUT OF.
     *
     *     USING      (organization_id IS NULL OR organization_id = app_current_org())
     *     WITH CHECK (organization_id = app_current_org())
     *
     *   The permissive USING clause is what lets every clinic READ the platform
     *   catalogue, and it is tempting to reason from there that an UPDATE
     *   targeting a platform row therefore passes too — the row is visible, so
     *   the update finds it. It does find it. It then fails the WITH CHECK,
     *   which is evaluated against the row AS IT WOULD BE AFTER the update, and
     *   a platform row's organization_id stays NULL.
     *
     *   So Postgres refuses it. `assertMutable` in the service is the SECOND
     *   layer, not the only one: it turns this into a 400 naming the problem
     *   instead of an opaque row-level-security error. Both are wanted; neither
     *   is redundant.
     *
     * ⚠️ THE REFUSAL NOW COMES FROM A TRIGGER, NOT FROM WITH CHECK, and this
     *   assertion changed to match. `platform_rows_immutable` fires BEFORE the
     *   policy is evaluated, so it is the first thing to say no. Everything
     *   above still holds — WITH CHECK would refuse this statement on its own,
     *   and does if the trigger is ever dropped. The trigger exists for the two
     *   cases WITH CHECK cannot reach: DELETE, and an UPDATE that rewrites
     *   organization_id. See 20260814100000_platform_rows_immutable.
     *
     *   Copying `files`' NULL-permissive WITH CHECK here would remove this
     *   protection entirely and let one clinic rename Cardiology for all of
     *   them. The schema comment on `Specialty` warns about exactly that. This
     *   test is what would catch it.
     */
    it('refuses a tenant updating a platform row', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(`UPDATE specialties SET description = 'written by a tenant' WHERE id = $1`, [
            SPEC_PLATFORM,
          ])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const check = await owner.query<{ description: string | null }>(
        'SELECT description FROM specialties WHERE id = $1',
        [SPEC_PLATFORM]
      );
      expect(check.rows[0]?.description).toBeNull();
    });

    it('still refuses a tenant INSERTING a platform-wide row', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO specialties (id, organization_id, code, name, updated_at)
             VALUES (gen_random_uuid(), NULL, 'ISO_SNEAKY_PLATFORM', 'Sneaky', now())`
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('working hours are branch-scoped as well as tenant-scoped', () => {
    const SCHED_A1 = 'dddddddd-4444-4444-8444-0000000000a1';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO doctor_schedules
           (id, organization_id, doctor_profile_id, branch_id, day_of_week,
            start_time, end_time, valid_from, updated_at)
         VALUES ($1, $2, $3, $4, 1, '09:00', '13:00', CURRENT_DATE, now())
         ON CONFLICT DO NOTHING`,
        [SCHED_A1, ORG_A, DOC_A, BRANCH_A]
      );
    });

    afterAll(async () => {
      await owner.query('DELETE FROM doctor_schedules WHERE id = $1', [SCHED_A1]);
    });

    it('is invisible with a tenant context but an empty branch scope', async () => {
      // The RESTRICTIVE branch_isolation policy ANDs with tenant_isolation, and
      // app.branch_scope defaults to {}. A context that forgets to set it sees
      // an empty week rather than an error — which is exactly how a "the doctor
      // has no hours" bug would present.
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM doctor_schedules');
        return rows.length;
      });
      expect(found).toBe(0);
    });

    it('is visible once the branch is in scope', async () => {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [ORG_A]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [`{${BRANCH_A}}`]);
      const { rows } = await app.query('SELECT id FROM doctor_schedules');
      await app.query('COMMIT');

      expect(rows).toHaveLength(1);
    });
  });
});

/**
 * Designations — the job titles a clinic hands out.
 *
 * Same platform-catalogue-plus-extension shape as `specialties`, and the same
 * policy trap: a NULL-permissive WITH CHECK would let any clinic insert a
 * platform-wide title visible to every tenant.
 *
 * The second half covers the RESTRICTIVE `designation_visible` policies. Both
 * `invitations.designation_id` and `staff_profiles.designation_id` are plain FKs
 * — a designation may be a platform row with no organization_id to compose with
 * — so each table's own isolation constrains the invitation/membership side and
 * says nothing about the designation.
 */
describe('designations', () => {
  const DESIG_PLATFORM = 'aaaaaaaa-5555-4555-8555-000000000001';
  const DESIG_PRIVATE_B = 'aaaaaaaa-5555-4555-8555-0000000000b1';
  /** An inviter, because `invitations.invited_by` is NOT NULL. */
  const INVITER = 'aaaaaaaa-6666-4666-8666-000000000001';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Iso Inviter', 'iso-inviter@example.test', now())
       ON CONFLICT DO NOTHING`,
      [INVITER]
    );
    await owner.query(
      `INSERT INTO designations (id, organization_id, code, name, updated_at)
       VALUES ($1, NULL, 'ISO_TITLE', 'Iso Title', now()),
              ($2, $3,   'ISO_TITLE_B', 'Iso Title B', now())
       ON CONFLICT DO NOTHING`,
      [DESIG_PLATFORM, DESIG_PRIVATE_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM designations WHERE id = ANY($1)', [
      [DESIG_PLATFORM, DESIG_PRIVATE_B],
    ]);
    await owner.query('DELETE FROM users WHERE id = $1', [INVITER]);
  });

  it('lets every tenant read the platform titles', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(`SELECT id FROM designations WHERE code = 'ISO_TITLE'`);
      return rows.length;
    });
    expect(forA).toBe(1);
  });

  it("hides one clinic's private title from another", async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(`SELECT id FROM designations WHERE code = 'ISO_TITLE_B'`);
      return rows.length;
    });
    expect(forA).toBe(0);
  });

  it('refuses a tenant writing a PLATFORM-WIDE title', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO designations (id, organization_id, code, name, updated_at)
           VALUES (gen_random_uuid(), NULL, 'SNEAKY_TITLE', 'Sneaky', now())`
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * The RESTRICTIVE designation_visible policy on `invitations`. Without it, a
   * clinic could point an invitation at another clinic's private title and read
   * the name back through the invite preview.
   */
  it("refuses an invitation naming another clinic's private title", async () => {
    const roleRow = await owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id IS NULL AND code = 'NURSE'`
    );

    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO invitations
             (id, organization_id, email, role_id, designation_id, token, invited_by, expires_at)
           VALUES (gen_random_uuid(), $1, 'x@example.test', $2, $3, $4, $5, now() + interval '7 days')`,
          [ORG_A, roleRow.rows[0]?.id, DESIG_PRIVATE_B, `tok-${Date.now()}`, INVITER]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows an invitation naming a platform title', async () => {
    const roleRow = await owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id IS NULL AND code = 'NURSE'`
    );

    const inserted = await asTenant(ORG_A, async () => {
      const res = await app.query(
        `INSERT INTO invitations
           (id, organization_id, email, role_id, designation_id, token, invited_by, expires_at)
         VALUES (gen_random_uuid(), $1, 'ok@example.test', $2, $3, $4, $5, now() + interval '7 days')`,
        [ORG_A, roleRow.rows[0]?.id, DESIG_PLATFORM, `tok-ok-${Date.now()}`, INVITER]
      );
      return res.rowCount;
    });

    expect(inserted).toBe(1);
    await owner.query(`DELETE FROM invitations WHERE email = 'ok@example.test'`);
  });
});

/**
 * Role ↔ title pairings.
 *
 * Two parents, both plain FKs, and one of them — `roles` — is RLS-EXEMPT. So
 * the RESTRICTIVE `role_visible` policy's organization_id test is doing the
 * whole job on its own rather than backing up a policy that would have caught
 * it anyway: without it a clinic could pair one of its titles with another
 * clinic's private role and read that role's name back through the join.
 */
describe('role_designations', () => {
  const ROLE_PRIVATE_B = 'bbbbbbbb-7777-4777-8777-0000000000b1';
  const TITLE_PLATFORM = 'bbbbbbbb-8888-4888-8888-000000000001';
  const TITLE_PRIVATE_B = 'bbbbbbbb-8888-4888-8888-0000000000b1';
  let systemRoleId: string;

  beforeAll(async () => {
    const sys = await owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id IS NULL AND code = 'NURSE'`
    );
    systemRoleId = sys.rows[0]?.id as string;

    await owner.query(
      `INSERT INTO roles (id, organization_id, code, name, scope_level, updated_at)
       VALUES ($1, $2, 'PRIVATE_B_ROLE', 'Private B Role', 'BRANCH', now())
       ON CONFLICT DO NOTHING`,
      [ROLE_PRIVATE_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO designations (id, organization_id, code, name, updated_at)
       VALUES ($1, NULL, 'RD_PLATFORM', 'RD Platform', now()),
              ($2, $3,   'RD_PRIVATE_B', 'RD Private B', now())
       ON CONFLICT DO NOTHING`,
      [TITLE_PLATFORM, TITLE_PRIVATE_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM role_designations WHERE designation_id = ANY($1)', [
      [TITLE_PLATFORM, TITLE_PRIVATE_B],
    ]);
    await owner.query('DELETE FROM designations WHERE id = ANY($1)', [
      [TITLE_PLATFORM, TITLE_PRIVATE_B],
    ]);
    await owner.query('DELETE FROM roles WHERE id = $1', [ROLE_PRIVATE_B]);
  });

  /*
   * NOT "fails closed with no context", which is the shape used for every
   * ordinary tenant table above and is the WRONG assertion here.
   *
   * This is a platform catalogue: the seeded pairings carry organization_id
   * NULL and are deliberately the same for everybody, so they are visible
   * without a tenant context exactly as `designations` and `specialties` are.
   * What must never be visible without context is a pairing a CLINIC made.
   */
  it('exposes no tenant pairing without a tenant context', async () => {
    await owner.query(
      `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [ORG_B, systemRoleId, TITLE_PLATFORM]
    );

    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM role_designations WHERE organization_id IS NOT NULL'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows the seeded platform pairings to every tenant', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM role_designations');
      return rows.length;
    });
    expect(forA).toBeGreaterThan(0);
  });

  it('refuses a tenant publishing a PLATFORM-WIDE pairing', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
           VALUES (gen_random_uuid(), NULL, $1, $2)`,
          [systemRoleId, TITLE_PLATFORM]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows a tenant pairing a platform role with a platform title', async () => {
    const inserted = await asTenant(ORG_A, async () => {
      const res = await app.query(
        `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [ORG_A, systemRoleId, TITLE_PLATFORM]
      );
      return res.rowCount;
    });
    expect(inserted).toBe(1);
  });

  /*
   * The `role_visible` case. `roles` is RLS-EXEMPT, so nothing except this
   * policy stops org A naming org B's private role.
   */
  it("refuses pairing with another clinic's private role", async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [ORG_A, ROLE_PRIVATE_B, TITLE_PLATFORM]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses pairing with another clinic's private title", async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [ORG_A, systemRoleId, TITLE_PRIVATE_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot see another clinic's pairing", async () => {
    await owner.query(
      `INSERT INTO role_designations (id, organization_id, role_id, designation_id)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [ORG_B, systemRoleId, TITLE_PRIVATE_B]
    );

    const visible = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT id FROM role_designations WHERE designation_id = $1',
        [TITLE_PRIVATE_B]
      );
      return rows.length;
    });
    expect(visible).toBe(0);
  });
});

/**
 * Patients — PHI, and the one domain where the branch boundary deliberately
 * does NOT fall where it falls everywhere else.
 *
 * ⚠️ `patients` HAS NO `branch_isolation` POLICY, ON PURPOSE (ADR-0016). The
 * cases below assert the ABSENCE as deliberately as they assert the presence,
 * because "add branch_isolation to patients for consistency" is exactly the
 * change that looks like a security improvement and produces duplicate records
 * with empty allergy lists.
 *
 * What IS branch-local is `patient_registrations` — attendance, not identity —
 * and its RESTRICTIVE policy is the whole control on which clinic's patient
 * list a receptionist can read.
 *
 * The five history/detail tables are org-scoped for the same reason as
 * `patients`: an allergy follows the person to whichever branch they walk into.
 */
describe('patients', () => {
  const PATIENT_A = 'eeeeeeee-1111-4111-8111-0000000000a1';
  const PATIENT_B = 'eeeeeeee-1111-4111-8111-0000000000b1';
  /** Registered at B2 only, so B1's scope must not see the registration. */
  const REG_B2 = 'eeeeeeee-2222-4222-8222-0000000000b2';
  const ALLERGY_B = 'eeeeeeee-3333-4333-8333-0000000000b1';
  const CONDITION_B = 'eeeeeeee-4444-4444-8444-0000000000b1';
  const MEDICATION_B = 'eeeeeeee-5555-4555-8555-0000000000b1';
  const ADDRESS_B = 'eeeeeeee-6666-4666-8666-0000000000b1';
  const CONTACT_B = 'eeeeeeee-7777-4777-8777-0000000000b1';

  /** A tenant context WITH a branch scope, which `asTenant` deliberately omits. */
  async function asTenantAtBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, updated_at)
       VALUES ($1, $2, 'ISOA0001', 'Iso', 'Patient A', now()),
              ($3, $4, 'ISOB0001', 'Iso', 'Patient B', now())
       ON CONFLICT DO NOTHING`,
      [PATIENT_A, ORG_A, PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'MRNB0001', now())
       ON CONFLICT DO NOTHING`,
      [REG_B2, ORG_B, PATIENT_B, BRANCH_B2]
    );
    await owner.query(
      `INSERT INTO patient_allergies
         (id, organization_id, patient_id, allergen_text, updated_at)
       VALUES ($1, $2, $3, 'Iso Allergen', now()) ON CONFLICT DO NOTHING`,
      [ALLERGY_B, ORG_B, PATIENT_B]
    );
    await owner.query(
      `INSERT INTO patient_conditions
         (id, organization_id, patient_id, condition_text, updated_at)
       VALUES ($1, $2, $3, 'Iso Condition', now()) ON CONFLICT DO NOTHING`,
      [CONDITION_B, ORG_B, PATIENT_B]
    );
    await owner.query(
      `INSERT INTO patient_medications
         (id, organization_id, patient_id, medicine_text, updated_at)
       VALUES ($1, $2, $3, 'Iso Medicine', now()) ON CONFLICT DO NOTHING`,
      [MEDICATION_B, ORG_B, PATIENT_B]
    );
    await owner.query(
      `INSERT INTO patient_addresses
         (id, organization_id, patient_id, line1, updated_at)
       VALUES ($1, $2, $3, 'Iso Street', now()) ON CONFLICT DO NOTHING`,
      [ADDRESS_B, ORG_B, PATIENT_B]
    );
    await owner.query(
      `INSERT INTO patient_contacts
         (id, organization_id, patient_id, relation, name, phone, updated_at)
       VALUES ($1, $2, $3, 'Spouse', 'Iso Kin', '+919999999999', now())
       ON CONFLICT DO NOTHING`,
      [CONTACT_B, ORG_B, PATIENT_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[PATIENT_A, PATIENT_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM patients');
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows each clinic only its own patients', async () => {
    const forA = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM patients WHERE id = ANY($1)', [
        [PATIENT_A, PATIENT_B],
      ]);
      return rows.map((r) => (r as { id: string }).id);
    });
    expect(forA).toEqual([PATIENT_A]);
  });

  it('cannot read another clinic’s patient even when its id is known', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM patients WHERE id = $1', [PATIENT_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects writing a patient into another clinic', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
           VALUES (gen_random_uuid(), $1, 'SNEAK0001', 'Sneaky', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * ⚠️ THE DELIBERATE ABSENCE. A patient of branch B2 is visible to a reader
   * scoped only to B1, WITHIN THE SAME CLINIC. If this ever starts returning 0,
   * someone has added branch_isolation to `patients` — and the duplicate check
   * at the front desk has silently stopped working.
   */
  it('shows a patient of another BRANCH inside the same clinic — by design', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM patients WHERE id = $1', [PATIENT_B]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  /* …while their ATTENDANCE at that branch is not. This is the boundary. */
  it('hides the registration at a branch out of scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM patient_registrations WHERE id = $1', [
        REG_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows the registration once its branch is in scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM patient_registrations WHERE id = $1', [
        REG_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  it('hides another clinic’s registration entirely', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM patient_registrations WHERE id = $1', [
        REG_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('rejects registering a patient at another clinic’s branch', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B1], () =>
        app.query(
          `INSERT INTO patient_registrations
             (id, organization_id, patient_id, branch_id, mrn, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'SNEAKMRN', now())`,
          [ORG_A, PATIENT_A, BRANCH_B1]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  describe.each([
    ['patient_allergies', ALLERGY_B],
    ['patient_conditions', CONDITION_B],
    ['patient_medications', MEDICATION_B],
    ['patient_addresses', ADDRESS_B],
    ['patient_contacts', CONTACT_B],
  ])('%s', (table, rowId) => {
    it('fails closed with no tenant context', async () => {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('is invisible to the other clinic', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(`SELECT id FROM ${table} WHERE id = $1`, [rowId]);
        return rows.length;
      });
      expect(found).toBe(0);
    });

    /*
     * Org-scoped and NOT branch-scoped: a clinical fact follows the person, and
     * a branch that could not read it would prescribe against an empty chart.
     */
    it('is visible to its own clinic regardless of branch scope', async () => {
      const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
        const { rows } = await app.query(`SELECT id FROM ${table} WHERE id = $1`, [rowId]);
        return rows.length;
      });
      expect(found).toBe(1);
    });
  });
});

/**
 * Appointments — PHI again, and the OPPOSITE branch call from `patients`.
 *
 * ⚠️ `appointments` IS branch-scoped, where `patients` deliberately is not, and
 * both are right. Identity follows the person across a hospital group so the
 * front desk can find the duplicate head office already created; ATTENDANCE
 * belongs to the clinic it happened at, and a booking is attendance. The cases
 * below assert the presence here as firmly as the patients block asserts the
 * absence there.
 *
 * `appointment_status_history` carries no `branch_id` at all. Its policy is an
 * EXISTS against `appointments`, and that subquery is itself subject to the
 * parent's RESTRICTIVE branch policy — so the boundary composes rather than
 * being restated. The last two cases are what prove the composition actually
 * happens, rather than being a comment.
 */
describe('appointments', () => {
  const APT_PATIENT_A = 'ffffffff-1111-4111-8111-0000000000a1';
  const APT_PATIENT_B = 'ffffffff-1111-4111-8111-0000000000b1';
  const APT_REG_A = 'ffffffff-2222-4222-8222-0000000000a1';
  const APT_REG_B2 = 'ffffffff-2222-4222-8222-0000000000b2';
  const APT_DOC_USER_A = 'ffffffff-3333-4333-8333-0000000000a1';
  const APT_DOC_USER_B = 'ffffffff-3333-4333-8333-0000000000b1';
  const APT_DOC_A = 'ffffffff-4444-4444-8444-0000000000a1';
  const APT_DOC_B = 'ffffffff-4444-4444-8444-0000000000b1';
  const APT_A = 'ffffffff-5555-4555-8555-0000000000a1';
  /** Booked at B2, so a reader scoped to B1 must not see it. */
  const APT_B2 = 'ffffffff-5555-4555-8555-0000000000b2';
  const HISTORY_B2 = 'ffffffff-6666-4666-8666-0000000000b2';
  /** A reading taken at B2. Same branch reasoning as the booking it hangs off. */
  const VITALS_B2 = 'ffffffff-7777-4777-8777-0000000000b2';

  async function asTenantAtBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'APTA0001', 'Apt A', now()), ($3, $4, 'APTB0001', 'Apt B', now())
       ON CONFLICT DO NOTHING`,
      [APT_PATIENT_A, ORG_A, APT_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'APTMRNA', now()), ($5, $6, $7, $8, 'APTMRNB', now())
       ON CONFLICT DO NOTHING`,
      [APT_REG_A, ORG_A, APT_PATIENT_A, BRANCH_A, APT_REG_B2, ORG_B, APT_PATIENT_B, BRANCH_B2]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Apt Doc A', 'apt-doc-a@example.test', now()),
              ($2, 'Apt Doc B', 'apt-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [APT_DOC_USER_A, APT_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [APT_DOC_A, ORG_A, APT_DOC_USER_A, APT_DOC_B, ORG_B, APT_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, appointment_number, scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ISOA000001',
               '2027-06-01T04:00:00Z', '2027-06-01T04:15:00Z', now()),
              ($7, $8, $9, $10, $11, $12, 'ISOB000001',
               '2027-06-01T05:00:00Z', '2027-06-01T05:15:00Z', now())
       ON CONFLICT DO NOTHING`,
      [
        APT_A,
        ORG_A,
        BRANCH_A,
        APT_PATIENT_A,
        APT_REG_A,
        APT_DOC_A,
        APT_B2,
        ORG_B,
        BRANCH_B2,
        APT_PATIENT_B,
        APT_REG_B2,
        APT_DOC_B,
      ]
    );
    await owner.query(
      `INSERT INTO appointment_status_history
         (id, organization_id, appointment_id, to_status)
       VALUES ($1, $2, $3, 'BOOKED') ON CONFLICT DO NOTHING`,
      [HISTORY_B2, ORG_B, APT_B2]
    );
    await owner.query(
      `INSERT INTO appointment_vitals
         (id, organization_id, branch_id, appointment_id, patient_id,
          systolic_mm_hg, diastolic_mm_hg, updated_at)
       VALUES ($1, $2, $3, $4, $5, 128, 82, now()) ON CONFLICT DO NOTHING`,
      [VITALS_B2, ORG_B, BRANCH_B2, APT_B2, APT_PATIENT_B]
    );
  });

  afterAll(async () => {
    // Before the appointments — the FK is ON DELETE CASCADE, but deleting the
    // child explicitly keeps this teardown readable as the inverse of the setup.
    await owner.query('DELETE FROM appointment_vitals WHERE id = ANY($1)', [[VITALS_B2]]);
    await owner.query('DELETE FROM appointments WHERE id = ANY($1)', [[APT_A, APT_B2]]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[APT_DOC_A, APT_DOC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[APT_PATIENT_A, APT_PATIENT_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[APT_DOC_USER_A, APT_DOC_USER_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM appointments'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides another clinic’s booking entirely', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointments WHERE id = $1', [APT_B2]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /* The presence, where `patients` asserts the absence. */
  it('hides a booking at a branch out of scope, inside the same clinic', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM appointments WHERE id = $1', [APT_B2]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows the booking once its branch is in scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointments WHERE id = $1', [APT_B2]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  it('rejects booking into another clinic’s branch', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B1], () =>
        app.query(
          `INSERT INTO appointments
             (id, organization_id, branch_id, patient_id, patient_registration_id,
              doctor_profile_id, appointment_number, scheduled_start, scheduled_end, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'SNEAK00001',
                   '2027-06-02T04:00:00Z', '2027-06-02T04:15:00Z', now())`,
          [ORG_A, BRANCH_B1, APT_PATIENT_A, APT_REG_A, APT_DOC_A]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  /*
   * The composition. The history row carries no branch of its own, so if the
   * EXISTS against `appointments` were ever replaced by a plain organization_id
   * predicate, this would start returning 1 — and a receptionist at one branch
   * could read when another branch's patients were seen.
   */
  it('hides the status trail of a booking at a branch out of scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_status_history WHERE id = $1', [
        HISTORY_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows the status trail once the booking’s branch is in scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_status_history WHERE id = $1', [
        HISTORY_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  it('hides another clinic’s status trail entirely', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_status_history WHERE id = $1', [
        HISTORY_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /*
   * Vitals — the most mechanically sensitive rows in the schema. A blood
   * pressure against a named patient needs no interpretation and no join to be a
   * clinical record, so this table gets the full four-case treatment: no
   * context, another clinic, another branch, and the branch in scope.
   *
   * ⚠️ UNLIKE `appointment_status_history`, THIS TABLE CARRIES ITS OWN
   *   `organization_id` AND `branch_id`, so it is an ordinary member of both
   *   loops in enable-rls.sql rather than an EXISTS against its parent. These
   *   cases would pass on inheritance alone, which is exactly why they are
   *   written against the table directly — a future change that drops the
   *   branch policy while keeping the org one leaves the parent's boundary
   *   intact and silently opens this one.
   */
  it('vitals fail closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM appointment_vitals'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides another clinic’s vitals entirely', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_vitals WHERE id = $1', [
        VITALS_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('hides vitals taken at a branch out of scope, inside the same clinic', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_vitals WHERE id = $1', [
        VITALS_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows vitals once their branch is in scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_vitals WHERE id = $1', [
        VITALS_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  /*
   * ⚠️ A SUPERSEDED VERSION CARRIES THE VALUES A READING USED TO HOLD, SO IT IS
   *   AS MUCH PHI AS THE READING. It lives on the same table and therefore under
   *   the same policy — which is exactly why the prior version was put HERE
   *   rather than into `audit_logs`, a table with no branch scoping at all. This
   *   asserts that the policy really does cover it rather than that it ought to.
   */
  it('hides another clinic’s superseded readings too', async () => {
    const revisionId = 'ffffffff-7777-4777-8777-0000000000r1'.replace('r', 'e');

    await owner.query(
      `INSERT INTO appointment_vitals
         (id, organization_id, branch_id, appointment_id, patient_id,
          systolic_mm_hg, diastolic_mm_hg, revision_of_id, superseded_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 180, 110, $6, now(), now()) ON CONFLICT DO NOTHING`,
      [revisionId, ORG_B, BRANCH_B2, APT_B2, APT_PATIENT_B, VITALS_B2]
    );

    try {
      const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM appointment_vitals WHERE id = $1', [
          revisionId,
        ]);
        return rows.length;
      });
      expect(found).toBe(0);
    } finally {
      await owner.query('DELETE FROM appointment_vitals WHERE id = $1', [revisionId]);
    }
  });

  /*
   * The write side. A caller scoped to B1 filing a reading against B1 — but
   * onto a booking that lives at B2 — must be refused: without the WITH CHECK
   * half of the branch policy, a reading could be planted into a visit the
   * caller cannot see, and then read back by whoever can.
   */
  it('rejects recording vitals into another clinic’s branch', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B1], () =>
        app.query(
          `INSERT INTO appointment_vitals
             (id, organization_id, branch_id, appointment_id, patient_id, pulse_bpm, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 72, now())`,
          [ORG_A, BRANCH_B1, APT_A, APT_PATIENT_A]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });
});

/*
 * The clinic's own tax position.
 *
 * ⚠️ THESE TWO TABLES ARE THE OPPOSITE DECISION FROM `tax_registrations`, WHICH
 *   IS EXEMPT FROM RLS ON PURPOSE. That one holds rcln's numbers, is read inside
 *   a tenant transaction, and a policy on it would return zero rows — which
 *   reads as NOT_REGISTERED and silently untaxes every subscription invoice.
 *   None of that applies here: these rows belong to the organization reading
 *   them. Someone who knows the exemption and not the reason for it could
 *   plausibly exempt these too, and nothing would fail — a clinic would simply
 *   start being able to read its competitor's GSTIN and its whole rate card.
 *   That is what these cases exist to catch.
 */
describe('issuer tax registrations and rules', () => {
  const REG_A = 'aaaaaaaa-7a11-4a11-8a11-000000000001';
  const REG_B = 'bbbbbbbb-7b11-4b11-8b11-000000000001';
  const RULE_B = 'bbbbbbbb-7b22-4b22-8b22-000000000001';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO issuer_tax_registrations
         (id, organization_id, country_code, region_code, scheme, registration_number,
          effective_from, updated_at)
       VALUES ($1,$3,'IN','KA','GST','29AAACR1234K1ZP','2025-04-01',now()),
              ($2,$4,'IN','KL','GST','32AAACR9999K1ZQ','2025-04-01',now())
       ON CONFLICT (id) DO NOTHING`,
      [REG_A, REG_B, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES ($1,$2,'IN','GST','MEDICINE',500,'STANDARD','GST','2025-04-01',now())
       ON CONFLICT (id) DO NOTHING`,
      [RULE_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM tax_rules WHERE id = $1', [RULE_B]);
    await owner.query('DELETE FROM issuer_tax_registrations WHERE id = ANY($1)', [[REG_A, REG_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM issuer_tax_registrations'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  /*
   * A GSTIN is the number every invoice a business issues is filed under. It is
   * not PHI, but it identifies the competitor completely and is exactly the sort
   * of row that reads as harmless configuration right up until it leaks.
   */
  it('hides another clinic’s registration', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM issuer_tax_registrations WHERE id = $1', [
        REG_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows a clinic its own registration', async () => {
    const number = await asTenant(ORG_A, async () => {
      const { rows } = await app.query<{ registration_number: string }>(
        'SELECT registration_number FROM issuer_tax_registrations WHERE id = $1',
        [REG_A]
      );
      return rows[0]?.registration_number;
    });
    expect(number).toBe('29AAACR1234K1ZP');
  });

  it('hides another clinic’s rate card', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM tax_rules WHERE id = $1', [RULE_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /*
   * The write half. Without WITH CHECK, a clinic could plant a registration
   * under another organization's id — and the invoices raised against it would
   * then carry a GSTIN belonging to somebody else.
   */
  it('rejects writing a registration into another clinic', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO issuer_tax_registrations
             (id, organization_id, country_code, scheme, registration_number,
              effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, 'IN', 'GST', '29PLANTED0000ZZ', '2025-04-01', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * ⚠️ THE LINK TABLE IS NOT EXEMPT FOR HOLDING ONLY IDS. Both of them are tenant
   *   ids, so another clinic's row says which of its branches bills under which
   *   of its registrations — the same disclosure as reading the registration
   *   itself, one join later.
   */
  describe('coverage links', () => {
    const LINK_B = 'bbbbbbbb-7b33-4b33-8b33-000000000001';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO issuer_tax_registration_branches
           (id, organization_id, tax_registration_id, branch_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO NOTHING`,
        [LINK_B, ORG_B, REG_B, BRANCH_B1]
      );
    });

    afterAll(async () => {
      await owner.query('DELETE FROM issuer_tax_registration_branches WHERE id = $1', [LINK_B]);
    });

    it('fails closed with no tenant context', async () => {
      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM issuer_tax_registration_branches'
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('hides which of another clinic’s branches bills under which registration', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          'SELECT id FROM issuer_tax_registration_branches WHERE id = $1',
          [LINK_B]
        );
        return rows.length;
      });
      expect(found).toBe(0);
    });

    it('shows a clinic its own coverage', async () => {
      const branch = await asTenant(ORG_B, async () => {
        const { rows } = await app.query<{ branch_id: string }>(
          'SELECT branch_id FROM issuer_tax_registration_branches WHERE id = $1',
          [LINK_B]
        );
        return rows[0]?.branch_id;
      });
      expect(branch).toBe(BRANCH_B1);
    });

    it('rejects writing coverage into another clinic', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO issuer_tax_registration_branches
               (id, organization_id, tax_registration_id, branch_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, now())`,
            [ORG_B, REG_B, BRANCH_B2]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    /*
     * ⚠️ THE COMPOSITE FK, WHICH IS THE LAYER BELOW RLS. Even as the owner —
     *   who bypasses every policy — a link cannot join one organization's branch
     *   to another's registration, because the tenant travels inside both keys.
     *   Without it, a bug in the service could point a Karnataka clinic's invoice
     *   at a competitor's GSTIN and no policy would notice.
     */
    it('cannot join one clinic’s branch to another clinic’s registration', async () => {
      await expect(
        owner.query(
          `INSERT INTO issuer_tax_registration_branches
             (id, organization_id, tax_registration_id, branch_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now())`,
          [ORG_A, REG_B, BRANCH_A]
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  /*
   * ⚠️ The CHECK that stops a catalogue row asserting a legal position it knows
   *   nothing about. `treatment` is the full six-value enum because Prisma
   *   cannot express a subset of one, so the database is the only thing holding
   *   the line — and the service layer casts to `ItemTaxTreatment` on the way
   *   out, trusting exactly this.
   */
  it('refuses a tax rule claiming a treatment an item cannot have', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'BOGUS', 0, 'REVERSE_CHARGE', 'GST', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_treatment_is_item_level/);
  });

  /*
   * An "EXEMPT at 18%" row is not a legal position, it is a typo — and it prints
   * an invoice line that contradicts itself.
   */
  it('refuses an untaxed treatment carrying a non-zero rate', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'BOGUS', 1800, 'EXEMPT', 'GST', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_untaxed_means_zero_rate/);
  });

  /*
   * NULLS NOT DISTINCT. A country-wide rule has a NULL region_code, and in
   * ordinary SQL two NULLs are never equal — so without it a clinic can hold any
   * number of country-wide rules for one category and one start date, and
   * `ruleFor` picks whichever the planner returns first.
   */
  it('refuses a second country-wide rule for the same category and date', async () => {
    const first = 'bbbbbbbb-7b33-4b33-8b33-000000000001';
    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES ($1,$2,'IN','GST','DUPE',500,'STANDARD','GST','2025-04-01',now())`,
      [first, ORG_B]
    );

    try {
      await expect(
        owner.query(
          `INSERT INTO tax_rules
             (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
              line_name, effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'DUPE', 1200, 'STANDARD', 'GST', '2025-04-01', now())`,
          [ORG_B]
        )
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await owner.query('DELETE FROM tax_rules WHERE id = $1', [first]);
    }
  });
  /*
   * ⚠️ A stacking rule is always regional. `stacks` means "charge this IN
   *   ADDITION to the country-wide rule for the same category" — Canada's
   *   provincial PST on top of federal GST. A country-wide rule that stacked
   *   would be both the base AND the addition, so the same rate would be charged
   *   twice on one line item and the invoice would silently overcharge.
   */
  it('refuses a country-wide rule that claims to stack', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, region_code, scheme, tax_category, rate_bps,
            treatment, line_name, stacks, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'CA', NULL, 'GST', 'MEDICINE', 700, 'STANDARD',
                 'PST', true, '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_stacking_is_regional/);
  });

  /* And the same rule scoped to a province is accepted. */
  it('accepts a regional stacking rule', async () => {
    const id = 'bbbbbbbb-7b44-4b44-8b44-000000000001';
    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, region_code, scheme, tax_category, rate_bps,
          treatment, line_name, stacks, effective_from, updated_at)
       VALUES ($1, $2, 'CA', 'BC', 'GST', 'MEDICINE', 700, 'STANDARD',
               'PST', true, '2025-04-01', now())`,
      [id, ORG_B]
    );
    await owner.query('DELETE FROM tax_rules WHERE id = $1', [id]);
  });

  /*
   * ⚠️ India's split derives `CGST`/`SGST`/`IGST` from `line_name` by prefixing,
   *   which is how those names are constructed in law. A `line_name` of
   *   'Sales Tax' would derive 'CSales Tax' and print it on an invoice.
   */
  it('refuses a split rule whose line name cannot be prefixed', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, split, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE', 1200, 'STANDARD',
                 'Sales Tax', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_split_name_is_prefixable/);
  });
});

describe('patient invoices', () => {
  const INV_PATIENT_A = 'dddddddd-1111-4111-8111-0000000000a1';
  const INV_PATIENT_B = 'dddddddd-1111-4111-8111-0000000000b1';
  const INV_REG_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const INV_REG_B2 = 'dddddddd-7777-4777-8777-0000000000b2';
  const INV_DOC_USER_A = 'dddddddd-8888-4888-8888-0000000000a1';
  const INV_DOC_USER_B = 'dddddddd-8888-4888-8888-0000000000b1';
  const INV_DOC_A = 'dddddddd-9999-4999-8999-0000000000a1';
  const INV_DOC_B = 'dddddddd-9999-4999-8999-0000000000b1';
  /** The visits the seeded invoices bill for — the new composite FK's target. */
  const INV_APT_A = 'dddddddd-aaaa-4aaa-8aaa-0000000000a1';
  const INV_APT_B2 = 'dddddddd-aaaa-4aaa-8aaa-0000000000b2';
  const INV_A = 'dddddddd-2222-4222-8222-0000000000a1';
  /** Raised at B2, so a reader scoped to B1 must not see it. */
  const INV_B2 = 'dddddddd-2222-4222-8222-0000000000b2';
  const ITEM_B2 = 'dddddddd-3333-4333-8333-0000000000b2';
  const TAX_B2 = 'dddddddd-4444-4444-8444-0000000000b2';
  const FILE_A = 'dddddddd-5555-4555-8555-0000000000a1';
  const FILE_B = 'dddddddd-5555-4555-8555-0000000000b1';
  const DOC_B2 = 'dddddddd-6666-4666-8666-0000000000b2';

  async function asTenantAtBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'INVA0001', 'Inv A', now()), ($3, $4, 'INVB0001', 'Inv B', now())
       ON CONFLICT DO NOTHING`,
      [INV_PATIENT_A, ORG_A, INV_PATIENT_B, ORG_B]
    );

    /*
     * A real visit per tenant, so the seeded invoices cite an appointment
     * through the composite FK rather than a bare uuid. Without these the
     * `invoices_source_reference_matches_type` CHECK refuses the rows outright,
     * which is the point of the constraint.
     */
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'INVMRNA', now()), ($5, $6, $7, $8, 'INVMRNB', now())
       ON CONFLICT DO NOTHING`,
      [INV_REG_A, ORG_A, INV_PATIENT_A, BRANCH_A, INV_REG_B2, ORG_B, INV_PATIENT_B, BRANCH_B2]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Inv Doc A', 'inv-doc-a@example.test', now()),
              ($2, 'Inv Doc B', 'inv-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [INV_DOC_USER_A, INV_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [INV_DOC_A, ORG_A, INV_DOC_USER_A, INV_DOC_B, ORG_B, INV_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, appointment_number, scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'INVA000001',
               '2027-07-01T04:00:00Z', '2027-07-01T04:15:00Z', now()),
              ($7, $8, $9, $10, $11, $12, 'INVB000001',
               '2027-07-01T05:00:00Z', '2027-07-01T05:15:00Z', now())
       ON CONFLICT DO NOTHING`,
      [
        INV_APT_A,
        ORG_A,
        BRANCH_A,
        INV_PATIENT_A,
        INV_REG_A,
        INV_DOC_A,
        INV_APT_B2,
        ORG_B,
        BRANCH_B2,
        INV_PATIENT_B,
        INV_REG_B2,
        INV_DOC_B,
      ]
    );

    await owner.query(
      `INSERT INTO invoices
         (id, organization_id, branch_id, patient_id, invoice_number, source_type,
          appointment_id, customer_name, supplied_at, issued_at, status, grand_total,
          updated_at)
       VALUES ($1, $2, $3, $4, 'INV-2026-APP-MAIN-000001', 'APPOINTMENT', $9,
               'Inv A', now(), now(), 'ISSUED', 500.00, now()),
              ($5, $6, $7, $8, 'INV-2026-APP-B2-000001', 'APPOINTMENT', $10,
               'Inv B', now(), now(), 'ISSUED', 900.00, now())
       ON CONFLICT DO NOTHING`,
      [
        INV_A,
        ORG_A,
        BRANCH_A,
        INV_PATIENT_A,
        INV_B2,
        ORG_B,
        BRANCH_B2,
        INV_PATIENT_B,
        INV_APT_A,
        INV_APT_B2,
      ]
    );

    await owner.query(
      `INSERT INTO invoice_items
         (id, organization_id, branch_id, invoice_id, line_number, description,
          tax_category, unit_price, gross_amount, taxable_amount, line_total, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'MRI Brain with contrast', 'PROCEDURE',
               900.00, 900.00, 900.00, 900.00, now())
       ON CONFLICT DO NOTHING`,
      [ITEM_B2, ORG_B, BRANCH_B2, INV_B2]
    );

    await owner.query(
      `INSERT INTO invoice_taxes
         (id, organization_id, branch_id, invoice_id, invoice_item_id, name,
          jurisdiction, rate_bps, taxable_amount, tax_amount, treatment)
       VALUES ($1, $2, $3, $4, $5, 'CGST', 'IN', 600, 900.00, 54.00, 'STANDARD')
       ON CONFLICT DO NOTHING`,
      [TAX_B2, ORG_B, BRANCH_B2, INV_B2, ITEM_B2]
    );

    await owner.query(
      `INSERT INTO files
         (id, organization_id, branch_id, document_type, status, storage_key,
          original_name, mime_type)
       VALUES ($1, $2, $3, 'INVOICE_PDF', 'READY', $7, 'a.pdf', 'application/pdf'),
              ($4, $5, $6, 'INVOICE_PDF', 'READY', $8, 'b.pdf', 'application/pdf')
       ON CONFLICT DO NOTHING`,
      [FILE_A, ORG_A, BRANCH_A, FILE_B, ORG_B, BRANCH_B2, `iso/${FILE_A}.pdf`, `iso/${FILE_B}.pdf`]
    );

    await owner.query(
      `INSERT INTO invoice_documents
         (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_PDF', 'invoice', 1)
       ON CONFLICT DO NOTHING`,
      [DOC_B2, ORG_B, BRANCH_B2, INV_B2, FILE_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM invoice_documents WHERE id = $1', [DOC_B2]);
    await owner.query('DELETE FROM files WHERE id = ANY($1)', [[FILE_A, FILE_B]]);
    await owner.query('DELETE FROM invoice_taxes WHERE id = $1', [TAX_B2]);
    await owner.query('DELETE FROM invoice_items WHERE id = $1', [ITEM_B2]);
    await owner.query('DELETE FROM invoices WHERE id = ANY($1)', [[INV_A, INV_B2]]);
    await owner.query('DELETE FROM appointments WHERE id = ANY($1)', [[INV_APT_A, INV_APT_B2]]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[INV_DOC_A, INV_DOC_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[INV_DOC_USER_A, INV_DOC_USER_B]]);
    await owner.query('DELETE FROM patient_registrations WHERE id = ANY($1)', [
      [INV_REG_A, INV_REG_B2],
    ]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[INV_PATIENT_A, INV_PATIENT_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>('SELECT count(*) AS count FROM invoices');
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides an invoice belonging to another clinic, even by primary key', async () => {
    const rows = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const r = await app.query('SELECT id FROM invoices WHERE id = $1', [INV_B2]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  /*
   * ⚠️ THE CASE THE CHILDREN CARRY THEIR OWN TENANT COLUMNS FOR. A line reads
   *   "MRI Brain with contrast" — a clinical fact about a named person — and it
   *   is answerable by primary key. Isolated through a parent it would be
   *   protected only by the code never asking; here the database refuses.
   */
  it('hides the lines, taxes and documents of another clinic', async () => {
    const counts = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const items = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      const taxes = await app.query('SELECT id FROM invoice_taxes WHERE id = $1', [TAX_B2]);
      const docs = await app.query('SELECT id FROM invoice_documents WHERE id = $1', [DOC_B2]);
      return [items.rows.length, taxes.rows.length, docs.rows.length];
    });
    expect(counts).toEqual([0, 0, 0]);
  });

  /*
   * ⚠️ THE HALF A PARENT-SCOPED POLICY CANNOT ENFORCE. B1 and B2 are the same
   *   tenant, so tenant_isolation passes for both. Only branch_isolation — on
   *   the CHILD, in its own right — hides B2's takings from a cashier at B1. A
   *   child protected through its parent inherits the org half of that
   *   predicate and none of the branch half, which is the hole
   *   `appointment_status_history` had to restate by hand.
   */
  it('hides another BRANCH of the same clinic, lines included', async () => {
    const counts = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const invoices = await app.query('SELECT id FROM invoices WHERE id = $1', [INV_B2]);
      const items = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      const taxes = await app.query('SELECT id FROM invoice_taxes WHERE id = $1', [TAX_B2]);
      const docs = await app.query('SELECT id FROM invoice_documents WHERE id = $1', [DOC_B2]);
      return [invoices.rows.length, items.rows.length, taxes.rows.length, docs.rows.length];
    });
    expect(counts).toEqual([0, 0, 0, 0]);

    const own = await asTenantAtBranches(ORG_B, [BRANCH_B2], async () => {
      const r = await app.query('SELECT id FROM invoice_items WHERE id = $1', [ITEM_B2]);
      return r.rows.length;
    });
    expect(own).toBe(1);
  });

  it('refuses to write an invoice into another tenant', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO invoices
             (id, organization_id, branch_id, source_type, customer_name,
              supplied_at, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Nobody', now(), 'DRAFT', now())`,
          [ORG_B, BRANCH_B2]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * ⚠️ THE POLICY THAT REPLACES A COMPOSITE FK THAT CANNOT EXIST.
   *   `files.organization_id` is nullable, so invoice_documents.file_id is a
   *   plain FK and ADR-0004 does not apply. The row's OWN organization_id would
   *   be perfectly correct here and tenant_isolation would pass; only
   *   `file_in_same_org` notices that the FILE belongs to somebody else.
   */
  it('refuses an invoice document citing a file from another tenant', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO invoice_documents
             (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'credit-note', 1)`,
          [ORG_A, BRANCH_A, INV_A, FILE_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('accepts an invoice document citing a file from its own tenant', async () => {
    const inserted = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const r = await app.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'credit-note', 1)
         RETURNING id`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      );
      return r.rows.length;
    });
    expect(inserted).toBe(1);
    await owner.query('DELETE FROM invoice_documents WHERE invoice_id = $1', [INV_A]);
  });

  /*
   * ⚠️ The one unique in this schema that wants NULLS DISTINCT, which is
   *   Postgres' default. Every DRAFT has a NULL invoice_number and a clinic has
   *   many drafts open at once; NULLS NOT DISTINCT would let it hold one.
   */
  it('allows many numberless drafts and still refuses a duplicate number', async () => {
    await owner.query(
      `INSERT INTO invoices
         (id, organization_id, branch_id, source_type, customer_name, supplied_at,
          status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Draft one', now(), 'DRAFT', now()),
              (gen_random_uuid(), $1, $2, 'OTHER', 'Draft two', now(), 'DRAFT', now())`,
      [ORG_A, BRANCH_A]
    );

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, invoice_number,
            supplied_at, issued_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Clash', 'INV-2026-APP-MAIN-000001',
                 now(), now(), 'ISSUED', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_organization_id_invoice_number_key/);

    await owner.query('DELETE FROM invoices WHERE organization_id = $1 AND status = $2', [
      ORG_A,
      'DRAFT',
    ]);
  });

  /*
   * ⚠️ An ISSUED invoice with no number cannot be cited on a return; a DRAFT
   *   that already holds one has burnt a serial that will never appear on any
   *   document, leaving a gap somebody has to explain years later.
   */
  it('refuses an issued invoice with no number, and a numbered draft', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            issued_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'No number', now(), now(), 'ISSUED', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_number_matches_status/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, invoice_number,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Early number',
                 'INV-2026-OTH-MAIN-000099', now(), 'DRAFT', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_number_matches_status/);
  });

  /*
   * ⚠️ THE WHOLE REASON `source_id` IS NOT A LOOSE UUID.
   *   The risk was never "this invoice bills an appointment that does not
   *   exist" — ids are random and nobody stumbles onto one. It is "this invoice
   *   bills ANOTHER CLINIC'S appointment", and only the composite
   *   (organization_id, appointment_id) reference answers that. A plain FK to
   *   `appointments(id)` would accept this row, and so would a stub table
   *   holding nothing but an id.
   */
  it('refuses an invoice billing an appointment from another clinic', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, appointment_id, customer_name,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'APPOINTMENT', $3, 'Cross tenant', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A, INV_APT_B2]
      )
    ).rejects.toThrow(/invoices_organization_id_appointment_id_fkey/);
  });

  /*
   * ⚠️ The clause list grows with the modules. An APPOINTMENT invoice that cites
   *   nothing has lost the link the moment it was created, and an OTHER invoice
   *   carrying an appointment is billing a visit while claiming to be manual —
   *   two rows that read as fine and reconcile against nothing.
   */
  it('refuses a source type and a reference column that disagree', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'APPOINTMENT', 'No visit', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_source_reference_matches_type/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, appointment_id, customer_name,
            supplied_at, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', $3, 'Manual with a visit', now(),
                 'DRAFT', now())`,
        [ORG_A, BRANCH_A, INV_APT_A]
      )
    ).rejects.toThrow(/invoices_source_reference_matches_type/);
  });

  /*
   * ⚠️ "10% off" and "₹150 off" are different instructions that can produce the
   *   same amount, and the invoice prints which was given. A type without its
   *   input computes one way and prints another.
   */
  it('refuses a discount whose type and input disagree', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, discount_type, discount_fixed, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Wrong shape', now(), 'DRAFT',
                 'PERCENTAGE', 150.00, now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_discount_input_matches_type/);

    await expect(
      owner.query(
        `INSERT INTO invoices
           (id, organization_id, branch_id, source_type, customer_name, supplied_at,
            status, discount_type, discount_bps, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'OTHER', 'Over 100%', now(), 'DRAFT',
                 'PERCENTAGE', 12000, now())`,
        [ORG_A, BRANCH_A]
      )
    ).rejects.toThrow(/invoices_discount_input_matches_type/);
  });

  /*
   * ⚠️ Which table priced a line is the difference between a rate the clinic
   *   authored and one it merely inherited — the question the rate-card screen
   *   and an auditor both ask. A row citing both answers neither.
   */
  it('refuses a tax line citing both a tenant rule and a platform default', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'INVCHECK', 1200, 'STANDARD', 'GST',
               '2025-04-01', now())
       RETURNING id`,
      [ORG_B]
    );
    const ruleId = rows[0]!.id;

    const defaults = await owner.query<{ id: string }>(`SELECT id FROM tax_rule_defaults LIMIT 1`);

    if (defaults.rows[0]) {
      await expect(
        owner.query(
          `INSERT INTO invoice_taxes
             (id, organization_id, branch_id, invoice_id, invoice_item_id, tax_rule_id,
              tax_rule_default_id, name, rate_bps, taxable_amount, tax_amount, treatment)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'CGST', 600, 900.00, 54.00,
                   'STANDARD')`,
          [ORG_B, BRANCH_B2, INV_B2, ITEM_B2, ruleId, defaults.rows[0].id]
        )
      ).rejects.toThrow(/invoice_taxes_one_rule_source/);
    }

    await owner.query('DELETE FROM tax_rules WHERE id = $1', [ruleId]);
  });

  /*
   * ⚠️ A render that FAILED and was retried leaves a dead row behind, because
   *   the row is written before the bytes and the failure has to stay findable.
   *   A non-partial unique would refuse the retry: invoice issued, PDF
   *   permanently missing, discovered by a patient at the front desk.
   */
  it('allows a superseded document beside the current one, but not two current', async () => {
    await owner.query(`UPDATE invoice_documents SET superseded_at = now() WHERE id = $1`, [DOC_B2]);

    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO invoice_documents
         (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'INVOICE_PDF', 'invoice', 1)
       RETURNING id`,
      [ORG_B, BRANCH_B2, INV_B2, FILE_B]
    );

    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'INVOICE_PDF', 'invoice', 1)`,
        [ORG_B, BRANCH_B2, INV_B2, FILE_B]
      )
    ).rejects.toThrow(/invoice_documents_current_per_type_key/);

    await owner.query('DELETE FROM invoice_documents WHERE id = $1', [rows[0]!.id]);
    await owner.query('UPDATE invoice_documents SET superseded_at = NULL WHERE id = $1', [DOC_B2]);
  });

  /**
   * ⚠️ A DOCUMENT MUST SAY WHICH TEMPLATE DREW IT, AND THE COLUMNS HAVE NO
   *   DEFAULT ON PURPOSE. They exist so that "what did the document this patient
   *   is holding look like?" has an answer years later, when the template has
   *   moved on several revisions. A DEFAULT would be the reflexive way to make
   *   the migration safe and would stamp a confident, wrong answer onto any row
   *   that did not supply one — indistinguishable from a real one.
   */
  it('refuses an invoice document that does not say which template drew it', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF')`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      )
    ).rejects.toThrow(/template_key/);
  });

  /* A version is a count of revisions. Zero means nothing; negative is a typo. */
  it('refuses a template version that is not a positive count', async () => {
    await expect(
      owner.query(
        `INSERT INTO invoice_documents
           (id, organization_id, branch_id, invoice_id, file_id, document_type,
            template_key, template_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT_NOTE_PDF', 'invoice', 0)`,
        [ORG_A, BRANCH_A, INV_A, FILE_A]
      )
    ).rejects.toThrow(/invoice_documents_template_version_positive/);
  });
});

// ---------------------------------------------------------------------------

/**
 * Fees, pay and the reschedule trail.
 *
 * Three tables, three different shapes of boundary, and the first one is the
 * only table in this repository where a NULL `branch_id` is a MEANING rather
 * than a tolerated absence:
 *
 *   - `fee_schedule_entries` — NULL branch means "the clinic's default,
 *     everywhere", so the branch policy MUST let it through or inheritance
 *     stops working for a branch-scoped receptionist. A branch's own row must
 *     still be hidden from other branches. Both directions are asserted,
 *     because a policy that got either one wrong would pass a test that only
 *     checked the other.
 *   - `doctor_compensation` — org-scoped only, deliberately: one contract per
 *     person. RLS answers "whose organization"; who may READ a salary is
 *     `doctor.compensation.read`, which is the application's business and not
 *     this file's.
 *   - `appointment_reschedules` — org AND branch, like `appointment_vitals`,
 *     because its `reason` column is PHI. "Can't come Thursday, chemo" must not
 *     be readable from another branch.
 */
describe('fee schedule, compensation and reschedules', () => {
  const FEE_DOC_USER_B = 'ffffffff-8888-4888-8888-00000000ae01';
  const FEE_DOC_B = 'ffffffff-8888-4888-8888-0000000000d1';
  /** B's organization-wide default. Visible at every branch of B, and nowhere else. */
  const FEE_ORGWIDE_B = 'ffffffff-8888-4888-8888-0000000000f0';
  /** B's price at B2 only. */
  const FEE_AT_B2 = 'ffffffff-8888-4888-8888-0000000000f2';
  const COMP_B = 'ffffffff-9999-4999-8999-0000000000c1';
  const RESCHED_B2 = 'ffffffff-9999-4999-8999-00000000be02';
  const RESCHED_APT_B2 = 'ffffffff-9999-4999-8999-0000000000a2';
  const RESCHED_PATIENT_B = 'ffffffff-9999-4999-8999-00000000be03';
  const RESCHED_REG_B2 = 'ffffffff-9999-4999-8999-00000000be04';

  async function asTenantAtBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Fee Doc B', 'fee-doc-b@example.test', now()) ON CONFLICT DO NOTHING`,
      [FEE_DOC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
      [FEE_DOC_B, ORG_B, FEE_DOC_USER_B]
    );

    await owner.query(
      `INSERT INTO fee_schedule_entries
         (id, organization_id, branch_id, doctor_profile_id, fee_type, amount, updated_at)
       VALUES ($1, $2, NULL, NULL, 'NEW', 500.00, now()),
              ($3, $4, $5, $6, 'NEW', 900.00, now())
       ON CONFLICT DO NOTHING`,
      [FEE_ORGWIDE_B, ORG_B, FEE_AT_B2, ORG_B, BRANCH_B2, FEE_DOC_B]
    );

    await owner.query(
      `INSERT INTO doctor_compensation
         (id, organization_id, doctor_profile_id, amount, "interval", updated_at)
       VALUES ($1, $2, $3, 250000.00, 'MONTHLY', now()) ON CONFLICT DO NOTHING`,
      [COMP_B, ORG_B, FEE_DOC_B]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'RESB0001', 'Res B', now()) ON CONFLICT DO NOTHING`,
      [RESCHED_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'RESMRNB', now()) ON CONFLICT DO NOTHING`,
      [RESCHED_REG_B2, ORG_B, RESCHED_PATIENT_B, BRANCH_B2]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, appointment_number, scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'RES-B2-0001',
               now() + interval '1 day', now() + interval '1 day 15 minutes', now())
       ON CONFLICT DO NOTHING`,
      [RESCHED_APT_B2, ORG_B, BRANCH_B2, RESCHED_PATIENT_B, RESCHED_REG_B2, FEE_DOC_B]
    );
    await owner.query(
      `INSERT INTO appointment_reschedules
         (id, organization_id, branch_id, appointment_id, from_start, to_start,
          from_doctor_profile_id, to_doctor_profile_id, initiated_by, reason, charge_amount)
       VALUES ($1, $2, $3, $4, now(), now() + interval '2 days', $5, $6,
               'PATIENT', 'Chemotherapy on Thursdays', 200.00)
       ON CONFLICT DO NOTHING`,
      [RESCHED_B2, ORG_B, BRANCH_B2, RESCHED_APT_B2, FEE_DOC_B, FEE_DOC_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM appointment_reschedules WHERE id = $1', [RESCHED_B2]);
    await owner.query('DELETE FROM appointments WHERE id = $1', [RESCHED_APT_B2]);
    await owner.query('DELETE FROM patients WHERE id = $1', [RESCHED_PATIENT_B]);
    await owner.query('DELETE FROM doctor_compensation WHERE id = $1', [COMP_B]);
    await owner.query('DELETE FROM fee_schedule_entries WHERE id = ANY($1)', [
      [FEE_ORGWIDE_B, FEE_AT_B2],
    ]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = $1', [FEE_DOC_B]);
    await owner.query('DELETE FROM users WHERE id = $1', [FEE_DOC_USER_B]);
  });

  // --- fee_schedule_entries ------------------------------------------------

  it('fees fail closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM fee_schedule_entries'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides another clinic’s price list entirely, branch-wide row included', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM fee_schedule_entries WHERE id = ANY($1)', [
        [FEE_ORGWIDE_B, FEE_AT_B2],
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /**
   * ⚠️ THE CASE THE NULL PREDICATE EXISTS FOR. A receptionist scoped to B1 has
   *   no business reading what B2 charges, but they MUST be able to read the
   *   clinic's organization-wide default or the resolver falls through to
   *   unpriced and every bill at B1 says "no rate card".
   */
  it('shows the clinic-wide default to a branch that has no row of its own', async () => {
    const ids = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query<{ id: string }>(
        'SELECT id FROM fee_schedule_entries WHERE id = ANY($1)',
        [[FEE_ORGWIDE_B, FEE_AT_B2]]
      );
      return rows.map((r) => r.id);
    });

    expect(ids).toContain(FEE_ORGWIDE_B);
    /* …and still not what the other branch charges. */
    expect(ids).not.toContain(FEE_AT_B2);
  });

  it('shows a branch’s own price once that branch is in scope', async () => {
    const ids = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query<{ id: string }>(
        'SELECT id FROM fee_schedule_entries WHERE id = ANY($1)',
        [[FEE_ORGWIDE_B, FEE_AT_B2]]
      );
      return rows.map((r) => r.id);
    });

    expect(ids).toHaveLength(2);
  });

  /**
   * ⚠️ WITHOUT `NULLS NOT DISTINCT` THIS INSERT SUCCEEDS, and the clinic then
   *   holds two organization-wide `NEW` prices with nothing deciding which one a
   *   patient pays. A plain unique index does not constrain NULLs, and both
   *   scoping columns here are nullable by design.
   *
   * The constraint name is Prisma's generated one and reads badly on purpose:
   * the hand-picked `fee_schedule_entries_scope_key` it replaced differed from
   * what the schema implies, so every `prisma migrate dev` for any unrelated
   * feature emitted a rename into somebody's migration. See the
   * `align_fee_schedule_index_name` migration. The index definition — columns,
   * uniqueness and NULLS NOT DISTINCT — is unchanged; only the label moved.
   */
  it('refuses a second clinic-wide price for the same fee type', async () => {
    await expect(
      owner.query(
        `INSERT INTO fee_schedule_entries
           (id, organization_id, branch_id, doctor_profile_id, fee_type, amount, updated_at)
         VALUES (gen_random_uuid(), $1, NULL, NULL, 'NEW', 750.00, now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/fee_schedule_entries_organization_id_doctor_profile_id_bran_key/);
  });

  // --- doctor_compensation -------------------------------------------------

  it('compensation fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM doctor_compensation'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides another clinic’s salaries entirely', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM doctor_compensation WHERE id = $1', [
        COMP_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /*
   * Org-scoped ONLY, so a branch-scoped reader inside the right clinic DOES see
   * it — one contract per person, not one per branch. Asserted so that adding a
   * branch policy later is a deliberate act with a failing test behind it rather
   * than a quiet tightening that hides a doctor's pay from their own employer.
   */
  it('shows a salary to any branch scope inside the owning clinic', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM doctor_compensation WHERE id = $1', [
        COMP_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(1);
  });

  // --- appointment_reschedules ---------------------------------------------

  it('reschedules fail closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM appointment_reschedules'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('hides another clinic’s reschedule trail entirely', async () => {
    const found = await asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_reschedules WHERE id = $1', [
        RESCHED_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /* The reason is PHI, so the branch half is not optional. */
  it('hides a reschedule made at a branch out of scope, inside the same clinic', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_reschedules WHERE id = $1', [
        RESCHED_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows a reschedule once its branch is in scope', async () => {
    const found = await asTenantAtBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM appointment_reschedules WHERE id = $1', [
        RESCHED_B2,
      ]);
      return rows.length;
    });
    expect(found).toBe(1);
  });
});

/**
 * The product catalogue (PI-1). Thirteen tables, all PLATFORM CATALOGUE + TENANT
 * EXTENSION, and the two failure modes that class has.
 *
 *   1. The policy is READ-PERMISSIVE and WRITE-STRICT, which is NOT the policy on
 *      `files`. Copying that one would let any clinic insert a row with
 *      organization_id NULL — a product instantly visible to every other tenant
 *      on the platform, written by anyone holding `product.definition.manage`.
 *      Nothing else in the system would notice: it is a valid insert into a
 *      table the caller is allowed to write. That case is measured below.
 *
 *   2. ⚠️ THE ELEVEN RESTRICTIVE `*_visible` POLICIES. Every foreign key from a
 *      product into a master is a PLAIN key — it cannot be composite, because
 *      the target may be a platform row with no organization_id to compose with.
 *      `tenant_isolation` therefore constrains the row's OWN organization_id and
 *      says nothing whatsoever about what it POINTS AT. Without these policies a
 *      clinic attaches another clinic's private category, ingredient,
 *      composition or unit to its own product and reads the name back out
 *      through the join. This is the single most likely security regression in
 *      PI-1, and every one of the eleven is exercised here.
 *
 * The CHILDREN are a different shape and are covered too: they reach their
 * parent through a COMPOSITE FK on `(organization_id, product_id)`, which is
 * what makes it impossible for a tenant to bolt its own packaging onto a
 * platform product.
 */
describe('the product catalogue', () => {
  const UNIT_PLATFORM = 'eeeeeeee-1111-4111-8111-000000000001';
  const UNIT_PRIVATE_B = 'eeeeeeee-1111-4111-8111-0000000000b1';
  const CAT_PLATFORM = 'eeeeeeee-2222-4222-8222-000000000001';
  const CAT_PRIVATE_B = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const MFR_PRIVATE_B = 'eeeeeeee-3333-4333-8333-0000000000b1';
  const ING_PRIVATE_B = 'eeeeeeee-4444-4444-8444-0000000000b1';
  const COMP_PRIVATE_B = 'eeeeeeee-5555-4555-8555-0000000000b1';
  const STORE_PRIVATE_B = 'eeeeeeee-6666-4666-8666-0000000000b1';
  const PRODUCT_PLATFORM = 'eeeeeeee-7777-4777-8777-000000000001';
  const PRODUCT_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const PRODUCT_B = 'eeeeeeee-7777-4777-8777-0000000000b1';
  const COMP_A = 'eeeeeeee-5555-4555-8555-0000000000a1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'ISO_PLATFORM_UNIT', 'Iso Platform Unit', 'ipu', 'COUNT', now()),
              ($2, $3,   'ISO_PRIVATE_UNIT_B', 'Iso Private Unit B', 'ipb', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [UNIT_PLATFORM, UNIT_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
       VALUES ($1, NULL, 'ISO_PLATFORM_CAT', 'Iso Platform Category', now()),
              ($2, $3,   'ISO_PRIVATE_CAT_B', 'Iso Private Category B', now())
       ON CONFLICT DO NOTHING`,
      [CAT_PLATFORM, CAT_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_MFR_B', 'Iso Private Manufacturer B', now())
       ON CONFLICT DO NOTHING`,
      [MFR_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_ING_B', 'Iso Private Ingredient B', now())
       ON CONFLICT DO NOTHING`,
      [ING_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO compositions (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_COMP_B', 'Iso Private Composition B', now()),
              ($3, $4, 'ISO_COMP_A',         'Iso Composition A',         now())
       ON CONFLICT DO NOTHING`,
      [COMP_PRIVATE_B, ORG_B, COMP_A, ORG_A]
    );

    await owner.query(
      `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_STORE_B', 'Iso Private Storage B', now())
       ON CONFLICT DO NOTHING`,
      [STORE_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
       VALUES ($1, NULL, 'CONSUMABLE', 'ACTIVE', 'ISO_PLATFORM_PROD', 'Iso Platform Product', $4, now()),
              ($2, $5,   'CONSUMABLE', 'ACTIVE', 'ISO_PROD_A',        'Iso Product A',        $4, now()),
              ($3, $6,   'CONSUMABLE', 'ACTIVE', 'ISO_PROD_B',        'Iso Product B',        $4, now())
       ON CONFLICT DO NOTHING`,
      [PRODUCT_PLATFORM, PRODUCT_A, PRODUCT_B, UNIT_PLATFORM, ORG_A, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [
      [PRODUCT_PLATFORM, PRODUCT_A, PRODUCT_B],
    ]);
    await owner.query('DELETE FROM compositions WHERE id = ANY($1)', [[COMP_PRIVATE_B, COMP_A]]);
    await owner.query('DELETE FROM storage_requirement_profiles WHERE id = $1', [STORE_PRIVATE_B]);
    await owner.query('DELETE FROM active_ingredients WHERE id = $1', [ING_PRIVATE_B]);
    await owner.query('DELETE FROM manufacturers WHERE id = $1', [MFR_PRIVATE_B]);
    await owner.query('DELETE FROM product_categories WHERE id = ANY($1)', [
      [CAT_PLATFORM, CAT_PRIVATE_B],
    ]);
    await owner.query('DELETE FROM units_of_measure WHERE id = ANY($1)', [
      [UNIT_PLATFORM, UNIT_PRIVATE_B],
    ]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM products WHERE organization_id IS NOT NULL'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  describe('the platform catalogue', () => {
    it('lets every tenant read the platform rows', async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT id FROM products WHERE code = 'ISO_PLATFORM_PROD'`
        );
        return rows.length;
      });
      expect(forA).toBe(1);
    });

    it("hides one tenant's private product from another", async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(`SELECT id FROM products WHERE code = 'ISO_PROD_B'`);
        return rows.length;
      });
      expect(forA).toBe(0);
    });

    it('cannot read another tenant’s product even when its id is known', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM products WHERE id = $1', [PRODUCT_B]);
        return rows.length;
      });
      expect(found).toBe(0);
    });

    /*
     * THE case for this tenancy class. A permissive WITH CHECK — the one `files`
     * uses — would let this succeed, and the row would be visible to every
     * tenant on the platform.
     */
    it('refuses a tenant writing a PLATFORM-WIDE product', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
             VALUES (gen_random_uuid(), NULL, 'CONSUMABLE', 'ACTIVE', 'SNEAKY_PROD', 'Sneaky', $1, now())`,
            [UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('refuses a tenant writing a platform-wide unit, category or composition', async () => {
      for (const statement of [
        `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_UNIT', 'Sneaky', 'sn', 'COUNT', now())`,
        `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_CAT', 'Sneaky', now())`,
        `INSERT INTO compositions (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_COMP', 'Sneaky', now())`,
        `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_MFR', 'Sneaky', now())`,
        `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_ING', 'Sneaky', now())`,
        `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_STORE', 'Sneaky', now())`,
      ]) {
        await expect(asTenant(ORG_A, () => app.query(statement))).rejects.toThrow(
          /row-level security/i
        );
      }
    });

    it('allows a tenant writing its own product', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'ISO_OWN_A', 'Iso Own A', $2, now())`,
          [ORG_A, UNIT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM products WHERE code = 'ISO_OWN_A'`);
    });

    it('refuses a tenant EDITING a platform product', async () => {
      /*
       * The permissive USING clause makes the row VISIBLE, so the UPDATE finds
       * it — and then fails the WITH CHECK, which is evaluated against the row
       * as it would be after the write. A platform row's organization_id stays
       * NULL. This is the intuitive-but-wrong reading the service header warns
       * about, measured.
       */
      /*
       * ⚠️ IT RAISES, IT DOES NOT SILENTLY UPDATE ZERO ROWS — and the difference
       *   matters. A no-op would let a clinic press Save on a platform product
       *   and be told it worked. The refusal is an error the service turns into
       *   a sentence, which is why `assertMutable` exists as the friendlier
       *   first layer rather than as the only one. Keeping this property is why
       *   `platform_rows_immutable` is a TRIGGER and not a RESTRICTIVE policy —
       *   a RESTRICTIVE USING would have made exactly this statement a silent
       *   zero-row success.
       *
       *   That trigger is also what raises here now, since it runs before the
       *   policy. WITH CHECK would refuse this on its own and still does if the
       *   trigger goes away.
       */
      await expect(
        asTenant(ORG_A, () =>
          app.query(`UPDATE products SET name = 'Hijacked' WHERE id = $1`, [PRODUCT_PLATFORM])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ name: string }>(
        'SELECT name FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(rows[0]?.name).toBe('Iso Platform Product');
    });

    /*
     * The two things WITH CHECK does not cover, both closed by the
     * `platform_rows_immutable` trigger rather than by the policy.
     *
     * ⚠️ THE TEST ABOVE PASSED BEFORE THAT TRIGGER EXISTED AND THESE TWO DID
     *   NOT, WHICH IS THE WHOLE POINT. `SET name` leaves organization_id NULL,
     *   so WITH CHECK catches it and the policy looks like it covers editing.
     *   It covers editing the row's CONTENT. It does not cover editing its
     *   OWNER, and it does not cover DELETE at all — Postgres evaluates no WITH
     *   CHECK on a statement with no new row. Both cases below passed cleanly
     *   under the policy alone.
     */
    it('refuses a tenant CAPTURING a platform product by rewriting its owner', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(`UPDATE products SET organization_id = $1 WHERE id = $2`, [
            ORG_A,
            PRODUCT_PLATFORM,
          ])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ organization_id: string | null }>(
        'SELECT organization_id FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(rows[0]?.organization_id).toBeNull();
    });

    it('refuses a tenant DELETING the platform catalogue', async () => {
      await expect(
        asTenant(ORG_A, () => app.query('DELETE FROM products WHERE organization_id IS NULL'))
      ).rejects.toThrow(/not writable by a tenant/i);

      /* And the same for a master, not just a product. */
      await expect(
        asTenant(ORG_A, () =>
          app.query('DELETE FROM units_of_measure WHERE id = $1', [UNIT_PLATFORM])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ count: string }>(
        'SELECT count(*) AS count FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('still lets a tenant edit and delete its OWN row', async () => {
      /*
       * The trigger fires on every UPDATE and DELETE on these tables, so the
       * ordinary path has to be measured too — a guard that also blocks the
       * legitimate case is a guard that gets deleted in a hurry six months from
       * now, by someone who will not put it back correctly.
       */
      const updated = await asTenant(ORG_A, async () => {
        const res = await app.query(`UPDATE products SET name = $1 WHERE id = $2`, [
          'Iso Product A Renamed',
          PRODUCT_A,
        ]);
        return res.rowCount;
      });
      expect(updated).toBe(1);

      await asTenant(ORG_A, () =>
        app.query(`UPDATE products SET name = 'Iso Product A' WHERE id = $1`, [PRODUCT_A])
      );

      const scratch = 'eeeeeeee-7777-4777-8777-0000000000a9';
      await owner.query(
        `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
         VALUES ($1, $2, 'CONSUMABLE', 'ACTIVE', 'ISO_PROD_A_SCRATCH', 'Scratch', $3, now())`,
        [scratch, ORG_A, UNIT_PLATFORM]
      );
      const deleted = await asTenant(ORG_A, async () => {
        const res = await app.query('DELETE FROM products WHERE id = $1', [scratch]);
        return res.rowCount;
      });
      expect(deleted).toBe(1);
    });
  });

  /**
   * The eleven RESTRICTIVE policies, one case each for the refusal and a
   * representative case for the permission.
   *
   * ⚠️ EVERY `updated_at` IS SUPPLIED EVEN THOUGH THESE INSERTS ARE MEANT TO
   *   FAIL. Without it the statement can also fail on the NOT NULL constraint,
   *   and a test asserting /row-level security/ that passes for a different
   *   reason is a test that keeps passing after the policy is dropped.
   */
  describe('the RESTRICTIVE visibility policies', () => {
    it("refuses attaching another tenant's private category to your own product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, category_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_CAT', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, CAT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private manufacturer", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, manufacturer_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_MFR', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, MFR_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private composition", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, composition_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'MEDICINE', 'DRAFT', 'SNEAK_COMP', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, COMP_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private storage profile", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, storage_profile_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_STORE', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, STORE_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses denominating a product in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_UNIT', 'Sneak', $2, now())`,
            [ORG_A, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    /*
     * ⚠️ THE CATEGORY SELF-PARENT IS AN ACCEPTED GAP, AND THIS TEST RECORDS THAT
     *   RATHER THAN A PROTECTION. A `parent_visible` policy was written for it
     *   and removed: `parent_id` points at the same table, a policy may not read
     *   its own table, and the resulting recursion propagated through
     *   `category_visible` to every read of `products`. See the
     *   `drop_category_parent_visible` migration.
     *
     *   So the write SUCCEEDS, and what actually protects the tenant is that the
     *   parent stays invisible: the row can be created, and the category's name
     *   can never be read back. That is asserted below, because it is the part
     *   that must not regress. `specialties` has carried the identical gap since
     *   it shipped.
     */
    it('permits parenting under an invisible category, but never discloses it', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_categories (id, organization_id, parent_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ISO_ORPHAN_A', 'Iso Orphan A', now())`,
          [ORG_A, CAT_PRIVATE_B]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      // The protection that matters: the parent's NAME is unreadable.
      const leaked = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT p.name
             FROM product_categories c
             JOIN product_categories p ON p.id = c.parent_id
            WHERE c.code = 'ISO_ORPHAN_A'`
        );
        return rows.length;
      });
      expect(leaked).toBe(0);

      await owner.query(`DELETE FROM product_categories WHERE code = 'ISO_ORPHAN_A'`);
    });

    it("refuses putting another tenant's private ingredient into your composition", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
            [ORG_A, COMP_A, ING_PRIVATE_B, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses expressing a strength in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
            [ORG_A, COMP_A, ING_PRIVATE_B, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses packaging a product in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings
               (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 1, $3, 10, now())`,
            [ORG_A, PRODUCT_A, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('allows attaching a PLATFORM category and unit', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, category_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'ISO_OK_A', 'Iso OK A', $2, $3, now())`,
          [ORG_A, UNIT_PLATFORM, CAT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM products WHERE code = 'ISO_OK_A'`);
    });
  });

  /**
   * The children reach their parent through a COMPOSITE FK on
   * `(organization_id, product_id)`, which does three jobs at once — and the one
   * worth measuring is that a tenant cannot bolt its own packaging, identifier
   * or tax classification onto a PLATFORM product. A clinic customises a shared
   * product by cloning it, and this is what makes that the only path.
   */
  describe('children of a platform-extensible parent', () => {
    it("refuses attaching a tenant's packaging to a PLATFORM product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings
               (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 1, $3, 10, now())`,
            [ORG_A, PRODUCT_PLATFORM, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses attaching a child to ANOTHER TENANT's product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_identifiers
               (id, organization_id, product_id, type, value, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'GTIN', '05012345678900', now())`,
            [ORG_A, PRODUCT_B]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('allows a child on your own product, and hides it from the other tenant', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_identifiers
             (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'ISO-GTIN-A', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT id FROM product_identifiers WHERE value = 'ISO-GTIN-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      await owner.query(`DELETE FROM product_identifiers WHERE value = 'ISO-GTIN-A'`);
    });

    it('lets BOTH tenants hold the same GTIN, because a GTIN is not globally unique', async () => {
      /*
       * ⚠️ A BARE `@@unique([value])` WOULD BREAK THIS, AND IT WOULD LOOK
       *   CORRECT. Repackagers reuse GTINs and two countries assign one national
       *   code to different medicines, so uniqueness is qualified by tenant,
       *   type and country. A global unique would make a legitimate catalogue
       *   unimportable while asserting something untrue.
       */
      await asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO product_identifiers (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'SHARED-GTIN', now())`,
          [ORG_A, PRODUCT_A]
        )
      );
      const insertedForB = await asTenant(ORG_B, async () => {
        const res = await app.query(
          `INSERT INTO product_identifiers (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'SHARED-GTIN', now())`,
          [ORG_B, PRODUCT_B]
        );
        return res.rowCount;
      });
      expect(insertedForB).toBe(1);

      await owner.query(`DELETE FROM product_identifiers WHERE value = 'SHARED-GTIN'`);
    });

    /*
     * ⚠️ THE THREE CHILDREN BELOW WERE THE ONES WITHOUT A CROSS-TENANT CASE.
     *   `product_identifiers` and `product_packagings` were covered above;
     *   `medicine_details` had no case at all, and `composition_ingredients` and
     *   `product_tax_classifications` appeared only in the CHECK-constraint
     *   block, which exercises the constraint and not the policy. A child whose
     *   isolation is never measured is exactly the row that carries the leak:
     *   these hold the dosage form, the strength and the tax category — the
     *   substance of the catalogue — while the parent holds little more than a
     *   name. Covered as a set so PI-2's children inherit the shape.
     */
    it('hides a medicine detail from the other tenant, and refuses one on their product', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO medicine_details
             (id, organization_id, product_id, dosage_form, label_instructions, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'TABLET', 'ISO-MED-A', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT id FROM medicine_details WHERE label_instructions = 'ISO-MED-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      /* And B cannot write one onto A's product — the composite FK refuses. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO medicine_details
               (id, organization_id, product_id, dosage_form, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'CAPSULE', now())`,
            [ORG_B, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      /* Nor onto the PLATFORM product, which is the "clone, don't edit" rule. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO medicine_details
               (id, organization_id, product_id, dosage_form, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'CAPSULE', now())`,
            [ORG_B, PRODUCT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query(`DELETE FROM medicine_details WHERE label_instructions = 'ISO-MED-A'`);
    });

    it("hides a composition's ingredients from the other tenant", async () => {
      const ingredientA = await owner.query<{ id: string }>(
        `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'ISO_ING_A', 'Iso Ingredient A', now())
         RETURNING id`,
        [ORG_A]
      );
      const ingredientAId = ingredientA.rows[0]?.id;
      expect(ingredientAId).toBeDefined();

      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO composition_ingredients
             (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
          [ORG_A, COMP_A, ingredientAId, UNIT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT strength FROM composition_ingredients WHERE composition_id = $1`,
          [COMP_A]
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      /* B cannot add an ingredient to A's composition either. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 250, $4, now())`,
            [ORG_B, COMP_A, ING_PRIVATE_B, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query('DELETE FROM composition_ingredients WHERE composition_id = $1', [COMP_A]);
      await owner.query('DELETE FROM active_ingredients WHERE id = $1', [ingredientAId]);
    });

    it("hides a product's tax classification from the other tenant", async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_tax_classifications
             (id, organization_id, product_id, country_code, tax_category, item_code,
              effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_12', 'ISO-HSN-A', '2026-01-01', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT tax_category FROM product_tax_classifications WHERE item_code = 'ISO-HSN-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO product_tax_classifications
               (id, organization_id, product_id, country_code, tax_category, effective_from, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_05', '2026-01-01', now())`,
            [ORG_B, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query(`DELETE FROM product_tax_classifications WHERE item_code = 'ISO-HSN-A'`);
    });
  });

  /**
   * The constraints Prisma cannot express, exercised at the DATABASE under a
   * tenant connection. The services check these first and return friendlier
   * errors — these exist because the services are not the only writers, and a
   * guard nobody exercises is a guard nobody notices losing.
   */
  describe('the constraints that are not in the schema file', () => {
    it('refuses a conversion that crosses unit classes', async () => {
      const massUnit = await owner.query<{ id: string }>(
        `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND unit_class = 'MASS' LIMIT 1`
      );
      const massId = massUnit.rows[0]?.id;
      expect(massId).toBeDefined();

      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO unit_conversions (id, organization_id, from_unit_id, to_unit_id, numerator, denominator, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 5, 1, now())`,
            [ORG_A, UNIT_PLATFORM, massId]
          )
        )
      ).rejects.toThrow(/crosses unit classes/i);
    });

    it('refuses a zero or negative conversion ratio', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO unit_conversions (id, organization_id, from_unit_id, to_unit_id, numerator, denominator, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 0, 1, now())`,
            [ORG_A, UNIT_PLATFORM, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/unit_conversions_ratio_positive|unit_conversions_distinct_units/i);
    });

    it('refuses a tenant declaring its own base unit', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, is_base, updated_at)
             VALUES (gen_random_uuid(), $1, 'ISO_BASE_A', 'Iso Base A', 'iba', 'COUNT', true, now())`,
            [ORG_A]
          )
        )
      ).rejects.toThrow(/units_of_measure_base_is_platform/i);
    });

    it('refuses expiry control on a product that is not batch tracked', async () => {
      /*
       * ⚠️ `batches.expires_on` IS THE ONLY COLUMN THAT HOLDS AN EXPIRY, and a
       *   product tracked NONE or SERIAL never gets a batch row. Marking it
       *   expiry-controlled asserts a control nothing can record, and PI-2's
       *   expiry sweep would skip it forever without complaining.
       */
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, is_expiry_controlled, updated_at)
             VALUES (gen_random_uuid(), $1, 'MEDICINE', 'DRAFT', 'ISO_BADEXP', 'Bad expiry', $2, 'NONE', true, now())`,
            [ORG_A, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/products_expiry_requires_batch_tracking/i);
    });

    it('refuses a packaging level 0 that does not contain exactly one', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 0, $3, 10, now())`,
            [ORG_A, PRODUCT_A, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/product_packagings_level_sane/i);
    });

    it('refuses a category that is its own parent', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'ISO_CYCLE_A', 'Iso Cycle A', now()) RETURNING id`,
        [ORG_A]
      );
      const id = rows[0]?.id;
      expect(id).toBeDefined();

      await expect(
        asTenant(ORG_A, () =>
          app.query('UPDATE product_categories SET parent_id = id WHERE id = $1', [id])
        )
      ).rejects.toThrow(/cannot be its own parent/i);

      await owner.query('DELETE FROM product_categories WHERE id = $1', [id]);
    });

    it('refuses an effective window that ends before it starts', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_tax_classifications
               (id, organization_id, product_id, country_code, tax_category, effective_from, effective_to, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_5', '2026-06-01', '2026-01-01', now())`,
            [ORG_A, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/product_tax_classifications_window_ordered/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Inventory (PI-2).
//
// ⚠️ THE OPPOSITE TENANCY CLASS FROM THE CATALOGUE ABOVE, AND THE CASES BELOW
//   ARE SHAPED BY THAT. A product may be a PLATFORM row that every clinic reads;
//   a location, a lot, a serial, a movement and a balance never may. Every one
//   of these seven tables has `organization_id` NOT NULL and `branch_id` NOT
//   NULL, so both policies are absolute — and the branch half is tested as hard
//   as the organization half, because a hospital group whose Bangalore
//   storekeeper can read the Mysore controlled-drug cabinet has a real problem
//   that an org-only test would call clean.
//
// ⚠️ AND THE `product_visible` POLICIES ARE THE HIGHEST-RISK ITEM IN THE PHASE.
//   `batches.product_id` cannot be a composite FK — a clinic legitimately stocks
//   a PLATFORM product, whose organization_id is NULL — so `tenant_isolation`
//   constrains the batch's own organization and says NOTHING about the product
//   it names. Without the RESTRICTIVE policy a clinic creates a batch of another
//   clinic's private product and reads its name straight back out of the join.
//   That write is refused below, on `batches`, `serials`, `stock_ledger` and
//   `stock_balances`.
// ---------------------------------------------------------------------------
describe('inventory', () => {
  const INV_UNIT = 'dddddddd-1111-4111-8111-000000000001';
  const INV_PROD_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const INV_PROD_B = 'dddddddd-7777-4777-8777-0000000000b1';
  const INV_PROD_PLATFORM = 'dddddddd-7777-4777-8777-000000000001';
  const INV_ACTOR = 'dddddddd-8888-4888-8888-000000000001';

  const LOC_A = 'dddddddd-2222-4222-8222-0000000000a1';
  const LOC_B1 = 'dddddddd-2222-4222-8222-0000000000b1';
  const LOC_B2 = 'dddddddd-2222-4222-8222-0000000000b2';
  const AREA_B1 = 'dddddddd-3333-4333-8333-0000000000b1';
  const BIN_B1 = 'dddddddd-4444-4444-8444-0000000000b1';
  const BATCH_A = 'dddddddd-5555-4555-8555-0000000000a1';
  const BATCH_B1 = 'dddddddd-5555-4555-8555-0000000000b1';
  const SERIAL_B1 = 'dddddddd-6666-4666-8666-0000000000b1';
  const INV_MEM_A = 'dddddddd-9999-4999-8999-0000000000a1';
  const INV_MEM_B = 'dddddddd-9999-4999-8999-0000000000b1';

  async function atBranches<T>(
    organizationId: string,
    branchIds: string[],
    fn: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_org', $1, true)`, [organizationId]);
      await app.query(`SELECT set_config('app.branch_scope', $1, true)`, [
        `{${branchIds.join(',')}}`,
      ]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Inv Actor', 'inv-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [INV_ACTOR]
    );

    /*
     * ⚠️ THE ACTOR NEEDS A MEMBERSHIP IN BOTH ORGANIZATIONS, because
     *   `actor_is_member` refuses a movement naming somebody who does not work
     *   at the clinic. Without these the CHECK-constraint cases below would fail
     *   on the POLICY instead — passing for the wrong reason, and testing
     *   nothing about the constraint they name.
     */
    await owner.query(
      `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
       VALUES ($1,$3,$4,'ACTIVE',now()), ($2,$3,$5,'ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [INV_MEM_A, INV_MEM_B, INV_ACTOR, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'INV_ISO_UNIT', 'Inv Iso Unit', 'iiu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [INV_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $4, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_A', 'Inv Iso Product A', $5, 'LOT_BATCH', now()),
              ($2, $6, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_B', 'Inv Iso Product B', $5, 'LOT_BATCH', now()),
              ($3, NULL, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_P', 'Inv Iso Product P', $5, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [INV_PROD_A, INV_PROD_B, INV_PROD_PLATFORM, ORG_A, INV_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
       VALUES ($1, $4, $5, 'MAIN_PHARMACY', 'INV_ISO_A',  'Iso A Pharmacy', now()),
              ($2, $6, $7, 'MAIN_PHARMACY', 'INV_ISO_B1', 'Iso B1 Pharmacy', now()),
              ($3, $6, $8, 'REFRIGERATOR',  'INV_ISO_B2', 'Iso B2 Fridge',   now())
       ON CONFLICT DO NOTHING`,
      [LOC_A, LOC_B1, LOC_B2, ORG_A, BRANCH_A, ORG_B, BRANCH_B1, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO storage_areas (id, organization_id, branch_id, location_id, code, name, updated_at)
       VALUES ($1, $2, $3, $4, 'AISLE1', 'Aisle 1', now()) ON CONFLICT DO NOTHING`,
      [AREA_B1, ORG_B, BRANCH_B1, LOC_B1]
    );
    await owner.query(
      `INSERT INTO storage_bins (id, organization_id, branch_id, area_id, code, updated_at)
       VALUES ($1, $2, $3, $4, 'BIN1', now()) ON CONFLICT DO NOTHING`,
      [BIN_B1, ORG_B, BRANCH_B1, AREA_B1]
    );

    await owner.query(
      `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
       VALUES ($1, $3, $4, $5, 'ISO-LOT-A', now()),
              ($2, $6, $7, $8, 'ISO-LOT-B', now())
       ON CONFLICT DO NOTHING`,
      [BATCH_A, BATCH_B1, ORG_A, BRANCH_A, INV_PROD_A, ORG_B, BRANCH_B1, INV_PROD_B]
    );

    await owner.query(
      `INSERT INTO serials (id, organization_id, branch_id, product_id, batch_id, serial_number, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ISO-SER-B', now()) ON CONFLICT DO NOTHING`,
      [SERIAL_B1, ORG_B, BRANCH_B1, INV_PROD_B, BATCH_B1]
    );

    // One receipt at each organization, so both the ledger and the
    // trigger-maintained balance have rows to hide from the other.
    await owner.query(
      `INSERT INTO stock_ledger
         (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
          quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 100, 100, $5, $6, 'AVAILABLE', 'MANUAL', $7),
              (gen_random_uuid(), $8, $9, $10, $11, 'LOT_BATCH', 'PURCHASE_RECEIPT', 250, 250, $5, $12, 'AVAILABLE', 'MANUAL', $7)`,
      [
        ORG_A,
        BRANCH_A,
        INV_PROD_A,
        BATCH_A,
        INV_UNIT,
        LOC_A,
        INV_ACTOR,
        ORG_B,
        BRANCH_B1,
        INV_PROD_B,
        BATCH_B1,
        LOC_B1,
      ]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM stock_ledger WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM stock_balances WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM serials WHERE id = $1', [SERIAL_B1]);
    await owner.query('DELETE FROM batches WHERE id = ANY($1)', [[BATCH_A, BATCH_B1]]);
    await owner.query('DELETE FROM storage_bins WHERE id = $1', [BIN_B1]);
    await owner.query('DELETE FROM storage_areas WHERE id = $1', [AREA_B1]);
    await owner.query('DELETE FROM inventory_locations WHERE id = ANY($1)', [
      [LOC_A, LOC_B1, LOC_B2],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [
      [INV_PROD_A, INV_PROD_B, INV_PROD_PLATFORM],
    ]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [INV_UNIT]);
    await owner.query('DELETE FROM memberships WHERE id = ANY($1)', [[INV_MEM_A, INV_MEM_B]]);
    await owner.query('DELETE FROM users WHERE id = $1', [INV_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [
      'inventory_locations',
      'storage_areas',
      'storage_bins',
      'batches',
      'serials',
      'stock_ledger',
      'stock_balances',
    ]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  /*
   * ⚠️ A TENANT CONTEXT WITH NO BRANCH SCOPE SEES NOTHING EITHER, and that is
   *   the half an org-only test would call clean. `branch_id` is NOT NULL on all
   *   seven tables, so the RESTRICTIVE branch policy's `branch_id IS NULL OR`
   *   disjunct can never fire — a caller that forgot to set `app.branch_scope`
   *   gets an empty array, and an empty array matches nothing.
   */
  it('shows nothing to a tenant whose branch scope is empty', async () => {
    const seen = await asTenant(ORG_B, async () => {
      const { rows } = await app.query('SELECT id FROM inventory_locations');
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  describe('the organization boundary', () => {
    it("hides one organization's locations from another", async () => {
      const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations WHERE id = $1', [
          LOC_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    it("hides one organization's lots, serials, movements and balances from another", async () => {
      const counts = await atBranches(ORG_A, [BRANCH_A], async () => {
        const batches = await app.query('SELECT id FROM batches WHERE id = $1', [BATCH_B1]);
        const serials = await app.query('SELECT id FROM serials WHERE id = $1', [SERIAL_B1]);
        const ledger = await app.query('SELECT id FROM stock_ledger WHERE organization_id = $1', [
          ORG_B,
        ]);
        const balances = await app.query(
          'SELECT id FROM stock_balances WHERE organization_id = $1',
          [ORG_B]
        );
        return [batches.rows.length, serials.rows.length, ledger.rows.length, balances.rows.length];
      });
      expect(counts).toEqual([0, 0, 0, 0]);
    });

    it('hides the children — areas and bins — as well as their parent', async () => {
      const counts = await atBranches(ORG_A, [BRANCH_A], async () => {
        const areas = await app.query('SELECT id FROM storage_areas WHERE id = $1', [AREA_B1]);
        const bins = await app.query('SELECT id FROM storage_bins WHERE id = $1', [BIN_B1]);
        return [areas.rows.length, bins.rows.length];
      });
      expect(counts).toEqual([0, 0]);
    });

    it('refuses a location written against another organization', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'MAIN_PHARMACY', 'INV_ISO_STEAL', 'Stolen', now())`,
            [ORG_B, BRANCH_B1]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('the branch boundary', () => {
    /*
     * ⚠️ THIS IS THE CASE `patients` DELIBERATELY DOES NOT HAVE, AND STOCK
     *   DELIBERATELY DOES. A person is one person across a hospital group, so
     *   their identity follows them; a shelf is at one site, and what one site
     *   holds, paid and dispensed is not another site's business.
     */
    it("hides one branch's locations from a storekeeper scoped to the other", async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations WHERE id = $1', [
          LOC_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    it("hides one branch's lots, movements and balances from the other", async () => {
      const counts = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const batches = await app.query('SELECT id FROM batches WHERE id = $1', [BATCH_B1]);
        const ledger = await app.query('SELECT id FROM stock_ledger');
        const balances = await app.query('SELECT id FROM stock_balances');
        return [batches.rows.length, ledger.rows.length, balances.rows.length];
      });
      expect(counts).toEqual([0, 0, 0]);
    });

    it('shows both branches to an organization-wide reader', async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations');
        return rows.length;
      });
      expect(seen).toBe(2);
    });

    it('refuses a lot written against a branch outside the caller’s scope', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B2], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-CROSS', now())`,
            [ORG_B, BRANCH_B1, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('the product_visible policies', () => {
    /*
     * ⚠️ THE HIGHEST-RISK ITEM IN THIS PHASE, AND THE ONE THAT LOOKS FINE.
     *   `tenant_isolation` on `batches` constrains the batch's OWN
     *   organization_id, which passes here — the row genuinely belongs to A. The
     *   product it names does not, and nothing but the RESTRICTIVE policy asks.
     *   Without it this INSERT succeeds and A reads B's product name, generic
     *   name, composition and manufacturer back out through the join.
     */
    it('refuses a lot of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-LEAK', now())`,
            [ORG_A, BRANCH_A, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a serial of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO serials (id, organization_id, branch_id, product_id, serial_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-SER-LEAK', now())`,
            [ORG_A, BRANCH_A, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a movement of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'NONE', 'PURCHASE_RECEIPT', 1, 1, $4, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_B, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    /*
     * The other half of the same policy, and the reason it is permissive on the
     * read side: a clinic stocking a PLATFORM product is the ordinary case, and
     * a policy that refused it would make the shared catalogue unusable.
     */
    /*
     * ⚠️ THE OTHER FOUR POLICIES HAD NO DECOY, WHICH IS HOW ONE OF THEM ENDS UP
     *   SUBTLY DIFFERENT FROM THE REST. Each is the same shape and each guards a
     *   different join a read already performs: `listLedger` selects
     *   `unit.symbol`, `listBatches` selects `manufacturer.name`, and
     *   `listLocations` selects `storageProfile.name`. Without the policy each
     *   of those is another clinic's private row read back out through a join.
     */
    it('refuses a movement naming another tenant’s private unit', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_UNIT_B', 'Inv Iso Unit B', 'iib', 'COUNT', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateUnit = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 1, 1, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, privateUnit, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM units_of_measure WHERE id = $1', [privateUnit]);
    });

    it('refuses a lot naming another tenant’s private manufacturer', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_MFR_B', 'Inv Iso Manufacturer B', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateMfr = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, manufacturer_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-MFR', $4, now())`,
            [ORG_A, BRANCH_A, INV_PROD_A, privateMfr]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM manufacturers WHERE id = $1', [privateMfr]);
    });

    it('refuses a location naming another tenant’s private storage profile', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_STORE_B', 'Inv Iso Storage B', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateProfile = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, storage_profile_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'REFRIGERATOR', 'INV_ISO_LEAK', 'Leaky fridge', $3, now())`,
            [ORG_A, BRANCH_A, privateProfile]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM storage_requirement_profiles WHERE id = $1', [privateProfile]);
    });

    /*
     * ⚠️ THE EIGHTH PLAIN FK, WHICH THE `*_visible` LOOP COULD NOT EXPRESS.
     *   `users` is RLS-EXEMPT and has no organization_id, so the policy is a
     *   membership test instead. Without it a tenant writes a movement naming
     *   any user uuid and reads `users.full_name` back through the join
     *   `listLedger` already performs and returns as `actorName`.
     */
    it('refuses a movement naming somebody who does not work at this clinic', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO users (id, full_name, email, updated_at)
         VALUES (gen_random_uuid(), 'Outsider', 'inv-outsider@example.test', now())
         RETURNING id`
      );
      const outsider = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 1, 1, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, outsider]
          )
        )
      ).rejects.toThrow(/actor_is_member|row-level security/i);

      await owner.query('DELETE FROM users WHERE id = $1', [outsider]);
    });

    it('permits a lot of a PLATFORM product', async () => {
      const inserted = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query(
          `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-PLATFORM', now()) RETURNING id`,
          [ORG_A, BRANCH_A, INV_PROD_PLATFORM]
        );
        return rows[0]?.id as string;
      });
      expect(inserted).toBeDefined();
      await owner.query('DELETE FROM batches WHERE id = $1', [inserted]);
    });
  });

  describe('the ledger is append-only', () => {
    /*
     * ⚠️ TWO INDEPENDENT LAYERS, AND EACH IS TESTED WITH THE OTHER REMOVED —
     *   which is what the two cases below do implicitly. The GRANT check proves
     *   `rcln_app` holds no UPDATE or DELETE at all; the trigger check proves
     *   that even the owner's privileges do not help an app-role statement, and
     *   that re-running the init script's blanket GRANT would not silently
     *   re-open the table.
     */
    it('holds no UPDATE or DELETE grant on stock_ledger for the app role', async () => {
      const { rows } = await app.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = current_user AND table_name = 'stock_ledger'
          ORDER BY privilege_type`
      );
      const held = rows.map((r) => r.privilege_type);
      expect(held).not.toContain('UPDATE');
      expect(held).not.toContain('DELETE');
      // INSERT is kept: `recordMovement` writes through this role.
      expect(held).toContain('INSERT');
      expect(held).toContain('SELECT');
    });

    it('refuses an UPDATE of a movement even for the tenant that wrote it', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(`UPDATE stock_ledger SET reason_note = 'edited' WHERE organization_id = $1`, [
            ORG_A,
          ])
        )
      ).rejects.toThrow(/append-only|permission denied/i);
    });

    it('refuses a DELETE of a movement', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query('DELETE FROM stock_ledger WHERE organization_id = $1', [ORG_A])
        )
      ).rejects.toThrow(/append-only|permission denied/i);
    });
  });

  describe('the balance cache is written by the trigger and by nothing else', () => {
    /*
     * ⚠️ PI-ADR-004 RULE 2, MADE LITERAL. "Nothing at all writes stock_balances"
     *   is an agreement until the grant says so. With INSERT, UPDATE and DELETE
     *   revoked there is no code path in the application — present or future,
     *   correct or not — that can state a quantity directly. The only way a
     *   balance changes is that a movement was recorded.
     */
    it('holds only SELECT on stock_balances for the app role', async () => {
      const { rows } = await app.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = current_user AND table_name = 'stock_balances'
          ORDER BY privilege_type`
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
    });

    /*
     * ⚠️ THE GRANT CHECK THE FIRST VERSION DID NOT HAVE, AND ITS ABSENCE HID A
     *   CRITICAL. `REVOKE ALL ON FUNCTION ... FROM PUBLIC` does NOT remove the
     *   role-specific grant that `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
     *   FUNCTIONS TO rcln_app` in the init script hands to every function a
     *   migration creates. So `stock_balances_apply_delta` — SECURITY DEFINER,
     *   RLS-bypassing, and taking the organization, location and delta as
     *   ARGUMENTS — was callable by the request-path role, which nullified the
     *   REVOKE on the table above entirely.
     *
     *   The table grants were tested and the function grants were not. This is
     *   the missing half.
     */
    it('holds no EXECUTE on either balance function for the app role', async () => {
      const { rows } = await app.query<{ delta: boolean; trigger: boolean }>(
        `SELECT has_function_privilege(
                  'stock_balances_apply_delta(uuid,uuid,uuid,uuid,uuid,uuid,"StockStatus",numeric)',
                  'EXECUTE') AS delta,
                has_function_privilege('stock_balances_apply()', 'EXECUTE') AS trigger`
      );
      expect(rows[0]?.delta).toBe(false);
      expect(rows[0]?.trigger).toBe(false);
    });

    it('maintained the balance from the receipt the fixture recorded', async () => {
      const quantity = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query<{ quantity: string }>(
          `SELECT quantity FROM stock_balances
            WHERE batch_id = $1 AND location_id = $2 AND status = 'AVAILABLE'`,
          [BATCH_A, LOC_A]
        );
        return rows[0]?.quantity;
      });
      expect(Number(quantity)).toBe(100);
    });
  });

  describe('the constraints that carry weight', () => {
    it('refuses a negative quantity on a receipt', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', -5, -5, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_direction/i);
    });

    it('refuses an adjustment with no reason code', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'ADJUSTMENT', 5, 5, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_direction/i);
    });

    it('refuses a batch-tracked movement with no lot (PI-ADR-014)', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'LOT_BATCH', 'PURCHASE_RECEIPT', 5, 5, $4, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_tracking_satisfied/i);
    });

    it('refuses a bucket named without its location', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 5, 5, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_bucket_complete/i);
    });

    /*
     * ⚠️ THE LAST LINE AGAINST A NEGATIVE SHELF. The service takes the balance
     *   rows FOR UPDATE and re-verifies first, so the normal outcome of losing
     *   that race is a 409. This is what happens when something skips the
     *   service — a future domain, a bug in the re-verify, an import path.
     */
    it('refuses an issue larger than the shelf holds', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, from_location_id, status_from, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'DISPENSING', -1000, -1000, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_balances_non_negative/i);
    });

    it('refuses a cost with no currency', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, unit_cost_base, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-NOCCY', 1250, now())`,
            [ORG_A, BRANCH_A, INV_PROD_A]
          )
        )
      ).rejects.toThrow(/batches_cost_has_currency/i);
    });

    it('refuses a lot with no expiry on an expiry-controlled product', async () => {
      await owner.query(
        `UPDATE products SET tracking_mode = 'LOT_BATCH', is_expiry_controlled = true WHERE id = $1`,
        [INV_PROD_A]
      );
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-NOEXP', now())`,
            [ORG_A, BRANCH_A, INV_PROD_A]
          )
        )
      ).rejects.toThrow(/must carry an expiry date/i);
      await owner.query('UPDATE products SET is_expiry_controlled = false WHERE id = $1', [
        INV_PROD_A,
      ]);
    });

    it('refuses a quarantine with no reason', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query('UPDATE batches SET quarantined_at = now() WHERE id = $1', [BATCH_A])
        )
      ).rejects.toThrow(/batches_quarantine_reasoned/i);
    });
  });
});
