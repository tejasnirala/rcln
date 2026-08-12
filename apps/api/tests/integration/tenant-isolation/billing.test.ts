/**
 * Tenant isolation — billing.
 *
 * Subscriptions, plans, payments, and the one-row-wide webhook lookup.
 *
 * One file of the tenant-isolation suite; see ./README.md. The two seeded
 * organizations, the two connections and the teardown live in ./harness.ts.
 */
import { ORG_A, ORG_B, app, asTenant, owner, useIsolationHarness } from './harness.js';

useIsolationHarness();

/**
 * Billing.
 *
 * Five new tables, and every one of them holds something a competitor would pay
 * for: what a clinic is on, what it pays, and the tail of the instrument it pays
 * with. Three carry `organization_id` and get `tenant_isolation`; two hang off a
 * scoped parent and get `parent_isolation` — those two used to sit on the EXEMPT
 * list reading "reached via a scoped parent", which was true of the service layer
 * and enforced by nothing.
 *
 * The last block is the narrow SELECT policy a verified webhook uses to find the
 * one intent it is about. It is the only way to read a payment row without a
 * tenant context, and it must stay exactly one row wide.
 */
describe('billing tables', () => {
  const PLAN = 'ffffffff-0000-0000-0000-00000000f001';
  const PRICE = 'ffffffff-0000-0000-0000-00000000f002';
  const SUB_A = 'ffffffff-0000-0000-0000-00000000fa01';
  const SUB_B = 'ffffffff-0000-0000-0000-00000000fb01';
  const INVOICE_A = 'ffffffff-0000-0000-0000-00000000fa02';
  const INVOICE_B = 'ffffffff-0000-0000-0000-00000000fb02';
  const MANDATE_A = 'ffffffff-0000-0000-0000-00000000fa03';
  const MANDATE_B = 'ffffffff-0000-0000-0000-00000000fb03';
  const INTENT_A = 'ffffffff-0000-0000-0000-00000000fa04';
  const INTENT_B = 'ffffffff-0000-0000-0000-00000000fb04';

  const countIn = async (table: string): Promise<number> => {
    const { rows } = await app.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    return Number(rows[0]?.count);
  };

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO plans (id, code, name, updated_at)
       VALUES ($1,'ISO_TEST','Isolation Test',now()) ON CONFLICT (id) DO NOTHING`,
      [PLAN]
    );
    await owner.query(
      `INSERT INTO plan_prices (id, plan_id, currency, billing_interval, amount)
       VALUES ($1,$2,'INR','MONTH',1000) ON CONFLICT (id) DO NOTHING`,
      [PRICE, PLAN]
    );

    for (const [sub, org, invoice, mandate, intent] of [
      [SUB_A, ORG_A, INVOICE_A, MANDATE_A, INTENT_A],
      [SUB_B, ORG_B, INVOICE_B, MANDATE_B, INTENT_B],
    ] as const) {
      await owner.query(
        `INSERT INTO payment_mandates
           (id, organization_id, provider, provider_mandate_id, currency, max_amount, updated_at)
         VALUES ($1,$2,'mock',$3,'INR',3000,now()) ON CONFLICT (id) DO NOTHING`,
        [mandate, org, mandate]
      );
      await owner.query(
        `INSERT INTO subscriptions
           (id, organization_id, plan_id, plan_price_id, currency,
            current_period_start, current_period_end, updated_at)
         VALUES ($1,$2,$3,$4,'INR',now(),now() + interval '30 days',now())
         ON CONFLICT (id) DO NOTHING`,
        [sub, org, PLAN, PRICE]
      );
      await owner.query(
        `INSERT INTO subscription_invoices
           (id, organization_id, subscription_id, invoice_number, period_start, period_end,
            currency, subtotal, total, updated_at)
         VALUES ($1,$2,$3,$4,current_date,current_date + 30,'INR',1000,1000,now())
         ON CONFLICT (id) DO NOTHING`,
        [invoice, org, sub, `ISO-${invoice.slice(-6)}`]
      );
      await owner.query(
        `INSERT INTO subscription_invoice_lines
           (id, subscription_invoice_id, description, unit_amount, line_total)
         VALUES (gen_random_uuid(),$1,'Isolation Test',1000,1000)`,
        [invoice]
      );
      await owner.query(
        `INSERT INTO subscription_payments
           (id, subscription_invoice_id, amount, currency, gateway, gateway_payment_id)
         VALUES (gen_random_uuid(),$1,1000,'INR','mock',$2)`,
        [invoice, `pay-${invoice.slice(-6)}`]
      );
      await owner.query(
        `INSERT INTO subscription_feature_overrides (id, subscription_id, feature_key, int_value)
         VALUES (gen_random_uuid(),$1,'max_branches',99)
         ON CONFLICT (subscription_id, feature_key) DO NOTHING`,
        [sub]
      );
      await owner.query(
        `INSERT INTO payment_intents
           (id, organization_id, subscription_id, subscription_invoice_id, provider,
            provider_charge_id, purpose, amount, currency, description, updated_at)
         VALUES ($1,$2,$3,$4,'mock',$5,'SUBSCRIPTION_START',1000,'INR','Isolation Test',now())
         ON CONFLICT (id) DO NOTHING`,
        [intent, org, sub, invoice, intent]
      );
      await owner.query(
        `INSERT INTO subscription_changes
           (id, organization_id, subscription_id, change_type, currency, effective_at)
         VALUES (gen_random_uuid(),$1,$2,'SUBSCRIBE','INR',now())`,
        [org, sub]
      );
    }
  });

  afterAll(async () => {
    await owner.query('DELETE FROM subscription_changes WHERE subscription_id = ANY($1)', [
      [SUB_A, SUB_B],
    ]);
    await owner.query('DELETE FROM payment_intents WHERE id = ANY($1)', [[INTENT_A, INTENT_B]]);
    await owner.query('DELETE FROM subscription_invoices WHERE id = ANY($1)', [
      [INVOICE_A, INVOICE_B],
    ]);
    await owner.query('DELETE FROM subscriptions WHERE id = ANY($1)', [[SUB_A, SUB_B]]);
    await owner.query('DELETE FROM payment_mandates WHERE id = ANY($1)', [[MANDATE_A, MANDATE_B]]);
    await owner.query('DELETE FROM plan_prices WHERE id = $1', [PRICE]);
    await owner.query('DELETE FROM plans WHERE id = $1', [PLAN]);
  });

  const ORG_SCOPED = [
    ['subscriptions'],
    ['subscription_invoices'],
    ['subscription_changes'],
    ['payment_mandates'],
    ['payment_intents'],
  ] as const;

  const PARENT_SCOPED = [
    ['subscription_invoice_lines'],
    ['subscription_payments'],
    ['subscription_feature_overrides'],
  ] as const;

  it.each([...ORG_SCOPED, ...PARENT_SCOPED])(
    '%s fails closed with no tenant context',
    async (table) => {
      expect(await countIn(table)).toBe(0);
    }
  );

  it.each([...ORG_SCOPED, ...PARENT_SCOPED])(
    '%s shows each tenant exactly its own row',
    async (table) => {
      expect(await asTenant(ORG_A, () => countIn(table))).toBe(1);
      expect(await asTenant(ORG_B, () => countIn(table))).toBe(1);
    }
  );

  it('does not leak another tenant’s invoice by primary key', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query('SELECT id FROM subscription_invoices WHERE id = $1', [
        INVOICE_B,
      ]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('does not leak another tenant’s payment instrument by primary key', async () => {
    const found = await asTenant(ORG_A, async () => {
      const { rows } = await app.query(
        'SELECT instrument_label FROM subscription_payments WHERE gateway_payment_id = $1',
        [`pay-${INVOICE_B.slice(-6)}`]
      );
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it('refuses to write a payment intent into another tenant', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query(
          `INSERT INTO payment_intents
             (id, organization_id, provider, purpose, amount, currency, description, updated_at)
           VALUES (gen_random_uuid(),$1,'mock','SUBSCRIPTION_START',1,'INR','x',now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to mark another tenant’s invoice paid', async () => {
    const updated = await asTenant(ORG_A, async () => {
      const result = await app.query(
        `UPDATE subscription_invoices SET status = 'PAID' WHERE id = $1`,
        [INVOICE_B]
      );
      return result.rowCount;
    });
    // Silently zero rather than an error — the row is simply not visible. That
    // is exactly why this suite exists: nothing would have complained.
    expect(updated).toBe(0);
  });

  it('cannot attach another tenant’s mandate to your own subscription', async () => {
    await expect(
      asTenant(ORG_A, () =>
        app.query('UPDATE subscriptions SET mandate_id = $1 WHERE id = $2', [MANDATE_B, SUB_A])
      )
    ).rejects.toThrow();
  });

  /**
   * The webhook reference lookup.
   *
   * A public endpoint has to find the one intent a verified delivery names, with
   * no tenant context to do it under. The policy that allows it is narrowed on
   * both axes — the exact uuid, and only with no tenant claimed — and these cases
   * are what stop it widening into "read any payment row without a tenant".
   */
  describe('webhook reference lookup', () => {
    const LOOKUP_INTENT = INTENT_A;
    const OTHER_INTENT = INTENT_B;

    async function asWebhook<T>(reference: string, fn: () => Promise<T>): Promise<T> {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.payment_reference', $1, true)`, [reference]);
        const result = await fn();
        await app.query('COMMIT');
        return result;
      } catch (err) {
        await app.query('ROLLBACK');
        throw err;
      }
    }

    const read = async (id: string): Promise<number> => {
      const { rows } = await app.query(
        'SELECT organization_id FROM payment_intents WHERE id = $1',
        [id]
      );
      return rows.length;
    };

    const readAll = async (): Promise<number> => {
      const { rows } = await app.query('SELECT id FROM payment_intents');
      return rows.length;
    };

    it('finds the one intent it names', async () => {
      expect(await asWebhook(LOOKUP_INTENT, () => read(LOOKUP_INTENT))).toBe(1);
    });

    it('grants nothing beyond that single row', async () => {
      // The whole point: naming one reference must not open the table.
      expect(await asWebhook(LOOKUP_INTENT, () => readAll())).toBe(1);
      expect(await asWebhook(LOOKUP_INTENT, () => read(OTHER_INTENT))).toBe(0);
    });

    it('switches off entirely once a tenant context exists', async () => {
      // PERMISSIVE policies OR together, so this is what stops the lookup widening
      // an ordinary request. Org B's intent stays invisible inside org A.
      const found = await asTenant(ORG_A, async () => {
        await app.query(`SELECT set_config('app.payment_reference', $1, true)`, [OTHER_INTENT]);
        return read(OTHER_INTENT);
      });
      expect(found).toBe(0);
    });

    it('grants no ability to write', async () => {
      const updated = await asWebhook(LOOKUP_INTENT, async () => {
        const result = await app.query(
          `UPDATE payment_intents SET status = 'SUCCEEDED' WHERE id = $1`,
          [LOOKUP_INTENT]
        );
        return result.rowCount;
      });
      expect(updated).toBe(0);
    });
  });

  /*
   * tax_registrations: the one table here where the DANGER IS THE OPPOSITE.
   *
   * Everywhere else in this file the failure is a tenant seeing rows it should
   * not. Here it is the application seeing NOTHING: the table says where rcln
   * itself is registered to collect tax, it has no organization_id, and the tax
   * engine reads it from inside a tenant transaction while issuing an invoice.
   *
   * If it ever gained a policy — added by reflex, because "every table needs
   * one" — that read would match zero rows. Zero rows means NOT_REGISTERED,
   * NOT_REGISTERED means no tax, and every invoice would quietly come out
   * untaxed with nothing failing anywhere. That is a revenue and compliance bug
   * that no single-tenant test would catch, which is exactly why it is pinned.
   */
  describe('tax_registrations stays readable inside a tenant context', () => {
    beforeAll(async () => {
      /*
       * `ZZ` on purpose: it is user-assigned in ISO 3166, so no real
       * registration can ever occupy it.
       *
       * The first version used IN/KA/GST with `ON CONFLICT DO NOTHING`, which
       * collided with a genuine registration an operator had added through the
       * console — the insert silently did nothing and the assertion failed on
       * data that was perfectly correct. A fixture must not compete with real
       * rows for a unique key.
       */
      await owner.query(`DELETE FROM tax_registrations WHERE country_code = 'ZZ'`);
      await owner.query(
        `INSERT INTO tax_registrations
           (id, country_code, region_code, scheme, registration_number,
            standard_rate_bps, effective_from, created_at, updated_at)
         VALUES (gen_random_uuid(), 'ZZ', NULL, 'GST', 'TEST-GSTIN', 1800, CURRENT_DATE, now(), now())`
      );
    });

    afterAll(async () => {
      await owner.query(`DELETE FROM tax_registrations WHERE country_code = 'ZZ'`);
    });

    it('is visible to the app role while scoped to a tenant', async () => {
      const found = await asTenant(ORG_A, async () => {
        const { rows } = await app.query(
          `SELECT id FROM tax_registrations WHERE registration_number = 'TEST-GSTIN'`
        );
        return rows.length;
      });

      // One row, from inside org A's context. If this is ever 0, tax silently
      // stops being charged everywhere — read the comment above before "fixing".
      expect(found).toBe(1);
    });

    it('is the same set of rows for every tenant', async () => {
      // It describes the supplier, not the customer. Two clinics must not see
      // different registrations, or two invoices for the same supply disagree.
      const forA = await asTenant(ORG_A, async () => {
        const { rows } = await app.query('SELECT id FROM tax_registrations');
        return rows.length;
      });
      const forB = await asTenant(ORG_B, async () => {
        const { rows } = await app.query('SELECT id FROM tax_registrations');
        return rows.length;
      });

      expect(forA).toBe(forB);
      expect(forA).toBeGreaterThan(0);
    });
  });
});
