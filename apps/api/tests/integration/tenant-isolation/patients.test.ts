/**
 * Tenant isolation — patients.
 *
 * PHI, and the one domain where the branch boundary is deliberately absent
 * (ADR-0016).
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
