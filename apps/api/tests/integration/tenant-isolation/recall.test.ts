/**
 * Tenant isolation — recall & traceability (PI-10).
 *
 * Two tables, TWO tenancy classes, the third phase in a row to make this split:
 *
 *   `recalls`         org-scoped, NO branch column at all
 *   `recall_batches`  org + branch, `branch_id` NOT NULL
 *
 * ⚠️ WHAT IS BEING PROTECTED IS "WHICH LOT DID THIS CLINIC WITHDRAW, AND WHY". A
 *   recall names a product, a manufacturer's notice number and a reason —
 *   "sterility failure in this production run" — which is a statement about a
 *   competitor's quality problem as much as about a clinic's stock. A missing
 *   policy produces no error, breaks no single-tenant test, and quietly answers
 *   another clinic's question about what it had to pull off the shelf.
 *
 * ⚠️ AND THE BRANCH HALF IS LOAD-BEARING RATHER THAN COSMETIC HERE, which is
 *   unusual. `recall_batches.branch_isolation` is what makes a branch-scoped
 *   storekeeper execute only the lots at their own site — so a permissive
 *   instead of restrictive policy would not merely leak a row, it would change
 *   what Execute DOES.
 *
 * ⚠️ ONE plain FK lands in this phase — `recalls.product_id` into a
 *   platform-extensible table — and it gets a case of its own, because
 *   `db:rls:check` structurally cannot see a `*_visible` policy (KI-3). This
 *   exact class has produced a CRITICAL in four separate phases.
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

describe('recall and traceability', () => {
  const RC_UNIT = 'eeeeeeee-1111-4111-8111-000000000001';
  /** ⚠️ Both private to their clinic. A platform row would prove nothing. */
  const RC_PROD_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const RC_PROD_B = 'eeeeeeee-7777-4777-8777-0000000000b1';

  const RC_USER_A = 'eeeeeeee-8888-4888-8888-0000000000a1';
  const RC_USER_B = 'eeeeeeee-8888-4888-8888-0000000000b1';

  const RC_LOC_B1 = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const RC_BATCH_B1 = 'eeeeeeee-3333-4333-8333-0000000000b1';

  const RECALL_A = 'eeeeeeee-bbbb-4bbb-8bbb-0000000000a1';
  const RECALL_B = 'eeeeeeee-bbbb-4bbb-8bbb-0000000000b1';
  const RBATCH_B = 'eeeeeeee-cccc-4ccc-8ccc-0000000000b1';

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
       VALUES ($1, NULL, 'RC_ISO_UNIT', 'Recall Iso Unit', 'riu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [RC_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'MEDICINE', 'ACTIVE', 'RC_ISO_PROD_A', 'Recall Iso A', $4, 'LOT_BATCH', now()),
              ($2, $5, 'MEDICINE', 'ACTIVE', 'RC_ISO_PROD_B', 'Recall Iso B', $4, 'LOT_BATCH', now())
       ON CONFLICT DO NOTHING`,
      [RC_PROD_A, RC_PROD_B, ORG_A, RC_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'Rc Actor A', 'rc-iso-a@example.test', now()),
              ($2, 'Rc Actor B', 'rc-iso-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [RC_USER_A, RC_USER_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, is_dispensing_point, updated_at)
       VALUES ($1, $2, $3, 'MAIN_PHARMACY', 'RC_ISO_B1', 'Recall Iso B1', true, now())
       ON CONFLICT DO NOTHING`,
      [RC_LOC_B1, ORG_B, BRANCH_B1]
    );

    await owner.query(
      `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
       VALUES ($1, $2, $3, $4, 'RC-ISO-LOT-B', now()) ON CONFLICT DO NOTHING`,
      [RC_BATCH_B1, ORG_B, BRANCH_B1, RC_PROD_B]
    );

    await owner.query(
      `INSERT INTO recalls
         (id, organization_id, reference, product_id, title, classification, source, reason,
          status, raised_by_id, updated_at)
       VALUES ($1, $2, 'REC-ISO-A', $3, 'A notice', 'CLASS_I', 'MANUFACTURER',
               'Isolation fixture', 'DRAFT', $4, now()),
              ($5, $6, 'REC-ISO-B', $7, 'B notice', 'CLASS_I', 'REGULATOR',
               'Sterility failure in this production run', 'DRAFT', $8, now())
       ON CONFLICT DO NOTHING`,
      [RECALL_A, ORG_A, RC_PROD_A, RC_USER_A, RECALL_B, ORG_B, RC_PROD_B, RC_USER_B]
    );

    await owner.query(
      `INSERT INTO recall_batches
         (id, organization_id, branch_id, recall_id, batch_id, lot_number, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'RC-ISO-LOT-B', 'PENDING', now())
       ON CONFLICT DO NOTHING`,
      [RBATCH_B, ORG_B, BRANCH_B1, RECALL_B, RC_BATCH_B1]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM recall_batches WHERE id = $1', [RBATCH_B]);
    await owner.query('DELETE FROM recalls WHERE id = ANY($1)', [[RECALL_A, RECALL_B]]);
    await owner.query('DELETE FROM batches WHERE id = $1', [RC_BATCH_B1]);
    await owner.query('DELETE FROM inventory_locations WHERE id = $1', [RC_LOC_B1]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[RC_USER_A, RC_USER_B]]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[RC_PROD_A, RC_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [RC_UNIT]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of ['recalls', 'recall_batches']) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  /**
   * ⚠️ THE NOTICE ITSELF IS COMMERCIALLY SENSITIVE, WHICH IS EASY TO MISS. Its
   *   `reason` says what went wrong with a named manufacturer's production run,
   *   and `notice_reference` is the regulator's own file number.
   */
  it("shows one clinic nothing of another's recall notices", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM recalls WHERE id = $1', [RECALL_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('shows one clinic nothing of the lots another clinic pulled', async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM recall_batches WHERE id = $1', [RBATCH_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a notice into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO recalls
             (id, organization_id, reference, product_id, title, classification, source, reason,
              status, raised_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'REC-ISO-X', $2, 'Smuggled', 'CLASS_I', 'INTERNAL',
                   'Nope', 'DRAFT', $3, now())`,
          [ORG_B, RC_PROD_B, RC_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to attach another clinic's lot to its own notice", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO recall_batches
             (id, organization_id, branch_id, recall_id, batch_id, lot_number, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'RC-ISO-LOT-B', 'PENDING', now())`,
          [ORG_A, BRANCH_A, RECALL_A, RC_BATCH_B1]
        )
      )
    ).rejects.toThrow();
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ THE CASE THAT MATTERS MOST, AND IT IS NOT ONLY ABOUT VISIBILITY. Both
   *   branches belong to ORG_B, so the organization policy passes and only the
   *   RESTRICTIVE branch policy stands between B2 and a lot held at B1. A
   *   permissive-instead-of-restrictive policy here would OR with tenant
   *   isolation — and executing a recall from B2 would then walk B1's lots,
   *   moving quantity on a shelf the caller cannot reach.
   */
  it('shows a sibling branch nothing of a lot held at the other site', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM recall_batches WHERE id = $1', [RBATCH_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE NOTICE HAS NO BRANCH COLUMN AND IS THEREFORE VISIBLE ACROSS THE WHOLE
   *   ORGANIZATION. Asserted rather than assumed, because it is the deliberate
   *   cost recorded against the table: a branch-scoped member reads every recall
   *   the clinic has raised, which is why nothing branch-confidential may ever be
   *   added to it. A future change that branch-scoped this table would fail here
   *   and have to argue with the note.
   */
  it('shows a notice at every branch of its own organization', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM recalls WHERE id = $1', [RECALL_B]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  it('lets the branch that holds the lot see it', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM recall_batches WHERE id = $1', [RBATCH_B]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  // -- the `*_visible` policy (KI-3) -----------------------------------------

  /**
   * ⚠️ THE HOLE `db:rls:check` CANNOT SEE. `tenant_isolation` is satisfied — the
   *   notice being written IS ORG_A's — and only the RESTRICTIVE
   *   `product_visible` policy stops ORG_A raising a recall against ORG_B's
   *   PRIVATE product and reading its name back through the join that renders the
   *   list. `recalls.product_id` cannot be a composite FK, because a clinic
   *   legitimately recalls a PLATFORM product whose `organization_id` is NULL.
   */
  it("refuses a notice against another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO recalls
             (id, organization_id, reference, product_id, title, classification, source, reason,
              status, raised_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'REC-ISO-Y', $2, 'Peeking', 'CLASS_III', 'INTERNAL',
                   'Nope', 'DRAFT', $3, now())`,
          [ORG_A, RC_PROD_B, RC_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** And a PLATFORM product is fine, which is what the policy's NULL half is for. */
  it('permits a notice against a platform product', async () => {
    const platformProduct = await owner.query<{ id: string }>(
      `SELECT id FROM products WHERE organization_id IS NULL LIMIT 1`
    );
    const productId = platformProduct.rows[0]?.id;
    if (!productId) return;

    const written = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query<{ id: string }>(
        `INSERT INTO recalls
           (id, organization_id, reference, product_id, title, classification, source, reason,
            status, raised_by_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'REC-ISO-Z', $2, 'Platform product', 'CLASS_III',
                 'MANUFACTURER', 'Fixture', 'DRAFT', $3, now())
         RETURNING id`,
        [ORG_A, productId, RC_USER_A]
      );
      return rows[0]?.id ?? '';
    });

    expect(written).not.toBe('');
    await owner.query('DELETE FROM recalls WHERE id = $1', [written]);
  });

  // -- the CHECK constraints -------------------------------------------------

  /**
   * ⚠️ ZERO IS THE CASE THE WHOLE PHASE EXISTS FOR. A lot fully dispensed before
   *   the notice arrived has nothing left to pull, and the patient-contact work
   *   is then ALL of the work — so `NO_STOCK` carries a zero rather than a NULL,
   *   and "we looked and there was none" stays distinguishable from "we have not
   *   looked yet".
   */
  it('accepts a held lot with nothing left to pull', async () => {
    await expect(
      owner.query(
        `UPDATE recall_batches
            SET status = 'NO_STOCK', quantity_held_base = 0, held_at = now()
          WHERE id = $1`,
        [RBATCH_B]
      )
    ).resolves.toBeDefined();
  });

  it('refuses a resolved lot with no explanation', async () => {
    await expect(
      owner.query(
        `UPDATE recall_batches SET status = 'DISPOSED', outcome_note = '   ' WHERE id = $1`,
        [RBATCH_B]
      )
    ).rejects.toThrow(/recall_batches_resolution_is_explained/i);
  });

  it('refuses an ended notice with no outcome', async () => {
    await expect(
      owner.query(`UPDATE recalls SET status = 'CLOSED' WHERE id = $1`, [RECALL_B])
    ).rejects.toThrow(/recalls_ending_is_explained/i);
  });

  it('refuses an execution with a time and no name against it', async () => {
    await expect(
      owner.query(`UPDATE recalls SET executed_at = now() WHERE id = $1`, [RECALL_B])
    ).rejects.toThrow(/recalls_execution_is_attributed/i);
  });
});
