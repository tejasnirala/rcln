/**
 * Tenant isolation — appointments.
 *
 * PHI again, and the OPPOSITE branch call from `patients`.
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
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

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
  /*
   * Every appointment belongs to exactly one treatment journey (CE-1), and
   * `clinical_episode_id` is NOT NULL — so the fixture has to open one per
   * tenant before it can insert a booking. An episode of one is the ordinary
   * case, which is what these are.
   */
  const APT_EPISODE_A = 'ffffffff-6666-4666-8666-0000000000a1';
  const APT_EPISODE_B2 = 'ffffffff-6666-4666-8666-0000000000b2';
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
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOEPA0001', DATE '2027-06-01', now()),
              ($4, $5, $6, 'ISOEPB0001', DATE '2027-06-01', now())
       ON CONFLICT DO NOTHING`,
      [APT_EPISODE_A, ORG_A, APT_PATIENT_A, APT_EPISODE_B2, ORG_B, APT_PATIENT_B]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, clinical_episode_id, appointment_number,
          scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $13, 'ISOA000001',
               '2027-06-01T04:00:00Z', '2027-06-01T04:15:00Z', now()),
              ($7, $8, $9, $10, $11, $12, $14, 'ISOB000001',
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
        APT_EPISODE_A,
        APT_EPISODE_B2,
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

  /*
   * ⚠️ `clinical_episode_id` IS SUPPLIED, AND SUPPLYING IT IS THE POINT.
   *
   *   The column is NOT NULL since CE-1, so an INSERT that omits it is rejected
   *   by the not-null constraint BEFORE Postgres ever evaluates a policy — the
   *   test would still go red-to-green and would have stopped proving anything
   *   about the branch boundary. That is the quiet way an isolation test rots
   *   into a schema test.
   *
   *   Passing a legitimate episode belonging to ORG_A puts the row back in the
   *   state where the ONLY thing wrong with it is the branch.
   */
  it('rejects booking into another clinic’s branch', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A, BRANCH_B1], () =>
        app.query(
          `INSERT INTO appointments
             (id, organization_id, branch_id, patient_id, patient_registration_id,
              doctor_profile_id, clinical_episode_id, appointment_number,
              scheduled_start, scheduled_end, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'SNEAK00001',
                   '2027-06-02T04:00:00Z', '2027-06-02T04:15:00Z', now())`,
          [ORG_A, BRANCH_B1, APT_PATIENT_A, APT_REG_A, APT_DOC_A, APT_EPISODE_A]
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
