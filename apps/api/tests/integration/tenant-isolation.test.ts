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
      ).rejects.toThrow(/row-level security/i);

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
  });

  afterAll(async () => {
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
});
