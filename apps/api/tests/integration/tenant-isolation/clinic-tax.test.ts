/**
 * Tenant isolation — clinic-tax.
 *
 * The clinic's own tax position — the opposite decision from `tax_registrations`.
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

/*
 * The clinic's own tax position.
 *
 * ⚠️ THESE TWO TABLES ARE THE OPPOSITE DECISION FROM `tax_registrations`, WHICH
 *   IS EXEMPT FROM RLS ON PURPOSE. That one holds rcln's numbers, is read inside
 *   a tenant transaction, and a policy on it would return zero rows — which
 *   reads as NOT_REGISTERED and silently untaxes every subscription invoice.
 *   None of that applies here: these rows belong to the organization reading
 *   them. Someone who knows the exemption and not the reason for it could
 *   plausibly exempt these too, and nothing would fail — a clinic would simply
 *   start being able to read its competitor's GSTIN and its whole rate card.
 *   That is what these cases exist to catch.
 */
describe('issuer tax registrations and rules', () => {
  const REG_A = 'aaaaaaaa-7a11-4a11-8a11-000000000001';
  const REG_B = 'bbbbbbbb-7b11-4b11-8b11-000000000001';
  const RULE_B = 'bbbbbbbb-7b22-4b22-8b22-000000000001';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO issuer_tax_registrations
         (id, organization_id, country_code, region_code, scheme, registration_number,
          effective_from, updated_at)
       VALUES ($1,$3,'IN','KA','GST','29AAACR1234K1ZP','2025-04-01',now()),
              ($2,$4,'IN','KL','GST','32AAACR9999K1ZQ','2025-04-01',now())
       ON CONFLICT (id) DO NOTHING`,
      [REG_A, REG_B, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES ($1,$2,'IN','GST','MEDICINE',500,'STANDARD','GST','2025-04-01',now())
       ON CONFLICT (id) DO NOTHING`,
      [RULE_B, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM tax_rules WHERE id = $1', [RULE_B]);
    await owner.query('DELETE FROM issuer_tax_registrations WHERE id = ANY($1)', [[REG_A, REG_B]]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM issuer_tax_registrations'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  /*
   * A GSTIN is the number every invoice a business issues is filed under. It is
   * not PHI, but it identifies the competitor completely and is exactly the sort
   * of row that reads as harmless configuration right up until it leaks.
   */
  it('hides another clinic’s registration', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM issuer_tax_registrations WHERE id = $1', [
        REG_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('shows a clinic its own registration', async () => {
    const number = await asTenant(ORG_A, async () => {
      const { rows } = await app.query<{ registration_number: string }>(
        'SELECT registration_number FROM issuer_tax_registrations WHERE id = $1',
        [REG_A]
      );
      return rows[0]?.registration_number;
    });
    expect(number).toBe('29AAACR1234K1ZP');
  });

  it('hides another clinic’s rate card', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM tax_rules WHERE id = $1', [RULE_B]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  /*
   * The write half. Without WITH CHECK, a clinic could plant a registration
   * under another organization's id — and the invoices raised against it would
   * then carry a GSTIN belonging to somebody else.
   */
  it('rejects writing a registration into another clinic', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO issuer_tax_registrations
             (id, organization_id, country_code, scheme, registration_number,
              effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, 'IN', 'GST', '29PLANTED0000ZZ', '2025-04-01', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * ⚠️ THE LINK TABLE IS NOT EXEMPT FOR HOLDING ONLY IDS. Both of them are tenant
   *   ids, so another clinic's row says which of its branches bills under which
   *   of its registrations — the same disclosure as reading the registration
   *   itself, one join later.
   */
  describe('coverage links', () => {
    const LINK_B = 'bbbbbbbb-7b33-4b33-8b33-000000000001';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO issuer_tax_registration_branches
           (id, organization_id, tax_registration_id, branch_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO NOTHING`,
        [LINK_B, ORG_B, REG_B, BRANCH_B1]
      );
    });

    afterAll(async () => {
      await owner.query('DELETE FROM issuer_tax_registration_branches WHERE id = $1', [LINK_B]);
    });

    it('fails closed with no tenant context', async () => {
      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM issuer_tax_registration_branches'
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('hides which of another clinic’s branches bills under which registration', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          'SELECT id FROM issuer_tax_registration_branches WHERE id = $1',
          [LINK_B]
        );
        return rows.length;
      });
      expect(found).toBe(0);
    });

    it('shows a clinic its own coverage', async () => {
      const branch = await asTenant(ORG_B, async () => {
        const { rows } = await app.query<{ branch_id: string }>(
          'SELECT branch_id FROM issuer_tax_registration_branches WHERE id = $1',
          [LINK_B]
        );
        return rows[0]?.branch_id;
      });
      expect(branch).toBe(BRANCH_B1);
    });

    it('rejects writing coverage into another clinic', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO issuer_tax_registration_branches
               (id, organization_id, tax_registration_id, branch_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, now())`,
            [ORG_B, REG_B, BRANCH_B2]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    /*
     * ⚠️ THE COMPOSITE FK, WHICH IS THE LAYER BELOW RLS. Even as the owner —
     *   who bypasses every policy — a link cannot join one organization's branch
     *   to another's registration, because the tenant travels inside both keys.
     *   Without it, a bug in the service could point a Karnataka clinic's invoice
     *   at a competitor's GSTIN and no policy would notice.
     */
    it('cannot join one clinic’s branch to another clinic’s registration', async () => {
      await expect(
        owner.query(
          `INSERT INTO issuer_tax_registration_branches
             (id, organization_id, tax_registration_id, branch_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now())`,
          [ORG_A, REG_B, BRANCH_A]
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  /*
   * ⚠️ The CHECK that stops a catalogue row asserting a legal position it knows
   *   nothing about. `treatment` is the full six-value enum because Prisma
   *   cannot express a subset of one, so the database is the only thing holding
   *   the line — and the service layer casts to `ItemTaxTreatment` on the way
   *   out, trusting exactly this.
   */
  it('refuses a tax rule claiming a treatment an item cannot have', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'BOGUS', 0, 'REVERSE_CHARGE', 'GST', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_treatment_is_item_level/);
  });

  /*
   * An "EXEMPT at 18%" row is not a legal position, it is a typo — and it prints
   * an invoice line that contradicts itself.
   */
  it('refuses an untaxed treatment carrying a non-zero rate', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'BOGUS', 1800, 'EXEMPT', 'GST', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_untaxed_means_zero_rate/);
  });

  /*
   * NULLS NOT DISTINCT. A country-wide rule has a NULL region_code, and in
   * ordinary SQL two NULLs are never equal — so without it a clinic can hold any
   * number of country-wide rules for one category and one start date, and
   * `ruleFor` picks whichever the planner returns first.
   */
  it('refuses a second country-wide rule for the same category and date', async () => {
    const first = 'bbbbbbbb-7b33-4b33-8b33-000000000001';
    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
          line_name, effective_from, updated_at)
       VALUES ($1,$2,'IN','GST','DUPE',500,'STANDARD','GST','2025-04-01',now())`,
      [first, ORG_B]
    );

    try {
      await expect(
        owner.query(
          `INSERT INTO tax_rules
             (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
              line_name, effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'DUPE', 1200, 'STANDARD', 'GST', '2025-04-01', now())`,
          [ORG_B]
        )
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await owner.query('DELETE FROM tax_rules WHERE id = $1', [first]);
    }
  });
  /*
   * ⚠️ A stacking rule is always regional. `stacks` means "charge this IN
   *   ADDITION to the country-wide rule for the same category" — Canada's
   *   provincial PST on top of federal GST. A country-wide rule that stacked
   *   would be both the base AND the addition, so the same rate would be charged
   *   twice on one line item and the invoice would silently overcharge.
   */
  it('refuses a country-wide rule that claims to stack', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, region_code, scheme, tax_category, rate_bps,
            treatment, line_name, stacks, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'CA', NULL, 'GST', 'MEDICINE', 700, 'STANDARD',
                 'PST', true, '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_stacking_is_regional/);
  });

  /* And the same rule scoped to a province is accepted. */
  it('accepts a regional stacking rule', async () => {
    const id = 'bbbbbbbb-7b44-4b44-8b44-000000000001';
    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, region_code, scheme, tax_category, rate_bps,
          treatment, line_name, stacks, effective_from, updated_at)
       VALUES ($1, $2, 'CA', 'BC', 'GST', 'MEDICINE', 700, 'STANDARD',
               'PST', true, '2025-04-01', now())`,
      [id, ORG_B]
    );
    await owner.query('DELETE FROM tax_rules WHERE id = $1', [id]);
  });

  /*
   * ⚠️ India's split derives `CGST`/`SGST`/`IGST` from `line_name` by prefixing,
   *   which is how those names are constructed in law. A `line_name` of
   *   'Sales Tax' would derive 'CSales Tax' and print it on an invoice.
   */
  it('refuses a split rule whose line name cannot be prefixed', async () => {
    await expect(
      owner.query(
        `INSERT INTO tax_rules
           (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
            line_name, split, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE', 1200, 'STANDARD',
                 'Sales Tax', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
        [ORG_B]
      )
    ).rejects.toThrow(/tax_rules_split_name_is_prefixable/);
  });
});
