/**
 * Tenant isolation — core.
 *
 * The floor: the app role itself, the bare tenant boundary, the parent-scoped
 * children, the `own_membership` identity bootstrap and the composite FKs.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import {
  BRANCH_A,
  BRANCH_B1,
  BRANCH_B2,
  ORG_A,
  ORG_B,
  app,
  asTenant,
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

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
