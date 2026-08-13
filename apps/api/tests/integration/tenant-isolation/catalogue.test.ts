/**
 * Tenant isolation — catalogue.
 *
 * The product catalogue (PI-1) — thirteen tables and eleven RESTRICTIVE
 * `*_visible` policies.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import { ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

/**
 * The product catalogue (PI-1). Thirteen tables, all PLATFORM CATALOGUE + TENANT
 * EXTENSION, and the two failure modes that class has.
 *
 *   1. The policy is READ-PERMISSIVE and WRITE-STRICT, which is NOT the policy on
 *      `files`. Copying that one would let any clinic insert a row with
 *      organization_id NULL — a product instantly visible to every other tenant
 *      on the platform, written by anyone holding `product.definition.manage`.
 *      Nothing else in the system would notice: it is a valid insert into a
 *      table the caller is allowed to write. That case is measured below.
 *
 *   2. ⚠️ THE ELEVEN RESTRICTIVE `*_visible` POLICIES. Every foreign key from a
 *      product into a master is a PLAIN key — it cannot be composite, because
 *      the target may be a platform row with no organization_id to compose with.
 *      `tenant_isolation` therefore constrains the row's OWN organization_id and
 *      says nothing whatsoever about what it POINTS AT. Without these policies a
 *      clinic attaches another clinic's private category, ingredient,
 *      composition or unit to its own product and reads the name back out
 *      through the join. This is the single most likely security regression in
 *      PI-1, and every one of the eleven is exercised here.
 *
 * The CHILDREN are a different shape and are covered too: they reach their
 * parent through a COMPOSITE FK on `(organization_id, product_id)`, which is
 * what makes it impossible for a tenant to bolt its own packaging onto a
 * platform product.
 */
describe('the product catalogue', () => {
  const UNIT_PLATFORM = 'eeeeeeee-1111-4111-8111-000000000001';
  const UNIT_PRIVATE_B = 'eeeeeeee-1111-4111-8111-0000000000b1';
  const CAT_PLATFORM = 'eeeeeeee-2222-4222-8222-000000000001';
  const CAT_PRIVATE_B = 'eeeeeeee-2222-4222-8222-0000000000b1';
  const MFR_PRIVATE_B = 'eeeeeeee-3333-4333-8333-0000000000b1';
  const ING_PRIVATE_B = 'eeeeeeee-4444-4444-8444-0000000000b1';
  const COMP_PRIVATE_B = 'eeeeeeee-5555-4555-8555-0000000000b1';
  const STORE_PRIVATE_B = 'eeeeeeee-6666-4666-8666-0000000000b1';
  const PRODUCT_PLATFORM = 'eeeeeeee-7777-4777-8777-000000000001';
  const PRODUCT_A = 'eeeeeeee-7777-4777-8777-0000000000a1';
  const PRODUCT_B = 'eeeeeeee-7777-4777-8777-0000000000b1';
  const COMP_A = 'eeeeeeee-5555-4555-8555-0000000000a1';

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES ($1, NULL, 'ISO_PLATFORM_UNIT', 'Iso Platform Unit', 'ipu', 'COUNT', now()),
              ($2, $3,   'ISO_PRIVATE_UNIT_B', 'Iso Private Unit B', 'ipb', 'COUNT', now())
       ON CONFLICT DO NOTHING`,
      [UNIT_PLATFORM, UNIT_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
       VALUES ($1, NULL, 'ISO_PLATFORM_CAT', 'Iso Platform Category', now()),
              ($2, $3,   'ISO_PRIVATE_CAT_B', 'Iso Private Category B', now())
       ON CONFLICT DO NOTHING`,
      [CAT_PLATFORM, CAT_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_MFR_B', 'Iso Private Manufacturer B', now())
       ON CONFLICT DO NOTHING`,
      [MFR_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_ING_B', 'Iso Private Ingredient B', now())
       ON CONFLICT DO NOTHING`,
      [ING_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO compositions (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_COMP_B', 'Iso Private Composition B', now()),
              ($3, $4, 'ISO_COMP_A',         'Iso Composition A',         now())
       ON CONFLICT DO NOTHING`,
      [COMP_PRIVATE_B, ORG_B, COMP_A, ORG_A]
    );

    await owner.query(
      `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
       VALUES ($1, $2, 'ISO_PRIVATE_STORE_B', 'Iso Private Storage B', now())
       ON CONFLICT DO NOTHING`,
      [STORE_PRIVATE_B, ORG_B]
    );

    await owner.query(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
       VALUES ($1, NULL, 'CONSUMABLE', 'ACTIVE', 'ISO_PLATFORM_PROD', 'Iso Platform Product', $4, now()),
              ($2, $5,   'CONSUMABLE', 'ACTIVE', 'ISO_PROD_A',        'Iso Product A',        $4, now()),
              ($3, $6,   'CONSUMABLE', 'ACTIVE', 'ISO_PROD_B',        'Iso Product B',        $4, now())
       ON CONFLICT DO NOTHING`,
      [PRODUCT_PLATFORM, PRODUCT_A, PRODUCT_B, UNIT_PLATFORM, ORG_A, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM products WHERE id = ANY($1)', [
      [PRODUCT_PLATFORM, PRODUCT_A, PRODUCT_B],
    ]);
    await owner.query('DELETE FROM compositions WHERE id = ANY($1)', [[COMP_PRIVATE_B, COMP_A]]);
    await owner.query('DELETE FROM storage_requirement_profiles WHERE id = $1', [STORE_PRIVATE_B]);
    await owner.query('DELETE FROM active_ingredients WHERE id = $1', [ING_PRIVATE_B]);
    await owner.query('DELETE FROM manufacturers WHERE id = $1', [MFR_PRIVATE_B]);
    await owner.query('DELETE FROM product_categories WHERE id = ANY($1)', [
      [CAT_PLATFORM, CAT_PRIVATE_B],
    ]);
    await owner.query('DELETE FROM units_of_measure WHERE id = ANY($1)', [
      [UNIT_PLATFORM, UNIT_PRIVATE_B],
    ]);
  });

  it('fails closed with no tenant context', async () => {
    const { rows } = await app.query<{ count: string }>(
      'SELECT count(*) AS count FROM products WHERE organization_id IS NOT NULL'
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  describe('the platform catalogue', () => {
    it('lets every tenant read the platform rows', async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT id FROM products WHERE code = 'ISO_PLATFORM_PROD'`
        );
        return rows.length;
      });
      expect(forA).toBe(1);
    });

    it("hides one tenant's private product from another", async () => {
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(`SELECT id FROM products WHERE code = 'ISO_PROD_B'`);
        return rows.length;
      });
      expect(forA).toBe(0);
    });

    it('cannot read another tenant’s product even when its id is known', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM products WHERE id = $1', [PRODUCT_B]);
        return rows.length;
      });
      expect(found).toBe(0);
    });

    /*
     * THE case for this tenancy class. A permissive WITH CHECK — the one `files`
     * uses — would let this succeed, and the row would be visible to every
     * tenant on the platform.
     */
    it('refuses a tenant writing a PLATFORM-WIDE product', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
             VALUES (gen_random_uuid(), NULL, 'CONSUMABLE', 'ACTIVE', 'SNEAKY_PROD', 'Sneaky', $1, now())`,
            [UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('refuses a tenant writing a platform-wide unit, category or composition', async () => {
      for (const statement of [
        `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_UNIT', 'Sneaky', 'sn', 'COUNT', now())`,
        `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_CAT', 'Sneaky', now())`,
        `INSERT INTO compositions (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_COMP', 'Sneaky', now())`,
        `INSERT INTO manufacturers (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_MFR', 'Sneaky', now())`,
        `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_ING', 'Sneaky', now())`,
        `INSERT INTO storage_requirement_profiles (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), NULL, 'SNEAKY_STORE', 'Sneaky', now())`,
      ]) {
        await expect(asTenant(ORG_A, () => app.query(statement))).rejects.toThrow(
          /row-level security/i
        );
      }
    });

    it('allows a tenant writing its own product', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'ISO_OWN_A', 'Iso Own A', $2, now())`,
          [ORG_A, UNIT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM products WHERE code = 'ISO_OWN_A'`);
    });

    it('refuses a tenant EDITING a platform product', async () => {
      /*
       * The permissive USING clause makes the row VISIBLE, so the UPDATE finds
       * it — and then fails the WITH CHECK, which is evaluated against the row
       * as it would be after the write. A platform row's organization_id stays
       * NULL. This is the intuitive-but-wrong reading the service header warns
       * about, measured.
       */
      /*
       * ⚠️ IT RAISES, IT DOES NOT SILENTLY UPDATE ZERO ROWS — and the difference
       *   matters. A no-op would let a clinic press Save on a platform product
       *   and be told it worked. The refusal is an error the service turns into
       *   a sentence, which is why `assertMutable` exists as the friendlier
       *   first layer rather than as the only one. Keeping this property is why
       *   `platform_rows_immutable` is a TRIGGER and not a RESTRICTIVE policy —
       *   a RESTRICTIVE USING would have made exactly this statement a silent
       *   zero-row success.
       *
       *   That trigger is also what raises here now, since it runs before the
       *   policy. WITH CHECK would refuse this on its own and still does if the
       *   trigger goes away.
       */
      await expect(
        asTenant(ORG_A, () =>
          app.query(`UPDATE products SET name = 'Hijacked' WHERE id = $1`, [PRODUCT_PLATFORM])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ name: string }>(
        'SELECT name FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(rows[0]?.name).toBe('Iso Platform Product');
    });

    /*
     * The two things WITH CHECK does not cover, both closed by the
     * `platform_rows_immutable` trigger rather than by the policy.
     *
     * ⚠️ THE TEST ABOVE PASSED BEFORE THAT TRIGGER EXISTED AND THESE TWO DID
     *   NOT, WHICH IS THE WHOLE POINT. `SET name` leaves organization_id NULL,
     *   so WITH CHECK catches it and the policy looks like it covers editing.
     *   It covers editing the row's CONTENT. It does not cover editing its
     *   OWNER, and it does not cover DELETE at all — Postgres evaluates no WITH
     *   CHECK on a statement with no new row. Both cases below passed cleanly
     *   under the policy alone.
     */
    it('refuses a tenant CAPTURING a platform product by rewriting its owner', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(`UPDATE products SET organization_id = $1 WHERE id = $2`, [
            ORG_A,
            PRODUCT_PLATFORM,
          ])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ organization_id: string | null }>(
        'SELECT organization_id FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(rows[0]?.organization_id).toBeNull();
    });

    it('refuses a tenant DELETING the platform catalogue', async () => {
      await expect(
        asTenant(ORG_A, () => app.query('DELETE FROM products WHERE organization_id IS NULL'))
      ).rejects.toThrow(/not writable by a tenant/i);

      /* And the same for a master, not just a product. */
      await expect(
        asTenant(ORG_A, () =>
          app.query('DELETE FROM units_of_measure WHERE id = $1', [UNIT_PLATFORM])
        )
      ).rejects.toThrow(/not writable by a tenant/i);

      const { rows } = await owner.query<{ count: string }>(
        'SELECT count(*) AS count FROM products WHERE id = $1',
        [PRODUCT_PLATFORM]
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('still lets a tenant edit and delete its OWN row', async () => {
      /*
       * The trigger fires on every UPDATE and DELETE on these tables, so the
       * ordinary path has to be measured too — a guard that also blocks the
       * legitimate case is a guard that gets deleted in a hurry six months from
       * now, by someone who will not put it back correctly.
       */
      const updated = await asTenant(ORG_A, async () => {
        const res = await app.query(`UPDATE products SET name = $1 WHERE id = $2`, [
          'Iso Product A Renamed',
          PRODUCT_A,
        ]);
        return res.rowCount;
      });
      expect(updated).toBe(1);

      await asTenant(ORG_A, () =>
        app.query(`UPDATE products SET name = 'Iso Product A' WHERE id = $1`, [PRODUCT_A])
      );

      const scratch = 'eeeeeeee-7777-4777-8777-0000000000a9';
      await owner.query(
        `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
         VALUES ($1, $2, 'CONSUMABLE', 'ACTIVE', 'ISO_PROD_A_SCRATCH', 'Scratch', $3, now())`,
        [scratch, ORG_A, UNIT_PLATFORM]
      );
      const deleted = await asTenant(ORG_A, async () => {
        const res = await app.query('DELETE FROM products WHERE id = $1', [scratch]);
        return res.rowCount;
      });
      expect(deleted).toBe(1);
    });
  });

  /**
   * The eleven RESTRICTIVE policies, one case each for the refusal and a
   * representative case for the permission.
   *
   * ⚠️ EVERY `updated_at` IS SUPPLIED EVEN THOUGH THESE INSERTS ARE MEANT TO
   *   FAIL. Without it the statement can also fail on the NOT NULL constraint,
   *   and a test asserting /row-level security/ that passes for a different
   *   reason is a test that keeps passing after the policy is dropped.
   */
  describe('the RESTRICTIVE visibility policies', () => {
    it("refuses attaching another tenant's private category to your own product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, category_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_CAT', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, CAT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private manufacturer", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, manufacturer_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_MFR', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, MFR_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private composition", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, composition_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'MEDICINE', 'DRAFT', 'SNEAK_COMP', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, COMP_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses attaching another tenant's private storage profile", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, storage_profile_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_STORE', 'Sneak', $2, $3, now())`,
            [ORG_A, UNIT_PLATFORM, STORE_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses denominating a product in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'SNEAK_UNIT', 'Sneak', $2, now())`,
            [ORG_A, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    /*
     * ⚠️ THE CATEGORY SELF-PARENT IS AN ACCEPTED GAP, AND THIS TEST RECORDS THAT
     *   RATHER THAN A PROTECTION. A `parent_visible` policy was written for it
     *   and removed: `parent_id` points at the same table, a policy may not read
     *   its own table, and the resulting recursion propagated through
     *   `category_visible` to every read of `products`. See the
     *   `drop_category_parent_visible` migration.
     *
     *   So the write SUCCEEDS, and what actually protects the tenant is that the
     *   parent stays invisible: the row can be created, and the category's name
     *   can never be read back. That is asserted below, because it is the part
     *   that must not regress. `specialties` has carried the identical gap since
     *   it shipped.
     */
    it('permits parenting under an invisible category, but never discloses it', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_categories (id, organization_id, parent_id, code, name, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ISO_ORPHAN_A', 'Iso Orphan A', now())`,
          [ORG_A, CAT_PRIVATE_B]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      // The protection that matters: the parent's NAME is unreadable.
      const leaked = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT p.name
             FROM product_categories c
             JOIN product_categories p ON p.id = c.parent_id
            WHERE c.code = 'ISO_ORPHAN_A'`
        );
        return rows.length;
      });
      expect(leaked).toBe(0);

      await owner.query(`DELETE FROM product_categories WHERE code = 'ISO_ORPHAN_A'`);
    });

    it("refuses putting another tenant's private ingredient into your composition", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
            [ORG_A, COMP_A, ING_PRIVATE_B, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses expressing a strength in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
            [ORG_A, COMP_A, ING_PRIVATE_B, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("refuses packaging a product in another tenant's private unit", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings
               (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 1, $3, 10, now())`,
            [ORG_A, PRODUCT_A, UNIT_PRIVATE_B]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it('allows attaching a PLATFORM category and unit', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, category_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'DRAFT', 'ISO_OK_A', 'Iso OK A', $2, $3, now())`,
          [ORG_A, UNIT_PLATFORM, CAT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);
      await owner.query(`DELETE FROM products WHERE code = 'ISO_OK_A'`);
    });
  });

  /**
   * The children reach their parent through a COMPOSITE FK on
   * `(organization_id, product_id)`, which does three jobs at once — and the one
   * worth measuring is that a tenant cannot bolt its own packaging, identifier
   * or tax classification onto a PLATFORM product. A clinic customises a shared
   * product by cloning it, and this is what makes that the only path.
   */
  describe('children of a platform-extensible parent', () => {
    it("refuses attaching a tenant's packaging to a PLATFORM product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings
               (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 1, $3, 10, now())`,
            [ORG_A, PRODUCT_PLATFORM, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses attaching a child to ANOTHER TENANT's product", async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_identifiers
               (id, organization_id, product_id, type, value, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'GTIN', '05012345678900', now())`,
            [ORG_A, PRODUCT_B]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('allows a child on your own product, and hides it from the other tenant', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_identifiers
             (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'ISO-GTIN-A', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT id FROM product_identifiers WHERE value = 'ISO-GTIN-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      await owner.query(`DELETE FROM product_identifiers WHERE value = 'ISO-GTIN-A'`);
    });

    it('lets BOTH tenants hold the same GTIN, because a GTIN is not globally unique', async () => {
      /*
       * ⚠️ A BARE `@@unique([value])` WOULD BREAK THIS, AND IT WOULD LOOK
       *   CORRECT. Repackagers reuse GTINs and two countries assign one national
       *   code to different medicines, so uniqueness is qualified by tenant,
       *   type and country. A global unique would make a legitimate catalogue
       *   unimportable while asserting something untrue.
       */
      await asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO product_identifiers (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'SHARED-GTIN', now())`,
          [ORG_A, PRODUCT_A]
        )
      );
      const insertedForB = await asTenant(ORG_B, async () => {
        const res = await app.query(
          `INSERT INTO product_identifiers (id, organization_id, product_id, type, value, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'SHARED-GTIN', now())`,
          [ORG_B, PRODUCT_B]
        );
        return res.rowCount;
      });
      expect(insertedForB).toBe(1);

      await owner.query(`DELETE FROM product_identifiers WHERE value = 'SHARED-GTIN'`);
    });

    /*
     * ⚠️ THE THREE CHILDREN BELOW WERE THE ONES WITHOUT A CROSS-TENANT CASE.
     *   `product_identifiers` and `product_packagings` were covered above;
     *   `medicine_details` had no case at all, and `composition_ingredients` and
     *   `product_tax_classifications` appeared only in the CHECK-constraint
     *   block, which exercises the constraint and not the policy. A child whose
     *   isolation is never measured is exactly the row that carries the leak:
     *   these hold the dosage form, the strength and the tax category — the
     *   substance of the catalogue — while the parent holds little more than a
     *   name. Covered as a set so PI-2's children inherit the shape.
     */
    it('hides a medicine detail from the other tenant, and refuses one on their product', async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO medicine_details
             (id, organization_id, product_id, dosage_form, label_instructions, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'TABLET', 'ISO-MED-A', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT id FROM medicine_details WHERE label_instructions = 'ISO-MED-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      /* And B cannot write one onto A's product — the composite FK refuses. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO medicine_details
               (id, organization_id, product_id, dosage_form, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'CAPSULE', now())`,
            [ORG_B, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      /* Nor onto the PLATFORM product, which is the "clone, don't edit" rule. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO medicine_details
               (id, organization_id, product_id, dosage_form, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'CAPSULE', now())`,
            [ORG_B, PRODUCT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query(`DELETE FROM medicine_details WHERE label_instructions = 'ISO-MED-A'`);
    });

    it("hides a composition's ingredients from the other tenant", async () => {
      const ingredientA = await owner.query<{ id: string }>(
        `INSERT INTO active_ingredients (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'ISO_ING_A', 'Iso Ingredient A', now())
         RETURNING id`,
        [ORG_A]
      );
      const ingredientAId = ingredientA.rows[0]?.id;
      expect(ingredientAId).toBeDefined();

      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO composition_ingredients
             (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 500, $4, now())`,
          [ORG_A, COMP_A, ingredientAId, UNIT_PLATFORM]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT strength FROM composition_ingredients WHERE composition_id = $1`,
          [COMP_A]
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      /* B cannot add an ingredient to A's composition either. */
      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO composition_ingredients
               (id, organization_id, composition_id, ingredient_id, strength, strength_unit_id, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 250, $4, now())`,
            [ORG_B, COMP_A, ING_PRIVATE_B, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query('DELETE FROM composition_ingredients WHERE composition_id = $1', [COMP_A]);
      await owner.query('DELETE FROM active_ingredients WHERE id = $1', [ingredientAId]);
    });

    it("hides a product's tax classification from the other tenant", async () => {
      const inserted = await asTenant(ORG_A, async () => {
        const res = await app.query(
          `INSERT INTO product_tax_classifications
             (id, organization_id, product_id, country_code, tax_category, item_code,
              effective_from, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_12', 'ISO-HSN-A', '2026-01-01', now())`,
          [ORG_A, PRODUCT_A]
        );
        return res.rowCount;
      });
      expect(inserted).toBe(1);

      const seenByB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query(
          `SELECT tax_category FROM product_tax_classifications WHERE item_code = 'ISO-HSN-A'`
        );
        return rows.length;
      });
      expect(seenByB).toBe(0);

      await expect(
        asTenant(ORG_B, () =>
          app.query(
            `INSERT INTO product_tax_classifications
               (id, organization_id, product_id, country_code, tax_category, effective_from, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_05', '2026-01-01', now())`,
            [ORG_B, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/foreign key|violates/i);

      await owner.query(`DELETE FROM product_tax_classifications WHERE item_code = 'ISO-HSN-A'`);
    });
  });

  /**
   * The constraints Prisma cannot express, exercised at the DATABASE under a
   * tenant connection. The services check these first and return friendlier
   * errors — these exist because the services are not the only writers, and a
   * guard nobody exercises is a guard nobody notices losing.
   */
  describe('the constraints that are not in the schema file', () => {
    it('refuses a conversion that crosses unit classes', async () => {
      const massUnit = await owner.query<{ id: string }>(
        `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND unit_class = 'MASS' LIMIT 1`
      );
      const massId = massUnit.rows[0]?.id;
      expect(massId).toBeDefined();

      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO unit_conversions (id, organization_id, from_unit_id, to_unit_id, numerator, denominator, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 5, 1, now())`,
            [ORG_A, UNIT_PLATFORM, massId]
          )
        )
      ).rejects.toThrow(/crosses unit classes/i);
    });

    it('refuses a zero or negative conversion ratio', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO unit_conversions (id, organization_id, from_unit_id, to_unit_id, numerator, denominator, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 0, 1, now())`,
            [ORG_A, UNIT_PLATFORM, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/unit_conversions_ratio_positive|unit_conversions_distinct_units/i);
    });

    it('refuses a tenant declaring its own base unit', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, is_base, updated_at)
             VALUES (gen_random_uuid(), $1, 'ISO_BASE_A', 'Iso Base A', 'iba', 'COUNT', true, now())`,
            [ORG_A]
          )
        )
      ).rejects.toThrow(/units_of_measure_base_is_platform/i);
    });

    it('refuses expiry control on a product that is not batch tracked', async () => {
      /*
       * ⚠️ `batches.expires_on` IS THE ONLY COLUMN THAT HOLDS AN EXPIRY, and a
       *   product tracked NONE or SERIAL never gets a batch row. Marking it
       *   expiry-controlled asserts a control nothing can record, and PI-2's
       *   expiry sweep would skip it forever without complaining.
       */
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, is_expiry_controlled, updated_at)
             VALUES (gen_random_uuid(), $1, 'MEDICINE', 'DRAFT', 'ISO_BADEXP', 'Bad expiry', $2, 'NONE', true, now())`,
            [ORG_A, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/products_expiry_requires_batch_tracking/i);
    });

    it('refuses a packaging level 0 that does not contain exactly one', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_packagings (id, organization_id, product_id, level, unit_id, quantity_of_child, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 0, $3, 10, now())`,
            [ORG_A, PRODUCT_A, UNIT_PLATFORM]
          )
        )
      ).rejects.toThrow(/product_packagings_level_sane/i);
    });

    it('refuses a category that is its own parent', async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO product_categories (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'ISO_CYCLE_A', 'Iso Cycle A', now()) RETURNING id`,
        [ORG_A]
      );
      const id = rows[0]?.id;
      expect(id).toBeDefined();

      await expect(
        asTenant(ORG_A, () =>
          app.query('UPDATE product_categories SET parent_id = id WHERE id = $1', [id])
        )
      ).rejects.toThrow(/cannot be its own parent/i);

      await owner.query('DELETE FROM product_categories WHERE id = $1', [id]);
    });

    it('refuses an effective window that ends before it starts', async () => {
      await expect(
        asTenant(ORG_A, () =>
          app.query(
            `INSERT INTO product_tax_classifications
               (id, organization_id, product_id, country_code, tax_category, effective_from, effective_to, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'IN', 'GST_5', '2026-06-01', '2026-01-01', now())`,
            [ORG_A, PRODUCT_A]
          )
        )
      ).rejects.toThrow(/product_tax_classifications_window_ordered/i);
    });
  });
});
