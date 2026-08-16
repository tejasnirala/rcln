/**
 * Tenant isolation — the visit-history traversal (CE-5).
 *
 * ⚠️ CE-5 ADDS NO TABLE, SO THERE IS NO NEW POLICY HERE. What it adds is a new
 *   SHAPE OF QUERY, and that shape is the hazard: it nests a BRANCH-scoped child
 *   under an ORG-scoped parent.
 *
 * ```text
 *   clinical_episodes   org-scoped     a journey follows the PATIENT, and a
 *                                      person is one person across a group
 *         │
 *         └── encounters branch-scoped a VISIT belongs to the place it happened
 * ```
 *
 * Every other nested read in this codebase goes parent → child with both in the
 * same loop, so "the parent is visible" and "the child is visible" answer alike
 * and nobody has to think about it. Here they deliberately do not. A reader at
 * B1 CAN see a journey whose consultations all happened at B2 — that is
 * correct, and it is exactly the arrangement where somebody assumes the parent's
 * visibility covers the child and writes a join that leaks one branch's clinical
 * content into another's screen.
 *
 * Three things are asserted, and each fails differently:
 *
 *   1. THE ORGANIZATION — clinic A traversing episodes must reach none of B's
 *      consultations. The `tenant_isolation` policy on `encounters` is what
 *      stops it, and a missing one is silent.
 *
 *   2. THE BRANCH, THROUGH THE PARENT — a reader at B1 sees B's episode and must
 *      still see NO encounter hanging off it, because every one of them happened
 *      at B2. This is the case the shape above exists to catch.
 *
 *   3. THE RECALL JOIN — `listRecall` gained a join through `appointments` into
 *      `doctor_profiles` and `users` for the booking form's diary (CE-5).
 *      `users` is a platform table with no tenant column at all, so the join is
 *      only safe because the row it is reached THROUGH is tenant-scoped.
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

describe('visit history', () => {
  const VH_CONTEXT = 'aaaaaaaa-1111-4111-8111-000000000005';
  const VH_TPL = 'aaaaaaaa-2222-4222-8222-000000000005';
  const VH_VER = 'aaaaaaaa-3333-4333-8333-000000000005';

  const VH_PATIENT_A = 'aaaaaaaa-4444-4444-8444-0000000005a1';
  const VH_PATIENT_B = 'aaaaaaaa-4444-4444-8444-0000000005b1';
  const VH_USER_A = 'aaaaaaaa-5555-4555-8555-0000000005a1';
  const VH_USER_B = 'aaaaaaaa-5555-4555-8555-0000000005b1';
  const VH_DOC_A = 'aaaaaaaa-6666-4666-8666-0000000005a1';
  const VH_DOC_B = 'aaaaaaaa-6666-4666-8666-0000000005b1';
  const VH_EPISODE_A = 'aaaaaaaa-7777-4777-8777-0000000005a1';
  /** ⚠️ ORG-SCOPED. Visible from B1 even though nothing on it happened there. */
  const VH_EPISODE_B = 'aaaaaaaa-7777-4777-8777-0000000005b1';

  const VH_ENC_A = 'aaaaaaaa-8888-4888-8888-0000000005a1';
  /** Written at B2. The whole point of case 2. */
  const VH_ENC_B2 = 'aaaaaaaa-8888-4888-8888-0000000005b2';

  const DEFINITION = JSON.stringify({
    schemaVersion: 1,
    scopes: [],
    sections: [
      {
        type: 'CHIEF_COMPLAINT',
        key: 'chief_complaint',
        label: 'Chief complaint',
        order: 10,
        visible: true,
        required: true,
      },
    ],
  });

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

  /** The join `getVisitHistory` makes: journey → its consultations. */
  async function encountersUnderEpisodes(patientId: string): Promise<string[]> {
    const rows = await app.query<{ id: string }>(
      `SELECT e.id
         FROM clinical_episodes ep
         JOIN encounters e ON e.clinical_episode_id = ep.id
        WHERE ep.patient_id = $1
          AND ep.deleted_at IS NULL
          AND e.deleted_at IS NULL`,
      [patientId]
    );
    return rows.rows.map((r) => r.id);
  }

  beforeAll(async () => {
    /* A platform CARE_CONTEXT root, for the reason `encounters.test.ts` records
       at length: it does not cascade, and a parentless SPECIALTY left behind
       fails the taxonomy suite on the NEXT run. */
    await owner.query(
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_VH_CONTEXT', 'Isolation visit history', 'CARE_CONTEXT', now())
       ON CONFLICT DO NOTHING`,
      [VH_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_VH_PLATFORM', 'Platform consultation', $2, NULL, now())
       ON CONFLICT DO NOTHING`,
      [VH_TPL, VH_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $2, 1, $3::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [VH_VER, VH_TPL, DEFINITION]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'VHISOA001', 'VH A', now()), ($3, $4, 'VHISOB001', 'VH B', now())
       ON CONFLICT DO NOTHING`,
      [VH_PATIENT_A, ORG_A, VH_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'VH Doc A', 'vh-doc-a@example.test', now()),
              ($2, 'VH Doc B', 'vh-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [VH_USER_A, VH_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [VH_DOC_A, ORG_A, VH_USER_A, VH_DOC_B, ORG_B, VH_USER_B]
    );
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOVHEPA1', DATE '2027-06-01', now()),
              ($4, $5, $6, 'ISOVHEPB1', DATE '2027-06-01', now())
       ON CONFLICT DO NOTHING`,
      [VH_EPISODE_A, ORG_A, VH_PATIENT_A, VH_EPISODE_B, ORG_B, VH_PATIENT_B]
    );

    /* Walk-ins on both sides — `appointment_id` is nullable precisely so a
       consultation with no booking is representable (CD-1), and it keeps this
       fixture free of the whole scheduling chain. */
    await owner.query(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id,
          doctor_profile_id, template_id, template_version_id, template_snapshot,
          chief_complaint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $11, $12, $13::jsonb, 'A complaint', now()),
              ($7, $8, $9, $10, $14, $15, $11, $12, $13::jsonb, 'B complaint', now())
       ON CONFLICT DO NOTHING`,
      [
        VH_ENC_A,
        ORG_A,
        BRANCH_A,
        VH_PATIENT_A,
        VH_EPISODE_A,
        VH_DOC_A,
        VH_ENC_B2,
        ORG_B,
        BRANCH_B2,
        VH_PATIENT_B,
        VH_TPL,
        VH_VER,
        DEFINITION,
        VH_EPISODE_B,
        VH_DOC_B,
      ]
    );
  });

  afterAll(async () => {
    /* ⚠️ THE ENCOUNTERS GO FIRST, AND THIS HOOK RUNS BEFORE THE HARNESS'S. Jest
       runs an inner `afterAll` before the outer one, so the organizations are
       still here and their encounters still cite the platform version, which is
       `ON DELETE RESTRICT` exactly so a cited version cannot vanish. */
    await owner.query('DELETE FROM encounters WHERE id = ANY($1)', [[VH_ENC_A, VH_ENC_B2]]);
    await owner.query('DELETE FROM consultation_template_versions WHERE id = $1', [VH_VER]);
    await owner.query('DELETE FROM consultation_templates WHERE id = $1', [VH_TPL]);
    await owner.query('DELETE FROM specialties WHERE id = $1', [VH_CONTEXT]);
    await owner.query('DELETE FROM clinical_episodes WHERE id = ANY($1)', [
      [VH_EPISODE_A, VH_EPISODE_B],
    ]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[VH_DOC_A, VH_DOC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[VH_PATIENT_A, VH_PATIENT_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[VH_USER_A, VH_USER_B]]);
  });

  it("sees its own journey's consultations", async () => {
    const ids = await asTenantAtBranches(ORG_A, [BRANCH_A], () =>
      encountersUnderEpisodes(VH_PATIENT_A)
    );
    expect(ids).toEqual([VH_ENC_A]);
  });

  /**
   * ⚠️ CASE 1 — THE ORGANIZATION. Clinic A asking for B's patient must get
   *   nothing, not an error: RLS filters, it does not refuse, and a leak here
   *   would be one clinic reading another's clinical record through a join that
   *   looks entirely innocent.
   */
  it('reaches none of the other tenant’s consultations through the journey', async () => {
    const ids = await asTenantAtBranches(ORG_A, [BRANCH_A], () =>
      encountersUnderEpisodes(VH_PATIENT_B)
    );
    expect(ids).toEqual([]);
  });

  /**
   * ⚠️ CASE 2 — THE BRANCH, THROUGH AN ORG-SCOPED PARENT. This is the shape CE-5
   *   introduced. The journey IS visible at B1 — a person is one person across a
   *   hospital group — and every consultation on it happened at B2, so the right
   *   answer is "your colleague's journey, and none of its clinical content".
   *
   *   If `encounters` were only in the tenant loop and not the branch one, this
   *   returns B2's chief complaint to a reader at B1 and nothing anywhere says
   *   it should not have.
   */
  it('sees the journey from the other branch and none of the consultations on it', async () => {
    const visible = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const episodes = await app.query<{ id: string }>(
        `SELECT id FROM clinical_episodes WHERE patient_id = $1 AND deleted_at IS NULL`,
        [VH_PATIENT_B]
      );
      const encounters = await encountersUnderEpisodes(VH_PATIENT_B);
      return { episodes: episodes.rows.map((r) => r.id), encounters };
    });

    /* The journey is org-scoped and follows the patient. */
    expect(visible.episodes).toEqual([VH_EPISODE_B]);
    /* The visits are not. */
    expect(visible.encounters).toEqual([]);
  });

  it('sees them from the branch they were written at', async () => {
    const ids = await asTenantAtBranches(ORG_B, [BRANCH_B2], () =>
      encountersUnderEpisodes(VH_PATIENT_B)
    );
    expect(ids).toEqual([VH_ENC_B2]);
  });

  /**
   * ⚠️ CASE 3 — THE RECALL JOIN'S FAR END. CE-5 added
   *   `appointments -> doctor_profiles -> users` to `listRecall`, so the desk's
   *   booking form knows whose diary to show. `users` is a PLATFORM table with
   *   no tenant column and no policy — it is only safe because it is reached
   *   through `doctor_profiles`, which has both. This asserts that the reach is
   *   what stops it: A cannot name B's clinician through the doctor profile.
   */
  it('cannot reach the other tenant’s clinician through the doctor profile', async () => {
    const names = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const rows = await app.query<{ full_name: string }>(
        `SELECT u.full_name
           FROM doctor_profiles dp
           JOIN users u ON u.id = dp.user_id
          WHERE dp.id = ANY($1)`,
        [[VH_DOC_A, VH_DOC_B]]
      );
      return rows.rows.map((r) => r.full_name);
    });

    expect(names).toEqual(['VH Doc A']);
  });
});
