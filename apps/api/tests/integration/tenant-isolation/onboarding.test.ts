/**
 * Tenant isolation — the clinic profile and the setup wizard (CO-1).
 *
 * Four tables, TWO tenancy classes:
 *
 *   `clinic_profiles`               org + branch, `branch_id` NULLABLE
 *   `clinic_profile_care_contexts`  org + branch, `branch_id` NULLABLE
 *   `clinic_profile_modules`        org + branch, `branch_id` NULLABLE
 *   `clinic_onboarding_steps`       org-scoped, NO branch column at all
 *
 * ⚠️ THE `IS NULL` HALF OF THE BRANCH PREDICATE IS LIVE HERE, WHICH IT IS NOT IN
 *   MOST OF THIS SUITE. NULL means "the ORGANIZATION's answer" and every member
 *   must see it; a row with a branch set is that site's override and is visible
 *   only to somebody scoped there. Both directions get a case, because a policy
 *   that hid the org-level row would break the product silently — every clinic
 *   would read as unconfigured and every nav would fall back to showing
 *   everything.
 *
 * ⚠️ AND `specialty_visible` GETS A CASE OF ITS OWN, because `db:rls:check`
 *   structurally cannot see it (KI-3). `clinic_profile_care_contexts.specialty_id`
 *   is a PLAIN FK into `specialties`, which is platform-extensible and therefore
 *   nullable-tenant — no composite FK can be drawn, so `tenant_isolation` says
 *   the ROW is yours and nothing at all about which specialty it names. Without
 *   the RESTRICTIVE policy a clinic attaches another clinic's private
 *   CARE_CONTEXT node to its own profile and reads its name back out of the join
 *   that renders the wizard's checkboxes.
 *
 * ⚠️ WHAT IS *NOT* PROTECTED HERE, STATED SO NOBODY LOOKS FOR IT: that a child's
 *   `branch_id` equals its parent's. A composite FK over a nullable column is
 *   MATCH SIMPLE and skips the check when the column is NULL, so the database
 *   cannot enforce the copy is faithful. The service writes both halves in one
 *   transaction; the last case in this file asserts they agree for the rows the
 *   fixture seeds, and there is no third guard short of a trigger.
 *
 * ⚠️ AND `setting_values` — WHICH THE WIZARD SEEDS — IS RLS-EXEMPT AND HAS NO
 *   CASE IN THIS SUITE AT ALL. There is no policy to prove. Its isolation is
 *   entirely the pinned `(settingKey, scopeType, scopeId)` predicates in
 *   `seed.service.ts`, which are covered by a unit test instead. This paragraph
 *   is here because the absence otherwise reads as an oversight.
 *
 * One file of the tenant-isolation suite; see ./README.md.
 */
import {
  BRANCH_A,
  BRANCH_B1,
  BRANCH_B2,
  ORG_A,
  ORG_B,
  app,
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

describe('clinic onboarding', () => {
  /** A PLATFORM care context — the shape `HUMAN` and `VET` really have. */
  const OB_CONTEXT_PLATFORM = 'eeeeeeee-1111-4111-8111-000000000001';
  /** One private to B. Naming it from A is what `specialty_visible` must refuse. */
  const OB_CONTEXT_B = 'eeeeeeee-1111-4111-8111-0000000000b1';

  /** B's organization-level profile — the row whose `branch_id` IS NULL. */
  const PROFILE_B_ORG = 'eeeeeeee-2222-4222-8222-0000000000b0';
  /** B's override for its second site, the standalone pharmacy. */
  const PROFILE_B_BRANCH2 = 'eeeeeeee-2222-4222-8222-0000000000b2';

  const CONTEXT_ROW_B = 'eeeeeeee-3333-4333-8333-0000000000b1';
  const MODULE_ROW_B_ORG = 'eeeeeeee-4444-4444-8444-0000000000b1';
  const MODULE_ROW_B_BRANCH2 = 'eeeeeeee-4444-4444-8444-0000000000b2';
  const STEP_B = 'eeeeeeee-5555-4555-8555-0000000000b1';

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
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_OB_PLATFORM_CTX', 'Isolation platform context', 'CARE_CONTEXT', now()),
              ($2, $3,   NULL, 'ISO_OB_B_CTX',        'Isolation B context',        'CARE_CONTEXT', now())
       ON CONFLICT DO NOTHING`,
      [OB_CONTEXT_PLATFORM, OB_CONTEXT_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO clinic_profiles (id, organization_id, branch_id, facility_kind, updated_at)
       VALUES ($1, $2, NULL, 'CLINIC', now()),
              ($3, $2, $4,   'PHARMACY', now())
       ON CONFLICT DO NOTHING`,
      [PROFILE_B_ORG, ORG_B, PROFILE_B_BRANCH2, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO clinic_profile_care_contexts
         (id, organization_id, profile_id, branch_id, specialty_id)
       VALUES ($1, $2, $3, NULL, $4) ON CONFLICT DO NOTHING`,
      [CONTEXT_ROW_B, ORG_B, PROFILE_B_ORG, OB_CONTEXT_B]
    );

    await owner.query(
      `INSERT INTO clinic_profile_modules (id, organization_id, profile_id, branch_id, module)
       VALUES ($1, $2, $3, NULL, 'CONSULTATIONS'),
              ($4, $2, $5, $6,   'PHARMACY')
       ON CONFLICT DO NOTHING`,
      [MODULE_ROW_B_ORG, ORG_B, PROFILE_B_ORG, MODULE_ROW_B_BRANCH2, PROFILE_B_BRANCH2, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO clinic_onboarding_steps (id, organization_id, step, completed_at, updated_at)
       VALUES ($1, $2, 'CARE_CONTEXTS', now(), now()) ON CONFLICT DO NOTHING`,
      [STEP_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM clinic_onboarding_steps WHERE id = $1', [STEP_B]);
    await owner.query('DELETE FROM clinic_profile_modules WHERE id = ANY($1)', [
      [MODULE_ROW_B_ORG, MODULE_ROW_B_BRANCH2],
    ]);
    await owner.query('DELETE FROM clinic_profile_care_contexts WHERE id = $1', [CONTEXT_ROW_B]);
    await owner.query('DELETE FROM clinic_profiles WHERE id = ANY($1)', [
      [PROFILE_B_ORG, PROFILE_B_BRANCH2],
    ]);
    await owner.query('DELETE FROM specialties WHERE id = ANY($1)', [
      [OB_CONTEXT_PLATFORM, OB_CONTEXT_B],
    ]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [
      'clinic_profiles',
      'clinic_profile_care_contexts',
      'clinic_profile_modules',
      'clinic_onboarding_steps',
    ]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  it("shows one clinic nothing of another's profile", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM clinic_profiles WHERE id = ANY($1)', [
        [PROFILE_B_ORG, PROFILE_B_BRANCH2],
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of another's care contexts, modules or progress", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const contexts = await app.query(
        'SELECT id FROM clinic_profile_care_contexts WHERE id = $1',
        [CONTEXT_ROW_B]
      );
      const modules = await app.query('SELECT id FROM clinic_profile_modules WHERE id = ANY($1)', [
        [MODULE_ROW_B_ORG, MODULE_ROW_B_BRANCH2],
      ]);
      const steps = await app.query('SELECT id FROM clinic_onboarding_steps WHERE id = $1', [
        STEP_B,
      ]);
      return contexts.rows.length + modules.rows.length + steps.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a profile into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], async () =>
        app.query(
          `INSERT INTO clinic_profiles (id, organization_id, branch_id, updated_at)
           VALUES (gen_random_uuid(), $1, NULL, now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow();
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ THE ORG-LEVEL ROW MUST STAY VISIBLE TO EVERY BRANCH, and this is the case
   *   that would catch a policy tightened into `branch_id = ANY(...)`. Losing it
   *   makes every clinic read as unconfigured: no care contexts, no modules, and
   *   a patient form that starts asking a question the clinic already answered.
   */
  it("shows a branch-scoped member the organization's own answer", async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM clinic_profiles WHERE id = $1', [
        PROFILE_B_ORG,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it("hides one branch's override from a member scoped to another", async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
      const profile = await app.query('SELECT id FROM clinic_profiles WHERE id = $1', [
        PROFILE_B_BRANCH2,
      ]);
      const modules = await app.query('SELECT id FROM clinic_profile_modules WHERE id = $1', [
        MODULE_ROW_B_BRANCH2,
      ]);
      return profile.rows.length + modules.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows a branch its own override', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM clinic_profiles WHERE id = $1', [
        PROFILE_B_BRANCH2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('refuses to write an override for a branch outside the caller’s scope', async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B1], async () =>
        app.query(
          `INSERT INTO clinic_profile_modules (id, organization_id, profile_id, branch_id, module)
           VALUES (gen_random_uuid(), $1, $2, $3, 'LAB')`,
          [ORG_B, PROFILE_B_BRANCH2, BRANCH_B2]
        )
      )
    ).rejects.toThrow();
  });

  // -- specialty_visible, which db:rls:check cannot see ----------------------

  /**
   * ⚠️ THE CASE THAT FAILS IF THE RESTRICTIVE POLICY IS FORGOTTEN, and nothing
   *   else in this repository catches it. `tenant_isolation` is satisfied — the
   *   row would belong to A — and the FK is satisfied, because the specialty
   *   exists. Only `specialty_visible` refuses.
   */
  it("refuses to name another clinic's private care context", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], async () => {
        await app.query(
          `INSERT INTO clinic_profiles (id, organization_id, branch_id, updated_at)
           VALUES ('eeeeeeee-2222-4222-8222-0000000000a1', $1, NULL, now())
           ON CONFLICT DO NOTHING`,
          [ORG_A]
        );
        return app.query(
          `INSERT INTO clinic_profile_care_contexts
             (id, organization_id, profile_id, branch_id, specialty_id)
           VALUES (gen_random_uuid(), $1, 'eeeeeeee-2222-4222-8222-0000000000a1', NULL, $2)`,
          [ORG_A, OB_CONTEXT_B]
        );
      })
    ).rejects.toThrow();

    await owner.query('DELETE FROM clinic_profiles WHERE id = $1', [
      'eeeeeeee-2222-4222-8222-0000000000a1',
    ]);
  });

  it('accepts a PLATFORM care context, which is the ordinary case', async () => {
    const written = await atBranches(ORG_A, [BRANCH_A], async () => {
      await app.query(
        `INSERT INTO clinic_profiles (id, organization_id, branch_id, updated_at)
         VALUES ('eeeeeeee-2222-4222-8222-0000000000a2', $1, NULL, now())
         ON CONFLICT DO NOTHING`,
        [ORG_A]
      );
      const { rowCount } = await app.query(
        `INSERT INTO clinic_profile_care_contexts
           (id, organization_id, profile_id, branch_id, specialty_id)
         VALUES (gen_random_uuid(), $1, 'eeeeeeee-2222-4222-8222-0000000000a2', NULL, $2)`,
        [ORG_A, OB_CONTEXT_PLATFORM]
      );
      return rowCount;
    });
    expect(written).toBe(1);

    await owner.query('DELETE FROM clinic_profile_care_contexts WHERE profile_id = $1', [
      'eeeeeeee-2222-4222-8222-0000000000a2',
    ]);
    await owner.query('DELETE FROM clinic_profiles WHERE id = $1', [
      'eeeeeeee-2222-4222-8222-0000000000a2',
    ]);
  });

  // -- the constraints the policies do not cover -----------------------------

  /**
   * ⚠️ ADR-0004's LAYER, PROVEN INDEPENDENTLY OF RLS. The composite FK is what
   *   stops a profile naming another tenant's branch, and it refuses as a
   *   FOREIGN KEY violation rather than as a policy error — so it still holds
   *   for the owner connection, which bypasses every policy in this file.
   */
  it("refuses a profile that names another clinic's branch", async () => {
    await expect(
      owner.query(
        `INSERT INTO clinic_profiles (id, organization_id, branch_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now())`,
        [ORG_A, BRANCH_B1]
      )
    ).rejects.toThrow();
  });

  /**
   * ⚠️ `NULLS NOT DISTINCT`, WITHOUT WHICH THE UNIQUE INDEX PERMITS EXACTLY WHAT
   *   IT EXISTS TO FORBID. Postgres treats every NULL as distinct from every
   *   other, so the generated index would accept a hundred org-level profiles
   *   for one clinic and "what did this clinic answer" would resolve to
   *   whichever row the planner reached first.
   */
  it('refuses a second organization-level profile', async () => {
    await expect(
      owner.query(
        `INSERT INTO clinic_profiles (id, organization_id, branch_id, updated_at)
         VALUES (gen_random_uuid(), $1, NULL, now())`,
        [ORG_B]
      )
    ).rejects.toThrow();
  });

  /**
   * The invariant the database cannot check — see the file header. Asserted for
   * the seeded rows so a service change that stopped copying `branch_id` fails
   * here rather than silently widening a branch override to the whole group.
   */
  it("keeps a child's branch_id equal to its parent's", async () => {
    const { rows } = await owner.query<{ mismatches: string }>(
      `SELECT count(*) AS mismatches
         FROM clinic_profile_modules m
         JOIN clinic_profiles p ON p.id = m.profile_id
        WHERE p.organization_id = $1
          AND m.branch_id IS DISTINCT FROM p.branch_id`,
      [ORG_B]
    );
    expect(Number(rows[0]?.mismatches)).toBe(0);
  });
});
