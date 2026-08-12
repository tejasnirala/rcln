/**
 * Tenant isolation — movements.
 *
 * Movements (PI-3): reason codes, transfers and reservations.
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

// ---------------------------------------------------------------------------
// Movements (PI-3): reason codes, transfers and reservations.
//
// ⚠️ THREE TENANCY CLASSES IN FOUR TABLES, WHICH IS WHY THIS IS A SEPARATE BLOCK
//   RATHER THAN FOUR MORE CASES IN THE ONE ABOVE:
//
//     stock_reason_codes    PLATFORM-EXTENSIBLE. The only table in the whole
//                           inventory domain that allows a NULL
//                           organization_id, because a reason code is a WORD
//                           rather than a fact about a clinic. Read-permissive,
//                           write-strict, plus the immutability trigger.
//     stock_transfers       TWO branches and NO `branch_id`. The generic
//                           branch_scoped loop cannot express it, so it carries
//                           a bespoke `from OR to` policy — the one place in the
//                           programme where a row is legitimately visible to two
//                           branches and to no third.
//     stock_transfer_lines  A child of that, restating the two-ended predicate
//                           BY HAND. The `appointment_status_history` trap: a
//                           policy expression is evaluated with row security
//                           DISABLED on the tables it references, so an EXISTS
//                           against the parent does NOT pick up the parent's
//                           branch policy.
//     stock_reservations    An ordinary branch-scoped tenant table.
//
// ⚠️ THE CASE THAT MATTERS MOST IS THE THIRD BRANCH. A two-ended policy reads
//   like a widening, and the way it would actually BE one is if the disjunction
//   were written PERMISSIVE — which ORs with tenant_isolation instead of ANDing,
//   making every transfer in the organization visible to everyone in it. That
//   passes every single-tenant test. It is `sees nothing at a third branch`.
// ---------------------------------------------------------------------------
describe('movements', () => {
  const MOV_UNIT = 'eeeeeeee-1111-4111-8111-000000000001';
  const MOV_PROD_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const MOV_PROD_B = 'eeeeeeee-7777-4777-8777-0000000000b1';
  const MOV_ACTOR = 'eeeeeeee-8888-4888-8888-000000000001';

  const MLOC_A = 'eeeeeeee-2222-4222-8222-0000000000a1';
  const MLOC_B1 = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const MLOC_B2 = 'eeeeeeee-2222-4222-8222-0000000000b2';

  /** B1 -> B2. Visible to both, and to nobody else. */
  const XFER_B = 'eeeeeeee-aaaa-4aaa-8aaa-0000000000b1';
  const XLINE_B = 'eeeeeeee-bbbb-4bbb-8bbb-0000000000b1';
  const XFER_A = 'eeeeeeee-aaaa-4aaa-8aaa-0000000000a1';
  const RES_B1 = 'eeeeeeee-cccc-4ccc-8ccc-0000000000b1';

  /** One organization's own reason code. Never visible to the other. */
  const RC_B = 'eeeeeeee-dddd-4ddd-8ddd-0000000000b1';

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
       VALUES ($1, 'Mov Actor', 'mov-iso-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [MOV_ACTOR]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'MOV_ISO_UNIT', 'Mov Iso Unit', 'miu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [MOV_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'CONSUMABLE', 'ACTIVE', 'MOV_ISO_PROD_A', 'Mov Iso Product A', $4, 'NONE', now()),
              ($2, $5, 'CONSUMABLE', 'ACTIVE', 'MOV_ISO_PROD_B', 'Mov Iso Product B', $4, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [MOV_PROD_A, MOV_PROD_B, ORG_A, MOV_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
       VALUES ($1, $4, $5, 'MAIN_PHARMACY', 'MOV_ISO_A',  'Mov Iso A',  now()),
              ($2, $6, $7, 'MAIN_PHARMACY', 'MOV_ISO_B1', 'Mov Iso B1', now()),
              ($3, $6, $8, 'REFRIGERATOR',  'MOV_ISO_B2', 'Mov Iso B2', now())
       ON CONFLICT DO NOTHING`,
      [MLOC_A, MLOC_B1, MLOC_B2, ORG_A, BRANCH_A, ORG_B, BRANCH_B1, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO stock_reason_codes (id, organization_id, code, label, direction, updated_at)
       VALUES ($1, $2, 'MOV_ISO_PRIVATE', 'Iso private reason', 'BOTH', now())
       ON CONFLICT DO NOTHING`,
      [RC_B, ORG_B]
    );

    // ORG_B's transfer goes B1 -> B2, so both branches may read it and BRANCH_A
    // — a different organization entirely — may not. ORG_A gets its own, so the
    // organization boundary has something to hide in each direction.
    await owner.query(
      `INSERT INTO stock_transfers
         (id, organization_id, from_branch_id, to_branch_id, from_location_id, from_location_name,
          status, created_by_id, updated_at)
       VALUES ($1, $3, $4, $5, $6, 'Mov Iso B1', 'DRAFT', $9, now()),
              ($2, $7, $8, $8, $10, 'Mov Iso A', 'DRAFT', $9, now())
       ON CONFLICT DO NOTHING`,
      [XFER_B, XFER_A, ORG_B, BRANCH_B1, BRANCH_B2, MLOC_B1, ORG_A, BRANCH_A, MOV_ACTOR, MLOC_A]
    );

    await owner.query(
      `INSERT INTO stock_transfer_lines
         (id, organization_id, transfer_id, product_id, sent_quantity_base, quantity_entered,
          unit_id, updated_at)
       VALUES ($1, $2, $3, $4, 10, 10, $5, now()) ON CONFLICT DO NOTHING`,
      [XLINE_B, ORG_B, XFER_B, MOV_PROD_B, MOV_UNIT]
    );

    await owner.query(
      `INSERT INTO stock_reservations
         (id, organization_id, branch_id, product_id, location_id, quantity_base,
          reference_type, expires_at, created_by_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, 5, 'MANUAL', now() + interval '7 days', $6, now())
       ON CONFLICT DO NOTHING`,
      [RES_B1, ORG_B, BRANCH_B1, MOV_PROD_B, MLOC_B1, MOV_ACTOR]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM stock_transfer_lines WHERE id = $1', [XLINE_B]);
    await owner.query('DELETE FROM stock_transfers WHERE id = ANY($1)', [[XFER_B, XFER_A]]);
    await owner.query('DELETE FROM stock_reservations WHERE id = $1', [RES_B1]);
    await owner.query('DELETE FROM stock_reason_codes WHERE id = $1', [RC_B]);
    await owner.query('DELETE FROM inventory_locations WHERE id = ANY($1)', [
      [MLOC_A, MLOC_B1, MLOC_B2],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[MOV_PROD_A, MOV_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [MOV_UNIT]);
    await owner.query('DELETE FROM users WHERE id = $1', [MOV_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of ['stock_transfers', 'stock_transfer_lines', 'stock_reservations']) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  describe('the reason-code vocabulary', () => {
    /*
     * ⚠️ THE ONE PLATFORM-EXTENSIBLE TABLE IN THE INVENTORY DOMAIN, SO IT IS THE
     *   ONE WHERE "I CAN SEE A ROW WITH SOMEBODY ELSE'S organization_id" IS
     *   CORRECT — for NULL, and for NULL only.
     */
    it('shows every tenant the platform codes', async () => {
      const seen = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT id FROM stock_reason_codes WHERE code = 'COUNT_SHORT'`
        );
        return rows.length;
      });
      expect(seen).toBe(1);
    });

    it("hides one clinic's own codes from another", async () => {
      const seen = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM stock_reason_codes WHERE id = $1', [RC_B]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    /*
     * ⚠️ THE HOLE `platform_rows_immutable` EXISTS TO CLOSE, ON THE EIGHTEENTH
     *   TABLE. `tenant_isolation`'s USING permits `organization_id IS NULL`, and
     *   Postgres applies NO WITH CHECK to a DELETE — so without the trigger any
     *   clinic could delete the platform vocabulary for every clinic.
     */
    it('refuses a tenant deleting a platform code', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(`DELETE FROM stock_reason_codes WHERE code = 'COUNT_SHORT'`)
        )
      ).rejects.toThrow(/not writable by a tenant/i);
    });

    /* And the capture: old row NULL passes USING, new row mine passes WITH CHECK. */
    it('refuses a tenant capturing a platform code as its own', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `UPDATE stock_reason_codes SET organization_id = $1 WHERE code = 'COUNT_SHORT'`,
            [ORG_A]
          )
        )
      ).rejects.toThrow(/not writable by a tenant/i);
    });

    it('refuses a tenant writing a new PLATFORM code', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO stock_reason_codes (id, organization_id, code, label, updated_at)
             VALUES (gen_random_uuid(), NULL, 'MOV_ISO_STEAL', 'Stolen', now())`
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('the transfer document', () => {
    it("hides one organization's transfers from another", async () => {
      const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query('SELECT id FROM stock_transfers WHERE id = $1', [XFER_B]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    /*
     * ⚠️ BOTH ENDS SEE IT, AND THAT IS THE POINT OF THE BESPOKE POLICY. A
     *   transfer from Central Store to Anna Nagar is the business of both, and a
     *   receiving storekeeper who could not read the document would have no way
     *   to sign for a delivery they are holding.
     */
    it('is visible to the SENDING branch', async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
        const { rows } = await app.query('SELECT id FROM stock_transfers WHERE id = $1', [XFER_B]);
        return rows.length;
      });
      expect(seen).toBe(1);
    });

    it('is visible to the RECEIVING branch', async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM stock_transfers WHERE id = $1', [XFER_B]);
        return rows.length;
      });
      expect(seen).toBe(1);
    });

    /*
     * ⚠️ THE LOAD-BEARING CASE. A third branch at the same organization sees
     *   NOTHING — which is what distinguishes the RESTRICTIVE two-ended policy
     *   that was written from the PERMISSIVE one that would have made every
     *   transfer in the organization visible to everyone in it. That mistake
     *   passes every single-tenant test and every test above this one.
     */
    it('sees nothing at a third branch of the same organization', async () => {
      const { rows: third } = await owner.query<{ id: string }>(
        `INSERT INTO branches (id, organization_id, code, name, timezone, updated_at)
         VALUES (gen_random_uuid(), $1, 'MOVISO3', 'Mov Iso Third', 'Asia/Kolkata', now())
         RETURNING id`,
        [ORG_B]
      );
      const thirdBranch = third[0]?.id ?? '';

      try {
        const seen = await atBranches(ORG_B, [thirdBranch], async () => {
          const { rows } = await app.query('SELECT id FROM stock_transfers WHERE id = $1', [
            XFER_B,
          ]);
          return rows.length;
        });
        expect(seen).toBe(0);
      } finally {
        await owner.query('DELETE FROM branches WHERE id = $1', [thirdBranch]);
      }
    });

    /*
     * ⚠️ THE LINES RESTATE THE PARENT'S PREDICATE, AND THIS IS WHAT PROVES THEY
     *   DO. The `parent_scoped` loop would ask only the ORGANIZATION question,
     *   because a policy expression is evaluated with row security disabled on
     *   the tables it references — so an EXISTS against `stock_transfers` does
     *   not pick up the policy tested immediately above. Measured on
     *   `appointment_status_history` first; restated here.
     */
    it('hides the LINES from a third branch too, not only the header', async () => {
      const { rows: third } = await owner.query<{ id: string }>(
        `INSERT INTO branches (id, organization_id, code, name, timezone, updated_at)
         VALUES (gen_random_uuid(), $1, 'MOVISO4', 'Mov Iso Fourth', 'Asia/Kolkata', now())
         RETURNING id`,
        [ORG_B]
      );
      const thirdBranch = third[0]?.id ?? '';

      try {
        const seen = await atBranches(ORG_B, [thirdBranch], async () => {
          const { rows } = await app.query('SELECT id FROM stock_transfer_lines WHERE id = $1', [
            XLINE_B,
          ]);
          return rows.length;
        });
        expect(seen).toBe(0);
      } finally {
        await owner.query('DELETE FROM branches WHERE id = $1', [thirdBranch]);
      }
    });

    it('shows the lines to both ends', async () => {
      const counts = await Promise.all([
        atBranches(ORG_B, [BRANCH_B1], async () => {
          const { rows } = await app.query('SELECT id FROM stock_transfer_lines WHERE id = $1', [
            XLINE_B,
          ]);
          return rows.length;
        }),
        atBranches(ORG_B, [BRANCH_B2], async () => {
          const { rows } = await app.query('SELECT id FROM stock_transfer_lines WHERE id = $1', [
            XLINE_B,
          ]);
          return rows.length;
        }),
      ]);
      expect(counts).toEqual([1, 1]);
    });

    it('refuses a transfer written between another organization’s branches', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_transfers
               (id, organization_id, from_branch_id, to_branch_id, from_location_id,
                from_location_name, created_by_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Stolen', $5, now())`,
            [ORG_B, BRANCH_B1, BRANCH_B2, MLOC_B1, MOV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a transfer neither of whose ends the caller works at', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B2], () =>
          app.query(
            `INSERT INTO stock_transfers
               (id, organization_id, from_branch_id, to_branch_id, from_location_id,
                from_location_name, created_by_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $2, $3, 'Not mine', $4, now())`,
            [ORG_B, BRANCH_B1, MLOC_B1, MOV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a post-dispatch status with no dispatch time and no number', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B1], () =>
          app.query(`UPDATE stock_transfers SET status = 'DISPATCHED' WHERE id = $1`, [XFER_B])
        )
      ).rejects.toThrow(/stock_transfers_dispatched_states_complete/i);
    });

    it('refuses receiving more than was sent', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B2], () =>
          app.query('UPDATE stock_transfer_lines SET received_quantity_base = 11 WHERE id = $1', [
            XLINE_B,
          ])
        )
      ).rejects.toThrow(/stock_transfer_lines_quantities_sane/i);
    });

    it('refuses a cancellation with no reason', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B1], () =>
          app.query('UPDATE stock_transfers SET cancelled_at = now() WHERE id = $1', [XFER_B])
        )
      ).rejects.toThrow(/stock_transfers_cancellation_reasoned/i);
    });
  });

  describe('the sweep discovery function', () => {
    /*
     * ⚠️ THE PI-2 CRITICAL, CHECKED FOR THE NEW FUNCTION RATHER THAN
     *   REDISCOVERED. `inventory_branches_with_due_reservations` is SECURITY
     *   DEFINER and `rcln_app` is MEANT to execute it — the worker connects as
     *   that role — so the grant is asserted PRESENT here rather than absent.
     *   What is asserted absent is the thing that made the balance functions a
     *   CRITICAL: an argument that widens what it returns. It takes a row cap
     *   and nothing else, so the app role cannot ask it about a tenant.
     */
    it('is executable by the app role, and takes only a row cap', async () => {
      const { rows } = await app.query<{ granted: boolean; args: string }>(
        `SELECT has_function_privilege(
                  'inventory_branches_with_due_reservations(int)', 'EXECUTE') AS granted,
                pg_get_function_identity_arguments(
                  'inventory_branches_with_due_reservations(int)'::regprocedure) AS args`
      );
      expect(rows[0]?.granted).toBe(true);
      expect(rows[0]?.args).toBe('row_limit integer');
    });

    /*
     * ⚠️ AND IT RETURNS NOTHING TO A TENANT WHO ASKS IT DIRECTLY ABOUT ANOTHER
     *   TENANT, BECAUSE IT CANNOT BE ASKED. It has no tenant parameter at all —
     *   the ONLY reason a scheduler may call it is that a scheduler has no
     *   tenant. A request path calling it learns which branches hold overdue
     *   reservations platform-wide, which is why the function returns three ids
     *   and nothing a person could read.
     */
    it('returns only ids, never a name or a quantity', async () => {
      const { rows } = await app.query<{ column_name: string }>(
        `SELECT unnest(proargnames) AS column_name
           FROM pg_proc
          WHERE proname = 'inventory_branches_with_due_reservations'`
      );
      const names = rows.map((r) => r.column_name).filter((n) => n !== 'row_limit');
      expect(names.sort()).toEqual(['actor_user_id', 'branch_id', 'organization_id']);
    });
  });

  describe('reservations', () => {
    it("hides one organization's reservations from another", async () => {
      const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query('SELECT id FROM stock_reservations WHERE id = $1', [
          RES_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    /*
     * ⚠️ ORDINARY BRANCH SCOPING, WHICH IS THE OPPOSITE CALL FROM THE TRANSFER
     *   ABOVE AND THE RIGHT ONE. Stock is reserved AT one place, so a
     *   storekeeper at another site has no business knowing that a shelf they
     *   cannot see is holding something back.
     */
    it("hides one branch's reservations from the other", async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM stock_reservations WHERE id = $1', [
          RES_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    it('refuses a reservation written against a branch outside the caller’s scope', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B2], () =>
          app.query(
            `INSERT INTO stock_reservations
               (id, organization_id, branch_id, product_id, location_id, quantity_base,
                reference_type, expires_at, created_by_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, 'MANUAL', now() + interval '1 day', $5, now())`,
            [ORG_B, BRANCH_B1, MOV_PROD_B, MLOC_B1, MOV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a reservation of nothing', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B1], () =>
          app.query('UPDATE stock_reservations SET quantity_base = 0 WHERE id = $1', [RES_B1])
        )
      ).rejects.toThrow(/stock_reservations_quantity_positive/i);
    });

    it('refuses a terminal reservation with no release time', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B1], () =>
          app.query(`UPDATE stock_reservations SET status = 'RELEASED' WHERE id = $1`, [RES_B1])
        )
      ).rejects.toThrow(/stock_reservations_terminal_dated/i);
    });
  });
});
