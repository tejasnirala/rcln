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
