/**
 * The clinic's tax resolution against real Postgres, real RLS and real rows.
 *
 * The package tests in `@rcln/tax` already prove the rules. What only a real
 * database can prove is the wiring between them, and every case here is one
 * where the wiring is what goes wrong:
 *
 *   1. The place of supply really is read from the BRANCH. In the pure tests it
 *      is a literal the test itself supplies; here it comes out of a row, and
 *      the row is what a multi-state group edits.
 *   2. RLS does not accidentally hide the issuer's OWN registrations. This is
 *      the failure mode that exempted `tax_registrations` from RLS in the first
 *      place — zero rows reads as NOT_REGISTERED and every invoice silently
 *      comes out untaxed. These tables took the opposite decision, so this is
 *      the case that proves the decision was safe.
 *   3. Another tenant's rate card cannot price this tenant's invoice.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { money } = await import('@rcln/payments');
const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { loadTaxContext, taxForItem } = await import('../../src/services/invoicing/tax.service.js');

const SUFFIX = `t${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
const SUPPLIED_AT = new Date('2026-08-09T06:00:00Z');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let ctxA: TenantContext;
let ctxB: TenantContext;
/** A second branch for org A, in another state — the multi-state group case. */
let branchA2: string;

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

  orgA = await registerOrganization(payload(`tax-a-${SUFFIX}`, 'Tax A'));
  orgB = await registerOrganization(payload(`tax-b-${SUFFIX}`, 'Tax B'));

  // Karnataka for A's main branch, Kerala for its second.
  await owner.query(`UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = $1`, [
    orgA.branchId,
  ]);

  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO branches (id, organization_id, code, name, country_code, region_code, updated_at)
     VALUES (gen_random_uuid(), $1, 'KL1', 'Tax A Kerala', 'IN', 'KL', now())
     RETURNING id`,
    [orgA.organizationId]
  );
  branchA2 = rows[0]!.id;

  await owner.query(`UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = $1`, [
    orgB.branchId,
  ]);

  // A is registered in both states it operates in; B only in Karnataka.
  await owner.query(
    `INSERT INTO issuer_tax_registrations
       (id, organization_id, country_code, region_code, scheme, registration_number,
        effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAACR1234K1ZP', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'KL', 'GST', '32AAACR1234K1ZR', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'KA', 'GST', '29ZZZZZ9999Z1ZZ', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
  );

  // A's rate card. B gets a deliberately different rate for the same category,
  // so a leak across the boundary shows up as a wrong number rather than as a
  // missing one.
  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'CONSULTATION',    0, 'EXEMPT',   'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE',      500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now()),
            (gen_random_uuid(), $2, 'IN', 'GST', 'MEDICINE',     1800, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2025-04-01', now())`,
    [orgA.organizationId, orgB.organizationId]
  );

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId, branchA2],
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

const contextFor = (ctx: TenantContext, branchId: string) =>
  withTenant(ctx, (tx) => loadTaxContext(tx, ctx, branchId, SUPPLIED_AT));

describe('the issuer can read its own tax position', () => {
  /*
   * ⚠️ THE CASE THAT JUSTIFIES THE RLS DECISION. `tax_registrations` is exempt
   *   from RLS because a policy there returns zero rows inside a tenant
   *   transaction, and zero rows reads as NOT_REGISTERED — every invoice
   *   silently untaxed, no error anywhere. These tables carry a policy instead,
   *   which is only safe because the rows belong to the tenant doing the
   *   reading. This asserts that they really do come back.
   */
  it('sees its registrations and rules through RLS', async () => {
    const context = await contextFor(ctxA, orgA.branchId);

    /*
     * ⚠️ ONE, NOT TWO, AND THE NARROWING IS THE POINT RATHER THAN A REGRESSION.
     *   `loadTaxContext` used to hand the engine every live registration and let
     *   `registrationFor` choose — but that function ends in `?? inCountry[0]`, a
     *   last-resort guess that returns SOME registration in the right country
     *   when none matches the region. With both rows in scope, a branch in a
     *   third state would have billed under whichever came back first.
     *
     *   The context now carries only what can apply to THIS branch: its stated
     *   coverage, or failing that the registrations whose jurisdiction actually
     *   matches. This clinic holds Karnataka and Kerala; the Karnataka branch
     *   sees Karnataka. The RLS claim this case exists for is unchanged and still
     *   asserted — the row does come back, where an exempt table would have
     *   returned nothing and silently untaxed the invoice.
     */
    expect(context.registrations).toHaveLength(1);
    expect(context.registrations[0]?.registrationNumber).toBe('29AAACR1234K1ZP');

    const kerala = await contextFor(ctxA, branchA2);
    expect(kerala.registrations.map((row) => row.registrationNumber)).toEqual(['32AAACR1234K1ZR']);

    /*
     * TENANT only — `context.rules` now also carries the platform catalogue this
     * clinic inherits, which is the subject of its own block below.
     */
    const own = context.rules.filter((r) => r.source === 'TENANT');
    expect(own.map((r) => r.taxCategory).sort()).toEqual(['CONSULTATION', 'MEDICINE']);
  });

  it('reads the place of supply from the branch row', async () => {
    const karnataka = await contextFor(ctxA, orgA.branchId);
    const kerala = await contextFor(ctxA, branchA2);

    expect(karnataka.placeOfSupply).toEqual({ countryCode: 'IN', regionCode: 'KA' });
    expect(kerala.placeOfSupply).toEqual({ countryCode: 'IN', regionCode: 'KL' });
  });

  /*
   * A branch id from another tenant is invisible under RLS, so it looks exactly
   * like one that does not exist. Refusing beats falling back to the
   * organization's own jurisdiction, which would bill under the wrong state's
   * GSTIN and look entirely plausible on the printed invoice.
   */
  it('refuses to price against a branch it cannot see', async () => {
    await expect(contextFor(ctxA, orgB.branchId)).rejects.toThrow(/branch .* not found/i);
  });
});

describe('pricing a line at a branch', () => {
  it('charges nothing on an exempt consultation', async () => {
    const context = await contextFor(ctxA, orgA.branchId);

    const quote = taxForItem(context, {
      net: money(50_000, 'INR'),
      taxCategory: 'CONSULTATION',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.treatment).toBe('EXEMPT');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.supplierTaxId).toBe('29AAACR1234K1ZP');
  });

  /*
   * ⚠️ The same clinic, the same rate card, the same item — and a different
   *   GSTIN, because the branch is in a different state. This is the whole
   *   reason the place of supply is the branch rather than the organization, and
   *   it is invisible to a single-branch clinic, which is why it is tested here
   *   and not left to be discovered by a hospital group.
   */
  it('bills under the registration of the state the branch is in', async () => {
    const karnataka = await contextFor(ctxA, orgA.branchId);
    const kerala = await contextFor(ctxA, branchA2);
    const line = { net: money(100_000, 'INR'), taxCategory: 'MEDICINE', suppliedAt: SUPPLIED_AT };

    const inKa = taxForItem(karnataka, line);
    const inKl = taxForItem(kerala, line);

    expect(inKa.supplierTaxId).toBe('29AAACR1234K1ZP');
    expect(inKl.supplierTaxId).toBe('32AAACR1234K1ZR');
    // Both intra-state, because a clinical service is supplied where it happens.
    expect(inKa.lines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
    expect(inKl.lines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
    expect(inKa.total.amountMinor).toBe(5_000);
  });

  /*
   * The tenancy claim stated as an arithmetic one. B taxes MEDICINE at 18% and A
   * at 5%; if A's context could see B's rules the number would be 18000, and a
   * count-the-rows assertion would not necessarily notice.
   */
  it('never prices a line with another clinic’s rate card', async () => {
    const context = await contextFor(ctxA, orgA.branchId);

    const quote = taxForItem(context, {
      net: money(100_000, 'INR'),
      taxCategory: 'MEDICINE',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.total.amountMinor).toBe(5_000);
  });

  /*
   * B operates only in Karnataka, so its own MEDICINE rate applies there — the
   * mirror of the case above, which together rule out both directions of leak.
   */
  it('prices the other clinic’s line with the other clinic’s card', async () => {
    const context = await contextFor(ctxB, orgB.branchId);

    const quote = taxForItem(context, {
      net: money(100_000, 'INR'),
      taxCategory: 'MEDICINE',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.total.amountMinor).toBe(18_000);
    expect(quote.supplierTaxId).toBe('29ZZZZZ9999Z1ZZ');
  });

  /*
   * ⚠️ A category nobody configured must NOT borrow a rate. There is a valid
   *   registration here and other rules under it, so a fallback would be easy
   *   and would look right on the invoice.
   */
  it('returns UNRATED for a category with no rule', async () => {
    const context = await contextFor(ctxA, orgA.branchId);

    const quote = taxForItem(context, {
      net: money(100_000, 'INR'),
      taxCategory: 'PHYSIOTHERAPY',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.treatment).toBe('UNRATED');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.reason).toContain('PHYSIOTHERAPY');
  });

  /*
   * A registration that had not taken effect on the supply date does not cover
   * it, even though the row exists today. Matters on the first invoices after
   * registering, and on any invoice backdated across the boundary.
   */
  it('does not use a registration that was not yet in force', async () => {
    const context = await withTenant(ctxA, (tx) =>
      loadTaxContext(tx, ctxA, orgA.branchId, new Date('2025-01-15T06:00:00Z'))
    );

    expect(context.registrations).toHaveLength(0);

    const quote = taxForItem(context, {
      net: money(100_000, 'INR'),
      taxCategory: 'MEDICINE',
      suppliedAt: new Date('2025-01-15T06:00:00Z'),
    });

    expect(quote.treatment).toBe('NOT_REGISTERED');
    expect(quote.total.amountMinor).toBe(0);
  });
});

/*
 * A clinic outside India, end to end, through the same service.
 *
 * ⚠️ THE CASE THAT PROVES THE ENGINE IS NOT INDIA-SHAPED AT THE DATABASE LEVEL
 *   AND NOT ONLY IN ITS UNIT TESTS. British Columbia charges federal GST at 5%
 *   AND provincial PST at 7% — two lines, two governments, two returns, from two
 *   `tax_rules` rows that must both be selected by one query. An engine that
 *   picks a single rule bills 5% or 12% and never 5% + 7%.
 */
describe('a Canadian clinic', () => {
  let orgC: { organizationId: string; ownerUserId: string; branchId: string };
  let ctxC: TenantContext;

  beforeAll(async () => {
    orgC = await registerOrganization(payload(`tax-c-${SUFFIX}`, 'Tax C'));

    await owner.query(`UPDATE branches SET country_code = 'CA', region_code = 'BC' WHERE id = $1`, [
      orgC.branchId,
    ]);
    await owner.query(
      `INSERT INTO issuer_tax_registrations
         (id, organization_id, country_code, region_code, scheme, registration_number,
          effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, 'CA', 'BC', 'GST', '123456789RT0001', '2025-04-01', now())`,
      [orgC.organizationId]
    );
    await owner.query(
      `INSERT INTO tax_rules
         (id, organization_id, country_code, region_code, scheme, tax_category, rate_bps,
          treatment, line_name, split, stacks, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, 'CA', NULL, 'GST', 'MEDICINE', 500, 'STANDARD',
               'GST', 'NONE', false, '2025-04-01', now()),
              (gen_random_uuid(), $1, 'CA', 'BC', 'GST', 'MEDICINE', 700, 'STANDARD',
               'PST', 'NONE', true,  '2025-04-01', now())`,
      [orgC.organizationId]
    );

    ctxC = {
      organizationId: orgC.organizationId,
      branchIds: [orgC.branchId],
      userId: orgC.ownerUserId,
    };
  }, 30_000);

  afterAll(async () => {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [orgC?.ownerUserId]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgC?.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [orgC?.organizationId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [orgC?.ownerUserId]);
  });

  it('charges federal GST and provincial PST as two separate lines', async () => {
    const context = await contextFor(ctxC, orgC.branchId);

    const quote = taxForItem(context, {
      net: money(100_000, 'CAD'),
      taxCategory: 'MEDICINE',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.lines.map((l) => [l.name, l.jurisdiction])).toEqual([
      ['GST', 'CA'],
      ['PST', 'CA-BC'],
    ]);
    // 5% + 7% of the net, and NOT 7% of (net + GST) — that would be 12_350.
    expect(quote.total.amountMinor).toBe(12_000);
  });

  /*
   * ⚠️ And nothing Indian leaks in. No CGST, no SGST, no IGST, and no mention of
   *   an inter-state supply — the concepts do not exist in Canadian law.
   */
  it('prints nothing Indian on a Canadian invoice', async () => {
    const context = await contextFor(ctxC, orgC.branchId);
    const quote = taxForItem(context, {
      net: money(100_000, 'CAD'),
      taxCategory: 'MEDICINE',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.lines.some((l) => /GST$/.test(l.name) && l.name !== 'GST')).toBe(false);
    expect(quote.reason).not.toMatch(/inter-state|India/i);
  });
});

/*
 * Inheritance from the rate card rcln maintains, against the real seeded rows.
 *
 * ⚠️ THE CASE THAT PROVES DEFAULTS ARE READ AND NOT COPIED. This clinic defines
 *   no rules at all and must still price a consultation correctly from
 *   `tax_rule_defaults`. If the design ever regresses to copying defaults into
 *   each tenant at signup, a clinic created before a new default was published
 *   stops inheriting it — and this is what fails.
 */
describe('a clinic that has configured nothing', () => {
  let orgD: { organizationId: string; ownerUserId: string; branchId: string };
  let ctxD: TenantContext;

  beforeAll(async () => {
    orgD = await registerOrganization(payload(`tax-d-${SUFFIX}`, 'Tax D'));

    await owner.query(`UPDATE branches SET country_code = 'IN', region_code = 'KA' WHERE id = $1`, [
      orgD.branchId,
    ]);
    // A registration, but deliberately NO tax_rules of its own.
    await owner.query(
      `INSERT INTO issuer_tax_registrations
         (id, organization_id, country_code, region_code, scheme, registration_number,
          effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, 'IN', 'KA', 'GST', '29AAAAA1111A1ZA', '2025-04-01', now())`,
      [orgD.organizationId]
    );

    ctxD = {
      organizationId: orgD.organizationId,
      branchIds: [orgD.branchId],
      userId: orgD.ownerUserId,
    };
  }, 30_000);

  afterAll(async () => {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [orgD?.ownerUserId]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgD?.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [orgD?.organizationId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [orgD?.ownerUserId]);
  });

  it('inherits the seeded exemption for a consultation', async () => {
    const context = await contextFor(ctxD, orgD.branchId);

    const quote = taxForItem(context, {
      net: money(50_000, 'INR'),
      taxCategory: 'CONSULTATION',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.treatment).toBe('EXEMPT');
    expect(quote.total.amountMinor).toBe(0);
    expect(quote.supplierTaxId).toBe('29AAAAA1111A1ZA');
  });

  /*
   * ⚠️ And GOODS are deliberately NOT seeded, so they come back UNRATED rather
   *   than at some plausible default. A medicine's rate varies by product within
   *   a country, so any single seeded figure would be wrong for a large share of
   *   what a pharmacy dispenses — and wrong invisibly, because an inherited
   *   default looks configured. The clinic is forced to enter a checked rate.
   */
  it('is UNRATED for a medicine, because goods are not seeded', async () => {
    const context = await contextFor(ctxD, orgD.branchId);

    const quote = taxForItem(context, {
      net: money(100_000, 'INR'),
      taxCategory: 'MEDICINE',
      suppliedAt: SUPPLIED_AT,
    });

    expect(quote.treatment).toBe('UNRATED');
    expect(quote.total.amountMinor).toBe(0);
  });

  /* A clinic that HAS configured a category prices it; this one still cannot. */
  it('lets a configured clinic override where an inheriting one has nothing', async () => {
    const configured = await contextFor(ctxA, orgA.branchId);
    const inheriting = await contextFor(ctxD, orgD.branchId);
    const line = { net: money(100_000, 'INR'), taxCategory: 'MEDICINE', suppliedAt: SUPPLIED_AT };

    expect(taxForItem(configured, line).total.amountMinor).toBe(5_000);
    expect(taxForItem(inheriting, line).treatment).toBe('UNRATED');
  });

  /*
   * The defaults table is RLS-exempt and read inside a tenant transaction. If it
   * ever gained a tenant_isolation policy it would return zero rows here and
   * every clinic would silently lose every inherited rule — so this asserts the
   * rows actually arrive rather than that they ought to.
   */
  it('really does see the platform catalogue through a tenant transaction', async () => {
    const context = await contextFor(ctxD, orgD.branchId);
    const inherited = context.rules.filter((r) => r.source === 'PLATFORM');

    expect(inherited.length).toBeGreaterThan(0);
    expect(inherited.map((r) => r.taxCategory)).toContain('CONSULTATION');
  });
});
