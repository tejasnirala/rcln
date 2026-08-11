/**
 * A whole invoice priced against real Postgres, real RLS and real rate cards.
 *
 * `packages/invoicing` already proves the arithmetic — the calculation order,
 * the largest-remainder apportionment, the per-line rounding — with no tenant
 * and no clock. What only a real database can prove is the wiring, and every
 * case here is one where the wiring is what goes wrong:
 *
 *   1. The rule ids really reach `invoice_taxes`' two columns. In the pure tests
 *      they are literals the test supplies; here they are uuids that came out of
 *      two different tables, and which column they land in is the difference
 *      between "the clinic chose this rate" and "the clinic accepted ours".
 *   2. The registration id really is the one the engine priced under, resolved
 *      by the same selection rule rather than by a second opinion about it.
 *   3. Another tenant's rate card cannot price this tenant's bill — asserted as
 *      an arithmetic claim, so a leak shows up as the wrong tax rather than as a
 *      missing row.
 *   4. A category the clinic never configured comes back UNRATED on a document
 *      that says so, not at a plausible guessed rate.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { fromMajor } = await import('@rcln/payments');
const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { priceDraftInvoice } = await import('../../src/services/invoicing/pricing.service.js');

const SUFFIX = `p${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
const SUPPLIED_AT = new Date('2026-08-09T06:00:00Z');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let ctxA: TenantContext;
let ctxB: TenantContext;
let registrationA: string;
let medicineRuleA: string;

const inr = (major: string) => fromMajor(major, 'INR');

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pvt Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  orgA = await registerOrganization(payload(`price-a-${SUFFIX}`, 'Price A'));
  orgB = await registerOrganization(payload(`price-b-${SUFFIX}`, 'Price B'));

  await owner.query(
    `UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = ANY($1)`,
    [[orgA.branchId, orgB.branchId]]
  );

  const registrations = await owner.query<{ id: string }>(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        legal_name, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', 'Price A Pvt Ltd', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'KA', 'GST', '29ZZZZZ9999Z1ZZ', 'Price B Pvt Ltd', '2025-04-01', now())
     RETURNING id`,
    [orgA.organizationId, orgB.organizationId]
  );
  registrationA = registrations.rows[0]!.id;

  /*
   * A taxes medicine at 5%, B at 18%. The same category deliberately, so a
   * cross-tenant leak shows up as `1800` where `500` was expected rather than as
   * a row count that could be explained away.
   */
  const rules = await owner.query<{ id: string }>(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE',      500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION',    0, 'EXEMPT',   'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'GST', 'MEDICINE',     1800, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())
     RETURNING id`,
    [orgA.organizationId, orgB.organizationId]
  );
  medicineRuleA = rules.rows[0]!.id;

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  };
  ctxB = {
    organizationId: orgB.organizationId,
    branchIds: [orgB.branchId],
    userId: orgB.ownerUserId,
  };
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const line = (description: string, taxCategory: string, major: string, quantityMilli = 1000) => ({
  description,
  taxCategory,
  unitPrice: inr(major),
  quantityMilli,
});

const price = (ctx: TenantContext, branchId: string, input: Record<string, unknown>) =>
  withTenant(ctx, (tx) =>
    priceDraftInvoice(tx, ctx, {
      branchId,
      suppliedAt: SUPPLIED_AT,
      currency: 'INR',
      lines: [],
      ...input,
    } as Parameters<typeof priceDraftInvoice>[2])
  );

describe('a clinic prices its own bill', () => {
  it('bills a consultation and a medicine under one registration at two rates', async () => {
    const priced = await price(ctxA, orgA.branchId, {
      lines: [
        line('Consultation', 'CONSULTATION', '750.00'),
        line('Amoxicillin 500mg', 'MEDICINE', '20.00', 21_000),
      ],
    });

    // The consultation is exempt; the strip of 21 tablets is 420.00 at 5%.
    expect(priced.subtotal).toEqual(inr('1170.00'));
    expect(priced.lines[0]?.taxTreatment).toBe('EXEMPT');
    expect(priced.lines[0]?.taxAmount).toEqual(inr('0.00'));
    expect(priced.lines[1]?.grossAmount).toEqual(inr('420.00'));
    expect(priced.taxTotal).toEqual(inr('21.00'));
    expect(priced.grandTotal).toEqual(inr('1191.00'));
    expect(priced.taxTreatment).toBe('STANDARD');
    expect(priced.issuable).toBe(true);
  });

  it('splits the medicine line into CGST and SGST owed to two governments', async () => {
    const priced = await price(ctxA, orgA.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '420.00')],
    });

    const taxes = priced.lines[0]?.taxes ?? [];
    expect(taxes.map((t) => t.name)).toEqual(['CGST', 'SGST']);
    expect(taxes.map((t) => t.jurisdiction)).toEqual(['IN', 'IN-KA']);
    expect(taxes.map((t) => t.taxAmount.amountMinor)).toEqual([1050, 1050]);
  });

  it('cites the clinic’s OWN rule id, in tax_rule_id and not the other column', async () => {
    /*
     * ⚠️ THE COLUMN A ROW LANDS IN IS THE WHOLE POINT OF THERE BEING TWO. This
     *   clinic wrote its own MEDICINE rule, so the invoice records that it chose
     *   5% — not that it accepted a published default. Both columns NULL would
     *   read as "no rule was involved", which is the UNRATED case.
     */
    const priced = await price(ctxA, orgA.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '420.00')],
    });

    for (const tax of priced.lines[0]?.taxes ?? []) {
      expect(tax.taxRuleId).toBe(medicineRuleA);
      expect(tax.taxRuleDefaultId).toBeNull();
    }
  });

  it('cites rcln’s catalogue when the clinic wrote no rule of its own', async () => {
    /*
     * A consultation is exempt in India by seeded default, and this clinic
     * ALSO wrote its own — so B, which wrote none, is the one that inherits.
     */
    const priced = await price(ctxB, orgB.branchId, {
      lines: [line('Consultation', 'CONSULTATION', '750.00')],
    });

    expect(priced.lines[0]?.taxTreatment).toBe('EXEMPT');
    expect(priced.lines[0]?.taxReason).toMatch(/exempt/i);
    expect(priced.issuable).toBe(true);
  });

  it('records the registration it priced under, resolved by the same rule', async () => {
    const priced = await price(ctxA, orgA.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '420.00')],
    });

    expect(priced.placeOfSupply).toBe('IN-KA');
    expect(priced.issuerTaxId).toBe('29AAACR1234K1ZP');
    expect(priced.issuerTaxRegistrationId).toBe(registrationA);
    expect(priced.issuerLegalName).toBe('Price A Pvt Ltd');
  });

  it('applies a whole-bill discount to the tax base, against real rules', async () => {
    const priced = await price(ctxA, orgA.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '1000.00')],
      discount: { type: 'PERCENTAGE', bps: 1000 },
    });

    expect(priced.lines[0]?.taxableAmount).toEqual(inr('900.00'));
    // 5% of 900, not of 1000. ₹50 would be tax on ₹100 nobody paid.
    expect(priced.taxTotal).toEqual(inr('45.00'));
    expect(priced.grandTotal).toEqual(inr('945.00'));
  });
});

describe('the boundaries', () => {
  it('CANNOT price one clinic’s bill with another clinic’s rate card', async () => {
    // A leak shows up as 18% where 5% was configured — an arithmetic claim, not
    // a row count that could be explained away.
    const a = await price(ctxA, orgA.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '1000.00')],
    });
    const b = await price(ctxB, orgB.branchId, {
      lines: [line('Amoxicillin 500mg', 'MEDICINE', '1000.00')],
    });

    expect(a.taxTotal).toEqual(inr('50.00'));
    expect(b.taxTotal).toEqual(inr('180.00'));
    expect(a.issuerTaxId).toBe('29AAACR1234K1ZP');
    expect(b.issuerTaxId).toBe('29ZZZZZ9999Z1ZZ');
  });

  it('refuses to price against a branch the tenant cannot see', async () => {
    await expect(
      price(ctxA, orgB.branchId, { lines: [line('X', 'MEDICINE', '100.00')] })
    ).rejects.toThrow(/branch .* not found/i);
  });

  it('MARKS A BILL UNISSUABLE when a category has no rule anywhere', async () => {
    /*
     * ⚠️ Nothing is charged and nothing is guessed. The draft exists saying
     *   exactly what is wrong with it, and Phase 5's finalisation refuses to
     *   ISSUE it. A fallback to some other rate would produce a plausible
     *   invoice at a rate nobody chose, on a document a patient may claim
     *   against insurance.
     */
    const priced = await price(ctxA, orgA.branchId, {
      lines: [
        line('Amoxicillin 500mg', 'MEDICINE', '420.00'),
        line('Wrist splint', 'ORTHOTIC-DEVICE', '1250.00'),
      ],
    });

    expect(priced.lines[1]?.taxTreatment).toBe('UNRATED');
    expect(priced.lines[1]?.taxAmount).toEqual(inr('0.00'));
    expect(priced.issuable).toBe(false);
    expect(priced.taxTreatment).toBe('UNRATED');
    expect(priced.unissuableReasons[0]).toContain('Wrist splint');
    // Both tax-rule columns stay NULL: no rule was involved at all.
    expect(priced.lines[1]?.taxes).toHaveLength(0);
  });
});
