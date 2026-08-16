/**
 * Tenant isolation — the visual mapping engine (CE-6).
 *
 * Three tables in two tenancy classes, and every failure mode they have is one
 * a sibling file has already documented — with two that are specific to this
 * trio:
 *
 * ⚠️ `visual_maps` AND `visual_regions` ARE PLATFORM-EXTENSIBLE, so the whole
 *   `consultation_templates` gauntlet applies unchanged: a clinic must READ the
 *   platform odontogram, must not PUBLISH one, must not DELETE one for everybody,
 *   and must not CAPTURE one as its own. The last two are what
 *   `platform_rows_immutable` exists for — the policy alone loses both, because
 *   Postgres applies no WITH CHECK to a DELETE and never compares the old row
 *   with the new one on an UPDATE.
 *
 * ⚠️ `clinical_findings` IS ORG + BRANCH SCOPED AND CITES TWO PLATFORM-EXTENSIBLE
 *   PARENTS BY PLAIN FK. `visual_region_id` and `finding_item_id` cannot be
 *   composite-FK'd — both parents allow a NULL organization_id and this row's is
 *   NOT NULL — so `tenant_isolation` constrains the FINDING and says nothing
 *   about what it points at. Without `region_visible` and `item_visible`, clinic
 *   A files a finding against clinic B's private region or private word and
 *   reads the label straight back out of the join.
 *
 * ⚠️ AND THE CE-5 HAZARD IS CHECKED RATHER THAN ASSUMED. `NEXT_SESSION.md`
 *   predicted that `clinical_findings` hangs off an ENCOUNTER, which is
 *   branch-scoped, so the "ORG-scoped parent over a BRANCH-scoped child" shape
 *   the visit history had to solve does not recur. The B1/B2 case below is what
 *   makes that a fact instead of a prediction.
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
  asTenant,
  owner,
  useIsolationHarness,
} from './harness.js';

useIsolationHarness();

describe('visual mapping', () => {
  const VM_CONTEXT = 'eeeeeeee-1111-4111-8111-000000000001';
  const VM_SPECIALTY_B = 'eeeeeeee-1111-4111-8111-0000000000b1';

  const MAP_PLATFORM = 'eeeeeeee-2222-4222-8222-000000000001';
  const MAP_B = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const REGION_PLATFORM = 'eeeeeeee-3333-4333-8333-000000000001';
  const REGION_B = 'eeeeeeee-3333-4333-8333-0000000000b1';

  const ITEM_PLATFORM = 'eeeeeeee-4444-4444-8444-000000000001';
  const ITEM_B = 'eeeeeeee-4444-4444-8444-0000000000b1';

  const VM_TPL = 'eeeeeeee-5555-4555-8555-000000000001';
  const VM_VER = 'eeeeeeee-5555-4555-8555-000000000002';
  const VM_PATIENT_A = 'eeeeeeee-6666-4666-8666-0000000000a1';
  const VM_PATIENT_B = 'eeeeeeee-6666-4666-8666-0000000000b1';
  const VM_USER_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const VM_USER_B = 'eeeeeeee-7777-4777-8777-0000000000b1';
  const VM_DOC_A = 'eeeeeeee-8888-4888-8888-0000000000a1';
  const VM_DOC_B = 'eeeeeeee-8888-4888-8888-0000000000b1';
  const VM_EPISODE_A = 'eeeeeeee-9999-4999-8999-0000000000a1';
  const VM_EPISODE_B = 'eeeeeeee-9999-4999-8999-0000000000b1';
  const VM_ENC_A = 'eeeeeeee-aaaa-4aaa-8aaa-0000000000a1';
  /** Written at B2, so a reader scoped to B1 must not see its findings. */
  const VM_ENC_B2 = 'eeeeeeee-aaaa-4aaa-8aaa-0000000000b2';
  const FINDING_B2 = 'eeeeeeee-bbbb-4bbb-8bbb-0000000000b2';

  const TOOTH = JSON.stringify({
    shape: { kind: 'RECT', x: 0, y: 0, width: 30, height: 40 },
  });

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
    /* A CARE_CONTEXT root, for the reason the sibling files record: a parentless
       platform SPECIALTY left behind fails the taxonomy suite on the NEXT run. */
    await owner.query(
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_VM_CONTEXT', 'Isolation charts', 'CARE_CONTEXT', now()),
              ($2, $3,   $1,   'ISO_VM_SPEC',    'B private specialty', 'SPECIALTY', now())
       ON CONFLICT DO NOTHING`,
      [VM_CONTEXT, VM_SPECIALTY_B, ORG_B]
    );

    /*
     * ⚠️ ONE PLATFORM CHART AND ONE PRIVATE ONE. The pair is the whole point:
     *   the platform row must stay readable by everybody, and B's must be
     *   invisible to A. A test with only the second would pass against a policy
     *   that refused the platform's charts outright — and the symptom of THAT is
     *   every dentist on the platform with nothing to draw on.
     */
    await owner.query(
      `INSERT INTO visual_maps
         (id, organization_id, code, name, care_context_id, specialty_id, view_box, updated_at)
       VALUES ($1, NULL, 'ISO_VM_PLATFORM', 'Platform chart', $2, NULL, '0 0 100 100', now()),
              ($3, $4,   'ISO_VM_B',        'B private chart', $2, NULL, '0 0 100 100', now())
       ON CONFLICT DO NOTHING`,
      [MAP_PLATFORM, VM_CONTEXT, MAP_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO visual_regions
         (id, organization_id, map_id, code, label, metadata, updated_at)
       VALUES ($1, NULL, $2, 'ISO_VM_R1', 'Platform region', $5::jsonb, now()),
              ($3, $4,   $6, 'ISO_VM_RB', 'B private region', $5::jsonb, now())
       ON CONFLICT DO NOTHING`,
      [REGION_PLATFORM, MAP_PLATFORM, REGION_B, ORG_B, TOOTH, MAP_B]
    );

    await owner.query(
      `INSERT INTO clinical_master_items (id, organization_id, kind, code, name, updated_at)
       VALUES ($1, NULL, 'FINDING_TYPE', 'ISO_VM_PLATFORM_F', 'Platform finding', now()),
              ($2, $3,   'FINDING_TYPE', 'ISO_VM_B_F',        'B private finding', now())
       ON CONFLICT DO NOTHING`,
      [ITEM_PLATFORM, ITEM_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_VM_PLATFORM_TPL', 'Platform consultation', $2, NULL, now())
       ON CONFLICT DO NOTHING`,
      [VM_TPL, VM_CONTEXT]
    );
    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $2, 1, $3::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [VM_VER, VM_TPL, DEFINITION]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'VMA00001', 'Vm A', now()), ($3, $4, 'VMB00001', 'Vm B', now())
       ON CONFLICT DO NOTHING`,
      [VM_PATIENT_A, ORG_A, VM_PATIENT_B, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Vm Doc A', 'vm-doc-a@example.test', now()),
              ($2, 'Vm Doc B', 'vm-doc-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [VM_USER_A, VM_USER_B]
    );
    await owner.query(
      `INSERT INTO doctor_profiles (id, organization_id, user_id, updated_at)
       VALUES ($1, $2, $3, now()), ($4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [VM_DOC_A, ORG_A, VM_USER_A, VM_DOC_B, ORG_B, VM_USER_B]
    );
    await owner.query(
      `INSERT INTO clinical_episodes
         (id, organization_id, patient_id, code, opened_on, updated_at)
       VALUES ($1, $2, $3, 'ISOVMEPA1', DATE '2027-06-01', now()),
              ($4, $5, $6, 'ISOVMEPB1', DATE '2027-06-01', now())
       ON CONFLICT DO NOTHING`,
      [VM_EPISODE_A, ORG_A, VM_PATIENT_A, VM_EPISODE_B, ORG_B, VM_PATIENT_B]
    );

    /* Walk-ins (CD-1), which keeps this fixture off the scheduling chain. */
    await owner.query(
      `INSERT INTO encounters
         (id, organization_id, branch_id, patient_id, clinical_episode_id,
          doctor_profile_id, template_id, template_version_id, template_snapshot, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $10, $11, $12::jsonb, now()),
              ($7, $8, $9, $13, $14, $15, $10, $11, $12::jsonb, now())
       ON CONFLICT DO NOTHING`,
      [
        VM_ENC_A,
        ORG_A,
        BRANCH_A,
        VM_PATIENT_A,
        VM_EPISODE_A,
        VM_DOC_A,
        VM_ENC_B2,
        ORG_B,
        BRANCH_B2,
        VM_TPL,
        VM_VER,
        DEFINITION,
        VM_PATIENT_B,
        VM_EPISODE_B,
        VM_DOC_B,
      ]
    );

    await owner.query(
      `INSERT INTO clinical_findings
         (id, organization_id, branch_id, encounter_id, section_key,
          visual_region_id, finding_item_id, notes, updated_at)
       VALUES ($1, $2, $3, $4, 'odontogram', $5, $6, 'B private note', now())
       ON CONFLICT DO NOTHING`,
      [FINDING_B2, ORG_B, BRANCH_B2, VM_ENC_B2, REGION_B, ITEM_B]
    );
  });

  afterAll(async () => {
    /*
     * ⚠️ THE FINDINGS AND THE ENCOUNTERS GO FIRST, AND THIS HOOK RUNS BEFORE THE
     *   HARNESS'S. Jest runs an inner `afterAll` before the outer one, so the
     *   organizations are still here — and a finding cites its region and its
     *   word with `ON DELETE RESTRICT`, exactly so that a region a consultation
     *   drew on cannot be deleted out from under it. Deleting the regions first
     *   would fail on the very constraint this phase added.
     */
    await owner.query('DELETE FROM clinical_findings WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounter_procedures WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM encounters WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM visual_regions WHERE id = ANY($1)', [
      [REGION_PLATFORM, REGION_B],
    ]);
    await owner.query('DELETE FROM visual_maps WHERE id = ANY($1)', [[MAP_PLATFORM, MAP_B]]);
    await owner.query('DELETE FROM clinical_master_items WHERE id = ANY($1)', [
      [ITEM_PLATFORM, ITEM_B],
    ]);
    await owner.query('DELETE FROM consultation_template_versions WHERE id = $1', [VM_VER]);
    await owner.query('DELETE FROM consultation_templates WHERE id = $1', [VM_TPL]);
    await owner.query('DELETE FROM clinical_episodes WHERE id = ANY($1)', [
      [VM_EPISODE_A, VM_EPISODE_B],
    ]);
    await owner.query('DELETE FROM doctor_profiles WHERE id = ANY($1)', [[VM_DOC_A, VM_DOC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[VM_PATIENT_A, VM_PATIENT_B]]);
    await owner.query('DELETE FROM specialties WHERE id = ANY($1)', [[VM_SPECIALTY_B, VM_CONTEXT]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[VM_USER_A, VM_USER_B]]);
  });

  // -- the charts: platform-extensible --------------------------------------

  it('lets every clinic read the platform chart and its regions', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const maps = await app.query('SELECT id FROM visual_maps WHERE id = $1', [MAP_PLATFORM]);
      const regions = await app.query('SELECT id FROM visual_regions WHERE id = $1', [
        REGION_PLATFORM,
      ]);
      return [maps.rows.length, regions.rows.length];
    });
    expect(seen).toEqual([1, 1]);
  });

  it('shows one clinic nothing of another’s chart or its regions', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const maps = await app.query('SELECT id FROM visual_maps WHERE id = $1', [MAP_B]);
      const regions = await app.query('SELECT id FROM visual_regions WHERE id = $1', [REGION_B]);
      return [maps.rows.length, regions.rows.length];
    });
    expect(seen).toEqual([0, 0]);
  });

  /**
   * ⚠️ THE ONE THAT MATTERS MOST ON THESE TABLES. If the WITH CHECK were copied
   *   from `files` — which permits a NULL organization_id — this insert would
   *   SUCCEED, and the row would be a chart visible to every clinic on the
   *   platform, authored by one of them. Nothing else would flag it: it is a
   *   valid insert into a table the caller may write.
   */
  it('refuses to let a clinic publish a platform-wide chart', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO visual_maps
             (id, organization_id, code, name, care_context_id, view_box, updated_at)
           VALUES (gen_random_uuid(), NULL, 'SNEAK_MAP', 'Sneak', $1, '0 0 10 10', now())`,
          [VM_CONTEXT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ A DELETE IS WHERE THE POLICY ALONE LOSES. Postgres applies no WITH CHECK
   *   to a DELETE, so `USING (organization_id IS NULL OR …)` is the whole test
   *   and it PERMITS the platform row. Without `platform_rows_immutable` one
   *   clinic deletes the odontogram for every clinic on the platform.
   */
  it('refuses to let a clinic delete the platform chart for everybody', async () => {
    await expect(
      asTenant(ORG_A, () => app.query('DELETE FROM visual_maps WHERE id = $1', [MAP_PLATFORM]))
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ CAPTURE. USING sees the OLD row (NULL org — permitted) and WITH CHECK
   *   sees the NEW row (the caller's own org — permitted). Neither clause
   *   compares the two.
   */
  it('refuses to let a clinic capture the platform chart as its own', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE visual_maps SET organization_id = $1 WHERE id = $2', [
          ORG_A,
          MAP_PLATFORM,
        ])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  it('refuses to let a clinic redraw a region of the platform chart', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('DELETE FROM visual_regions WHERE id = $1', [REGION_PLATFORM])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ THE PLAIN-FK HOLE ON THE MAP. `care_context_id` and `specialty_id` point
   *   at a platform-extensible table, so no composite FK is drawable and
   *   `tenant_isolation` says nothing about them. Without `specialty_visible`,
   *   clinic A anchors a chart to clinic B's private specialty and reads B's
   *   specialty name back out of the join.
   */
  it('refuses to anchor a chart to another clinic’s private specialty', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO visual_maps
             (id, organization_id, code, name, care_context_id, specialty_id, view_box, updated_at)
           VALUES (gen_random_uuid(), $1, 'ISO_VM_SNEAK', 'Sneak', $2, $3, '0 0 10 10', now())`,
          [ORG_A, VM_CONTEXT, VM_SPECIALTY_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE COMPOSITE FK IS WHAT PROTECTS THE REGIONS, and it is drawable here
   *   precisely because BOTH sides allow a NULL organization_id. A tenant region
   *   naming another tenant's map has no `(organization_id, id)` pair to satisfy.
   */
  it('refuses to add a region to another clinic’s chart', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO visual_regions
             (id, organization_id, map_id, code, label, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'SNEAK_REGION', 'Sneak', now())`,
          [ORG_A, MAP_B]
        )
      )
    ).rejects.toThrow(/foreign key/i);
  });

  // -- the findings: org + branch scoped, PHI --------------------------------

  it('shows one clinic nothing of another’s findings', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM clinical_findings WHERE id = $1', [
        FINDING_B2,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE BRANCH BOUNDARY, AND THE CHECK `NEXT_SESSION.md` ASKED FOR. CE-5's
   *   visit history nests a BRANCH-scoped child under an ORG-scoped parent and
   *   had to say so; a finding's parent is the ENCOUNTER, which belongs to the
   *   place it happened at. So the shape does not recur — and this is what makes
   *   that a fact rather than a prediction.
   */
  it('hides a finding recorded at another branch of the same clinic', async () => {
    const atB2 = await asTenantAtBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM clinical_findings WHERE id = $1', [
        FINDING_B2,
      ]);
      return rows.length;
    });
    expect(atB2).toBe(1);

    const atB1 = await asTenantAtBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM clinical_findings WHERE id = $1', [
        FINDING_B2,
      ]);
      return rows.length;
    });
    expect(atB1).toBe(0);
  });

  it('lets a clinic record a finding on the platform chart with a platform word', async () => {
    const inserted = await asTenantAtBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query(
        `INSERT INTO clinical_findings
           (id, organization_id, branch_id, encounter_id, section_key,
            visual_region_id, finding_item_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'odontogram', $4, $5, now())
         RETURNING id`,
        [ORG_A, BRANCH_A, VM_ENC_A, REGION_PLATFORM, ITEM_PLATFORM]
      );
      return rows.length;
    });
    expect(inserted).toBe(1);
  });

  /**
   * ⚠️ THE PLAIN-FK HOLE ON THE FINDING, AND THE REASON `region_visible` EXISTS.
   *   Without it clinic A files a finding against clinic B's private region and
   *   reads B's label back out of the join — a competitor's chart, disclosed one
   *   region at a time.
   */
  it('refuses to record a finding on another clinic’s private region', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO clinical_findings
             (id, organization_id, branch_id, encounter_id, section_key,
              visual_region_id, finding_item_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'odontogram', $4, $5, now())`,
          [ORG_A, BRANCH_A, VM_ENC_A, REGION_B, ITEM_PLATFORM]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** The same hole one column over — `item_visible`, on `finding_item_id`. */
  it('refuses to record a finding citing another clinic’s private word', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO clinical_findings
             (id, organization_id, branch_id, encounter_id, section_key,
              visual_region_id, finding_item_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'odontogram', $4, $5, now())`,
          [ORG_A, BRANCH_A, VM_ENC_A, REGION_PLATFORM, ITEM_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE SAME HOLE ON THE CE-4 TABLE THAT GREW A POINTER AT A REGION. A
   *   procedure "done on tooth 36" is the same disclosure through a different
   *   column, and `region_visible` on `encounter_procedures` is what closes it.
   */
  it('refuses to record a procedure on another clinic’s private region', async () => {
    await expect(
      asTenantAtBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO encounter_procedures
             (id, organization_id, branch_id, encounter_id, item_id,
              visual_region_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
          [ORG_A, BRANCH_A, VM_ENC_A, ITEM_PLATFORM, REGION_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });
});
