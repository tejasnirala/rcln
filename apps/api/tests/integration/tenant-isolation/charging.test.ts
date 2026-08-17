/**
 * Tenant isolation — charging (PI-8).
 *
 * Three tables, TWO tenancy classes, which is what makes this file different
 * from the pharmacy one where all seven were alike:
 *
 *   `charge_policy_rules`   org-scoped, NO branch column at all
 *   `product_prices`        org + branch, and `branch_id` is NULLABLE
 *   `charge_requests`       org + branch, `branch_id` NOT NULL
 *
 * ⚠️ WHAT IS BEING PROTECTED IS "WHAT A NAMED PERSON IS BEING CHARGED FOR, AND
 *   FOR WHICH MEDICINE". A charge request is the same disclosure a dispense line
 *   is, with a price on it. A missing policy produces no error, breaks no
 *   single-tenant test, and quietly answers another clinic's question about
 *   somebody's medication.
 *
 * ⚠️ `product_prices.branch_id` IS NULLABLE AND THE `IS NULL OR` HALF OF THE
 *   BRANCH PREDICATE IS THEREFORE LIVE, UNLIKE EVERY OTHER BRANCH-SCOPED TABLE
 *   IN THE PROGRAMME. That is deliberate — NULL is the organization-wide default
 *   every branch inherits — and it needs its own case in BOTH directions: a
 *   sibling branch must SEE the org default (or nothing is priced anywhere) and
 *   must NOT see the other branch's override.
 *
 * ⚠️ AND THE `*_visible` POLICIES GET CASES OF THEIR OWN, because `db:rls:check`
 *   structurally cannot see them (KI-3). `tenant_isolation` is satisfied when the
 *   ROW is yours; nothing in it stops the row pointing at another clinic's
 *   private product and reading the name back through the join.
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

describe('charging', () => {
  const CH_UNIT = 'cccccccc-1111-4111-8111-000000000001';
  const CH_PROD_A = 'cccccccc-7777-4777-8777-0000000000a1';
  const CH_PROD_B = 'cccccccc-7777-4777-8777-0000000000b1';
  const CH_ACTOR = 'cccccccc-8888-4888-8888-000000000001';

  const CLOC_B1 = 'cccccccc-2222-4222-8222-0000000000b1';
  const PATIENT_B = 'cccccccc-3333-4333-8333-0000000000b1';
  const DEC_B = 'cccccccc-4444-4444-8444-0000000000b1';
  const DISP_B = 'cccccccc-5555-4555-8555-0000000000b1';
  const DLINE_B = 'cccccccc-6666-4666-8666-0000000000b1';

  const RULE_A = 'cccccccc-9999-4999-8999-0000000000a1';
  const RULE_B = 'cccccccc-9999-4999-8999-0000000000b1';
  /** ORG_B's org-wide default, and B1's override. B2 must see one and not the other. */
  const PRICE_B_DEFAULT = 'cccccccc-aaaa-4aaa-8aaa-0000000000b0';
  const PRICE_B1 = 'cccccccc-aaaa-4aaa-8aaa-0000000000b1';
  const CHARGE_B = 'cccccccc-bbbb-4bbb-8bbb-0000000000b1';

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
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Charge Actor', 'charge-iso-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [CH_ACTOR]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'CH_ISO_UNIT', 'Charge Iso Unit', 'ciu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [CH_UNIT]
    );

    /*
     * ⚠️ BOTH PRODUCTS ARE PRIVATE TO THEIR CLINIC — neither has a NULL
     *   organization_id. That is what makes the `*_visible` cases below mean
     *   something: a platform product would legitimately be visible to both and
     *   would prove nothing.
     */
    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'MEDICINE', 'ACTIVE', 'CH_ISO_PROD_A', 'Charge Iso Product A', $4, 'NONE', now()),
              ($2, $5, 'MEDICINE', 'ACTIVE', 'CH_ISO_PROD_B', 'Charge Iso Product B', $4, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [CH_PROD_A, CH_PROD_B, ORG_A, CH_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, is_dispensing_point, updated_at)
       VALUES ($1, $2, $3, 'MAIN_PHARMACY', 'CH_ISO_B1', 'Charge Iso B1', true, now())
       ON CONFLICT DO NOTHING`,
      [CLOC_B1, ORG_B, BRANCH_B1]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'CHISOB001', 'Charge B', now()) ON CONFLICT DO NOTHING`,
      [PATIENT_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO regulatory_decisions
         (id, organization_id, branch_id, product_id, transaction, outcome, country_code,
          quantity_base, evaluated_at, pack_versions, reasons, conditions, rule_codes,
          actor_user_id)
       VALUES ($1, $2, $3, $4, 'DISPENSE', 'UNDETERMINED', 'IN', 10, now(),
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY[]::text[], $5)
       ON CONFLICT DO NOTHING`,
      [DEC_B, ORG_B, BRANCH_B1, CH_PROD_B, CH_ACTOR]
    );

    await owner.query(
      `INSERT INTO dispenses
         (id, organization_id, branch_id, dispense_number, kind, status, patient_id,
          location_id, dispensed_by_id, updated_at)
       VALUES ($1, $2, $3, 'DSP-CHISO-B1', 'COUNTER_SALE', 'DISPENSED', $4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [DISP_B, ORG_B, BRANCH_B1, PATIENT_B, CLOC_B1, CH_ACTOR]
    );

    await owner.query(
      `INSERT INTO dispense_lines
         (id, organization_id, branch_id, dispense_id, line_number, product_id,
          quantity_entered, unit_id, quantity_base, regulatory_decision_id, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, 10, $6, 10, $7, now())
       ON CONFLICT DO NOTHING`,
      [DLINE_B, ORG_B, BRANCH_B1, DISP_B, CH_PROD_B, CH_UNIT, DEC_B]
    );

    await owner.query(
      `INSERT INTO charge_policy_rules
         (id, organization_id, product_id, policy, updated_at)
       VALUES ($1, $2, $3, 'NEVER_BILL', now()), ($4, $5, $6, 'SEPARATELY_BILLABLE', now())
       ON CONFLICT DO NOTHING`,
      [RULE_A, ORG_A, CH_PROD_A, RULE_B, ORG_B, CH_PROD_B]
    );

    await owner.query(
      `INSERT INTO product_prices
         (id, organization_id, branch_id, product_id, unit_id, amount, currency, updated_at)
       VALUES ($1, $3, NULL, $4, $5, 45.00, 'INR', now()),
              ($2, $3, $6,   $4, $5, 50.00, 'INR', now())
       ON CONFLICT DO NOTHING`,
      [PRICE_B_DEFAULT, PRICE_B1, ORG_B, CH_PROD_B, CH_UNIT, BRANCH_B1]
    );

    await owner.query(
      `INSERT INTO charge_requests
         (id, organization_id, branch_id, source_type, kind, status, dispense_line_id,
          product_id, patient_id, occurred_at, quantity_base, quantity, unit_id,
          policy, policy_scope, policy_rule_id, description, unit_price, currency,
          tax_category, updated_at)
       VALUES ($1, $2, $3, 'PHARMACY', 'SUPPLY', 'PENDING', $4, $5, $6, now(), 10, 10, $7,
               'SEPARATELY_BILLABLE', 'PRODUCT', $8, 'Charge Iso Product B', 45.00, 'INR',
               '3004', now())
       ON CONFLICT DO NOTHING`,
      [CHARGE_B, ORG_B, BRANCH_B1, DLINE_B, CH_PROD_B, PATIENT_B, CH_UNIT, RULE_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM charge_requests WHERE id = $1', [CHARGE_B]);
    await owner.query('DELETE FROM product_prices WHERE id = ANY($1)', [
      [PRICE_B_DEFAULT, PRICE_B1],
    ]);
    await owner.query('DELETE FROM charge_policy_rules WHERE id = ANY($1)', [[RULE_A, RULE_B]]);
    await owner.query('DELETE FROM dispense_lines WHERE id = $1', [DLINE_B]);
    await owner.query('DELETE FROM dispenses WHERE id = $1', [DISP_B]);
    await owner.query('DELETE FROM regulatory_decisions WHERE id = $1', [DEC_B]);
    await owner.query('DELETE FROM patients WHERE id = $1', [PATIENT_B]);
    await owner.query('DELETE FROM inventory_locations WHERE id = $1', [CLOC_B1]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[CH_PROD_A, CH_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [CH_UNIT]);
    await owner.query('DELETE FROM users WHERE id = $1', [CH_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of ['charge_policy_rules', 'product_prices', 'charge_requests']) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  it("shows one clinic nothing of another's charge policy", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM charge_policy_rules WHERE id = $1', [
        RULE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of another's prices", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM product_prices WHERE id = ANY($1)', [
        [PRICE_B_DEFAULT, PRICE_B1],
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE ROW THAT NAMES A PATIENT, A MEDICINE AND A PRICE TOGETHER. This is the
   *   disclosure the whole file exists for.
   */
  it("shows one clinic nothing of another's charges", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM charge_requests WHERE id = $1', [CHARGE_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a charge into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO charge_requests
             (id, organization_id, branch_id, source_type, kind, status, dispense_line_id,
              product_id, occurred_at, quantity_base, quantity, unit_id, policy, policy_scope,
              description, currency, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'PHARMACY', 'SUPPLY', 'PENDING', $3, $4, now(),
                   1, 1, $5, 'SEPARATELY_BILLABLE', 'DEFAULT', 'Smuggled', 'INR', now())`,
          [ORG_B, BRANCH_B1, DLINE_B, CH_PROD_B, CH_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ THE CASE THAT MATTERS MOST. Both branches belong to ORG_B, so the
   *   organization policy passes and only the RESTRICTIVE branch policy stands
   *   between B2 and B1's charge queue. A permissive-instead-of-restrictive
   *   policy here would OR with tenant isolation and make every charge in the
   *   organization visible to everyone in it — and it would pass every case
   *   above.
   */
  it('shows a sibling branch nothing of the till next door', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM charge_requests WHERE id = $1', [CHARGE_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE NULLABLE HALF, IN THE DIRECTION THAT MUST WORK. A NULL `branch_id` on
   *   `product_prices` is the organization-wide default every branch inherits. If
   *   the branch predicate were written absolutely — as it correctly is on
   *   `charge_requests` — this row would be invisible everywhere and a clinic
   *   that prices centrally would find nothing priced at any of its sites.
   */
  it('shows a sibling branch the clinic-wide default price', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM product_prices WHERE id = $1', [
        PRICE_B_DEFAULT,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  /** And the other direction: a branch's own override stays its own. */
  it("shows a sibling branch nothing of another branch's price override", async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM product_prices WHERE id = $1', [PRICE_B1]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ `charge_policy_rules` HAS NO BRANCH COLUMN AND IS THEREFORE VISIBLE ACROSS
   *   THE WHOLE ORGANIZATION. Asserted rather than assumed, because it is the
   *   deliberate cost recorded against the table: a branch-scoped member reads
   *   the clinic's whole charge policy, which is why nothing branch-confidential
   *   may ever be added to it. A future change that branch-scoped this table
   *   would fail here and have to argue with the note.
   */
  it('shows the charge policy at every branch of its own organization', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM charge_policy_rules WHERE id = $1', [
        RULE_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  // -- the `*_visible` policies (KI-3) ---------------------------------------

  /**
   * ⚠️ THE HOLE `db:rls:check` CANNOT SEE. `tenant_isolation` is satisfied here —
   *   the row being written IS ORG_A's — and only the RESTRICTIVE
   *   `product_visible` policy stops ORG_A attaching ORG_B's PRIVATE product to
   *   its own price row and reading the name straight back out through the join
   *   the pricing screen makes. The table has a policy; it just would not have
   *   enough of one.
   */
  it("refuses to price another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO product_prices
             (id, organization_id, branch_id, product_id, unit_id, amount, currency, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 1.00, 'INR', now())`,
          [ORG_A, BRANCH_A, CH_PROD_B, CH_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to write a charge policy about another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO charge_policy_rules (id, organization_id, product_id, policy, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'NEVER_BILL', now())`,
          [ORG_A, CH_PROD_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to raise a charge for another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO charge_requests
             (id, organization_id, branch_id, source_type, kind, status, product_id,
              occurred_at, quantity_base, quantity, unit_id, policy, policy_scope,
              description, currency, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'INVENTORY', 'SUPPLY', 'PENDING', $3, now(),
                   1, 1, $4, 'SEPARATELY_BILLABLE', 'DEFAULT', 'Leak', 'INR', now())`,
          [ORG_A, BRANCH_A, CH_PROD_B, CH_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE SECOND PLAIN FK ON `dispense_lines`, AND THE ONE THE SECURITY REVIEW
   *   CAUGHT PI-8 ABOUT TO SHIP. `product_visible` covers `product_id`;
   *   `substituted_for_product_id` is a SECOND plain FK into the same
   *   platform-extensible table, it is accepted straight from the client, it is
   *   written with no validation, and it is joined for its NAME and rendered on
   *   the dispense detail screen.
   *
   *   PI-8 made it materially more reachable by adding the substitute picker to
   *   the dispensing workspace — a hole left open in PI-7 that this phase
   *   widened before closing.
   */
  it("refuses to record another clinic's private product as the one substituted for", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO dispense_lines
             (id, organization_id, branch_id, dispense_id, line_number, product_id,
              substituted_for_product_id, substitution_reason,
              quantity_entered, unit_id, quantity_base, regulatory_decision_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 98, $4, $5, 'Leak', 1, $6, 1, $7, now())`,
          [ORG_A, BRANCH_A, DISP_B, CH_PROD_A, CH_PROD_B, CH_UNIT, DEC_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ `regulatory_decisions.product_id` — the same class again, PI-7 vintage.
   *   Lower risk because `recordDecision` derives the id server-side, so no
   *   client controls it today. Closed anyway: "the service happens not to pass
   *   an attacker-controlled id" is the class of guarantee this schema exists to
   *   replace.
   */
  it("refuses to record a decision about another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO regulatory_decisions
             (id, organization_id, branch_id, product_id, transaction, outcome, country_code,
              quantity_base, evaluated_at, pack_versions, reasons, conditions, rule_codes,
              actor_user_id)
           VALUES (gen_random_uuid(), $1, $2, $3, 'DISPENSE', 'UNDETERMINED', 'IN', 1, now(),
                   '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY[]::text[], $4)`,
          [ORG_A, BRANCH_A, CH_PROD_B, CH_ACTOR]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE SAME HOLE ON `dispense_lines`, WHICH PI-7 SHIPPED WITHOUT AND PI-8
   *   CLOSED. `encounter_prescriptions` has carried `product_visible` since CE-4
   *   for the same plain FK into the same platform-extensible table, which is
   *   what makes the omission an oversight rather than a decision. Without it a
   *   clinic attaches another clinic's private product to its own dispense line
   *   and reads the name back through the join the dispense detail screen makes —
   *   on the most PHI-dense table in the programme.
   */
  it("refuses to dispense another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO dispense_lines
             (id, organization_id, branch_id, dispense_id, line_number, product_id,
              quantity_entered, unit_id, quantity_base, regulatory_decision_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 99, $4, 1, $5, 1, $6, now())`,
          [ORG_A, BRANCH_A, DISP_B, CH_PROD_B, CH_UNIT, DEC_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- membership_professional_registrations (PI-8) --------------------------

  /**
   * ⚠️ A PARENT-SCOPED CHILD WITH NO `organization_id` OF ITS OWN, AND THE ONE
   *   TABLE PI-8 ADDED WITHOUT A CASE UNTIL REVIEW ASKED FOR IT. It feeds
   *   `RegulatoryActor.licenceTypes`, so a leak here would let ONE CLINIC'S STAFF
   *   SATISFY ANOTHER CLINIC'S `PHARMACIST_AUTHORITY` RULE — the exact claim the
   *   RLS comment makes and nothing verified.
   *
   *   Protected by `parent_isolation`, an EXISTS against `memberships`. ⚠️ The
   *   subquery is NOT subject to the parent's own RLS — Postgres evaluates policy
   *   expressions with row security disabled on referenced tables — so the
   *   organization test is spelled out in the predicate rather than inherited.
   *   These cases are what prove it was.
   */
  describe('professional registrations', () => {
    const MEM_A = 'cccccccc-dddd-4ddd-8ddd-0000000000a1';
    const MEM_B = 'cccccccc-dddd-4ddd-8ddd-0000000000b1';
    const REG_B = 'cccccccc-eeee-4eee-8eee-0000000000b1';
    const USER_B = 'cccccccc-ffff-4fff-8fff-0000000000b1';

    beforeAll(async () => {
      await owner.query(
        `INSERT INTO users (id, full_name, email, updated_at)
         VALUES ($1, 'Reg B', 'reg-iso-b@example.test', now()) ON CONFLICT DO NOTHING`,
        [USER_B]
      );
      await owner.query(
        `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
         VALUES ($1, $3, $4, 'ACTIVE', now()), ($2, $5, $6, 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [MEM_A, MEM_B, CH_ACTOR, ORG_A, USER_B, ORG_B]
      );
      await owner.query(
        `INSERT INTO membership_professional_registrations
           (id, membership_id, licence_type, registration_number, status, updated_at)
         VALUES ($1, $2, 'PHARMACIST', 'B-REG-1', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [REG_B, MEM_B]
      );
    });

    afterAll(async () => {
      await owner.query('DELETE FROM membership_professional_registrations WHERE id = $1', [REG_B]);
      await owner.query('DELETE FROM memberships WHERE id = ANY($1)', [[MEM_A, MEM_B]]);
      await owner.query('DELETE FROM users WHERE id = $1', [USER_B]);
    });

    it('fails closed with no tenant context', async () => {
      const { rows } = await app.query<{ count: string }>(
        'SELECT count(*) AS count FROM membership_professional_registrations'
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it("shows one clinic nothing of another's registrations", async () => {
      const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query(
          'SELECT id FROM membership_professional_registrations WHERE id = $1',
          [REG_B]
        );
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    /**
     * ⚠️ THE WRITE SIDE, WHICH IS THE ONE THAT WOULD MATTER. Hanging a licence
     *   off another clinic's membership is how a clinic grants ITSELF an
     *   authority the law reserves for registered staff.
     */
    it("refuses to hang a licence off another clinic's membership", async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO membership_professional_registrations
               (id, membership_id, licence_type, registration_number, status, updated_at)
             VALUES (gen_random_uuid(), $1, 'PHARMACIST', 'FORGED', 'ACTIVE', now())`,
            [MEM_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('shows a clinic its own registrations', async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
        const { rows } = await app.query(
          'SELECT id FROM membership_professional_registrations WHERE id = $1',
          [REG_B]
        );
        return rows.length;
      });
      expect(seen).toBe(1);
    });
  });
});
