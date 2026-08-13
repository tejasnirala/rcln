/**
 * Tenant isolation — procurement (PI-4).
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 *
 * ── TWELVE TABLES AND TWO TENANCY CLASSES, WHICH IS THE POINT OF THIS FILE ───
 *
 *   suppliers                  ORG-WIDE. No `branch_id` at all, because a group
 *   supplier_tax_identifiers   negotiates ONE contract for every site. So a
 *   supplier_products          branch-scoped storekeeper reads all of it — which
 *                              is intended, and the case below PINS it, because
 *                              a later phase "tightening" it would break ordering
 *                              at every multi-branch clinic.
 *
 *   purchase_requisitions      BRANCH-SCOPED, absolutely. Nine tables, every one
 *   purchase_orders            with `branch_id` NOT NULL, every child carrying
 *   goods_receipts             its own copy rather than inheriting through a
 *   purchase_returns           parent predicate.
 *   …_lines (four of them)
 *   product_cost_averages
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE **CHILD** ONES. A line table is where the
 *   `appointment_status_history` trap lives: a policy expression is evaluated with
 *   row security DISABLED on the tables it references, so an EXISTS against
 *   `purchase_orders` would NOT pick up that table's branch policy and the branch
 *   half would simply not be asked. Every storekeeper in the organization would
 *   read every branch's order lines and unit costs. These children carry
 *   `organization_id` AND `branch_id` themselves for exactly that reason, and
 *   `sees nothing at a third branch` is what proves it.
 *
 * ⚠️ AND `product_cost_averages` IS THE LEAST OBVIOUS ONE. Nothing a tenant sends
 *   creates it — the receipt service upserts it — so it looks like it needs no
 *   policy. It carries a branch's unit costs, which is precisely what one site
 *   must not read off another.
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

describe('procurement', () => {
  const PROC_UNIT = 'dddddddd-1111-4111-8111-000000000001';
  const PROC_PROD_A = 'dddddddd-7777-4777-8777-0000000000a1';
  const PROC_PROD_B = 'dddddddd-7777-4777-8777-0000000000b1';
  const PROC_ACTOR = 'dddddddd-8888-4888-8888-000000000001';
  const PLOC_B1 = 'dddddddd-2222-4222-8222-0000000000b1';

  const SUP_A = 'dddddddd-3333-4333-8333-0000000000a1';
  const SUP_B = 'dddddddd-3333-4333-8333-0000000000b1';
  const TAXID_B = 'dddddddd-4444-4444-8444-0000000000b1';
  const SUPPROD_B = 'dddddddd-5555-4555-8555-0000000000b1';

  const REQ_B = 'dddddddd-6666-4666-8666-0000000000b1';
  const REQLINE_B = 'dddddddd-6667-4667-8667-0000000000b1';
  const PO_B = 'dddddddd-9999-4999-8999-0000000000b1';
  const POLINE_B = 'dddddddd-999a-499a-899a-0000000000b1';
  const GRN_B = 'dddddddd-aaaa-4aaa-8aaa-0000000000b1';
  const GRNLINE_B = 'dddddddd-aaab-4aab-8aab-0000000000b1';
  const PRN_B = 'dddddddd-bbbb-4bbb-8bbb-0000000000b1';
  const PRNLINE_B = 'dddddddd-bbbc-4bbc-8bbc-0000000000b1';
  const COST_B = 'dddddddd-cccc-4ccc-8ccc-0000000000b1';

  /** Every branch-scoped table in this phase, for the sweep cases. */
  const BRANCH_TABLES = [
    'purchase_requisitions',
    'purchase_requisition_lines',
    'purchase_orders',
    'purchase_order_lines',
    'goods_receipts',
    'goods_receipt_lines',
    'purchase_returns',
    'purchase_return_lines',
    'product_cost_averages',
  ];

  const ORG_TABLES = ['suppliers', 'supplier_tax_identifiers', 'supplier_products'];

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
       VALUES ($1, 'Proc Actor', 'proc-iso-actor@example.test', now()) ON CONFLICT DO NOTHING`,
      [PROC_ACTOR]
    );

    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'PROC_ISO_UNIT', 'Proc Iso Unit', 'piu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'CONSUMABLE', 'ACTIVE', 'PROC_ISO_PROD_A', 'Proc Iso Product A', $4, 'NONE', now()),
              ($2, $5, 'CONSUMABLE', 'ACTIVE', 'PROC_ISO_PROD_B', 'Proc Iso Product B', $4, 'NONE', now())
       ON CONFLICT DO NOTHING`,
      [PROC_PROD_A, PROC_PROD_B, ORG_A, PROC_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
       VALUES ($1, $2, $3, 'MAIN_PHARMACY', 'PROC_ISO_B1', 'Proc Iso B1', now())
       ON CONFLICT DO NOTHING`,
      [PLOC_B1, ORG_B, BRANCH_B1]
    );

    // One supplier each, so the organization boundary has something to hide in
    // both directions.
    await owner.query(
      `INSERT INTO suppliers (id, organization_id, code, name, status, default_currency, updated_at)
       VALUES ($1, $3, 'PROC_ISO_SUP_A', 'Iso Supplier A', 'ACTIVE', 'INR', now()),
              ($2, $4, 'PROC_ISO_SUP_B', 'Iso Supplier B', 'ACTIVE', 'INR', now())
       ON CONFLICT DO NOTHING`,
      [SUP_A, SUP_B, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO supplier_tax_identifiers
         (id, organization_id, supplier_id, country_code, region_code, scheme,
          registration_number, effective_from, updated_at)
       VALUES ($1, $2, $3, 'IN', 'KA', 'GST', '29ISOBBB1234F1Z5', CURRENT_DATE, now())
       ON CONFLICT DO NOTHING`,
      [TAXID_B, ORG_B, SUP_B]
    );

    await owner.query(
      `INSERT INTO supplier_products
         (id, organization_id, supplier_id, product_id, supplier_sku, pack_unit_id,
          quantity_per_pack, price_per_pack_minor, currency, price_effective_from, updated_at)
       VALUES ($1, $2, $3, $4, 'ISO-SKU-B', $5, 100, 41200, 'INR', CURRENT_DATE, now())
       ON CONFLICT DO NOTHING`,
      [SUPPROD_B, ORG_B, SUP_B, PROC_PROD_B, PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO purchase_requisitions
         (id, organization_id, branch_id, status, created_by_id, updated_at)
       VALUES ($1, $2, $3, 'DRAFT', $4, now()) ON CONFLICT DO NOTHING`,
      [REQ_B, ORG_B, BRANCH_B1, PROC_ACTOR]
    );

    await owner.query(
      `INSERT INTO purchase_requisition_lines
         (id, organization_id, branch_id, requisition_id, product_id, line_number,
          quantity_base, quantity_entered, unit_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 10, 10, $6, now()) ON CONFLICT DO NOTHING`,
      [REQLINE_B, ORG_B, BRANCH_B1, REQ_B, PROC_PROD_B, PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO purchase_orders
         (id, organization_id, branch_id, supplier_id, status, supplier_name, currency,
          created_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', 'Iso Supplier B', 'INR', $5, now())
       ON CONFLICT DO NOTHING`,
      [PO_B, ORG_B, BRANCH_B1, SUP_B, PROC_ACTOR]
    );

    await owner.query(
      `INSERT INTO purchase_order_lines
         (id, organization_id, branch_id, purchase_order_id, product_id, line_number,
          ordered_quantity_base, quantity_entered, unit_id, unit_cost_base, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 10, 10, $6, 412, now()) ON CONFLICT DO NOTHING`,
      [POLINE_B, ORG_B, BRANCH_B1, PO_B, PROC_PROD_B, PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO goods_receipts
         (id, organization_id, branch_id, supplier_id, status, supplier_name, location_id,
          currency, created_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', 'Iso Supplier B', $5, 'INR', $6, now())
       ON CONFLICT DO NOTHING`,
      [GRN_B, ORG_B, BRANCH_B1, SUP_B, PLOC_B1, PROC_ACTOR]
    );

    await owner.query(
      `INSERT INTO goods_receipt_lines
         (id, organization_id, branch_id, goods_receipt_id, product_id, line_number,
          received_quantity_base, quantity_entered, unit_id, unit_cost_base, currency, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 10, 10, $6, 412, 'INR', now()) ON CONFLICT DO NOTHING`,
      [GRNLINE_B, ORG_B, BRANCH_B1, GRN_B, PROC_PROD_B, PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO purchase_returns
         (id, organization_id, branch_id, supplier_id, status, supplier_name, reason,
          location_id, currency, created_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', 'Iso Supplier B', 'Short dated', $5, 'INR', $6, now())
       ON CONFLICT DO NOTHING`,
      [PRN_B, ORG_B, BRANCH_B1, SUP_B, PLOC_B1, PROC_ACTOR]
    );

    await owner.query(
      `INSERT INTO purchase_return_lines
         (id, organization_id, branch_id, purchase_return_id, product_id, line_number,
          quantity_base, quantity_entered, unit_id, status_from, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 5, 5, $6, 'AVAILABLE', now()) ON CONFLICT DO NOTHING`,
      [PRNLINE_B, ORG_B, BRANCH_B1, PRN_B, PROC_PROD_B, PROC_UNIT]
    );

    await owner.query(
      `INSERT INTO product_cost_averages
         (id, organization_id, branch_id, product_id, currency, valued_quantity_base,
          valued_cost_minor, receipt_count, updated_at)
       VALUES ($1, $2, $3, $4, 'INR', 100, 41200, 1, now()) ON CONFLICT DO NOTHING`,
      [COST_B, ORG_B, BRANCH_B1, PROC_PROD_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM purchase_return_lines WHERE id = $1', [PRNLINE_B]);
    await owner.query('DELETE FROM purchase_returns WHERE id = $1', [PRN_B]);
    await owner.query('DELETE FROM goods_receipt_lines WHERE id = $1', [GRNLINE_B]);
    await owner.query('DELETE FROM goods_receipts WHERE id = $1', [GRN_B]);
    await owner.query('DELETE FROM purchase_order_lines WHERE id = $1', [POLINE_B]);
    await owner.query('DELETE FROM purchase_orders WHERE id = $1', [PO_B]);
    await owner.query('DELETE FROM purchase_requisition_lines WHERE id = $1', [REQLINE_B]);
    await owner.query('DELETE FROM purchase_requisitions WHERE id = $1', [REQ_B]);
    await owner.query('DELETE FROM product_cost_averages WHERE id = $1', [COST_B]);
    await owner.query('DELETE FROM supplier_products WHERE id = $1', [SUPPROD_B]);
    await owner.query('DELETE FROM supplier_tax_identifiers WHERE id = $1', [TAXID_B]);
    await owner.query('DELETE FROM suppliers WHERE id = ANY($1)', [[SUP_A, SUP_B]]);
    await owner.query('DELETE FROM inventory_locations WHERE id = $1', [PLOC_B1]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[PROC_PROD_A, PROC_PROD_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [PROC_UNIT]);
    await owner.query('DELETE FROM users WHERE id = $1', [PROC_ACTOR]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of [...ORG_TABLES, ...BRANCH_TABLES]) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // The organization boundary
  // -------------------------------------------------------------------------

  it("hides another clinic's suppliers, tax numbers and prices", async () => {
    const seen = await asTenant(ORG_A, async () => ({
      suppliers: (await app.query('SELECT id FROM suppliers WHERE id = $1', [SUP_B])).rows.length,
      taxIds: (await app.query('SELECT id FROM supplier_tax_identifiers WHERE id = $1', [TAXID_B]))
        .rows.length,
      prices: (await app.query('SELECT id FROM supplier_products WHERE id = $1', [SUPPROD_B])).rows
        .length,
    }));

    expect(seen).toEqual({ suppliers: 0, taxIds: 0, prices: 0 });
  });

  it("hides another clinic's purchase documents and costs", async () => {
    const counts = await atBranches(ORG_A, [BRANCH_A], async () => {
      const seen: Record<string, number> = {};
      for (const table of BRANCH_TABLES) {
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table}`
        );
        seen[table] = Number(rows[0]?.count);
      }
      return seen;
    });

    for (const table of BRANCH_TABLES) expect(counts[table]).toBe(0);
  });

  /*
   * ⚠️ A CROSS-TENANT WRITE IS REFUSED BY `WITH CHECK` AND RAISES, RATHER THAN
   *   MATCHING NOTHING. That distinction is pinned on purpose across this suite: a
   *   policy that HID the row instead would report success to a caller that changed
   *   nothing, which is strictly worse than an error the service can turn into a
   *   sentence.
   */
  it("refuses to write a supplier into another clinic's organization", async () => {
    await expect(
      asTenant(ORG_A, async () =>
        app.query(
          `INSERT INTO suppliers (id, organization_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, 'PROC_ISO_FORGED', 'Forged', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to write a purchase order into another clinic's branch", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], async () =>
        app.query(
          `INSERT INTO purchase_orders
             (id, organization_id, branch_id, supplier_id, status, supplier_name, currency,
              created_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'DRAFT', 'Forged', 'INR', $4, now())`,
          [ORG_B, BRANCH_B1, SUP_B, PROC_ACTOR]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -------------------------------------------------------------------------
  // The org-wide seam: a branch-scoped reader sees the WHOLE price book
  // -------------------------------------------------------------------------

  /**
   * ⚠️ THIS CASE PINS A DELIBERATE WIDTH, NOT A LEAK, AND IT IS HERE SO A LATER
   *   PHASE CANNOT "TIGHTEN" IT BY ACCIDENT. A supplier is the ORGANIZATION's
   *   vendor: one contract, one price book, every branch. A storekeeper scoped to a
   *   single site has to be able to read it, because that is the list they order
   *   from — adding a branch predicate to these three tables would break ordering at
   *   every multi-branch clinic, and it would look like a security improvement in
   *   review. The cost is written on the `Supplier` model.
   */
  it('shows the whole organization’s price book to a single-branch reader', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => ({
      suppliers: (await app.query('SELECT id FROM suppliers WHERE id = $1', [SUP_B])).rows.length,
      prices: (await app.query('SELECT id FROM supplier_products WHERE id = $1', [SUPPROD_B])).rows
        .length,
    }));

    // BRANCH_B2 is not the branch anything above was created at, and that is the
    // point: the supplier tables carry no branch at all.
    expect(seen).toEqual({ suppliers: 1, prices: 1 });
  });

  // -------------------------------------------------------------------------
  // The branch boundary, and the child tables that could quietly miss it
  // -------------------------------------------------------------------------

  it('sees its own branch’s documents', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => ({
      requisition: (await app.query('SELECT id FROM purchase_requisitions WHERE id = $1', [REQ_B]))
        .rows.length,
      order: (await app.query('SELECT id FROM purchase_orders WHERE id = $1', [PO_B])).rows.length,
      receipt: (await app.query('SELECT id FROM goods_receipts WHERE id = $1', [GRN_B])).rows
        .length,
      ret: (await app.query('SELECT id FROM purchase_returns WHERE id = $1', [PRN_B])).rows.length,
      cost: (await app.query('SELECT id FROM product_cost_averages WHERE id = $1', [COST_B])).rows
        .length,
    }));

    expect(seen).toEqual({ requisition: 1, order: 1, receipt: 1, ret: 1, cost: 1 });
  });

  /**
   * ⚠️ THE CASE THAT MATTERS MOST IN THIS FILE. B2 is in the same ORGANIZATION as
   *   everything seeded above and is a different branch, so `tenant_isolation` passes
   *   and only `branch_isolation` stands between this reader and another site's unit
   *   costs. Every one of the four LINE tables is checked, because a child that
   *   inherited only the organization half of its parent's policy would pass every
   *   other case in this file — that is the `appointment_status_history` trap,
   *   measured there and avoided here by carrying `branch_id` on every child.
   */
  it('sees nothing at a third branch', async () => {
    const counts = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const seen: Record<string, number> = {};
      for (const table of BRANCH_TABLES) {
        const { rows } = await app.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE branch_id = $1`,
          [BRANCH_B1]
        );
        seen[table] = Number(rows[0]?.count);
      }
      return seen;
    });

    for (const table of BRANCH_TABLES) expect(counts[table]).toBe(0);
  });

  it('cannot update a document at a branch outside its scope', async () => {
    const changed = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const result = await app.query(
        `UPDATE purchase_orders SET notes = 'reached across' WHERE id = $1`,
        [PO_B]
      );
      return result.rowCount;
    });

    /*
     * ⚠️ ZERO ROWS RATHER THAN AN ERROR, AND THAT IS WHAT A RESTRICTIVE `USING`
     *   DOES: the row is not refused, it is NOT SEEN. It is the reason the services
     *   never rely on a write "failing" to enforce scope — every one of them asserts
     *   the branch is in `ctx.branchIds` first and throws NOT FOUND, so the caller
     *   gets a sentence instead of a silent success. See `assertBranchInScope`.
     */
    expect(changed).toBe(0);

    const { rows } = await owner.query<{ notes: string | null }>(
      'SELECT notes FROM purchase_orders WHERE id = $1',
      [PO_B]
    );
    expect(rows[0]?.notes).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The `*_visible` policies
  // -------------------------------------------------------------------------

  /**
   * ⚠️ WITHOUT THESE A CLINIC PUTS ANOTHER CLINIC'S PRIVATE PRODUCT ON ITS OWN
   *   DOCUMENT AND READS THE NAME BACK OUT OF THE JOIN. `product_id` cannot be a
   *   composite FK — a clinic legitimately buys a PLATFORM product, whose
   *   `organization_id` is NULL — so `tenant_isolation` constrains the row's own
   *   organization and says nothing at all about what it points AT. It is a valid
   *   insert into a table the caller is allowed to write, and nothing else in the
   *   system notices.
   */
  it("refuses another clinic's private product on its own price book", async () => {
    await expect(
      asTenant(ORG_B, async () =>
        app.query(
          `INSERT INTO supplier_products
             (id, organization_id, supplier_id, product_id, supplier_sku, pack_unit_id,
              quantity_per_pack, price_per_pack_minor, currency, price_effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'ISO-SKU-STOLEN', $4, 1, 100, 'INR',
                   CURRENT_DATE, now())`,
          [ORG_B, SUP_B, PROC_PROD_A, PROC_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses another clinic's private product on its own order line", async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B1], async () =>
        app.query(
          `INSERT INTO purchase_order_lines
             (id, organization_id, branch_id, purchase_order_id, product_id, line_number,
              ordered_quantity_base, quantity_entered, unit_id, unit_cost_base, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 99, 1, 1, $5, 100, now())`,
          [ORG_B, BRANCH_B1, PO_B, PROC_PROD_A, PROC_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses another clinic's private product on its own receipt line", async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B1], async () =>
        app.query(
          `INSERT INTO goods_receipt_lines
             (id, organization_id, branch_id, goods_receipt_id, product_id, line_number,
              received_quantity_base, quantity_entered, unit_id, unit_cost_base, currency, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 99, 1, 1, $5, 100, 'INR', now())`,
          [ORG_B, BRANCH_B1, GRN_B, PROC_PROD_A, PROC_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses another clinic's private product on its own cost average", async () => {
    await expect(
      atBranches(ORG_B, [BRANCH_B1], async () =>
        app.query(
          `INSERT INTO product_cost_averages
             (id, organization_id, branch_id, product_id, currency, valued_quantity_base,
              valued_cost_minor, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'INR', 1, 100, now())`,
          [ORG_B, BRANCH_B1, PROC_PROD_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // -------------------------------------------------------------------------
  // The composite foreign keys (ADR-0004)
  // -------------------------------------------------------------------------

  /**
   * ⚠️ WHERE A COMPOSITE FK **IS** AVAILABLE IT MAKES THE CROSS-TENANT REFERENCE
   *   UNREPRESENTABLE RATHER THAN MERELY REFUSED, AND THIS PROVES IT UNDER THE OWNER
   *   CONNECTION — which bypasses RLS entirely. A check that only held for `rcln_app`
   *   would be a policy; this one is a constraint, and it holds for migrations and
   *   support tooling too.
   */
  it('cannot point a purchase order at another clinic’s supplier, even as the owner', async () => {
    await expect(
      owner.query(
        `INSERT INTO purchase_orders
           (id, organization_id, branch_id, supplier_id, status, supplier_name, currency,
            created_by_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'DRAFT', 'Cross tenant', 'INR', $4, now())`,
        [ORG_B, BRANCH_B1, SUP_A, PROC_ACTOR]
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  /**
   * The branch-qualified form, which is the stronger one: a receipt at branch B1
   * citing a shelf at another branch is not a legal INSERT at all. Three columns
   * rather than two is what makes it unrepresentable — see the ledger's own note.
   */
  it('cannot point a goods receipt at a shelf at another branch, even as the owner', async () => {
    const OTHER_LOC = 'dddddddd-2222-4222-8222-0000000000b2';
    await owner.query(
      `INSERT INTO inventory_locations (id, organization_id, branch_id, kind, code, name, updated_at)
       VALUES ($1, $2, $3, 'REFRIGERATOR', 'PROC_ISO_B2', 'Proc Iso B2', now())
       ON CONFLICT DO NOTHING`,
      [OTHER_LOC, ORG_B, BRANCH_B2]
    );

    try {
      await expect(
        owner.query(
          `INSERT INTO goods_receipts
             (id, organization_id, branch_id, supplier_id, status, supplier_name, location_id,
              currency, created_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'DRAFT', 'Wrong branch', $4, 'INR', $5, now())`,
          [ORG_B, BRANCH_B1, SUP_B, OTHER_LOC, PROC_ACTOR]
        )
      ).rejects.toThrow(/foreign key|violates/i);
    } finally {
      await owner.query('DELETE FROM inventory_locations WHERE id = $1', [OTHER_LOC]);
    }
  });
});
