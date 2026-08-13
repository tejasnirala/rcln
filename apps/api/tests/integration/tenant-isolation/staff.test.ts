/**
 * Tenant isolation — staff.
 *
 * Doctors, designations and role pairings — platform catalogue plus tenant
 * extension, and the RESTRICTIVE *_visible policies that back it.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import { BRANCH_A, ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

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
