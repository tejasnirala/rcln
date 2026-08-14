/**
 * Tenant isolation — consultation templates (CE-2).
 *
 * Two platform-extensible tables, and every failure mode they have is one the
 * clinical vocabulary already documented — with one addition that is specific to
 * this pair:
 *
 * ⚠️ `consultation_templates` CITES `specialties` TWICE AND NEITHER POINTER CAN
 *   BE COMPOSITE-FK'D, because a specialty may be a platform row with no
 *   organization_id to compose with. So `tenant_isolation` constrains the
 *   TEMPLATE row and says nothing at all about the two nodes it names — without
 *   the RESTRICTIVE `specialty_visible` policy, clinic A anchors its own
 *   template to clinic B's private specialty and reads B's specialty name back
 *   out of the join.
 *
 * ⚠️ AND `specialty_id` IS NULLABLE ON PURPOSE. NULL is the care-context
 *   default — the template a doctor with no classification resolves to, and the
 *   reason resolution never returns nothing. A policy that required a node would
 *   make that row unwritable, and the symptom would be "no template applies" for
 *   every unclassified doctor.
 *
 * One file of the tenant-isolation suite; see ./README.md.
 */
import { ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

describe('consultation templates', () => {
  const CONTEXT_PLATFORM = 'dddddddd-1111-4111-8111-000000000001';
  const SPECIALTY_PRIVATE_B = 'dddddddd-2222-4222-8222-0000000000b1';
  const SPECIALTY_PLATFORM = 'dddddddd-2222-4222-8222-000000000001';
  const TEMPLATE_PLATFORM = 'dddddddd-3333-4333-8333-000000000001';
  const TEMPLATE_A = 'dddddddd-3333-4333-8333-0000000000a1';
  const TEMPLATE_B = 'dddddddd-3333-4333-8333-0000000000b1';
  const VERSION_PLATFORM = 'dddddddd-4444-4444-8444-000000000001';
  const VERSION_B = 'dddddddd-4444-4444-8444-0000000000b1';

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

  beforeAll(async () => {
    await owner.query(
      /*
       * ⚠️ THE TWO SPECIALTIES HANG OFF THE CARE CONTEXT, AND THAT IS NOT
       *   TIDINESS. A platform specialty does NOT cascade away when the harness
       *   deletes its organizations, so a parentless one persists — and
       *   `clinical-taxonomy`'s "serves the care contexts as roots" asserts that
       *   every root is a CARE_CONTEXT. Leaving it at the top level turns this
       *   fixture into a failure in an unrelated suite that only appears on the
       *   NEXT run.
       */
      `INSERT INTO specialties (id, organization_id, parent_id, code, name, type, updated_at)
       VALUES ($1, NULL, NULL, 'ISO_CARE_CONTEXT', 'Isolation context', 'CARE_CONTEXT', now()),
              ($4, NULL, $1,   'ISO_TPL_PUB_SPEC', 'Isolation specialty', 'SPECIALTY', now()),
              ($2, $3,   $1,   'ISO_TPL_SPEC',     'B private specialty', 'SPECIALTY', now())
       ON CONFLICT DO NOTHING`,
      [CONTEXT_PLATFORM, SPECIALTY_PRIVATE_B, ORG_B, SPECIALTY_PLATFORM]
    );

    await owner.query(
      `INSERT INTO consultation_templates
         (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
       VALUES ($1, NULL, 'ISO_TPL_PLATFORM', 'Platform template', $2, NULL, now()),
              ($3, $4,   'ISO_TPL_A',        'A template',        $2, $8,   now()),
              ($5, $6,   'ISO_TPL_B',        'B template',        $2, $7,   now())
       ON CONFLICT DO NOTHING`,
      [
        TEMPLATE_PLATFORM,
        CONTEXT_PLATFORM,
        TEMPLATE_A,
        ORG_A,
        TEMPLATE_B,
        ORG_B,
        SPECIALTY_PRIVATE_B,
        SPECIALTY_PLATFORM,
      ]
    );

    await owner.query(
      `INSERT INTO consultation_template_versions
         (id, organization_id, template_id, version, definition, status, published_at, updated_at)
       VALUES ($1, NULL, $2, 1, $5::jsonb, 'PUBLISHED', now(), now()),
              ($3, $4,   $6, 1, $5::jsonb, 'PUBLISHED', now(), now())
       ON CONFLICT DO NOTHING`,
      [VERSION_PLATFORM, TEMPLATE_PLATFORM, VERSION_B, ORG_B, DEFINITION, TEMPLATE_B]
    );
  });

  // -- reading --------------------------------------------------------------

  it('lets every clinic read the platform template', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM consultation_templates WHERE id = $1', [
        TEMPLATE_PLATFORM,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('shows one clinic nothing of another’s template', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM consultation_templates WHERE id = $1', [
        TEMPLATE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE VERSION IS THE DOCUMENT, AND IT IS THE ROW THAT ACTUALLY CARRIES THE
   *   CONFIGURATION. A policy on the template alone would hide the name and leak
   *   the definition — which is the whole configuration of another clinic's
   *   consultation, section by section.
   */
  it('shows one clinic nothing of another’s configuration document', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT id FROM consultation_template_versions WHERE id = $1',
        [VERSION_B]
      );
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  // -- writing --------------------------------------------------------------

  /**
   * ⚠️ THE ONE THAT MATTERS MOST ON THIS TABLE.
   *
   *   If the WITH CHECK were copied from `files` — which permits a NULL
   *   organization_id — this insert would SUCCEED, and the row would be a
   *   consultation template visible to every clinic on the platform, authored by
   *   one of them. Nothing else would flag it: it is a valid insert into a table
   *   the caller may write.
   */
  it('refuses to let a clinic publish a platform-wide template', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO consultation_templates
             (id, organization_id, code, name, care_context_id, updated_at)
           VALUES (gen_random_uuid(), NULL, 'SNEAK_TPL', 'Sneak', $1, now())`,
          [CONTEXT_PLATFORM]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ A DELETE IS WHERE THE POLICY ALONE WOULD LOSE. Postgres applies no WITH
   *   CHECK to a DELETE, so `USING (organization_id IS NULL OR …)` is the whole
   *   test and it PERMITS the platform row. Without `platform_rows_immutable`,
   *   one clinic deletes the general consultation for every clinic — and the
   *   symptom is every unclassified doctor on the platform unable to open a
   *   consultation.
   */
  it('refuses to let a clinic delete the platform template for everybody', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('DELETE FROM consultation_templates WHERE id = $1', [TEMPLATE_PLATFORM])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ CAPTURE. USING sees the OLD row (NULL org — permitted) and WITH CHECK
   *   sees the NEW row (the caller's own org — permitted). Neither clause
   *   compares the two, so without the trigger a clinic takes the platform
   *   template for itself and removes it from everyone else.
   */
  it('refuses to let a clinic capture the platform template as its own', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE consultation_templates SET organization_id = $1 WHERE id = $2', [
          ORG_A,
          TEMPLATE_PLATFORM,
        ])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  it('refuses to rewrite the platform’s published document', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('DELETE FROM consultation_template_versions WHERE id = $1', [VERSION_PLATFORM])
      )
    ).rejects.toThrow(/not writable by a tenant/i);
  });

  /**
   * ⚠️ THE PLAIN-FK HOLE, AND THE ONE THIS FILE EXISTS FOR. `specialty_id` and
   *   `care_context_id` point at a platform-extensible table, so no composite FK
   *   is drawable and `tenant_isolation` says nothing about them. Without
   *   `specialty_visible`, clinic A anchors a template to clinic B's private
   *   specialty and reads B's specialty name back out of the join.
   */
  it('refuses to anchor a template to another clinic’s private specialty', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO consultation_templates
             (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'ISO_TPL_SNEAK', 'Sneak', $2, $3, now())`,
          [ORG_A, CONTEXT_PLATFORM, SPECIALTY_PRIVATE_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ AND A NULL `specialty_id` MUST STILL PASS. This is the care-context
   *   default. A `specialty_visible` policy written without the `IS NULL` branch
   *   would make it unwritable — and the failure is not a leak but a product
   *   that cannot open a consultation for an unclassified doctor.
   */
  it('allows the care-context default, whose specialty is deliberately NULL', async () => {
    const written = await asTenant(ORG_A, async () => {
      const { rowCount } = await app.query(
        `INSERT INTO consultation_templates
           (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'ISO_TPL_A_DEFAULT', 'A default', $2, NULL, now())`,
        [ORG_A, CONTEXT_PLATFORM]
      );
      return rowCount;
    });
    expect(written).toBe(1);
  });

  it('refuses to hang a version on another clinic’s template', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO consultation_template_versions
             (id, organization_id, template_id, version, definition, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 9, $3::jsonb, now())`,
          [ORG_A, TEMPLATE_B, DEFINITION]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  /**
   * ⚠️ AND ON THE PLATFORM'S, WHICH IS THE COMPOSITE-FK CASE. The FK is
   *   (organization_id, template_id) -> (organization_id, id), so a tenant row
   *   naming a platform template has to supply an organization_id the platform
   *   row does not have. Under MATCH SIMPLE the constraint would be skipped
   *   entirely if organization_id were NULL — which the policy above refuses.
   */
  it('refuses to hang a version on the platform’s template', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO consultation_template_versions
             (id, organization_id, template_id, version, definition, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 9, $3::jsonb, now())`,
          [ORG_A, TEMPLATE_PLATFORM, DEFINITION]
        )
      )
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  /**
   * ⚠️ RESOLUTION MUST BE A DECISION, NOT A TIE-BREAK. Two active templates on
   *   the same node both apply equally; the resolver picks one, the other is
   *   configured, visible in the admin screen and inert, and the consultation
   *   that renders is perfectly reasonable and not the one the clinic meant.
   *   There is no error and nothing on screen to notice.
   */
  it('refuses a second active template on the same node for one clinic', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO consultation_templates
             (id, organization_id, code, name, care_context_id, specialty_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'ISO_TPL_A_CLASH', 'A clash', $2, NULL, now())`,
          [ORG_A, CONTEXT_PLATFORM]
        )
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  /**
   * ⚠️ BUT A CLINIC'S OWN TEMPLATE MAY SIT WHERE THE PLATFORM'S DOES. That
   *   overlap is the whole point of a platform-extensible catalogue — the
   *   clinic's own wins in `resolveTemplate` — and an index that forbade it
   *   would make the general consultation unoverridable.
   */
  it('allows a clinic’s template beside the platform’s at the same node', async () => {
    const seen = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS count FROM consultation_templates
          WHERE care_context_id = $1 AND specialty_id IS NULL AND is_active`,
        [CONTEXT_PLATFORM]
      );
      return rows[0].count as number;
    });
    /* The platform's, plus the default A wrote above. A's other template is
       anchored to a specialty and does not compete for this slot. */
    expect(seen).toBe(2);
  });
});
