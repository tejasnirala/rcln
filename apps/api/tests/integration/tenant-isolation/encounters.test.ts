/**
 * Tenant isolation — the consultation itself (CE-3).
 *
 * The most sensitive pair of tables in the product: `encounters` and
 * `encounter_sections` hold what a named clinician concluded about a named
 * patient, in free text, on a shared database.
 *
 * Three distinct boundaries are asserted here, and they fail in three different
 * ways:
 *
 *   1. THE ORGANIZATION — clinic A must see nothing of clinic B's consultation.
 *      A missing `tenant_isolation` policy is silent; this is what finds it.
 *
 *   2. THE BRANCH — `encounters` is in BOTH loops, unlike `clinical_episodes`.
 *      A journey follows the patient across a hospital group; the VISIT belongs
 *      to the place it happened at, so a reader scoped to B1 must not read what
 *      was written at B2 even inside the right tenant.
 *
 *   3. THE TEMPLATE IT CITES — `template_id` and `template_version_id` are PLAIN
 *      FKs, because a composite one would make the platform's GENERAL template
 *      uncitable (the encounter's organization_id is NOT NULL, so the FK would
 *      demand a template belonging to the clinic). `template_visible` is what
 *      stands in for the composite FK, and without it clinic A anchors its own
 *      consultation to clinic B's private template and reads B's whole
 *      configuration back out of the join.
 *
 * ⚠️ `encounter_sections` CARRIES ITS OWN organization_id AND branch_id rather
 *   than inheriting through its encounter, so it is an ordinary member of both
 *   loops. The last cases assert that directly — a child of a branch-scoped
 *   parent that inherited only the org half is the exact hole
 *   `appointment_status_history` had to restate by hand.
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

describe('encounters', () => {
  const ENC_CONTEXT = 'eeeeeeee-1111-4111-8111-000000000001';
  const ENC_TPL_PLATFORM = 'eeeeeeee-2222-4222-8222-000000000001';
  const ENC_VER_PLATFORM = 'eeeeeeee-3333-4333-8333-000000000001';
  const ENC_TPL_B = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const ENC_VER_B = 'eeeeeeee-3333-4333-8333-0000000000b1';

  const ENC_PATIENT_A = 'eeeeeeee-4444-4444-8444-0000000000a1';
  const ENC_PATIENT_B = 'eeeeeeee-4444-4444-8444-0000000000b1';
  const ENC_USER_A = 'eeeeeeee-5555-4555-8555-0000000000a1';
  const ENC_USER_B = 'eeeeeeee-5555-4555-8555-0000000000b1';
  const ENC_DOC_A = 'eeeeeeee-6666-4666-8666-0000000000a1';
  const ENC_DOC_B = 'eeeeeeee-6666-4666-8666-0000000000b1';
  const ENC_EPISODE_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const ENC_EPISODE_B = 'eeeeeeee-7777-4777-8777-0000000000b1';

  const ENC_A = 'eeeeeeee-8888-4888-8888-0000000000a1';
  /** Written at B2, so a reader scoped to B1 must not see it. */
  const ENC_B2 = 'eeeeeeee-8888-4888-8888-0000000000b2';
  const SECTION_B2 = 'eeeeeeee-9999-4999-8999-0000000000b2';

  /** The smallest legal document. Its shape is @rcln/clinical's business. */
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

  beforeAll(async () => {
    /*
     * ⚠️ THE CARE CONTEXT IS A PLATFORM ROW AND DOES NOT CASCADE when the
     *   harness deletes its organizations, so it is inserted as a ROOT of type
     *   CARE_CONTEXT — `clinical-taxonomy` asserts every root is one, and a
     *   parentless SPECIALTY left behind here fails that suite on the NEXT run.
     */
    await owner.query(
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_ENC_CONTEXT', 'Isolation encounters', 'CARE_CONTEXT', now())
       ON CONFLICT DO NOTHING`,
      [ENC_CONTEXT]
    );

    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_ENC_PLATFORM', 'Platform consultation', $3, NULL, now()),
              ($2, $4,   'ISO_ENC_B',        'B consultation',        $3, NULL, now())
       ON CONFLICT DO NOTHING`,
      [ENC_TPL_PLATFORM, ENC_TPL_B, ENC_CONTEXT, ORG_B]
    );
    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $3, 1, $5::jsonb, 'PUBLISHED', now(), now()),
              ($2, $4,   $6, 1, $5::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [ENC_VER_PLATFORM, ENC_VER_B, ENC_TPL_PLATFORM, ORG_B, DEFINITION, ENC_TPL_B]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'ENCA0001', 'Enc A', now()), ($3, $4, 'ENCB0001', 'Enc B', now())
       ON CONFLICT DO NOTHING`,
      [ENC_PATIENT_A, ORG_A, ENC_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Enc Doc A', 'enc-doc-a@example.test', now()),
              ($2, 'Enc Doc B', 'enc-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [ENC_USER_A, ENC_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [ENC_DOC_A, ORG_A, ENC_USER_A, ENC_DOC_B, ORG_B, ENC_USER_B]
    );
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOENCEPA1', DATE '2027-06-01', now()),
              ($4, $5, $6, 'ISOENCEPB1', DATE '2027-06-01', now())
       ON CONFLICT DO NOTHING`,
      [ENC_EPISODE_A, ORG_A, ENC_PATIENT_A, ENC_EPISODE_B, ORG_B, ENC_PATIENT_B]
    );

    /* Both walk-ins: `appointment_id` is nullable precisely so a consultation
       without a booking is representable (CD-1), and it keeps this fixture from
       needing the whole scheduling chain. */
    await owner.query(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id,
          doctor_profile_id, template_id, template_version_id, template_snapshot,
          chief_complaint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $13::jsonb, 'A complaint', now()),
              ($9, $10, $11, $12, $14, $15, $16, $17, $13::jsonb, 'B complaint', now())
       ON CONFLICT DO NOTHING`,
      [
        ENC_A,
        ORG_A,
        BRANCH_A,
        ENC_PATIENT_A,
        ENC_EPISODE_A,
        ENC_DOC_A,
        ENC_TPL_PLATFORM,
        ENC_VER_PLATFORM,
        ENC_B2,
        ORG_B,
        BRANCH_B2,
        ENC_PATIENT_B,
        DEFINITION,
        ENC_EPISODE_B,
        ENC_DOC_B,
        ENC_TPL_B,
        ENC_VER_B,
      ]
    );

    await owner.query(
      `INSERT INTO encounter_sections
         (id, organization_id, branch_id, encounter_id, section_type, section_key, data, updated_at)
       VALUES ($1, $2, $3, $4, 'EXAMINATION', 'examination', '{"note":"B findings"}'::jsonb, now())
       ON CONFLICT DO NOTHING`,
      [SECTION_B2, ORG_B, BRANCH_B2, ENC_B2]
    );
  });

  afterAll(async () => {
    /*
     * The PLATFORM template, its version and the care context do NOT cascade
     * when the harness deletes the two organizations — a platform row a test
     * leaves behind outlives the run and breaks a later one.
     *
     * ⚠️ THE ENCOUNTERS GO FIRST, AND THIS HOOK RUNS BEFORE THE HARNESS'S. Jest
     *   runs an inner `afterAll` before the outer one, so the organizations are
     *   still here and their encounters still cite the platform version —
     *   `template_version_id` is `ON DELETE RESTRICT`, exactly so that a version
     *   an encounter cites cannot be deleted out from under it.
     */
    await owner.query('DELETE FROM encounters WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM appointments WHERE organization_id = $1', [ORG_A]);
    await owner.query('DELETE FROM consultation_template_versions WHERE id = ANY($1)', [
      [ENC_VER_PLATFORM, ENC_VER_B],
    ]);
    await owner.query('DELETE FROM consultation_templates WHERE id = ANY($1)', [
      [ENC_TPL_PLATFORM, ENC_TPL_B],
    ]);
    await owner.query('DELETE FROM specialties WHERE id = $1', [ENC_CONTEXT]);
    await owner.query('DELETE FROM clinical_episodes WHERE id = ANY($1)', [
      [ENC_EPISODE_A, ENC_EPISODE_B],
    ]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[ENC_DOC_A, ENC_DOC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[ENC_PATIENT_A, ENC_PATIENT_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[ENC_USER_A, ENC_USER_B]]);
  });

  // -- the organization boundary --------------------------------------------

  it('shows one clinic nothing of another’s consultation', async () => {
    const seen = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM encounters WHERE id = $1', [ENC_B2]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE SECTION IS WHERE THE CLINICAL TEXT ACTUALLY LIVES for a
   *   descriptor-driven section. A policy on the parent alone would hide the
   *   chief complaint and leak the examination findings.
   */
  it('shows one clinic nothing of another’s section answers', async () => {
    const seen = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM encounter_sections WHERE id = $1', [
        SECTION_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a consultation into another clinic', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounters
             (id, organization_id, branch_id, patient_id, clinical_episode_id,
              doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
          [
            ORG_B,
            BRANCH_B2,
            ENC_PATIENT_B,
            ENC_EPISODE_B,
            ENC_DOC_B,
            ENC_TPL_PLATFORM,
            ENC_VER_PLATFORM,
            DEFINITION,
          ]
        )
      )
    ).rejects.toThrow(/row-level security|violates foreign key/i);
  });

  // -- the branch boundary --------------------------------------------------

  /**
   * ⚠️ THE CALL `clinical_episodes` DELIBERATELY DOES NOT MAKE. The journey is
   *   org-wide so a patient's history follows them between sites; the VISIT
   *   belongs to the site it happened at, and `branch_id` is NOT NULL here, so
   *   this boundary is absolute rather than NULL-tolerant.
   */
  it('hides a consultation written at another branch of the same clinic', async () => {
    const seen = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM encounters WHERE id = $1', [ENC_B2]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows it to a reader scoped to the branch it was written at', async () => {
    const seen = await asTenantAtBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM encounters WHERE id = $1', [ENC_B2]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  /**
   * ⚠️ THE CHILD CARRIES ITS OWN `branch_id`, WHICH IS WHY THIS PASSES WITHOUT A
   *   HAND-WRITTEN PARENT PREDICATE. A section that inherited only the org half
   *   through its encounter would be readable here — the exact hole
   *   `appointment_status_history` had to restate by hand.
   */
  it('hides the section answers from another branch too', async () => {
    const seen = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM encounter_sections WHERE id = $1', [
        SECTION_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  // -- the template it cites ------------------------------------------------

  /**
   * ⚠️ THE CASE THAT WOULD PASS SILENTLY WITHOUT `template_visible`.
   *
   *   `template_id` is a plain FK — a composite one is impossible here, because
   *   the platform's GENERAL template has a NULL organization_id and the
   *   encounter's is NOT NULL, so the FK would refuse the most ordinary
   *   consultation on the platform. That leaves `tenant_isolation` constraining
   *   the ENCOUNTER row and saying nothing about the template it names.
   *
   *   Without the RESTRICTIVE policy this INSERT succeeds, and clinic A then
   *   reads clinic B's entire consultation configuration — every section, label
   *   and descriptor — back out of the join.
   */
  it('refuses to let a clinic conduct a consultation under another clinic’s template', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounters
             (id, organization_id, branch_id, patient_id, clinical_episode_id,
              doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
          [
            ORG_A,
            BRANCH_A,
            ENC_PATIENT_A,
            ENC_EPISODE_A,
            ENC_DOC_A,
            ENC_TPL_B,
            ENC_VER_B,
            DEFINITION,
          ]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** And the platform's template stays citable by everybody, which is the point. */
  it('lets a clinic conduct a consultation under the platform template', async () => {
    const written = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query(
        `INSERT INTO encounters
           (id, organization_id, branch_id, patient_id, clinical_episode_id,
            doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
         RETURNING id`,
        [
          ORG_A,
          BRANCH_A,
          ENC_PATIENT_A,
          ENC_EPISODE_A,
          ENC_DOC_A,
          ENC_TPL_PLATFORM,
          ENC_VER_PLATFORM,
          DEFINITION,
        ]
      );
      return rows.length;
    });
    expect(written).toBe(1);
  });

  // -- the lifecycle constraints --------------------------------------------

  /**
   * ⚠️ NOT AN RLS CASE, AND IT BELONGS HERE ANYWAY. A FINALIZED row with no
   *   `finalized_at` reads as signed in every screen and sorts to the bottom of
   *   every date-ordered list — it is what a half-written transaction leaves
   *   behind, and the CHECK is the only thing that refuses it.
   */
  it('refuses a signed consultation with no signature', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounters
           (id, organization_id, branch_id, patient_id, clinical_episode_id,
            doctor_profile_id, template_id, template_version_id, template_snapshot,
            status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'FINALIZED', now())`,
        [
          ORG_A,
          BRANCH_A,
          ENC_PATIENT_A,
          ENC_EPISODE_A,
          ENC_DOC_A,
          ENC_TPL_PLATFORM,
          ENC_VER_PLATFORM,
          DEFINITION,
        ]
      )
    ).rejects.toThrow(/encounters_lifecycle_facts/i);
  });

  /**
   * ⚠️ THE SECOND "START CONSULTATION" CLICK. Without the partial unique index a
   *   double submit opens two records of one visit, and which one the
   *   prescription hangs off is a race nobody can see afterwards.
   */
  it('refuses a second live consultation for one appointment', async () => {
    const APPOINTMENT = 'eeeeeeee-aaaa-4aaa-8aaa-0000000000a1';
    const REGISTRATION = 'eeeeeeee-bbbb-4bbb-8bbb-0000000000a1';
    await owner.query(
      `INSERT INTO patient_registrations
         (id, organization_id, patient_id, branch_id, mrn, updated_at)
       VALUES ($1, $2, $3, $4, 'ENCMRNA', now())
       ON CONFLICT DO NOTHING`,
      [REGISTRATION, ORG_A, ENC_PATIENT_A, BRANCH_A]
    );
    await owner.query(
      `INSERT INTO appointments
         (id, organization_id, branch_id, patient_id, patient_registration_id,
          doctor_profile_id, clinical_episode_id, appointment_number,
          scheduled_start, scheduled_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ENCAPT1',
               now(), now() + interval '15 minutes', now())
       ON CONFLICT DO NOTHING`,
      [APPOINTMENT, ORG_A, BRANCH_A, ENC_PATIENT_A, REGISTRATION, ENC_DOC_A, ENC_EPISODE_A]
    );

    const insert = (): Promise<unknown> =>
      owner.query(
        `INSERT INTO encounters
           (id, organization_id, branch_id, patient_id, appointment_id, clinical_episode_id,
            doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $9, $4, $5, $6, $7, $8::jsonb, now())`,
        [
          ORG_A,
          BRANCH_A,
          ENC_PATIENT_A,
          ENC_EPISODE_A,
          ENC_DOC_A,
          ENC_TPL_PLATFORM,
          ENC_VER_PLATFORM,
          DEFINITION,
          APPOINTMENT,
        ]
      );

    await insert();
    await expect(insert()).rejects.toThrow(/encounters_one_live_per_appointment/i);
  });
});
