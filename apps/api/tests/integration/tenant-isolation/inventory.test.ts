/**
 * Tenant isolation — inventory.
 *
 * Inventory (PI-2) — the opposite tenancy class from the catalogue above.
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
// Inventory (PI-2).
//
// ⚠️ THE OPPOSITE TENANCY CLASS FROM THE CATALOGUE ABOVE, AND THE CASES BELOW
//   ARE SHAPED BY THAT. A product may be a PLATFORM row that every clinic reads;
//   a location, a lot, a serial, a movement and a balance never may. Every one
//   of these seven tables has `organization_id` NOT NULL and `branch_id` NOT
//   NULL, so both policies are absolute — and the branch half is tested as hard
//   as the organization half, because a hospital group whose Bangalore
//   storekeeper can read the Mysore controlled-drug cabinet has a real problem
//   that an org-only test would call clean.
//
// ⚠️ AND THE `product_visible` POLICIES ARE THE HIGHEST-RISK ITEM IN THE PHASE.
//   `batches.product_id` cannot be a composite FK — a clinic legitimately stocks
//   a PLATFORM product, whose organization_id is NULL — so `tenant_isolation`
//   constrains the batch's own organization and says NOTHING about the product
//   it names. Without the RESTRICTIVE policy a clinic creates a batch of another
//   clinic's private product and reads its name straight back out of the join.
//   That write is refused below, on `batches`, `serials`, `stock_ledger` and
//   `stock_balances`.
// ---------------------------------------------------------------------------
describe('inventory', () => {
  const INV_UNIT = 'dddddddd-1111-4111-8111-000000000001';
  const INV_PROD_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const INV_PROD_B = 'dddddddd-7777-4777-8777-0000000000b1';
  const INV_PROD_PLATFORM = 'dddddddd-7777-4777-8777-000000000001';
  const INV_ACTOR = 'dddddddd-8888-4888-8888-000000000001';

  const LOC_A = 'dddddddd-2222-4222-8222-0000000000a1';
  const LOC_B1 = 'dddddddd-2222-4222-8222-0000000000b1';
  const LOC_B2 = 'dddddddd-2222-4222-8222-0000000000b2';
  const AREA_B1 = 'dddddddd-3333-4333-8333-0000000000b1';
  const BIN_B1 = 'dddddddd-4444-4444-8444-0000000000b1';
  const BATCH_A = 'dddddddd-5555-4555-8555-0000000000a1';
  const BATCH_B1 = 'dddddddd-5555-4555-8555-0000000000b1';
  const SERIAL_B1 = 'dddddddd-6666-4666-8666-0000000000b1';
  const INV_MEM_A = 'dddddddd-9999-4999-8999-0000000000a1';
  const INV_MEM_B = 'dddddddd-9999-4999-8999-0000000000b1';

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
       VALUES ($1, 'Inv Actor', 'inv-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [INV_ACTOR]
    );

    /*
     * ⚠️ THE ACTOR NEEDS A MEMBERSHIP IN BOTH ORGANIZATIONS, because
     *   `actor_is_member` refuses a movement naming somebody who does not work
     *   at the clinic. Without these the CHECK-constraint cases below would fail
     *   on the POLICY instead — passing for the wrong reason, and testing
     *   nothing about the constraint they name.
     */
    await owner.query(
      `INSERT INTO memberships (id, user_id, organization_id, status, updated_at)
       VALUES ($1,$3,$4,'ACTIVE',now()), ($2,$3,$5,'ACTIVE',now())
       ON CONFLICT (id) DO NOTHING`,
      [INV_MEM_A, INV_MEM_B, INV_ACTOR, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'INV_ISO_UNIT', 'Inv Iso Unit', 'iiu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [INV_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $4, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_A', 'Inv Iso Product A', $5, 'LOT_BATCH', now()),
              ($2, $6, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_B', 'Inv Iso Product B', $5, 'LOT_BATCH', now()),
              ($3, NULL, 'CONSUMABLE', 'ACTIVE', 'INV_ISO_PROD_P', 'Inv Iso Product P', $5, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [INV_PROD_A, INV_PROD_B, INV_PROD_PLATFORM, ORG_A, INV_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
       VALUES ($1, $4, $5, 'MAIN_PHARMACY', 'INV_ISO_A',  'Iso A Pharmacy', now()),
              ($2, $6, $7, 'MAIN_PHARMACY', 'INV_ISO_B1', 'Iso B1 Pharmacy', now()),
              ($3, $6, $8, 'REFRIGERATOR',  'INV_ISO_B2', 'Iso B2 Fridge',   now())
       ON CONFLICT DO NOTHING`,
      [LOC_A, LOC_B1, LOC_B2, ORG_A, BRANCH_A, ORG_B, BRANCH_B1, BRANCH_B2]
    );

    await owner.query(
      `INSERT INTO storage_areas (id, organization_id, branch_id, location_id, code, name, updated_at)
       VALUES ($1, $2, $3, $4, 'AISLE1', 'Aisle 1', now()) ON CONFLICT DO NOTHING`,
      [AREA_B1, ORG_B, BRANCH_B1, LOC_B1]
    );
    await owner.query(
      `INSERT INTO storage_bins (id, organization_id, branch_id, area_id, code, updated_at)
       VALUES ($1, $2, $3, $4, 'BIN1', now()) ON CONFLICT DO NOTHING`,
      [BIN_B1, ORG_B, BRANCH_B1, AREA_B1]
    );

    await owner.query(
      `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
       VALUES ($1, $3, $4, $5, 'ISO-LOT-A', now()),
              ($2, $6, $7, $8, 'ISO-LOT-B', now())
       ON CONFLICT DO NOTHING`,
      [BATCH_A, BATCH_B1, ORG_A, BRANCH_A, INV_PROD_A, ORG_B, BRANCH_B1, INV_PROD_B]
    );

    await owner.query(
      `INSERT INTO serials (id, organization_id, branch_id, product_id, batch_id, serial_number, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ISO-SER-B', now()) ON CONFLICT DO NOTHING`,
      [SERIAL_B1, ORG_B, BRANCH_B1, INV_PROD_B, BATCH_B1]
    );

    // One receipt at each organization, so both the ledger and the
    // trigger-maintained balance have rows to hide from the other.
    await owner.query(
      `INSERT INTO stock_ledger
         (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
          quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 100, 100, $5, $6, 'AVAILABLE', 'MANUAL', $7),
              (gen_random_uuid(), $8, $9, $10, $11, 'LOT_BATCH', 'PURCHASE_RECEIPT', 250, 250, $5, $12, 'AVAILABLE', 'MANUAL', $7)`,
      [
        ORG_A,
        BRANCH_A,
        INV_PROD_A,
        BATCH_A,
        INV_UNIT,
        LOC_A,
        INV_ACTOR,
        ORG_B,
        BRANCH_B1,
        INV_PROD_B,
        BATCH_B1,
        LOC_B1,
      ]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM stock_ledger WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM stock_balances WHERE organization_id = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
    await owner.query('DELETE FROM serials WHERE id = $1', [SERIAL_B1]);
    await owner.query('DELETE FROM batches WHERE id = ANY($1)', [[BATCH_A, BATCH_B1]]);
    await owner.query('DELETE FROM storage_bins WHERE id = $1', [BIN_B1]);
    await owner.query('DELETE FROM storage_areas WHERE id = $1', [AREA_B1]);
    await owner.query('DELETE FROM inventory_locations WHERE id = ANY($1)', [
      [LOC_A, LOC_B1, LOC_B2],
    ]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [
      [INV_PROD_A, INV_PROD_B, INV_PROD_PLATFORM],
    ]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [INV_UNIT]);
    await owner.query('DELETE FROM memberships WHERE id = ANY($1)', [[INV_MEM_A, INV_MEM_B]]);
    await owner.query('DELETE FROM users WHERE id = $1', [INV_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [
      'inventory_locations',
      'storage_areas',
      'storage_bins',
      'batches',
      'serials',
      'stock_ledger',
      'stock_balances',
    ]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  /*
   * ⚠️ A TENANT CONTEXT WITH NO BRANCH SCOPE SEES NOTHING EITHER, and that is
   *   the half an org-only test would call clean. `branch_id` is NOT NULL on all
   *   seven tables, so the RESTRICTIVE branch policy's `branch_id IS NULL OR`
   *   disjunct can never fire — a caller that forgot to set `app.branch_scope`
   *   gets an empty array, and an empty array matches nothing.
   */
  it('shows nothing to a tenant whose branch scope is empty', async () => {
    const seen = await asTenant(ORG_B, async () => {
      const { rows } = await app.query('SELECT id FROM inventory_locations');
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  describe('the organization boundary', () => {
    it("hides one organization's locations from another", async () => {
      const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations WHERE id = $1', [
          LOC_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    it("hides one organization's lots, serials, movements and balances from another", async () => {
      const counts = await atBranches(ORG_A, [BRANCH_A], async () => {
        const batches = await app.query('SELECT id FROM batches WHERE id = $1', [BATCH_B1]);
        const serials = await app.query('SELECT id FROM serials WHERE id = $1', [SERIAL_B1]);
        const ledger = await app.query('SELECT id FROM stock_ledger WHERE organization_id = $1', [
          ORG_B,
        ]);
        const balances = await app.query(
          'SELECT id FROM stock_balances WHERE organization_id = $1',
          [ORG_B]
        );
        return [batches.rows.length, serials.rows.length, ledger.rows.length, balances.rows.length];
      });
      expect(counts).toEqual([0, 0, 0, 0]);
    });

    it('hides the children — areas and bins — as well as their parent', async () => {
      const counts = await atBranches(ORG_A, [BRANCH_A], async () => {
        const areas = await app.query('SELECT id FROM storage_areas WHERE id = $1', [AREA_B1]);
        const bins = await app.query('SELECT id FROM storage_bins WHERE id = $1', [BIN_B1]);
        return [areas.rows.length, bins.rows.length];
      });
      expect(counts).toEqual([0, 0]);
    });

    it('refuses a location written against another organization', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'MAIN_PHARMACY', 'INV_ISO_STEAL', 'Stolen', now())`,
            [ORG_B, BRANCH_B1]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('the branch boundary', () => {
    /*
     * ⚠️ THIS IS THE CASE `patients` DELIBERATELY DOES NOT HAVE, AND STOCK
     *   DELIBERATELY DOES. A person is one person across a hospital group, so
     *   their identity follows them; a shelf is at one site, and what one site
     *   holds, paid and dispensed is not another site's business.
     */
    it("hides one branch's locations from a storekeeper scoped to the other", async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations WHERE id = $1', [
          LOC_B1,
        ]);
        return rows.length;
      });
      expect(seen).toBe(0);
    });

    it("hides one branch's lots, movements and balances from the other", async () => {
      const counts = await atBranches(ORG_B, [BRANCH_B2], async () => {
        const batches = await app.query('SELECT id FROM batches WHERE id = $1', [BATCH_B1]);
        const ledger = await app.query('SELECT id FROM stock_ledger');
        const balances = await app.query('SELECT id FROM stock_balances');
        return [batches.rows.length, ledger.rows.length, balances.rows.length];
      });
      expect(counts).toEqual([0, 0, 0]);
    });

    it('shows both branches to an organization-wide reader', async () => {
      const seen = await atBranches(ORG_B, [BRANCH_B1, BRANCH_B2], async () => {
        const { rows } = await app.query('SELECT id FROM inventory_locations');
        return rows.length;
      });
      expect(seen).toBe(2);
    });

    it('refuses a lot written against a branch outside the caller’s scope', async () => {
      await expect(
        atBranches(ORG_B, [BRANCH_B2], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-CROSS', now())`,
            [ORG_B, BRANCH_B1, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });

  describe('the product_visible policies', () => {
    /*
     * ⚠️ THE HIGHEST-RISK ITEM IN THIS PHASE, AND THE ONE THAT LOOKS FINE.
     *   `tenant_isolation` on `batches` constrains the batch's OWN
     *   organization_id, which passes here — the row genuinely belongs to A. The
     *   product it names does not, and nothing but the RESTRICTIVE policy asks.
     *   Without it this INSERT succeeds and A reads B's product name, generic
     *   name, composition and manufacturer back out through the join.
     */
    it('refuses a lot of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-LEAK', now())`,
            [ORG_A, BRANCH_A, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a serial of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO serials (id, organization_id, branch_id, product_id, serial_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-SER-LEAK', now())`,
            [ORG_A, BRANCH_A, INV_PROD_B]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses a movement of another tenant’s private product', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'NONE', 'PURCHASE_RECEIPT', 1, 1, $4, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_B, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);
    });

    /*
     * The other half of the same policy, and the reason it is permissive on the
     * read side: a clinic stocking a PLATFORM product is the ordinary case, and
     * a policy that refused it would make the shared catalogue unusable.
     */
    /*
     * ⚠️ THE OTHER FOUR POLICIES HAD NO DECOY, WHICH IS HOW ONE OF THEM ENDS UP
     *   SUBTLY DIFFERENT FROM THE REST. Each is the same shape and each guards a
     *   different join a read already performs: `listLedger` selects
     *   `unit.symbol`, `listBatches` selects `manufacturer.name`, and
     *   `listLocations` selects `storageProfile.name`. Without the policy each
     *   of those is another clinic's private row read back out through a join.
     */
    it('refuses a movement naming another tenant’s private unit', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_UNIT_B', 'Inv Iso Unit B', 'iib', 'COUNT', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateUnit = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 1, 1, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, privateUnit, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM units_of_measure WHERE id = $1', [privateUnit]);
    });

    it('refuses a lot naming another tenant’s private manufacturer', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_MFR_B', 'Inv Iso Manufacturer B', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateMfr = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, manufacturer_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-MFR', $4, now())`,
            [ORG_A, BRANCH_A, INV_PROD_A, privateMfr]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM manufacturers WHERE id = $1', [privateMfr]);
    });

    it('refuses a location naming another tenant’s private storage profile', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'INV_ISO_STORE_B', 'Inv Iso Storage B', now())
         RETURNING id`,
        [ORG_B]
      );
      const privateProfile = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, storage_profile_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'REFRIGERATOR', 'INV_ISO_LEAK', 'Leaky fridge', $3, now())`,
            [ORG_A, BRANCH_A, privateProfile]
          )
        )
      ).rejects.toThrow(/row-level security|violates/i);

      await owner.query('DELETE FROM storage_requirement_profiles WHERE id = $1', [privateProfile]);
    });

    /*
     * ⚠️ THE EIGHTH PLAIN FK, WHICH THE `*_visible` LOOP COULD NOT EXPRESS.
     *   `users` is RLS-EXEMPT and has no organization_id, so the policy is a
     *   membership test instead. Without it a tenant writes a movement naming
     *   any user uuid and reads `users.full_name` back through the join
     *   `listLedger` already performs and returns as `actorName`.
     */
    it('refuses a movement naming somebody who does not work at this clinic', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO users (id, full_name, email, updated_at)
         VALUES (gen_random_uuid(), 'Outsider', 'inv-outsider@example.test', now())
         RETURNING id`
      );
      const outsider = rows[0]?.id;

      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 1, 1, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, outsider]
          )
        )
      ).rejects.toThrow(/actor_is_member|row-level security/i);

      await owner.query('DELETE FROM users WHERE id = $1', [outsider]);
    });

    it('permits a lot of a PLATFORM product', async () => {
      const inserted = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query(
          `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-PLATFORM', now()) RETURNING id`,
          [ORG_A, BRANCH_A, INV_PROD_PLATFORM]
        );
        return rows[0]?.id as string;
      });
      expect(inserted).toBeDefined();
      await owner.query('DELETE FROM batches WHERE id = $1', [inserted]);
    });
  });

  describe('the ledger is append-only', () => {
    /*
     * ⚠️ TWO INDEPENDENT LAYERS, AND EACH IS TESTED WITH THE OTHER REMOVED —
     *   which is what the two cases below do implicitly. The GRANT check proves
     *   `rcln_app` holds no UPDATE or DELETE at all; the trigger check proves
     *   that even the owner's privileges do not help an app-role statement, and
     *   that re-running the init script's blanket GRANT would not silently
     *   re-open the table.
     */
    it('holds no UPDATE or DELETE grant on stock_ledger for the app role', async () => {
      const { rows } = await app.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = current_user AND table_name = 'stock_ledger'
          ORDER BY privilege_type`
      );
      const held = rows.map((r) => r.privilege_type);
      expect(held).not.toContain('UPDATE');
      expect(held).not.toContain('DELETE');
      // INSERT is kept: `recordMovement` writes through this role.
      expect(held).toContain('INSERT');
      expect(held).toContain('SELECT');
    });

    it('refuses an UPDATE of a movement even for the tenant that wrote it', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(`UPDATE stock_ledger SET reason_note = 'edited' WHERE organization_id = $1`, [
            ORG_A,
          ])
        )
      ).rejects.toThrow(/append-only|permission denied/i);
    });

    it('refuses a DELETE of a movement', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query('DELETE FROM stock_ledger WHERE organization_id = $1', [ORG_A])
        )
      ).rejects.toThrow(/append-only|permission denied/i);
    });
  });

  describe('the balance cache is written by the trigger and by nothing else', () => {
    /*
     * ⚠️ PI-ADR-004 RULE 2, MADE LITERAL. "Nothing at all writes stock_balances"
     *   is an agreement until the grant says so. With INSERT, UPDATE and DELETE
     *   revoked there is no code path in the application — present or future,
     *   correct or not — that can state a quantity directly. The only way a
     *   balance changes is that a movement was recorded.
     */
    it('holds only SELECT on stock_balances for the app role', async () => {
      const { rows } = await app.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = current_user AND table_name = 'stock_balances'
          ORDER BY privilege_type`
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
    });

    /*
     * ⚠️ THE GRANT CHECK THE FIRST VERSION DID NOT HAVE, AND ITS ABSENCE HID A
     *   CRITICAL. `REVOKE ALL ON FUNCTION ... FROM PUBLIC` does NOT remove the
     *   role-specific grant that `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
     *   FUNCTIONS TO rcln_app` in the init script hands to every function a
     *   migration creates. So `stock_balances_apply_delta` — SECURITY DEFINER,
     *   RLS-bypassing, and taking the organization, location and delta as
     *   ARGUMENTS — was callable by the request-path role, which nullified the
     *   REVOKE on the table above entirely.
     *
     *   The table grants were tested and the function grants were not. This is
     *   the missing half.
     */
    it('holds no EXECUTE on either balance function for the app role', async () => {
      const { rows } = await app.query<{ delta: boolean; trigger: boolean }>(
        `SELECT has_function_privilege(
                  'stock_balances_apply_delta(uuid,uuid,uuid,uuid,uuid,uuid,"StockStatus",numeric)',
                  'EXECUTE') AS delta,
                has_function_privilege('stock_balances_apply()', 'EXECUTE') AS trigger`
      );
      expect(rows[0]?.delta).toBe(false);
      expect(rows[0]?.trigger).toBe(false);
    });

    it('maintained the balance from the receipt the fixture recorded', async () => {
      const quantity = await atBranches(ORG_A, [BRANCH_A], async () => {
        const { rows } = await app.query<{ quantity: string }>(
          `SELECT quantity FROM stock_balances
            WHERE batch_id = $1 AND location_id = $2 AND status = 'AVAILABLE'`,
          [BATCH_A, LOC_A]
        );
        return rows[0]?.quantity;
      });
      expect(Number(quantity)).toBe(100);
    });
  });

  describe('the constraints that carry weight', () => {
    it('refuses a negative quantity on a receipt', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', -5, -5, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_direction/i);
    });

    it('refuses an adjustment with no reason code', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'ADJUSTMENT', 5, 5, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_direction/i);
    });

    it('refuses a batch-tracked movement with no lot (PI-ADR-014)', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, to_location_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, 'LOT_BATCH', 'PURCHASE_RECEIPT', 5, 5, $4, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_tracking_satisfied/i);
    });

    it('refuses a bucket named without its location', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, status_to, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'PURCHASE_RECEIPT', 5, 5, $5, 'AVAILABLE', 'MANUAL', $6)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_ledger_bucket_complete/i);
    });

    /*
     * ⚠️ THE LAST LINE AGAINST A NEGATIVE SHELF. The service takes the balance
     *   rows FOR UPDATE and re-verifies first, so the normal outcome of losing
     *   that race is a 409. This is what happens when something skips the
     *   service — a future domain, a bug in the re-verify, an import path.
     */
    it('refuses an issue larger than the shelf holds', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO stock_ledger
               (id, organization_id, branch_id, product_id, batch_id, tracking_mode, movement_type,
                quantity_base, quantity_entered, unit_id, from_location_id, status_from, reference_type, actor_user_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'LOT_BATCH', 'DISPENSING', -1000, -1000, $5, $6, 'AVAILABLE', 'MANUAL', $7)`,
            [ORG_A, BRANCH_A, INV_PROD_A, BATCH_A, INV_UNIT, LOC_A, INV_ACTOR]
          )
        )
      ).rejects.toThrow(/stock_balances_non_negative/i);
    });

    it('refuses a cost with no currency', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, unit_cost_base, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-NOCCY', 1250, now())`,
            [ORG_A, BRANCH_A, INV_PROD_A]
          )
        )
      ).rejects.toThrow(/batches_cost_has_currency/i);
    });

    it('refuses a lot with no expiry on an expiry-controlled product', async () => {
      await owner.query(
        `UPDATE products SET tracking_mode = 'LOT_BATCH', is_expiry_controlled = true WHERE id = $1`,
        [INV_PROD_A]
      );
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO batches (id, organization_id, branch_id, product_id, lot_number, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-LOT-NOEXP', now())`,
            [ORG_A, BRANCH_A, INV_PROD_A]
          )
        )
      ).rejects.toThrow(/must carry an expiry date/i);
      await owner.query('UPDATE products SET is_expiry_controlled = false WHERE id = $1', [
        INV_PROD_A,
      ]);
    });

    it('refuses a quarantine with no reason', async () => {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query('UPDATE batches SET quarantined_at = now() WHERE id = $1', [BATCH_A])
        )
      ).rejects.toThrow(/batches_quarantine_reasoned/i);
    });
  });
});
