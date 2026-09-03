/**
 * Tenant isolation — online pharmacy (PI-12).
 *
 * Three tables, ONE tenancy class, which is the first time since PI-7 a phase
 * has been that uniform:
 *
 *   `online_orders`           org + branch, `branch_id` NOT NULL
 *   `online_order_lines`      org + branch, `branch_id` NOT NULL
 *   `online_order_shipments`  org + branch, `branch_id` NOT NULL
 *
 * PI-8, PI-9 and PI-10 each carried a configuration table with no branch column.
 * Nothing here is configuration: an order is fulfilled from ONE shelf, in ONE
 * jurisdiction, and the parcel leaves from that site.
 *
 * ⚠️ WHAT IS BEING PROTECTED IS THE BROADEST SINGLE-ROW DISCLOSURE IN THE
 *   PRODUCT. An order row carries a named person's HOME ADDRESS and telephone
 *   number beside the medicine going to it — which is a physical-safety fact as
 *   much as a clinical one. A missing policy produces no error, breaks no
 *   single-tenant test, and quietly answers "where does this clinic's patient
 *   live, and what are they taking".
 *
 * ⚠️ THE BRANCH HALF IS LOAD-BEARING RATHER THAN COSMETIC, exactly as it is for
 *   `recall_batches`: a member scoped to the satellite has no business reading
 *   the main site's delivery book, and `packOnlineOrder` reads the order through
 *   these policies before it moves anything.
 *
 * ⚠️ TWO plain FKs land in this phase — `online_order_lines.product_id` and
 *   `.unit_id`, both into platform-extensible tables — and they need no
 *   `*_visible` policy of their own. Both are reachable only THROUGH an order
 *   row this tenant already owns, which `tenant_isolation` decides; the same
 *   call PI-10 made about `recall_batches.batch_id`, and `dispense_lines` has
 *   the identical pair and the identical absence. A case below pins that the
 *   composite FK closes the door the `*_visible` policy would otherwise have to.
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

describe('online pharmacy', () => {
  const ON_UNIT = 'ffffffff-1111-4111-8111-000000000001';
  const ON_PROD_A = 'ffffffff-7777-4777-8777-0000000000a1';
  const ON_PROD_B = 'ffffffff-7777-4777-8777-0000000000b1';

  const ON_USER_A = 'ffffffff-8888-4888-8888-0000000000a1';
  const ON_USER_B = 'ffffffff-8888-4888-8888-0000000000b1';

  const ON_PATIENT_A = 'ffffffff-9999-4999-8999-0000000000a1';
  const ON_PATIENT_B = 'ffffffff-9999-4999-8999-0000000000b1';

  const ON_LOC_A = 'ffffffff-2222-4222-8222-0000000000a1';
  const ON_LOC_B1 = 'ffffffff-2222-4222-8222-0000000000b1';

  const ORDER_A = 'ffffffff-bbbb-4bbb-8bbb-0000000000a1';
  const ORDER_B = 'ffffffff-bbbb-4bbb-8bbb-0000000000b1';
  const LINE_B = 'ffffffff-cccc-4ccc-8ccc-0000000000b1';
  const SHIPMENT_B = 'ffffffff-dddd-4ddd-8ddd-0000000000b1';

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
       VALUES ($1, NULL, 'ON_ISO_UNIT', 'Online Iso Unit', 'oiu', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [ON_UNIT]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES ($1, $3, 'MEDICINE', 'ACTIVE', 'ON_ISO_PROD_A', 'Online Iso A', $4, 'LOT_BATCH', now()),
              ($2, $5, 'MEDICINE', 'ACTIVE', 'ON_ISO_PROD_B', 'Online Iso B', $4, 'LOT_BATCH', now())
       ON CONFLICT DO NOTHING`,
      [ON_PROD_A, ON_PROD_B, ORG_A, ON_UNIT, ORG_B]
    );

    await owner.query(
      `INSERT INTO users (id, full_name, email, updated_at)
       VALUES ($1, 'On Actor A', 'on-iso-a@example.test', now()),
              ($2, 'On Actor B', 'on-iso-b@example.test', now())
       ON CONFLICT DO NOTHING`,
      [ON_USER_A, ON_USER_B]
    );

    await owner.query(
      `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, updated_at)
       VALUES ($1, $3, 'ONISOA1', 'On', 'Iso A', now()),
              ($2, $4, 'ONISOB1', 'On', 'Iso B', now())
       ON CONFLICT DO NOTHING`,
      [ON_PATIENT_A, ON_PATIENT_B, ORG_A, ORG_B]
    );

    await owner.query(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, is_dispensing_point, updated_at)
       VALUES ($1, $3, $4, 'MAIN_PHARMACY', 'ON_ISO_A', 'Online Iso A', true, now()),
              ($2, $5, $6, 'MAIN_PHARMACY', 'ON_ISO_B1', 'Online Iso B1', true, now())
       ON CONFLICT DO NOTHING`,
      [ON_LOC_A, ON_LOC_B1, ORG_A, BRANCH_A, ORG_B, BRANCH_B1]
    );

    await owner.query(
      `INSERT INTO online_orders
         (id, organization_id, branch_id, channel, status, patient_id, location_id,
          recipient_name, recipient_phone, address_line1, city, state, pincode,
          destination_country_code, destination_region_code, placed_by_id, updated_at)
       VALUES ($1, $2, $3, 'PHONE', 'DRAFT', $4, $5,
               'A Recipient', '+919800000011', '1 A Lane', 'Bengaluru', 'Karnataka', '560001',
               'IN', 'KA', $6, now()),
              ($7, $8, $9, 'PHONE', 'DRAFT', $10, $11,
               'B Recipient', '+919800000022', '2 B Lane', 'Bengaluru', 'Karnataka', '560002',
               'IN', 'KA', $12, now())
       ON CONFLICT DO NOTHING`,
      [
        ORDER_A,
        ORG_A,
        BRANCH_A,
        ON_PATIENT_A,
        ON_LOC_A,
        ON_USER_A,
        ORDER_B,
        ORG_B,
        BRANCH_B1,
        ON_PATIENT_B,
        ON_LOC_B1,
        ON_USER_B,
      ]
    );

    await owner.query(
      `INSERT INTO online_order_lines
         (id, organization_id, branch_id, online_order_id, line_number, product_id,
          quantity_entered, unit_id, quantity_base, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, 5, $6, 5, now())
       ON CONFLICT DO NOTHING`,
      [LINE_B, ORG_B, BRANCH_B1, ORDER_B, ON_PROD_B, ON_UNIT]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM online_order_shipments WHERE id = $1', [SHIPMENT_B]);
    await owner.query('DELETE FROM online_order_lines WHERE id = $1', [LINE_B]);
    await owner.query('DELETE FROM online_orders WHERE id = ANY($1)', [[ORDER_A, ORDER_B]]);
    await owner.query('DELETE FROM inventory_locations WHERE id = ANY($1)', [
      [ON_LOC_A, ON_LOC_B1],
    ]);
    await owner.query('DELETE FROM patients WHERE id = ANY($1)', [[ON_PATIENT_A, ON_PATIENT_B]]);
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [[ON_PROD_A, ON_PROD_B]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[ON_USER_A, ON_USER_B]]);
    await owner.query('DELETE FROM units_of_measure WHERE id = $1', [ON_UNIT]);
  });

  it('fails closed with no tenant context', async () => {
    for (const table of ['online_orders', 'online_order_lines', 'online_order_shipments']) {
      const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count)).toBe(0);
    }
  });

  // -- the organization boundary ---------------------------------------------

  /**
   * ⚠️ THE ROW BEING PROTECTED IS AN ADDRESS. Everything else in this suite
   *   protects what a clinic knows about somebody's health; this protects where
   *   they live, beside what they are taking.
   */
  it("shows one clinic nothing of another's deliveries", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM online_orders WHERE id = $1', [ORDER_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it("shows one clinic nothing of what is on another's order", async () => {
    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM online_order_lines WHERE id = $1', [LINE_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  /**
   * ⚠️ THE THIRD TABLE HAD NO CROSS-TENANT CASE AT ALL, AND IT IS THE ONE THAT
   *   NAMES A PERSON. Every shipment assertion in this file runs as `owner` —
   *   which BYPASSES RLS — and checks a CHECK constraint. So `online_orders` and
   *   `online_order_lines` were each proved isolated and `online_order_shipments`
   *   was proved only to reject a malformed row. It carries `received_by_name`
   *   and the tracking reference, and its `branch_id` is denormalised off the
   *   parent, so it is where a `branch_isolation` regression would surface
   *   first. (PI-24 security review.)
   */
  it("shows one clinic nothing of another's shipments", async () => {
    await owner.query(
      `INSERT INTO online_order_shipments
         (id, organization_id, branch_id, online_order_id, carrier_name, package_count,
          shipped_at, shipped_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'Iso Courier', 1, now(), $5, now())
       ON CONFLICT DO NOTHING`,
      [SHIPMENT_B, ORG_B, BRANCH_B1, ORDER_B, ON_USER_B]
    );

    const seen = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query('SELECT id FROM online_order_shipments WHERE id = $1', [
        SHIPMENT_B,
      ]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('refuses to write a shipment into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO online_order_shipments
             (id, organization_id, branch_id, online_order_id, carrier_name, package_count,
              shipped_at, shipped_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'Smuggled Courier', 1, now(), $4, now())`,
          [ORG_B, BRANCH_B1, ORDER_B, ON_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to write an order into another clinic', async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO online_orders
             (id, organization_id, branch_id, channel, status, patient_id, location_id,
              recipient_name, recipient_phone, address_line1, destination_country_code,
              placed_by_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'WEB', 'DRAFT', $3, $4,
                   'Smuggled', '+919800000099', 'Nowhere', 'IN', $5, now())`,
          [ORG_B, BRANCH_B1, ON_PATIENT_B, ON_LOC_B1, ON_USER_A]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * ⚠️ THE COMPOSITE FK IS WHAT CLOSES THIS, NOT A POLICY, which is why the two
   *   plain FKs on the line need no `*_visible` policy of their own. A line
   *   citing another clinic's order is unrepresentable: `(organization_id,
   *   online_order_id)` has nowhere to point.
   */
  it("refuses to hang a line off another clinic's order", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO online_order_lines
             (id, organization_id, branch_id, online_order_id, line_number, product_id,
              quantity_entered, unit_id, quantity_base, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 9, $4, 1, $5, 1, now())`,
          [ORG_A, BRANCH_A, ORDER_B, ON_PROD_A, ON_UNIT]
        )
      )
    ).rejects.toThrow();
  });

  // -- the `*_visible` policies (KI-3) ---------------------------------------

  /**
   * ⚠️ THE HOLE `db:rls:check` CANNOT SEE, AND THE ONE THIS PHASE SHIPPED WITH
   *   UNTIL THE SECURITY REVIEW. `tenant_isolation` is satisfied — the LINE
   *   being written is ORG_A's — and only the RESTRICTIVE `product_visible`
   *   policy stops ORG_A attaching ORG_B's PRIVATE product to its own order and
   *   reading the name back through the join the order screen makes.
   *
   *   `online_order_lines.product_id` cannot be a composite FK, because a clinic
   *   legitimately orders a PLATFORM product whose `organization_id` is NULL.
   *   That is precisely what makes the policy the only thing here, and it is why
   *   this class has now produced a CRITICAL in five separate phases.
   */
  it("refuses a line citing another clinic's private product", async () => {
    await expect(
      atBranches(ORG_A, [BRANCH_A], () =>
        app.query(
          `INSERT INTO online_order_lines
             (id, organization_id, branch_id, online_order_id, line_number, product_id,
              quantity_entered, unit_id, quantity_base, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 5, $4, 1, $5, 1, now())`,
          [ORG_A, BRANCH_A, ORDER_A, ON_PROD_B, ON_UNIT]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  /** And a PLATFORM product is fine, which is what the policy's NULL half is for. */
  it('permits a line citing a platform product', async () => {
    const platformProduct = await owner.query<{ id: string }>(
      `SELECT id FROM products WHERE organization_id IS NULL LIMIT 1`
    );
    const productId = platformProduct.rows[0]?.id;
    if (!productId) return;

    const written = await atBranches(ORG_A, [BRANCH_A], async () => {
      const { rows } = await app.query<{ id: string }>(
        `INSERT INTO online_order_lines
           (id, organization_id, branch_id, online_order_id, line_number, product_id,
            quantity_entered, unit_id, quantity_base, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 6, $4, 1, $5, 1, now())
         RETURNING id`,
        [ORG_A, BRANCH_A, ORDER_A, productId, ON_UNIT]
      );
      return rows[0]?.id ?? '';
    });

    expect(written).not.toBe('');
    await owner.query('DELETE FROM online_order_lines WHERE id = $1', [written]);
  });

  /**
   * ⚠️ THE SECOND PLAIN FK, AND THE WEAKER OF THE TWO. `unit_id` is never
   *   resolved by the service at all — it is handed straight to `toBaseUnits` —
   *   so the policy is the ONLY thing standing between a clinic and another
   *   clinic's private unit of measure on its own order line.
   */
  it("refuses a line counted in another clinic's private unit", async () => {
    const privateUnit = 'ffffffff-1111-4111-8111-0000000000b1';
    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, $2, 'ON_ISO_UNIT_B', 'Online Iso Unit B', 'oib', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [privateUnit, ORG_B]
    );

    try {
      await expect(
        atBranches(ORG_A, [BRANCH_A], () =>
          app.query(
            `INSERT INTO online_order_lines
               (id, organization_id, branch_id, online_order_id, line_number, product_id,
                quantity_entered, unit_id, quantity_base, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 7, $4, 1, $5, 1, now())`,
            [ORG_A, BRANCH_A, ORDER_A, ON_PROD_A, privateUnit]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await owner.query('DELETE FROM units_of_measure WHERE id = $1', [privateUnit]);
    }
  });

  // -- the branch boundary ---------------------------------------------------

  /**
   * ⚠️ BOTH BRANCHES BELONG TO ORG_B, so the organization policy passes and only
   *   the RESTRICTIVE branch policy stands between B2 and the delivery book at
   *   B1. A permissive-instead-of-restrictive policy here would OR with tenant
   *   isolation and open every site's addresses to every other site.
   */
  it('shows a sibling branch nothing of an order at the other site', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B2], async () => {
      const { rows } = await app.query('SELECT id FROM online_orders WHERE id = $1', [ORDER_B]);
      return rows.length;
    });
    expect(seen).toBe(0);
  });

  it('lets the branch that is fulfilling it see it', async () => {
    const seen = await atBranches(ORG_B, [BRANCH_B1], async () => {
      const { rows } = await app.query('SELECT id FROM online_orders WHERE id = $1', [ORDER_B]);
      return rows.length;
    });
    expect(seen).toBe(1);
  });

  // -- the CHECK constraints -------------------------------------------------

  /**
   * ⚠️ THE STATE MACHINE, FROM THE SIDE THE SERVICE CANNOT REACH. Every case
   *   below is a row a fixture, a backfill or a second writer could produce and
   *   the service never would — which is the set a CHECK exists to catch, and
   *   the set PI-11's own new constraint got wrong in exactly this way.
   */
  it('refuses a draft that already carries a number', async () => {
    await expect(
      owner.query(`UPDATE online_orders SET order_number = 'ORD-ISO-1' WHERE id = $1`, [ORDER_A])
    ).rejects.toThrow(/online_orders_status_is_consistent/i);
  });

  it('refuses an accepted order with nobody who accepted it', async () => {
    await expect(
      owner.query(
        `UPDATE online_orders SET status = 'CONFIRMED', order_number = 'ORD-ISO-2',
                confirmed_at = now() WHERE id = $1`,
        [ORDER_A]
      )
    ).rejects.toThrow(/online_orders_acts_are_attributed/i);
  });

  it('refuses a packed order with no dispense behind it', async () => {
    await expect(
      owner.query(
        `UPDATE online_orders SET status = 'PACKED', order_number = 'ORD-ISO-3',
                confirmed_at = now(), confirmed_by_id = $2,
                packed_at = now(), packed_by_id = $2 WHERE id = $1`,
        [ORDER_A, ON_USER_A]
      )
    ).rejects.toThrow(/online_orders_status_is_consistent/i);
  });

  it('refuses a cancellation with no reason', async () => {
    await expect(
      owner.query(
        `UPDATE online_orders SET status = 'CANCELLED', cancelled_at = now(),
                cancelled_by_id = $2 WHERE id = $1`,
        [ORDER_A, ON_USER_A]
      )
    ).rejects.toThrow(/online_orders_status_is_consistent/i);
  });

  /**
   * ⚠️ `IN-KA` IN THE REGION COLUMN WOULD RENDER AS `IN-IN-KA` AND MISS EVERY
   *   REGIONAL RULE SILENTLY. The failure mode every region column in this schema
   *   shares, and this is the one a client supplies directly.
   */
  it('refuses a region code with the country prefix on it', async () => {
    await expect(
      owner.query(`UPDATE online_orders SET destination_region_code = 'IN-KA' WHERE id = $1`, [
        ORDER_A,
      ])
    ).rejects.toThrow(/online_orders_destination_is_a_jurisdiction/i);
  });

  it('refuses the same product on two lines of one order', async () => {
    await expect(
      owner.query(
        `INSERT INTO online_order_lines
           (id, organization_id, branch_id, online_order_id, line_number, product_id,
            quantity_entered, unit_id, quantity_base, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 2, $4, 3, $5, 3, now())`,
        [ORG_B, BRANCH_B1, ORDER_B, ON_PROD_B, ON_UNIT]
      )
    ).rejects.toThrow(/online_order_id_product/i);
  });

  it('refuses a line with nothing on it', async () => {
    await expect(
      owner.query(`UPDATE online_order_lines SET quantity_base = 0 WHERE id = $1`, [LINE_B])
    ).rejects.toThrow(/online_order_lines_quantities_positive/i);
  });

  it('refuses a failed delivery with no reason', async () => {
    await owner.query(
      `INSERT INTO online_order_shipments
         (id, organization_id, branch_id, online_order_id, carrier_name, package_count,
          shipped_at, shipped_by_id, updated_at)
       VALUES ($1, $2, $3, $4, 'Iso Courier', 1, now(), $5, now())
       ON CONFLICT DO NOTHING`,
      [SHIPMENT_B, ORG_B, BRANCH_B1, ORDER_B, ON_USER_B]
    );

    await expect(
      owner.query(
        `UPDATE online_order_shipments SET failed_at = now(), failed_by_id = $2 WHERE id = $1`,
        [SHIPMENT_B, ON_USER_B]
      )
    ).rejects.toThrow(/online_order_shipments_outcomes_are_attributed/i);
  });

  /**
   * ⚠️ A FAILED ATTEMPT FOLLOWED BY A DELIVERY IS THE ORDINARY CASE AND IS
   *   ACCEPTED. What is refused is the impossible ORDER — arriving before failing
   *   to — because that is a mistyped date rather than a courier's Tuesday.
   */
  it('accepts a delivery that follows a failed attempt', async () => {
    await owner.query(
      `UPDATE online_order_shipments
          SET failed_at = now() - interval '1 day', failed_by_id = $2,
              failure_reason = 'Nobody in.'
        WHERE id = $1`,
      [SHIPMENT_B, ON_USER_B]
    );

    await expect(
      owner.query(
        `UPDATE online_order_shipments SET delivered_at = now(), delivered_by_id = $2
          WHERE id = $1`,
        [SHIPMENT_B, ON_USER_B]
      )
    ).resolves.toBeDefined();
  });

  it('refuses a delivery dated before the attempt it follows', async () => {
    await expect(
      owner.query(
        `UPDATE online_order_shipments
            SET delivered_at = now() - interval '2 days', delivered_by_id = $2
          WHERE id = $1`,
        [SHIPMENT_B, ON_USER_B]
      )
    ).rejects.toThrow(/online_order_shipments_outcomes_are_ordered/i);
  });

  it('refuses a second consignment for one order', async () => {
    await expect(
      owner.query(
        `INSERT INTO online_order_shipments
           (id, organization_id, branch_id, online_order_id, carrier_name, package_count,
            shipped_at, shipped_by_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'Second Courier', 1, now(), $4, now())`,
        [ORG_B, BRANCH_B1, ORDER_B, ON_USER_B]
      )
    ).rejects.toThrow(/online_order_id/i);
  });
});
