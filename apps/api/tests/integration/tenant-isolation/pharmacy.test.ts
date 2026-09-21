/**
 * Tenant isolation — pharmacy dispensing (PI-7).
 *
 * Seven tables, one tenancy class, and the most sensitive rows on the platform:
 * `dispenses`, `dispense_lines`, `dispense_allocations`, `dispense_returns`,
 * `dispense_return_lines`, `prescription_fulfilments` and
 * `regulatory_decisions`.
 *
 * ⚠️ WHAT IS BEING PROTECTED HERE IS "WHICH MEDICINE A NAMED PERSON WAS GIVEN".
 *   Every other case in this suite guards a fact about a clinic; these guard a
 *   fact about a patient, and a missing policy on any one of them produces no
 *   error, breaks no single-tenant test, and quietly answers another clinic's
 *   question about somebody's medication.
 *
 * ⚠️ AND THE BRANCH BOUNDARY IS AS LOAD-BEARING AS THE ORGANIZATION ONE. A
 *   pharmacist scoped to one site has no business reading another site's
 *   dispensing register — several jurisdictions treat that register as the
 *   controlled-drugs record for THAT premises. `branch_id` is NOT NULL on all
 *   seven, so the RESTRICTIVE policy is absolute rather than the `IS NULL OR`
 *   shape it takes elsewhere, and `sees nothing at a sibling branch` is the case
 *   that proves it.
 *
 * ⚠️ `regulatory_decisions` ALSO CARRIES THE APPEND-ONLY PAIR — the revoked grant
 *   and the trigger — for the reason `audit_logs` does: the row is what a clinic
 *   shows an inspector to say which rules it applied, and one that can be edited
 *   afterwards is worth nothing as evidence (PI-ADR-008). Both layers get a case,
 *   because either alone is one `GRANT` away from silence.
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

describe('pharmacy', () => {
  const PH_UNIT = 'ffffffff-1111-4111-8111-000000000001';
  const PH_PROD_A = 'ffffffff-7777-4777-8777-0000000000a1';
  const PH_PROD_B = 'ffffffff-7777-4777-8777-0000000000b1';
  const PH_ACTOR = 'ffffffff-8888-4888-8888-000000000001';

  const PLOC_A = 'ffffffff-2222-4222-8222-0000000000a1';
  const PLOC_B1 = 'ffffffff-2222-4222-8222-0000000000b1';
  const PLOC_B2 = 'ffffffff-2222-4222-8222-0000000000b2';

  const PATIENT_A = 'ffffffff-3333-4333-8333-0000000000a1';
  const PATIENT_B = 'ffffffff-3333-4333-8333-0000000000b1';

  const DEC_A = 'ffffffff-4444-4444-8444-0000000000a1';
  const DEC_B = 'ffffffff-4444-4444-8444-0000000000b1';

  /** ORG_B's supply lives at B1. B2 is the sibling branch that must not see it. */
  const DISP_B = 'ffffffff-5555-4555-8555-0000000000b1';
  const DISP_A = 'ffffffff-5555-4555-8555-0000000000a1';
  const DLINE_B = 'ffffffff-6666-4666-8666-0000000000b1';
  const DALLOC_B = 'ffffffff-9999-4999-8999-0000000000b1';
  const DRET_B = 'ffffffff-aaaa-4aaa-8aaa-0000000000b1';
  const DRETLINE_B = 'ffffffff-bbbb-4bbb-8bbb-0000000000b1';

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
       VALUES ($1, 'Pharm Actor', 'pharm-iso-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [PH_ACTOR]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'PH_ISO_UNIT', 'Pharm Iso Unit', 'piu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [PH_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'MEDICINE', 'ACTIVE', 'PH_ISO_PROD_A', 'Pharm Iso Product A', $4, 'NONE', now()),
              ($2, $5, 'MEDICINE', 'ACTIVE', 'PH_ISO_PROD_B', 'Pharm Iso Product B', $4, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [PH_PROD_A, PH_PROD_B, ORG_A, PH_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, is_dispensing_point, updated_at)
       VALUES ($1, $4, $5, 'MAIN_PHARMACY', 'PH_ISO_A',  'Pharm Iso A',  true, now()),
              ($2, $6, $7, 'MAIN_PHARMACY', 'PH_ISO_B1', 'Pharm Iso B1', true, now()),
              ($3, $6, $8, 'MAIN_PHARMACY', 'PH_ISO_B2', 'Pharm Iso B2', true, now())
       ON CONFLICT DO NOTHING`,
      [PLOC_A, PLOC_B1, PLOC_B2, ORG_A, BRANCH_A, ORG_B, BRANCH_B1, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
       VALUES ($1, $2, 'PHISOA001', 'Pharm A', now()), ($3, $4, 'PHISOB001', 'Pharm B', now())
       ON CONFLICT DO NOTHING`,
      [PATIENT_A, ORG_A, PATIENT_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO regulatory_decisions
         (id, organization_id, branch_id, product_id, transaction, outcome, country_code,
          quantity_base, evaluated_at, pack_versions, reasons, conditions, rule_codes,
          actor_user_id)
       VALUES ($1, $3, $4, $5, 'DISPENSE', 'UNDETERMINED', 'IN', 10, now(),
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY[]::text[], $9),
              ($2, $6, $7, $8, 'DISPENSE', 'UNDETERMINED', 'IN', 10, now(),
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY[]::text[], $9)
       ON CONFLICT DO NOTHING`,
      [DEC_A, DEC_B, ORG_A, BRANCH_A, PH_PROD_A, ORG_B, BRANCH_B1, PH_PROD_B, PH_ACTOR]
    );

    /*
     * Counter sales, so the fixture needs no consultation: `encounter_id` is
     * nullable precisely because a sale over the counter has none, and the
     * CHECK allows a null patient on that path. The patient is set anyway —
     * this suite is about whether one clinic can read another's, and a row with
     * no patient would be a weaker thing to fail to hide.
     */
    await owner.query(
      `INSERT INTO dispenses
         (id, organization_id, branch_id, dispense_number, kind, status, patient_id,
          location_id, dispensed_by_id, updated_at)
       VALUES ($1, $3, $4, 'DSP-ISO-B1', 'COUNTER_SALE', 'DISPENSED', $5, $6, $9, now()),
              ($2, $7, $8, 'DSP-ISO-A1', 'COUNTER_SALE', 'DISPENSED', $10, $11, $9, now())
       ON CONFLICT DO NOTHING`,
      [
        DISP_B,
        DISP_A,
        ORG_B,
        BRANCH_B1,
        PATIENT_B,
        PLOC_B1,
        ORG_A,
        BRANCH_A,
        PH_ACTOR,
        PATIENT_A,
        PLOC_A,
      ]
    );

    await owner.query(
      `INSERT INTO dispense_lines
         (id, organization_id, branch_id, dispense_id, line_number, product_id,
          quantity_entered, unit_id, quantity_base, regulatory_decision_id, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, 10, $6, 10, $7, now())
       ON CONFLICT DO NOTHING`,
      [DLINE_B, ORG_B, BRANCH_B1, DISP_B, PH_PROD_B, PH_UNIT, DEC_B]
    );

    await owner.query(
      `INSERT INTO dispense_allocations
         (id, organization_id, branch_id, dispense_line_id, location_id, quantity_base)
       VALUES ($1, $2, $3, $4, $5, 10) ON CONFLICT DO NOTHING`,
      [DALLOC_B, ORG_B, BRANCH_B1, DLINE_B, PLOC_B1]
    );

    await owner.query(
      `INSERT INTO dispense_returns
         (id, organization_id, branch_id, dispense_id, disposition, location_id, reason,
          received_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'QUARANTINED', $5, 'Iso return', $6, now())
       ON CONFLICT DO NOTHING`,
      [DRET_B, ORG_B, BRANCH_B1, DISP_B, PLOC_B1, PH_ACTOR]
    );

    await owner.query(
      `INSERT INTO dispense_return_lines
         (id, organization_id, branch_id, dispense_return_id, dispense_line_id,
          dispense_allocation_id, quantity_base)
       VALUES ($1, $2, $3, $4, $5, $6, 2) ON CONFLICT DO NOTHING`,
      [DRETLINE_B, ORG_B, BRANCH_B1, DRET_B, DLINE_B, DALLOC_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM dispense_return_lines WHERE id = $1', [DRETLINE_B]);
    await owner.query('DELETE FROM dispense_returns WHERE id = $1', [DRET_B]);
    await owner.query('DELETE FROM dispense_allocations WHERE id = $1', [DALLOC_B]);
    await owner.query('DELETE FROM dispense_lines WHERE id = $1', [DLINE_B]);
    await owner.query('DELETE FROM dispenses WHERE id = ANY($1)', [[DISP_A, DISP_B]]);
    await owner.query('DELETE FROM regulatory_decisions WHERE id = ANY($1)', [[DEC_A, DEC_B]]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[PATIENT_A, PATIENT_B]]);
    await owner.query('DELETE FROM inventory_locations WHERE id = ANY($1)', [
      [PLOC_A, PLOC_B1, PLOC_B2],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[PH_PROD_A, PH_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [PH_UNIT]);
    await owner.query('DELETE FROM users WHERE id = $1', [PH_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [
      'dispenses',
      'dispense_lines',
      'dispense_allocations',
      'dispense_returns',
      'dispense_return_lines',
      'prescription_fulfilments',
      'regulatory_decisions',
    ]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  it("shows one clinic nothing of another's supply", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM dispenses WHERE id = $1', [DISP_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE LINE IS WHERE THE MEDICINE IS NAMED. A policy on the header alone
   *   would hide who was supplied and leak what they were supplied — which is the
   *   half that matters, and is why every child here carries its own
   *   organization_id and its own policy rather than inheriting through a parent.
   */
  it("shows one clinic nothing of another's dispensed lines", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM dispense_lines WHERE id = $1', [DLINE_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /** The allocation is where the LOT is named — the recall question. */
  it("shows one clinic nothing of another's allocations", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM dispense_allocations WHERE id = $1', [
        DALLOC_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of another's returns", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const returns = await app.query('SELECT id FROM dispense_returns WHERE id = $1', [DRET_B]);
      const lines = await app.query('SELECT id FROM dispense_return_lines WHERE id = $1', [
        DRETLINE_B,
      ]);
      return returns.rows.length + lines.rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE DECISION IS TENANT DATA EVEN THOUGH THE RULES ARE NOT. The law of a
   *   country is the same for everybody in it and has no organization_id; what
   *   this row records is that a named clinic supplied a controlled product on a
   *   given day, which is a fact about them.
   */
  it("shows one clinic nothing of another's regulatory decisions", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM regulatory_decisions WHERE id = $1', [
        DEC_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a supply into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO dispenses
             (id, organization_id, branch_id, dispense_number, kind, status, location_id,
              dispensed_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'DSP-ISO-X', 'COUNTER_SALE', 'DISPENSED', $3, $4, now())`,
          [ORG_B, BRANCH_B1, PLOC_B1, PH_ACTOR]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ THE CASE THAT MATTERS MOST. Both branches belong to ORG_B, so the
   *   organization policy passes and only the RESTRICTIVE branch policy stands
   *   between B2 and B1's dispensing register. A permissive-instead-of-restrictive
   *   policy here would OR with tenant isolation and make every supply in the
   *   organization visible to everyone in it — and it would pass every case above.
   */
  it('shows a sibling branch nothing of the counter next door', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const dispenses = await app.query('SELECT id FROM dispenses WHERE id = $1', [DISP_B]);
      const lines = await app.query('SELECT id FROM dispense_lines WHERE id = $1', [DLINE_B]);
      const allocations = await app.query('SELECT id FROM dispense_allocations WHERE id = $1', [
        DALLOC_B,
      ]);
      const decisions = await app.query('SELECT id FROM regulatory_decisions WHERE id = $1', [
        DEC_B,
      ]);
      return (
        dispenses.rows.length + lines.rows.length + allocations.rows.length + decisions.rows.length
      );
    });
    expect(seen).toBe(0);
  });

  it('shows the counter its own supply', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM dispenses WHERE id = $1', [DISP_B]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('refuses to write a supply into a branch outside the scope', async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B2], () =>
        app.query(
          `INSERT INTO dispenses
             (id, organization_id, branch_id, dispense_number, kind, status, location_id,
              dispensed_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'DSP-ISO-Y', 'COUNTER_SALE', 'DISPENSED', $3, $4, now())`,
          [ORG_B, BRANCH_B1, PLOC_B1, PH_ACTOR]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -- the snapshot is append-only -------------------------------------------

  /**
   * ⚠️ TWO LAYERS, TWO CASES, BECAUSE EITHER ONE ALONE IS ONE MISTAKE AWAY FROM
   *   NOTHING. The REVOKE stops the application role holding the privilege at
   *   all; the trigger refuses the statement even if a later migration grants it
   *   back. `audit_logs` is tested exactly this way, for the same reason.
   */
  it('holds no UPDATE or DELETE grant on the decision snapshot', async () => {
    const { rows } = await owner.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'rcln_app' AND table_name = 'regulatory_decisions'
          AND privilege_type IN ('UPDATE', 'DELETE')`
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to rewrite a decision even as the owner-adjacent app role', async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B1], () =>
        app.query(`UPDATE regulatory_decisions SET outcome = 'PERMITTED' WHERE id = $1`, [DEC_B])
      )
    ).rejects.toThrow();
  });

  /**
   * The trigger, isolated from the grant: as the OWNER — which the REVOKE does
   * not touch — a delete succeeds, and that exemption is deliberate (the
   * harness hard-deletes organizations in teardown). What must never work is a
   * rewrite through the application role, which the case above covers.
   */
  it('lets the owner delete one, so teardown and archival remain possible', async () => {
    const scratch = 'ffffffff-4444-4444-8444-00000000cc01';
    await owner.query(
      `INSERT INTO regulatory_decisions
         (id, organization_id, branch_id, product_id, transaction, outcome, country_code,
          quantity_base, evaluated_at, pack_versions, reasons, conditions, rule_codes, actor_user_id)
       VALUES ($1, $2, $3, $4, 'DISPENSE', 'UNDETERMINED', 'IN', 1, now(),
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ARRAY[]::text[], $5)`,
      [scratch, ORG_B, BRANCH_B1, PH_PROD_B, PH_ACTOR]
    );
    await expect(
      owner.query('DELETE FROM regulatory_decisions WHERE id = $1', [scratch])
    ).resolves.toBeDefined();
  });
});
