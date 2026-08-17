/**
 * Tenant isolation — clinical consumption (PI-9).
 *
 * Five tables, TWO tenancy classes, the same split charging has:
 *
 *   `consumption_templates`       org-scoped, NO branch column at all
 *   `consumption_template_lines`  org-scoped, NO branch column at all
 *   `clinical_consumptions`       org + branch, `branch_id` NOT NULL
 *   `consumption_lines`           org + branch, `branch_id` NOT NULL
 *   `consumption_allocations`     org + branch, `branch_id` NOT NULL
 *
 * ⚠️ WHAT IS BEING PROTECTED IS "WHICH IMPLANT IS IN WHICH NAMED PERSON". A
 *   consumption record is a patient beside a device serial beside a procedure,
 *   and it is answerable by primary key from three directions — the patient, the
 *   lot and the procedure. A missing policy produces no error, breaks no
 *   single-tenant test, and quietly answers another clinic's question about
 *   somebody's surgery.
 *
 * ⚠️ AND THE `*_visible` POLICIES GET CASES OF THEIR OWN, because `db:rls:check`
 *   structurally cannot see them (KI-3). `tenant_isolation` is satisfied when the
 *   ROW is yours; nothing in it stops the row pointing at another clinic's
 *   private product or private procedure word and reading the name back through
 *   the join that renders it. THREE plain FKs land in this phase — the procedure
 *   word on the template, and the product and unit on both line tables — and
 *   this exact class has produced a CRITICAL in three separate phases.
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

describe('clinical consumption', () => {
  const CN_UNIT = 'dddddddd-1111-4111-8111-000000000001';
  /** ⚠️ Both private to their clinic. A platform row would prove nothing. */
  const CN_PROD_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const CN_PROD_B = 'dddddddd-7777-4777-8777-0000000000b1';
  /** One PLATFORM procedure word and one private to B, for the same reason. */
  const CN_ITEM_PLATFORM = 'dddddddd-6666-4666-8666-000000000001';
  const CN_ITEM_B = 'dddddddd-6666-4666-8666-0000000000b1';

  const CN_USER_A = 'dddddddd-8888-4888-8888-0000000000a1';
  const CN_USER_B = 'dddddddd-8888-4888-8888-0000000000b1';
  const CN_DOC_B = 'dddddddd-9999-4999-8999-0000000000b1';
  const CN_PATIENT_B = 'dddddddd-3333-4333-8333-0000000000b1';
  const CN_EPISODE_B = 'dddddddd-4444-4444-8444-0000000000b1';
  const CN_ENC_B = 'dddddddd-5555-4555-8555-0000000000b1';
  const CN_PROC_B = 'dddddddd-5555-4555-8555-0000000000b2';
  const CN_LOC_B1 = 'dddddddd-2222-4222-8222-0000000000b1';

  const CN_CONTEXT = 'dddddddd-aaaa-4aaa-8aaa-000000000001';
  const CN_TPL = 'dddddddd-aaaa-4aaa-8aaa-000000000002';
  const CN_VER = 'dddddddd-aaaa-4aaa-8aaa-000000000003';
  const DEFINITION = JSON.stringify({ sections: [] });

  const TEMPLATE_A = 'dddddddd-bbbb-4bbb-8bbb-0000000000a1';
  const TEMPLATE_B = 'dddddddd-bbbb-4bbb-8bbb-0000000000b1';
  const TLINE_B = 'dddddddd-bbbb-4bbb-8bbb-0000000000b2';
  const CONSUMPTION_B = 'dddddddd-cccc-4ccc-8ccc-0000000000b1';
  const CLINE_B = 'dddddddd-cccc-4ccc-8ccc-0000000000b2';
  const CALLOC_B = 'dddddddd-cccc-4ccc-8ccc-0000000000b3';

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
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'CN_ISO_UNIT', 'Consumption Iso Unit', 'niu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [CN_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'CONSUMABLE', 'ACTIVE', 'CN_ISO_PROD_A', 'Consumption Iso A', $4, 'NONE', now()),
              ($2, $5, 'CONSUMABLE', 'ACTIVE', 'CN_ISO_PROD_B', 'Consumption Iso B', $4, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [CN_PROD_A, CN_PROD_B, ORG_A, CN_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES ($1, NULL, 'PROCEDURE', 'ISO_CN_PLATFORM_PROC', 'Platform procedure', now()),
              ($2, $3,   'PROCEDURE', 'ISO_CN_B_PROC',        'B private procedure', now())
       ON CONFLICT DO NOTHING`,
      [CN_ITEM_PLATFORM, CN_ITEM_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Cn Actor A', 'cn-iso-a@example.test', now()),
              ($2, 'Cn Actor B', 'cn-iso-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [CN_USER_A, CN_USER_B]
    );

    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
      [CN_DOC_B, ORG_B, CN_USER_B]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'CNISOB001', 'Consumption B', now()) ON CONFLICT DO NOTHING`,
      [CN_PATIENT_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO clinical_episodes (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOCNEPB1', DATE '2027-06-01', now()) ON CONFLICT DO NOTHING`,
      [CN_EPISODE_B, ORG_B, CN_PATIENT_B]
    );

    /* A CARE_CONTEXT root, for the reason `encounters.test.ts` records: a
       parentless SPECIALTY left behind fails the taxonomy suite on the NEXT run. */
    await owner.query(
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_CN_CONTEXT', 'Isolation consumption', 'CARE_CONTEXT', now())
       ON CONFLICT DO NOTHING`,
      [CN_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_CN_PLATFORM', 'Platform consultation', $2, NULL, now())
       ON CONFLICT DO NOTHING`,
      [CN_TPL, CN_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $2, 1, $3::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [CN_VER, CN_TPL, DEFINITION]
    );

    /* A walk-in (CD-1), which keeps this fixture off the scheduling chain. */
    await owner.query(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id,
          doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
       ON CONFLICT DO NOTHING`,
      [CN_ENC_B, ORG_B, BRANCH_B1, CN_PATIENT_B, CN_EPISODE_B, CN_DOC_B, CN_TPL, CN_VER, DEFINITION]
    );

    await owner.query(
      `INSERT INTO encounter_procedures
         (id, organization_id, branch_id, encounter_id, item_id, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'PERFORMED', now()) ON CONFLICT DO NOTHING`,
      [CN_PROC_B, ORG_B, BRANCH_B1, CN_ENC_B, CN_ITEM_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, is_dispensing_point, updated_at)
       VALUES ($1, $2, $3, 'PROCEDURE_ROOM', 'CN_ISO_B1', 'Consumption Iso B1', false, now())
       ON CONFLICT DO NOTHING`,
      [CN_LOC_B1, ORG_B, BRANCH_B1]
    );

    await owner.query(
      `INSERT INTO consumption_templates
         (id, organization_id, item_id, name, version, status, effective_from, updated_at)
       VALUES ($1, $2, $3, 'A tray', 1, 'ACTIVE', DATE '2027-01-01', now()),
              ($4, $5, $6, 'B tray', 1, 'ACTIVE', DATE '2027-01-01', now())
       ON CONFLICT DO NOTHING`,
      [TEMPLATE_A, ORG_A, CN_ITEM_PLATFORM, TEMPLATE_B, ORG_B, CN_ITEM_B]
    );

    await owner.query(
      `INSERT INTO consumption_template_lines
         (id, organization_id, template_id, product_id, quantity, unit_id, updated_at)
       VALUES ($1, $2, $3, $4, 2, $5, now()) ON CONFLICT DO NOTHING`,
      [TLINE_B, ORG_B, TEMPLATE_B, CN_PROD_B, CN_UNIT]
    );

    await owner.query(
      `INSERT INTO clinical_consumptions
         (id, organization_id, branch_id, kind, anchor_kind, encounter_id,
          encounter_procedure_id, patient_id, location_id, template_id,
          recorded_by_id, occurred_at, updated_at)
       VALUES ($1, $2, $3, 'CONSUMPTION', 'ENCOUNTER_PROCEDURE', $4, $5, $6, $7, $8, $9,
               now(), now())
       ON CONFLICT DO NOTHING`,
      [
        CONSUMPTION_B,
        ORG_B,
        BRANCH_B1,
        CN_ENC_B,
        CN_PROC_B,
        CN_PATIENT_B,
        CN_LOC_B1,
        TEMPLATE_B,
        CN_USER_B,
      ]
    );

    await owner.query(
      `INSERT INTO consumption_lines
         (id, organization_id, branch_id, consumption_id, line_number, template_line_id,
          product_id, expected_quantity_base, quantity_entered, unit_id, quantity_base,
          updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 2, 3, $7, 3, now())
       ON CONFLICT DO NOTHING`,
      [CLINE_B, ORG_B, BRANCH_B1, CONSUMPTION_B, TLINE_B, CN_PROD_B, CN_UNIT]
    );

    await owner.query(
      `INSERT INTO consumption_allocations
         (id, organization_id, branch_id, consumption_line_id, location_id, quantity_base)
       VALUES ($1, $2, $3, $4, $5, 3) ON CONFLICT DO NOTHING`,
      [CALLOC_B, ORG_B, BRANCH_B1, CLINE_B, CN_LOC_B1]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM consumption_allocations WHERE id = $1', [CALLOC_B]);
    await owner.query('DELETE FROM consumption_lines WHERE id = $1', [CLINE_B]);
    await owner.query('DELETE FROM clinical_consumptions WHERE id = $1', [CONSUMPTION_B]);
    await owner.query('DELETE FROM consumption_template_lines WHERE id = $1', [TLINE_B]);
    await owner.query('DELETE FROM consumption_templates WHERE id = ANY($1)', [
      [TEMPLATE_A, TEMPLATE_B],
    ]);
    await owner.query('DELETE FROM inventory_locations WHERE id = $1', [CN_LOC_B1]);
    await owner.query('DELETE FROM encounter_procedures WHERE id = $1', [CN_PROC_B]);
    await owner.query('DELETE FROM encounters WHERE id = $1', [CN_ENC_B]);
    await owner.query('DELETE FROM consultation_template_versions WHERE id = $1', [CN_VER]);
    await owner.query('DELETE FROM consultation_templates WHERE id = $1', [CN_TPL]);
    await owner.query('DELETE FROM specialties WHERE id = $1', [CN_CONTEXT]);
    await owner.query('DELETE FROM clinical_episodes WHERE id = $1', [CN_EPISODE_B]);
    await owner.query('DELETE FROM patients WHERE id = $1', [CN_PATIENT_B]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = $1', [CN_DOC_B]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[CN_USER_A, CN_USER_B]]);
    await owner.query('DELETE FROM clinical_master_items WHERE id = ANY($1)', [
      [CN_ITEM_PLATFORM, CN_ITEM_B],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[CN_PROD_A, CN_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [CN_UNIT]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [
      'consumption_templates',
      'consumption_template_lines',
      'clinical_consumptions',
      'consumption_lines',
      'consumption_allocations',
    ]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  it("shows one clinic nothing of another's templates", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM consumption_templates WHERE id = $1', [
        TEMPLATE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of another's template lines", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM consumption_template_lines WHERE id = $1', [
        TLINE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE ROW THAT NAMES A PATIENT, A PROCEDURE AND WHAT WENT INTO THEM. This is
   *   the disclosure the whole file exists for.
   */
  it("shows one clinic nothing of what another's procedures used", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM clinical_consumptions WHERE id = $1', [
        CONSUMPTION_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of another's consumption lines or lots", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const lines = await app.query('SELECT id FROM consumption_lines WHERE id = $1', [CLINE_B]);
      const allocations = await app.query('SELECT id FROM consumption_allocations WHERE id = $1', [
        CALLOC_B,
      ]);
      return lines.rows.length + allocations.rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a consumption into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO clinical_consumptions
             (id, organization_id, branch_id, kind, anchor_kind, encounter_id, patient_id,
              location_id, recorded_by_id, occurred_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'CONSUMPTION', 'ENCOUNTER', $3, $4, $5, $6,
                   now(), now())`,
          [ORG_B, BRANCH_B1, CN_ENC_B, CN_PATIENT_B, CN_LOC_B1, CN_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ THE CASE THAT MATTERS MOST. Both branches belong to ORG_B, so the
   *   organization policy passes and only the RESTRICTIVE branch policy stands
   *   between B2 and what happened in a treatment room at B1. A
   *   permissive-instead-of-restrictive policy here would OR with tenant
   *   isolation and make every procedure's consumption visible across the whole
   *   organization — and it would pass every case above.
   */
  it('shows a sibling branch nothing of what the other theatre used', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM clinical_consumptions WHERE id = $1', [
        CONSUMPTION_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows a sibling branch nothing of the other theatre's lines or lots", async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const lines = await app.query('SELECT id FROM consumption_lines WHERE id = $1', [CLINE_B]);
      const allocations = await app.query('SELECT id FROM consumption_allocations WHERE id = $1', [
        CALLOC_B,
      ]);
      return lines.rows.length + allocations.rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE TEMPLATES HAVE NO BRANCH COLUMN AND ARE THEREFORE VISIBLE ACROSS THE
   *   WHOLE ORGANIZATION. Asserted rather than assumed, because it is the
   *   deliberate cost recorded against the table: a branch-scoped clinician
   *   reads the clinic's whole set of templates, which is why nothing
   *   branch-confidential may ever be added to them. A future change that
   *   branch-scoped this table would fail here and have to argue with the note.
   */
  it('shows a template at every branch of its own organization', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM consumption_templates WHERE id = $1', [
        TEMPLATE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  // -- the `*_visible` policies (KI-3) ---------------------------------------

  /**
   * ⚠️ THE HOLE `db:rls:check` CANNOT SEE, ON THE COLUMN THAT IS NEW IN THIS
   *   PHASE. `tenant_isolation` is satisfied — the template being written IS
   *   ORG_A's — and only the RESTRICTIVE `item_visible` policy stops ORG_A
   *   writing a template against ORG_B's PRIVATE procedure word and reading its
   *   name straight back through the join the template screen makes. A
   *   competitor's procedure list, disclosed one selector at a time.
   */
  it("refuses to write a template against another clinic's private procedure", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO consumption_templates
             (id, organization_id, item_id, name, version, status, effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'Leak', 9, 'DRAFT', DATE '2027-01-01', now())`,
          [ORG_A, CN_ITEM_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** And the platform word stays citable, or the whole catalogue is unusable. */
  it('allows a template against a platform procedure', async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM consumption_templates WHERE id = $1', [
        TEMPLATE_A,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it("refuses to list another clinic's private product on a template line", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO consumption_template_lines
             (id, organization_id, template_id, product_id, quantity, unit_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, now())`,
          [ORG_A, TEMPLATE_A, CN_PROD_B, CN_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to record another clinic's private product as consumed", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO consumption_lines
             (id, organization_id, branch_id, consumption_id, line_number, product_id,
              expected_quantity_base, quantity_entered, unit_id, quantity_base, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 97, $4, 0, 1, $5, 1, now())`,
          [ORG_A, BRANCH_A, CONSUMPTION_B, CN_PROD_B, CN_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the CHECK constraints, which are the other half of the shape ----------

  /**
   * ⚠️ THE TWO DECLARED-BUT-UNBUILT ANCHORS. `LAB_ORDER` and `IMAGING_STUDY` are
   *   members of the database enum so the phases that build those modules need
   *   no enum migration, and neither has a column — so a row claiming one is a
   *   consumption anchored to nothing. `clinical_consumptions_anchor_is_resolvable`
   *   is what makes that unrepresentable rather than merely undocumented.
   */
  it('refuses an anchor kind with nothing behind it', async () => {
    await expect(
      owner.query(
        `INSERT INTO clinical_consumptions
           (id, organization_id, branch_id, kind, anchor_kind, encounter_id, patient_id,
            location_id, recorded_by_id, occurred_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'CONSUMPTION', 'LAB_ORDER', $3, $4, $5, $6,
                 now(), now())`,
        [ORG_B, BRANCH_B1, CN_ENC_B, CN_PATIENT_B, CN_LOC_B1, CN_USER_B]
      )
    ).rejects.toThrow(/anchor_is_resolvable/i);
  });

  /** A correction that cites nothing is a second consumption in disguise. */
  it('refuses a correction that cites no original', async () => {
    await expect(
      owner.query(
        `INSERT INTO clinical_consumptions
           (id, organization_id, branch_id, kind, anchor_kind, encounter_id, patient_id,
            location_id, recorded_by_id, occurred_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'CONSUMPTION_REVERSAL', 'ENCOUNTER', $3, $4, $5, $6,
                 now(), now())`,
        [ORG_B, BRANCH_B1, CN_ENC_B, CN_PATIENT_B, CN_LOC_B1, CN_USER_B]
      )
    ).rejects.toThrow(/correction_cites_original/i);
  });

  /** A variance with no reason is indistinguishable from a typo. */
  it('refuses a departure from the template with no reason', async () => {
    await expect(
      owner.query(
        `INSERT INTO consumption_lines
           (id, organization_id, branch_id, consumption_id, line_number, product_id,
            expected_quantity_base, quantity_entered, unit_id, quantity_base, is_override,
            updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 96, $4, 2, 5, $5, 5, true, now())`,
        [ORG_B, BRANCH_B1, CONSUMPTION_B, CN_PROD_B, CN_UNIT]
      )
    ).rejects.toThrow(/override_is_explained/i);
  });

  /**
   * ⚠️ "USED NONE OF IT" IS A LINE NOBODY SHOULD HAVE WRITTEN, not a zero-quantity
   *   ledger leg — and the EXPECTED figure is allowed to be zero in the same
   *   constraint, because a product the template never listed expects nothing.
   */
  it('refuses a consumed quantity of zero and allows an expectation of zero', async () => {
    await expect(
      owner.query(
        `INSERT INTO consumption_lines
           (id, organization_id, branch_id, consumption_id, line_number, product_id,
            expected_quantity_base, quantity_entered, unit_id, quantity_base, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 95, $4, 0, 1, $5, 0, now())`,
        [ORG_B, BRANCH_B1, CONSUMPTION_B, CN_PROD_B, CN_UNIT]
      )
    ).rejects.toThrow(/quantities_valid/i);

    const zeroExpected = 'dddddddd-eeee-4eee-8eee-0000000000b1';
    await owner.query(
      `INSERT INTO consumption_lines
         (id, organization_id, branch_id, consumption_id, line_number, product_id,
          expected_quantity_base, quantity_entered, unit_id, quantity_base, is_override,
          override_reason, updated_at)
       VALUES ($1, $2, $3, $4, 94, $5, 0, 1, $6, 1, true, 'Not on the tray', now())`,
      [zeroExpected, ORG_B, BRANCH_B1, CONSUMPTION_B, CN_PROD_B, CN_UNIT]
    );
    await owner.query('DELETE FROM consumption_lines WHERE id = $1', [zeroExpected]);
  });

  /**
   * ⚠️ THE CHECK PI-8 SAID WOULD BE REWRITTEN HERE. Its third branch used to
   *   permit an `INVENTORY` charge request citing nothing at all, which was
   *   audible rather than legal only because no caller existed. PI-9 is the
   *   caller, and the constraint now requires the consumption line.
   */
  it('refuses an inventory charge request that cites no consumption line', async () => {
    await expect(
      owner.query(
        `INSERT INTO charge_requests
           (id, organization_id, branch_id, source_type, kind, status, product_id,
            occurred_at, quantity_base, quantity, unit_id, policy, policy_scope,
            description, currency, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'INVENTORY', 'SUPPLY', 'PENDING', $3, now(),
                 1, 1, $4, 'SEPARATELY_BILLABLE', 'DEFAULT', 'Anchored to nothing', 'INR', now())`,
        [ORG_B, BRANCH_B1, CN_PROD_B, CN_UNIT]
      )
    ).rejects.toThrow(/reference_matches_kind/i);
  });

  /** And one charge request per consumption line — the idempotency guarantee. */
  it('refuses a second charge request against one consumption line', async () => {
    const first = 'dddddddd-ffff-4fff-8fff-0000000000b1';
    await owner.query(
      `INSERT INTO charge_requests
         (id, organization_id, branch_id, source_type, kind, status, consumption_line_id,
          product_id, occurred_at, quantity_base, quantity, unit_id, policy, policy_scope,
          description, currency, updated_at)
       VALUES ($1, $2, $3, 'INVENTORY', 'SUPPLY', 'PENDING', $4, $5, now(), 3, 3, $6,
               'NEVER_BILL', 'DEFAULT', 'Consumption Iso B', 'INR', now())`,
      [first, ORG_B, BRANCH_B1, CLINE_B, CN_PROD_B, CN_UNIT]
    );

    await expect(
      owner.query(
        `INSERT INTO charge_requests
           (id, organization_id, branch_id, source_type, kind, status, consumption_line_id,
            product_id, occurred_at, quantity_base, quantity, unit_id, policy, policy_scope,
            description, currency, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'INVENTORY', 'SUPPLY', 'PENDING', $3, $4, now(),
                 3, 3, $5, 'NEVER_BILL', 'DEFAULT', 'Billed twice', 'INR', now())`,
        [ORG_B, BRANCH_B1, CLINE_B, CN_PROD_B, CN_UNIT]
      )
    ).rejects.toThrow(/one_per_consumption_line/i);

    await owner.query('DELETE FROM charge_requests WHERE id = $1', [first]);
  });
});
