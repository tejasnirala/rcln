/**
 * Tenant isolation — regulatory (PI-5).
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 *
 * ── THIS DOMAIN HAS TWO TENANCY CLASSES AND THE INTERESTING ONE IS THE
 *    DELIBERATELY UNSCOPED HALF ────────────────────────────────────────────────
 *
 *   PLATFORM, no organization_id, NO RLS POLICY AT ALL
 *     jurisdictions · regulatory_authorities · regulatory_sources ·
 *     regulatory_rule_packs · regulatory_rules
 *
 *   TENANT, platform-extensible
 *     product_regulatory_profiles
 *
 * ⚠️ THE FIRST FIVE ARE READABLE BY EVERY TENANT ON PURPOSE, AND THE TESTS BELOW
 *   PIN THAT WIDTH RATHER THAN TREATING IT AS A LEAK. The law of a country is
 *   the same for every clinic in it; scoping these would return zero rows for
 *   everybody, no rule would ever match, and every decision would come back
 *   `UNDETERMINED` — which refuses. Nobody could dispense anything anywhere.
 *   Exactly the argument `tax_rule_defaults` already carries.
 *
 * ⚠️ WHAT IS **NOT** ALLOWED IS A TENANT WRITING THEM, and that is what most of
 *   this file measures. With no policy to lean on, the guard is the
 *   `platform_law_not_tenant_writable` trigger: it refuses any INSERT, UPDATE or
 *   DELETE from a transaction that claims a tenant, which is the same
 *   discriminator `refuse_platform_row_mutation` uses. Without it, one clinic
 *   could rewrite what every other clinic on the platform is evaluated against.
 */
import { ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

describe('the regulatory framework', () => {
  const JUR_COUNTRY = 'ffffffff-1111-4111-8111-000000000001';
  const JUR_REGION = 'ffffffff-1111-4111-8111-000000000002';
  const AUTHORITY = 'ffffffff-2222-4222-8222-000000000001';
  const SOURCE = 'ffffffff-3333-4333-8333-000000000001';
  const PACK = 'ffffffff-4444-4444-8444-000000000001';
  const RULE = 'ffffffff-5555-4555-8555-000000000001';

  const UNIT = 'ffffffff-6666-4666-8666-000000000001';
  const CAT_PRIVATE_B = 'ffffffff-7777-4777-8777-0000000000b1';
  const PRODUCT_A = 'ffffffff-8888-4888-8888-0000000000a1';
  const PRODUCT_B = 'ffffffff-8888-4888-8888-0000000000b1';
  const PROFILE_A = 'ffffffff-9999-4999-8999-0000000000a1';
  const PROFILE_B = 'ffffffff-9999-4999-8999-0000000000b1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
       VALUES ($1, 'ZZ', NULL, 'Isolation Country', now()),
              ($2, 'ZZ', 'IS', 'Isolation Region', now())
       ON CONFLICT DO NOTHING`,
      [JUR_COUNTRY, JUR_REGION]
    );

    await owner.query(
      `INSERT INTO regulatory_authorities (id, jurisdiction_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_REG', 'Isolation Regulator', now())
       ON CONFLICT DO NOTHING`,
      [AUTHORITY, JUR_COUNTRY]
    );

    await owner.query(
      `INSERT INTO regulatory_sources (id, jurisdiction_id, authority_id, title, updated_at)
       VALUES ($1, $2, $3, 'Isolation Act', now())
       ON CONFLICT DO NOTHING`,
      [SOURCE, JUR_COUNTRY, AUTHORITY]
    );

    await owner.query(
      `INSERT INTO regulatory_rule_packs
         (id, jurisdiction_id, authority_id, version, name, effective_from, updated_at)
       VALUES ($1, $2, $3, '1.0.0', 'Isolation Pack', DATE '2020-01-01', now())
       ON CONFLICT DO NOTHING`,
      [PACK, JUR_COUNTRY, AUTHORITY]
    );

    await owner.query(
      `INSERT INTO regulatory_rules
         (id, pack_id, rule_type, code, statement, status, parameters, source_id,
          effective_from, updated_at)
       VALUES ($1, $2, 'PRESCRIPTION_REQUIRED', 'ISO_POM',
               'Supply requires a prescription.', 'ACTIVE', '{"required":true}'::jsonb, $3,
               DATE '2020-01-01', now())
       ON CONFLICT DO NOTHING`,
      [RULE, PACK, SOURCE]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'ISO_REG_UNIT', 'Iso Reg Unit', 'iru', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [UNIT]
    );

    await owner.query(
      `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_REG_CAT_B', 'Iso Reg Category B', now())
       ON CONFLICT DO NOTHING`,
      [CAT_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
       VALUES ($1, $3, 'MEDICINE', 'ACTIVE', 'ISO_REG_PROD_A', 'Iso Reg Product A', $5, now()),
              ($2, $4, 'MEDICINE', 'ACTIVE', 'ISO_REG_PROD_B', 'Iso Reg Product B', $5, now())
       ON CONFLICT DO NOTHING`,
      [PRODUCT_A, PRODUCT_B, ORG_A, ORG_B, UNIT]
    );

    await owner.query(
      `INSERT INTO product_regulatory_profiles
         (id, organization_id, product_id, jurisdiction_id, classification,
          prescription_requirement, effective_from, updated_at)
       VALUES ($1, $3, $5, $7, 'ISO_SCHEDULE_A', 'PRESCRIPTION_REQUIRED', DATE '2020-01-01', now()),
              ($2, $4, $6, $7, 'ISO_SCHEDULE_B', 'CONTROLLED',            DATE '2020-01-01', now())
       ON CONFLICT DO NOTHING`,
      [PROFILE_A, PROFILE_B, ORG_A, ORG_B, PRODUCT_A, PRODUCT_B, JUR_COUNTRY]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM product_regulatory_profiles WHERE id = ANY($1)', [
      [PROFILE_A, PROFILE_B],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[PRODUCT_A, PRODUCT_B]]);
    await owner.query('DELETE FROM product_categories WHERE id = $1', [CAT_PRIVATE_B]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [UNIT]);
    await owner.query('DELETE FROM regulatory_rules WHERE id = $1', [RULE]);
    await owner.query('DELETE FROM regulatory_rule_packs WHERE id = $1', [PACK]);
    await owner.query('DELETE FROM regulatory_sources WHERE id = $1', [SOURCE]);
    await owner.query('DELETE FROM regulatory_authorities WHERE id = $1', [AUTHORITY]);
    await owner.query('DELETE FROM jurisdictions WHERE id = ANY($1)', [[JUR_COUNTRY, JUR_REGION]]);
  });

  // -------------------------------------------------------------------------
  // The law is readable by everybody, on purpose
  // -------------------------------------------------------------------------

  it('shows the same rule pack to both organizations', async () => {
    const seenByA = await asTenant(ORG_A, () =>
      app.query('SELECT id FROM regulatory_rule_packs WHERE id = $1', [PACK])
    );
    const seenByB = await asTenant(ORG_B, () =>
      app.query('SELECT id FROM regulatory_rule_packs WHERE id = $1', [PACK])
    );

    /*
     * ⚠️ THIS IS THE WIDTH, AND IT IS DELIBERATE. A test asserting the opposite
     *   would be asserting that no clinic can read the law it is judged by.
     */
    expect(seenByA.rowCount).toBe(1);
    expect(seenByB.rowCount).toBe(1);
  });

  it('shows the rules, sources, regulators and places to a tenant', async () => {
    const rows = await asTenant(ORG_A, async () => ({
      rules: await app.query('SELECT id FROM regulatory_rules WHERE id = $1', [RULE]),
      sources: await app.query('SELECT id FROM regulatory_sources WHERE id = $1', [SOURCE]),
      authorities: await app.query('SELECT id FROM regulatory_authorities WHERE id = $1', [
        AUTHORITY,
      ]),
      jurisdictions: await app.query('SELECT id FROM jurisdictions WHERE id = $1', [JUR_COUNTRY]),
    }));

    expect(rows.rules.rowCount).toBe(1);
    expect(rows.sources.rowCount).toBe(1);
    expect(rows.authorities.rowCount).toBe(1);
    expect(rows.jurisdictions.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // …and writable by nobody who has a tenant
  // -------------------------------------------------------------------------

  it('refuses a tenant INSERT into the law', async () => {
    await expect(
      asTenant(ORG_B, () =>
        app.query(
          `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
           VALUES (gen_random_uuid(), 'ZY', NULL, 'Forged', now())`
        )
      )
    ).rejects.toThrow(/not writable from a tenant request/);
  });

  it('refuses a tenant UPDATE of another clinic-facing rule', async () => {
    await expect(
      asTenant(ORG_B, () =>
        app.query(`UPDATE regulatory_rules SET statement = 'Anything goes.' WHERE id = $1`, [RULE])
      )
    ).rejects.toThrow(/not writable from a tenant request/);
  });

  it('refuses a tenant DELETE of a rule pack', async () => {
    /*
     * ⚠️ THE ONE A POLICY WOULD NOT HAVE CAUGHT ANYWAY. Postgres applies no WITH
     *   CHECK to DELETE, so on an unscoped table a DELETE is unguarded unless
     *   something refuses it outright.
     */
    await expect(
      asTenant(ORG_B, () => app.query('DELETE FROM regulatory_rule_packs WHERE id = $1', [PACK]))
    ).rejects.toThrow(/not writable from a tenant request/);

    const survivors = await owner.query('SELECT id FROM regulatory_rule_packs WHERE id = $1', [
      PACK,
    ]);
    expect(survivors.rowCount).toBe(1);
  });

  it('lets the platform write the law when no tenant is claimed', async () => {
    // No `set_config('app.current_org')` — the console and the seeds look like
    // this, and the trigger is what tells them apart from a clinic's request.
    await app.query('BEGIN');
    try {
      const inserted = await app.query(
        `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
         VALUES (gen_random_uuid(), 'ZX', NULL, 'Platform written', now())
         RETURNING id`
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('refuses a rule that names one clinic’s private category', async () => {
    /*
     * ⚠️ THE CROSS-TENANT READ A `*_visible` POLICY CANNOT CLOSE HERE, because
     *   `regulatory_rules` has no policy to AND with. Left open, a rule pointing
     *   at ORG_B's private category would leak that category's NAME to every
     *   other clinic through the rule screen's join. Refused upstream instead:
     *   platform law may only speak about platform categories.
     */
    await expect(
      owner.query(
        `INSERT INTO regulatory_rules
           (id, pack_id, rule_type, code, statement, parameters, source_id, effective_from,
            applies_to_category_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'LABELLING_REQUIREMENT', 'ISO_LEAK',
                 'Leaky rule.', '{}'::jsonb, $2, DATE '2020-01-01', $3, now())`,
        [PACK, SOURCE, CAT_PRIVATE_B]
      )
    ).rejects.toThrow(/tenant-owned product category/);
  });

  // -------------------------------------------------------------------------
  // The tenant's own half
  // -------------------------------------------------------------------------

  it('hides one clinic’s regulatory profile from the other', async () => {
    const seenByA = await asTenant(ORG_A, () =>
      app.query('SELECT id, classification FROM product_regulatory_profiles')
    );

    expect(seenByA.rows.map((row: { id: string }) => row.id)).toEqual([PROFILE_A]);
    /*
     * ⚠️ THE CLASSIFICATION IS THE PART THAT MATTERS. "This clinic stocks
     *   something it has recorded as a controlled substance" is a fact about
     *   that clinic's business, and it is exactly what the join would disclose.
     */
    expect(seenByA.rows.map((row: { classification: string }) => row.classification)).not.toContain(
      'ISO_SCHEDULE_B'
    );
  });

  it('refuses a profile written against another clinic’s product', async () => {
    // The composite FK `(organization_id, product_id)` is the control here, and
    // it is why this table needs no `product_visible` policy.
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO product_regulatory_profiles
             (id, organization_id, product_id, jurisdiction_id, effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, DATE '2020-01-01', now())`,
          [ORG_A, PRODUCT_B, JUR_COUNTRY]
        )
      )
    ).rejects.toThrow();
  });

  it('refuses a clinic writing a PLATFORM profile every tenant would read', async () => {
    /*
     * The read-permissive / write-strict asymmetry, again. Copying the
     * NULL-permissive WITH CHECK from `files` here would let any clinic assert a
     * classification for a platform product on behalf of the whole platform.
     */
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO product_regulatory_profiles
             (id, organization_id, product_id, jurisdiction_id, effective_from, updated_at)
           VALUES (gen_random_uuid(), NULL, $1, $2, DATE '2020-01-01', now())`,
          [PRODUCT_A, JUR_COUNTRY]
        )
      )
    ).rejects.toThrow();
  });

  it('refuses a clinic updating another clinic’s profile, silently or otherwise', async () => {
    const result = await asTenant(ORG_A, () =>
      app.query(
        `UPDATE product_regulatory_profiles SET classification = 'REWRITTEN' WHERE id = $1`,
        [PROFILE_B]
      )
    );

    // RLS hides the row rather than refusing the statement: zero rows matched.
    expect(result.rowCount).toBe(0);

    const after = await owner.query(
      'SELECT classification FROM product_regulatory_profiles WHERE id = $1',
      [PROFILE_B]
    );
    expect(after.rows[0]?.classification).toBe('ISO_SCHEDULE_B');
  });

  // -------------------------------------------------------------------------
  // The sign-off constraint
  // -------------------------------------------------------------------------

  it('refuses a pack reaching a reviewed state with no reviewer named', async () => {
    /*
     * ⚠️ THE MOST IMPORTANT CONSTRAINT IN THE DOMAIN (PI-ADR-009). Run as the
     *   OWNER, deliberately: this is the shortcut a later migration or a psql
     *   session would take, and the service-layer guard is not in the way of
     *   either.
     */
    await expect(
      owner.query(
        `UPDATE regulatory_rule_packs SET maturity = 'PRODUCTION_ENABLED' WHERE id = $1`,
        [PACK]
      )
    ).rejects.toThrow(/regulatory_rule_packs_review_recorded/);
  });

  it('accepts the same state when a named human and an instant are recorded', async () => {
    await owner.query(
      `UPDATE regulatory_rule_packs
          SET maturity = 'REGULATORY_REVIEWED', reviewed_by = 'A. Reviewer', reviewed_at = now()
        WHERE id = $1`,
      [PACK]
    );

    const after = await owner.query(
      'SELECT maturity, reviewed_by FROM regulatory_rule_packs WHERE id = $1',
      [PACK]
    );
    expect(after.rows[0]?.maturity).toBe('REGULATORY_REVIEWED');
    expect(after.rows[0]?.reviewed_by).toBe('A. Reviewer');

    // Put it back, so the file leaves the fixture as it found it.
    await owner.query(
      `UPDATE regulatory_rule_packs
          SET maturity = 'RULES_CONFIGURED', reviewed_by = NULL, reviewed_at = NULL
        WHERE id = $1`,
      [PACK]
    );
  });
});
