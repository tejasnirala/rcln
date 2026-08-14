/**
 * Tenant isolation — fees.
 *
 * Fees, pay and the reschedule trail — three different shapes of boundary.
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
  /** The journey that booking belongs to — see the fixture note. */
  const RESCHED_EPISODE_B2 = 'ffffffff-eeee-4eee-8eee-0000000000a2';
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
    /*
     * ⚠️ AN EPISODE FIRST. `appointments.clinical_episode_id` is NOT NULL since
     *   CE-1, so a raw fixture insert has to open a journey before it can book.
     *   Nothing in this file is about journeys; this is an episode of one.
     */
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'FEEEPB0001', current_date, now())
       ON CONFLICT DO NOTHING`,
      [RESCHED_EPISODE_B2, ORG_B, RESCHED_PATIENT_B]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, clinical_episode_id, appointment_number,
          scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'RES-B2-0001',
               now() + interval '1 day', now() + interval '1 day 15 minutes', now())
       ON CONFLICT DO NOTHING`,
      [
        RESCHED_APT_B2,
        ORG_B,
        BRANCH_B2,
        RESCHED_PATIENT_B,
        RESCHED_REG_B2,
        FEE_DOC_B,
        RESCHED_EPISODE_B2,
      ]
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
