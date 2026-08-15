/**
 * Tenant isolation — the clinical content of a consultation (CE-4).
 *
 * The densest PHI in the product: what a named clinician CONCLUDED about a
 * named patient, what they prescribed, and who they sent them to. `encounters`
 * next door holds what the patient said; these eight tables hold the answer.
 *
 * Four distinct boundaries are asserted here, and they fail in four different
 * ways:
 *
 *   1. THE ORGANIZATION — clinic A must see nothing of clinic B's diagnoses or
 *      prescriptions. A missing `tenant_isolation` policy is silent.
 *
 *   2. THE BRANCH — every one of these carries its OWN `organization_id` and
 *      `branch_id` rather than inheriting through its encounter, so each is an
 *      ordinary member of both loops. A child that inherited only the org half
 *      is exactly the hole `appointment_status_history` had to restate by hand,
 *      and these cases are what would notice.
 *
 *   3. THE CLINICAL WORD IT CITES — `item_id` is a PLAIN FK on five of the
 *      tables, because a composite one would refuse the platform's shared
 *      vocabulary (the item's organization_id is NULL and the content row's is
 *      NOT NULL). `item_visible` is what stands in for the composite FK, and
 *      without it clinic A records a diagnosis citing clinic B's private word
 *      and reads its name back out of the join — a competitor's clinical
 *      vocabulary, disclosed one selector at a time.
 *
 *   4. THE PRODUCT AND THE SPECIALTY — the same shape again, on
 *      `encounter_prescriptions.product_id` and `encounter_referrals.specialty_id`.
 *      `NEXT_SESSION.md` item 1 predicted the first of these would be needed.
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

describe('encounter content', () => {
  const CNT_CONTEXT = 'cccccccc-1111-4111-8111-000000000001';
  const CNT_TPL = 'cccccccc-2222-4222-8222-000000000001';
  const CNT_VER = 'cccccccc-3333-4333-8333-000000000001';

  const CNT_PATIENT_A = 'cccccccc-4444-4444-8444-0000000000a1';
  const CNT_PATIENT_B = 'cccccccc-4444-4444-8444-0000000000b1';
  const CNT_USER_A = 'cccccccc-5555-4555-8555-0000000000a1';
  const CNT_USER_B = 'cccccccc-5555-4555-8555-0000000000b1';
  const CNT_DOC_A = 'cccccccc-6666-4666-8666-0000000000a1';
  const CNT_DOC_B = 'cccccccc-6666-4666-8666-0000000000b1';
  const CNT_EPISODE_A = 'cccccccc-7777-4777-8777-0000000000a1';
  const CNT_EPISODE_B = 'cccccccc-7777-4777-8777-0000000000b1';

  const CNT_ENC_A = 'cccccccc-8888-4888-8888-0000000000a1';
  /** Written at B2, so a reader scoped to B1 must not see it. */
  const CNT_ENC_B2 = 'cccccccc-8888-4888-8888-0000000000b2';

  const DIAGNOSIS_B2 = 'cccccccc-9999-4999-8999-0000000000b2';
  const PRESCRIPTION_B2 = 'cccccccc-9999-4999-8999-0000000000b3';

  /** A PLATFORM word every clinic sees, and a PRIVATE one belonging to B. */
  const ITEM_PLATFORM = 'cccccccc-aaaa-4aaa-8aaa-000000000001';
  const ITEM_B = 'cccccccc-aaaa-4aaa-8aaa-0000000000b1';
  /** The same pair for the product catalogue. */
  const PRODUCT_PLATFORM = 'cccccccc-bbbb-4bbb-8bbb-000000000001';
  const PRODUCT_B = 'cccccccc-bbbb-4bbb-8bbb-0000000000b1';

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
    /* A CARE_CONTEXT root, for the reason `encounters.test.ts` records: a
       parentless SPECIALTY left behind fails the taxonomy suite on the NEXT run. */
    await owner.query(
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_CNT_CONTEXT', 'Isolation content', 'CARE_CONTEXT', now())
       ON CONFLICT DO NOTHING`,
      [CNT_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_CNT_PLATFORM', 'Platform consultation', $2, NULL, now())
       ON CONFLICT DO NOTHING`,
      [CNT_TPL, CNT_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $2, 1, $3::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [CNT_VER, CNT_TPL, DEFINITION]
    );

    /*
     * ⚠️ ONE PLATFORM WORD AND ONE PRIVATE ONE. The pair is the whole point: the
     *   platform row must stay citable by everybody, and B's must be uncitable
     *   by A. A test with only the second would pass against a policy that
     *   refused the platform catalogue outright.
     */
    await owner.query(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES ($1, NULL, 'DIAGNOSIS', 'ISO_CNT_PLATFORM_DX', 'Platform diagnosis', now()),
              ($2, $3,   'DIAGNOSIS', 'ISO_CNT_B_DX',        'B private diagnosis', now())
       ON CONFLICT DO NOTHING`,
      [ITEM_PLATFORM, ITEM_B, ORG_B]
    );
    await owner.query(
      /* ⚠️ `base_unit_id` IS REQUIRED — see PI-ADR-010. */
      `INSERT INTO products
         (id, organization_id, type, code, name, status, base_unit_id, updated_at)
       VALUES ($1, NULL, 'MEDICINE', 'ISO_CNT_PLATFORM_RX', 'Platform medicine', 'ACTIVE',
               (SELECT id FROM units_of_measure ORDER BY code LIMIT 1), now()),
              ($2, $3,   'MEDICINE', 'ISO_CNT_B_RX',        'B private medicine', 'ACTIVE',
               (SELECT id FROM units_of_measure ORDER BY code LIMIT 1), now())
       ON CONFLICT DO NOTHING`,
      [PRODUCT_PLATFORM, PRODUCT_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'CNTA0001', 'Cnt A', now()), ($3, $4, 'CNTB0001', 'Cnt B', now())
       ON CONFLICT DO NOTHING`,
      [CNT_PATIENT_A, ORG_A, CNT_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Cnt Doc A', 'cnt-doc-a@example.test', now()),
              ($2, 'Cnt Doc B', 'cnt-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [CNT_USER_A, CNT_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [CNT_DOC_A, ORG_A, CNT_USER_A, CNT_DOC_B, ORG_B, CNT_USER_B]
    );
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOCNTEPA1', DATE '2027-06-01', now()),
              ($4, $5, $6, 'ISOCNTEPB1', DATE '2027-06-01', now())
       ON CONFLICT DO NOTHING`,
      [CNT_EPISODE_A, ORG_A, CNT_PATIENT_A, CNT_EPISODE_B, ORG_B, CNT_PATIENT_B]
    );

    /* Walk-ins (CD-1), which keeps this fixture off the scheduling chain. */
    await owner.query(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id,
          doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $11, $12, $13::jsonb, now()),
              ($7, $8, $9, $10, $14, $15, $11, $12, $13::jsonb, now())
       ON CONFLICT DO NOTHING`,
      [
        CNT_ENC_A,
        ORG_A,
        BRANCH_A,
        CNT_PATIENT_A,
        CNT_EPISODE_A,
        CNT_DOC_A,
        CNT_ENC_B2,
        ORG_B,
        BRANCH_B2,
        CNT_PATIENT_B,
        CNT_TPL,
        CNT_VER,
        DEFINITION,
        CNT_EPISODE_B,
        CNT_DOC_B,
      ]
    );

    await owner.query(
      `INSERT INTO encounter_diagnoses
         (id, organization_id, branch_id, encounter_id, item_id, role, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'PRIMARY', now())
       ON CONFLICT DO NOTHING`,
      [DIAGNOSIS_B2, ORG_B, BRANCH_B2, CNT_ENC_B2, ITEM_B]
    );
    await owner.query(
      `INSERT INTO encounter_prescriptions
         (id, organization_id, branch_id, encounter_id, product_id, instructions, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Two at night', now())
       ON CONFLICT DO NOTHING`,
      [PRESCRIPTION_B2, ORG_B, BRANCH_B2, CNT_ENC_B2, PRODUCT_B]
    );
  });

  afterAll(async () => {
    /*
     * ⚠️ THE CONTENT AND THE ENCOUNTERS GO FIRST, AND THIS HOOK RUNS BEFORE THE
     *   HARNESS'S. Jest runs an inner `afterAll` before the outer one, so the
     *   organizations are still here — and the content rows cite platform items
     *   and products with `ON DELETE RESTRICT`, exactly so that a word a
     *   consultation used cannot be deleted out from under it.
     */
    await owner.query('DELETE FROM encounter_prescriptions WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounter_procedures WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounter_diagnoses WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounter_symptoms WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounter_referrals WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounters WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM consultation_template_versions WHERE id = $1', [CNT_VER]);
    await owner.query('DELETE FROM consultation_templates WHERE id = $1', [CNT_TPL]);
    await owner.query('DELETE FROM specialties WHERE id = $1', [CNT_CONTEXT]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[PRODUCT_PLATFORM, PRODUCT_B]]);
    await owner.query('DELETE FROM clinical_master_items WHERE id = ANY($1)', [
      [ITEM_PLATFORM, ITEM_B],
    ]);
    await owner.query('DELETE FROM clinical_episodes WHERE id = ANY($1)', [
      [CNT_EPISODE_A, CNT_EPISODE_B],
    ]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[CNT_DOC_A, CNT_DOC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[CNT_PATIENT_A, CNT_PATIENT_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[CNT_USER_A, CNT_USER_B]]);
  });

  // -- the organization boundary --------------------------------------------

  it('shows one clinic nothing of another’s diagnoses', async () => {
    const seen = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM encounter_diagnoses WHERE id = $1', [
        DIAGNOSIS_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows one clinic nothing of another’s prescriptions', async () => {
    const seen = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM encounter_prescriptions WHERE id = $1', [
        PRESCRIPTION_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write clinical content into another clinic', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounter_diagnoses
             (id, organization_id, branch_id, encounter_id, item_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [ORG_B, BRANCH_B2, CNT_ENC_B2, ITEM_PLATFORM]
        )
      )
    ).rejects.toThrow(/row-level security|violates foreign key/i);
  });

  // -- the branch boundary --------------------------------------------------

  /**
   * ⚠️ THE CHILD CARRIES ITS OWN `branch_id`, WHICH IS WHY THIS PASSES WITHOUT A
   *   HAND-WRITTEN PARENT PREDICATE. Content that inherited only the org half
   *   through its encounter would be readable here — the exact hole
   *   `appointment_status_history` had to restate by hand, and the reason
   *   SCHEMA.md is explicit that all eight carry both ids.
   */
  it('hides content written at another branch of the same clinic', async () => {
    const seen = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const diagnoses = await app.query('SELECT id FROM encounter_diagnoses WHERE id = $1', [
        DIAGNOSIS_B2,
      ]);
      const prescriptions = await app.query(
        'SELECT id FROM encounter_prescriptions WHERE id = $1',
        [PRESCRIPTION_B2]
      );
      return diagnoses.rows.length + prescriptions.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows it to a reader scoped to the branch it was written at', async () => {
    const seen = await asTenantAtBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM encounter_diagnoses WHERE id = $1', [
        DIAGNOSIS_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  // -- the clinical word it cites -------------------------------------------

  /**
   * ⚠️ THE CASE THAT WOULD PASS SILENTLY WITHOUT `item_visible`.
   *
   *   `item_id` is a plain FK — a composite one is impossible, because a
   *   platform word has a NULL organization_id and this row's is NOT NULL, so
   *   the constraint would refuse the entire shared vocabulary. That leaves
   *   `tenant_isolation` constraining the DIAGNOSIS row and saying nothing about
   *   the word it names.
   *
   *   Without the RESTRICTIVE policy this INSERT succeeds, and clinic A then
   *   reads clinic B's private clinical vocabulary back out of the join.
   */
  it('refuses to let a clinic record a diagnosis citing another clinic’s word', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounter_diagnoses
             (id, organization_id, branch_id, encounter_id, item_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [ORG_A, BRANCH_A, CNT_ENC_A, ITEM_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** And the platform's vocabulary stays usable by everybody, which is the point. */
  it('lets a clinic record a diagnosis citing the platform’s word', async () => {
    const written = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query(
        `INSERT INTO encounter_diagnoses
           (id, organization_id, branch_id, encounter_id, item_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
         RETURNING id`,
        [ORG_A, BRANCH_A, CNT_ENC_A, ITEM_PLATFORM]
      );
      return rows.length;
    });
    expect(written).toBe(1);
  });

  /** The same policy, on the four other tables that cite a word. */
  it('refuses a symptom citing another clinic’s word', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounter_symptoms
             (id, organization_id, branch_id, encounter_id, item_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [ORG_A, BRANCH_A, CNT_ENC_A, ITEM_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the product it prescribes --------------------------------------------

  /**
   * ⚠️ `NEXT_SESSION.md` ITEM 1 PREDICTED THIS TABLE WOULD NEED `product_visible`,
   *   and it does. Without it a clinic prescribes against another tenant's
   *   private product and reads its name, strength and pack size back out of the
   *   join — a competitor's formulary.
   */
  it('refuses to let a clinic prescribe another clinic’s medicine', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounter_prescriptions
             (id, organization_id, branch_id, encounter_id, product_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
          [ORG_A, BRANCH_A, CNT_ENC_A, PRODUCT_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('lets a clinic prescribe the platform’s medicine', async () => {
    const written = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query(
        `INSERT INTO encounter_prescriptions
           (id, organization_id, branch_id, encounter_id, product_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
         RETURNING id`,
        [ORG_A, BRANCH_A, CNT_ENC_A, PRODUCT_PLATFORM]
      );
      return rows.length;
    });
    expect(written).toBe(1);
  });

  // -- the constraints ------------------------------------------------------

  /**
   * ⚠️ NOT AN RLS CASE, AND IT BELONGS HERE ANYWAY. A row that is both coded and
   *   typed lets a free-text label sit beside a clinical term and contradict it,
   *   and then every report grouping by `item_id` disagrees with the chart.
   */
  it('refuses a diagnosis that is both coded and typed', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_diagnoses
           (id, organization_id, branch_id, encounter_id, item_id, custom_text, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Something else', now())`,
        [ORG_A, BRANCH_A, CNT_ENC_A, ITEM_PLATFORM]
      )
    ).rejects.toThrow(/coded_or_typed/i);
  });

  it('refuses a diagnosis that is neither', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_diagnoses
           (id, organization_id, branch_id, encounter_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [ORG_A, BRANCH_A, CNT_ENC_A]
      )
    ).rejects.toThrow(/coded_or_typed/i);
  });

  /**
   * ⚠️ TWO PRIMARIES IS TWO ANSWERS TO "WHAT WAS THIS VISIT ABOUT", and every
   *   report grouping by primary diagnosis counts the visit twice. The partial
   *   unique index is the guarantee under a race; the service's 409 is only what
   *   turns it into a sentence.
   */
  it('refuses a second primary diagnosis on one consultation', async () => {
    await owner.query(
      `INSERT INTO encounter_diagnoses
         (id, organization_id, branch_id, encounter_id, custom_text, role, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'First primary', 'PRIMARY', now())`,
      [ORG_A, BRANCH_A, CNT_ENC_A]
    );
    await expect(
      owner.query(
        `INSERT INTO encounter_diagnoses
           (id, organization_id, branch_id, encounter_id, custom_text, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'Second primary', 'PRIMARY', now())`,
        [ORG_A, BRANCH_A, CNT_ENC_A]
      )
    ).rejects.toThrow(/encounter_diagnoses_one_primary/i);
  });

  /** ⚠️ "TWICE PER" NOTHING IS A PRESCRIPTION NOBODY CAN FILL. */
  it('refuses a prescription frequency with no period', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_prescriptions
           (id, organization_id, branch_id, encounter_id, product_id, frequency, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 2, now())`,
        [ORG_A, BRANCH_A, CNT_ENC_A, PRODUCT_PLATFORM]
      )
    ).rejects.toThrow(/frequency_pair/i);
  });

  /** ⚠️ A REFERRAL NAMING NOBODY IS A REFERRAL TO NOBODY. */
  it('refuses a referral with no destination', async () => {
    await expect(
      owner.query(
        `INSERT INTO encounter_referrals
           (id, organization_id, branch_id, encounter_id, reason, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'Because', now())`,
        [ORG_A, BRANCH_A, CNT_ENC_A]
      )
    ).rejects.toThrow(/names_a_destination/i);
  });
});
