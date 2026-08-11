/**
 * Organization, branch and tax registration as three separate things.
 *
 * Every case here is a shape the old model could not express, and the reason it
 * could not was always the same: coverage was INFERRED from matching a branch's
 * region code against a registration's, so the answer to "which branches does
 * this GSTIN cover?" was *whichever ones happen to sit in the same state*.
 *
 *   1. AN ORGANIZATION HOLDS ZERO, ONE OR SEVERAL REGISTRATIONS, and the count
 *      has nothing to do with how many branches it has. Zero is a clinic below
 *      the registration threshold and is a legitimate steady state, not an
 *      unfinished setup.
 *   2. ONE REGISTRATION COVERS MANY BRANCHES. Three locations under one number is
 *      the ordinary Indian single-state group, and three branches must not imply
 *      three registrations.
 *   3. DIFFERENT BRANCHES USE DIFFERENT REGISTRATIONS, INCLUDING IN ONE
 *      JURISDICTION. Two branches in the same state billing under two numbers was
 *      previously impossible twice over — the unique key refused the second
 *      registration, and the inference would have given both branches to both.
 *   4. AND THE MIXED CASE, which is the one that proves coverage is really a
 *      statement: A and B share one number while C uses another.
 *   5. HISTORY SURVIVES. A registration that lapses is kept beside the one that
 *      replaced it, in the same jurisdiction, because an invoice raised today for
 *      last year's consultation must cite the number in force then.
 *   6. NONE OF IT IS ABOUT GST. The last block is an Irish clinic with a VAT
 *      registration and no region at all.
 *
 * ⚠️ ASSERTED THROUGH `priceDraftInvoice` AND NOT ONLY THROUGH THE COVERAGE API,
 *   because the only claim that matters is which number lands on the invoice. A
 *   coverage row that the pricing path does not read is a screen that lies.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
/*
 * The type without a static import, because every value here is loaded
 * dynamically AFTER `loadEnv` — a top-level `import` would be hoisted above it
 * and the db package would read its connection string before .env exists. The
 * same shape as the other invoicing suites.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type TenantContext = import('@rcln/db').TenantContext;

const { fromMajor } = await import('@rcln/payments');
const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { priceDraftInvoice } = await import('../../src/services/invoicing/pricing.service.js');
const { createBranch } = await import('../../src/services/branch/branch.service.js');
const {
  createClinicTaxRegistration,
  listClinicTaxRegistrations,
  setClinicTaxRegistrationBranches,
} = await import('../../src/services/tax/clinic-tax.service.js');
const { getOrganization } = await import('../../src/services/organization/organization.service.js');

const SUFFIX = `c${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
const SUPPLIED_AT = new Date('2026-08-11T06:00:00Z');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

/** The Indian group: three branches, one organization. */
let group: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;
let patna = '';
let gaya = '';
let mumbai = '';

/** The Irish clinic, for the case that has no GST and no state anywhere in it. */
let dublin: { organizationId: string; ownerUserId: string; branchId: string };
let ctxIE: TenantContext;

const inr = (major: string) => fromMajor(major, 'INR');

function payload(slug: string, label: string, countryCode: string, regionCode?: string) {
  return {
    organization: {
      legalName: `${label} Pvt Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode,
      ...(regionCode ? { regionCode } : {}),
      timezone: countryCode === 'IE' ? 'Europe/Dublin' : 'Asia/Kolkata',
      currency: countryCode === 'IE' ? 'EUR' : 'INR',
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

  group = await registerOrganization(payload(`cov-in-${SUFFIX}`, 'Coverage IN', 'IN', 'BR'));
  ctx = {
    organizationId: group.organizationId,
    branchIds: [group.branchId],
    userId: group.ownerUserId,
  };
  patna = group.branchId;

  /*
   * Two more branches, through the real service — which is also the assertion
   * that a branch's jurisdiction is settable at all. It was not: both fields
   * were absent from the contract, so every branch took the column default `IN`
   * with no region, whatever its organization said.
   */
  const gayaBranch = await createBranch(ctx, {
    name: 'Coverage Gaya',
    code: 'GAYA',
    branchType: 'CLINIC',
    // countryCode and regionCode omitted on purpose: they must inherit BR from
    // the organization rather than falling to the column's India-with-no-state.
  } as Parameters<typeof createBranch>[1]);
  gaya = gayaBranch.id;

  const mumbaiBranch = await createBranch(ctx, {
    name: 'Coverage Mumbai',
    code: 'BOM',
    branchType: 'CLINIC',
    countryCode: 'IN',
    regionCode: 'MH',
  } as Parameters<typeof createBranch>[1]);
  mumbai = mumbaiBranch.id;

  ctx = { ...ctx, branchIds: [patna, gaya, mumbai] };

  dublin = await registerOrganization(payload(`cov-ie-${SUFFIX}`, 'Coverage IE', 'IE'));
  ctxIE = {
    organizationId: dublin.organizationId,
    branchIds: [dublin.branchId],
    userId: dublin.ownerUserId,
  };

  // A rate to charge, so "which registration" is answerable on a real invoice.
  await owner.query(
    `INSERT INTO tax_rules
       (id, organization_id, country_code, scheme, tax_category, rate_bps, treatment,
        line_name, split, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'IN', 'GST', 'MEDICINE', 500, 'STANDARD', 'GST', 'INTRA_STATE_HALVES', '2020-01-01', now())`,
    [group.organizationId]
  );
}, 60_000);

afterAll(async () => {
  const ids = [group?.organizationId, dublin?.organizationId].filter(Boolean);
  const users = [group?.ownerUserId, dublin?.ownerUserId].filter(Boolean);

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

const priceAt = (context: TenantContext, branchId: string, currency = 'INR') =>
  withTenant(context, (tx) =>
    priceDraftInvoice(tx, context, {
      branchId,
      suppliedAt: SUPPLIED_AT,
      currency,
      lines: [
        {
          description: 'Amoxicillin 500mg',
          taxCategory: 'MEDICINE',
          unitPrice: currency === 'INR' ? inr('1000.00') : fromMajor('1000.00', 'EUR'),
          quantityMilli: 1000,
        },
      ],
    } as Parameters<typeof priceDraftInvoice>[2])
  );

const record = (input: {
  countryCode: string;
  regionCode?: string | null;
  scheme: 'GST' | 'VAT' | 'SALES_TAX';
  registrationNumber: string;
  effectiveFrom: string;
  effectiveTo?: string;
  legalName?: string;
  context?: TenantContext;
}) =>
  createClinicTaxRegistration(input.context ?? ctx, {
    countryCode: input.countryCode,
    regionCode: input.regionCode ?? null,
    scheme: input.scheme,
    registrationNumber: input.registrationNumber,
    legalName: input.legalName ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
  });

const coveredNames = async (registrationId: string): Promise<string[]> => {
  const all = await listClinicTaxRegistrations(ctx);
  const found = all.find((row) => row.id === registrationId);
  return (found?.coveredBranches ?? []).map((branch) => branch.name).sort();
};

// ---------------------------------------------------------------------------

describe('a branch is a place, not a registration', () => {
  it('inherits the organization’s jurisdiction rather than the column default', async () => {
    const { rows } = await owner.query<{ country_code: string; region_code: string | null }>(
      'SELECT country_code, region_code FROM branches WHERE id = $1',
      [gaya]
    );
    // Bihar, from the organization — not `IN` with no state, which is what the
    // column default gave every branch before the field existed on the contract.
    expect(rows[0]?.country_code).toBe('IN');
    expect(rows[0]?.region_code).toBe('BR');
  });

  it('takes its own jurisdiction when one is given, so a group can open elsewhere', async () => {
    const { rows } = await owner.query<{ region_code: string | null }>(
      'SELECT region_code FROM branches WHERE id = $1',
      [mumbai]
    );
    expect(rows[0]?.region_code).toBe('MH');
  });

  it('creating three branches creates no registrations at all', async () => {
    expect(await listClinicTaxRegistrations(ctx)).toEqual([]);
  });
});

describe('an organization with no tax registration', () => {
  it('is a legitimate state, and its invoices say NOT_REGISTERED rather than charging zero', async () => {
    const priced = await priceAt(ctx, patna);

    expect(priced.taxTreatment).toBe('NOT_REGISTERED');
    expect(priced.issuerTaxId).toBeNull();
    expect(priced.issuerTaxRegistrationId).toBeNull();
    expect(priced.taxTotal).toEqual(inr('0.00'));
  });

  it('shows the settings screen an empty list, not an empty field', async () => {
    const profile = await getOrganization(ctx);
    expect(profile.taxRegistrations).toEqual([]);
    expect(profile.taxId).toBeNull();
  });
});

describe('one registration, covering every branch in its jurisdiction', () => {
  let bihar = '';

  it('is recorded, and covers both Bihar branches without covering Mumbai', async () => {
    const created = await record({
      countryCode: 'IN',
      regionCode: 'BR',
      scheme: 'GST',
      registrationNumber: '10AAACR1234K1ZP',
      legalName: 'Coverage IN Pvt Ltd',
      effectiveFrom: '2025-04-01',
    });
    bihar = created.id;

    // Nobody has stated coverage yet, so this is the jurisdiction fallback —
    // the historic behaviour, unchanged, and labelled as such.
    expect(created.coverageMode).toBe('JURISDICTION');
    expect(await coveredNames(bihar)).toEqual(['Coverage Gaya', 'Coverage IN Main']);
  });

  it('prices invoices at BOTH Bihar branches under the one number', async () => {
    for (const branchId of [patna, gaya]) {
      const priced = await priceAt(ctx, branchId);
      expect(priced.issuerTaxId).toBe('10AAACR1234K1ZP');
      expect(priced.issuerTaxRegistrationId).toBe(bihar);
      // Three branches did not become three registrations.
      expect(priced.taxTotal).toEqual(inr('50.00'));
    }
  });

  it('leaves Mumbai uncovered, which is the honest answer and not an error', async () => {
    const priced = await priceAt(ctx, mumbai);
    expect(priced.taxTreatment).toBe('NOT_REGISTERED');
    expect(priced.issuerTaxRegistrationId).toBeNull();
  });

  it('reflects the number onto the organization without anyone typing it', async () => {
    const profile = await getOrganization(ctx);
    expect(profile.taxId).toBe('10AAACR1234K1ZP');
    expect(profile.taxRegistrations).toHaveLength(1);
    expect(profile.taxRegistrations[0]?.status).toBe('ACTIVE');
  });
});

describe('multiple registrations, independent of the number of branches', () => {
  let maharashtra = '';

  it('records a second one in another state, on the same organization', async () => {
    const created = await record({
      countryCode: 'IN',
      regionCode: 'MH',
      scheme: 'GST',
      registrationNumber: '27AAACR1234K1ZP',
      effectiveFrom: '2025-04-01',
    });
    maharashtra = created.id;

    const all = await listClinicTaxRegistrations(ctx);
    expect(all).toHaveLength(2);
    expect(await coveredNames(maharashtra)).toEqual(['Coverage Mumbai']);
  });

  it('so each branch bills under the registration for its own state', async () => {
    expect((await priceAt(ctx, patna)).issuerTaxId).toBe('10AAACR1234K1ZP');
    expect((await priceAt(ctx, mumbai)).issuerTaxId).toBe('27AAACR1234K1ZP');
  });

  it('records a THIRD in a state with no branch at all, which is still legitimate', async () => {
    /*
     * ⚠️ THE COUNT OF REGISTRATIONS IS NOT THE COUNT OF BRANCHES. A business may
     *   register somewhere before it opens there. The screen says this one covers
     *   nothing, which is a warning rather than a refusal.
     */
    const created = await record({
      countryCode: 'IN',
      regionCode: 'KA',
      scheme: 'GST',
      registrationNumber: '29AAACR1234K1ZP',
      effectiveFrom: '2025-04-01',
    });

    expect(await coveredNames(created.id)).toEqual([]);
    expect(await listClinicTaxRegistrations(ctx)).toHaveLength(3);
  });
});

describe('two registrations in ONE jurisdiction, split between branches', () => {
  let second = '';

  /*
   * ⚠️ THE CASE THE OLD MODEL REFUSED TWICE OVER. The unique key was
   *   (organization, country, region, scheme), so the second Bihar GSTIN could
   *   not be recorded — and even if it had been, coverage was matched on region,
   *   so both Bihar branches would have been claimed by both. India has permitted
   *   a second GSTIN per state for a separate business vertical since 2019.
   */
  it('records a second Bihar registration, which the jurisdiction key used to forbid', async () => {
    const created = await record({
      countryCode: 'IN',
      regionCode: 'BR',
      scheme: 'GST',
      registrationNumber: '10ZZZZZ9999Z1ZZ',
      effectiveFrom: '2025-04-01',
    });
    second = created.id;
    expect(created.placeOfSupply).toBe('IN-BR');
  });

  it('assigns Gaya to it, and Gaya alone', async () => {
    const updated = await setClinicTaxRegistrationBranches(ctx, second, { branchIds: [gaya] });

    expect(updated.coverageMode).toBe('EXPLICIT');
    expect(updated.coveredBranches.map((branch) => branch.name)).toEqual(['Coverage Gaya']);
  });

  it('and Gaya’s invoices move to the new number while Patna’s do not', async () => {
    expect((await priceAt(ctx, gaya)).issuerTaxId).toBe('10ZZZZZ9999Z1ZZ');
    // Patna stated nothing, so it still falls back to jurisdiction matching —
    // which is what keeps this additive for branches nobody has touched.
    expect((await priceAt(ctx, patna)).issuerTaxId).toBe('10AAACR1234K1ZP');
  });

  it('refuses to put a second live registration of one scheme on the same branch', async () => {
    /*
     * Not a richer configuration — an invoice whose number depends on the order
     * Postgres returned the rows in.
     */
    const registrations = await listClinicTaxRegistrations(ctx);
    const bihar = registrations.find((row) => row.registrationNumber === '10AAACR1234K1ZP');

    await expect(
      setClinicTaxRegistrationBranches(ctx, bihar?.id ?? '', { branchIds: [gaya] })
    ).rejects.toThrow(/already covered/i);
  });
});

describe('some branches share a registration while another uses a different one', () => {
  let bihar = '';

  it('puts Patna and Mumbai on one number and leaves Gaya on its own', async () => {
    /*
     * ⚠️ THE SHAPE THAT PROVES COVERAGE IS A STATEMENT. Mumbai is in another
     *   state entirely, so no amount of region matching would ever have put it
     *   under the Bihar number — and Gaya, which IS in Bihar, stays out of it.
     */
    const registrations = await listClinicTaxRegistrations(ctx);
    bihar = registrations.find((row) => row.registrationNumber === '10AAACR1234K1ZP')?.id ?? '';

    const updated = await setClinicTaxRegistrationBranches(ctx, bihar, {
      branchIds: [patna, mumbai],
    });

    expect(updated.coverageMode).toBe('EXPLICIT');
    expect(updated.coveredBranches.map((branch) => branch.name).sort()).toEqual([
      'Coverage IN Main',
      'Coverage Mumbai',
    ]);
  });

  it('and each branch bills under exactly the number it was assigned', async () => {
    expect((await priceAt(ctx, patna)).issuerTaxId).toBe('10AAACR1234K1ZP');
    expect((await priceAt(ctx, mumbai)).issuerTaxId).toBe('10AAACR1234K1ZP');
    expect((await priceAt(ctx, gaya)).issuerTaxId).toBe('10ZZZZZ9999Z1ZZ');
  });

  it('clearing the list returns that registration to jurisdiction matching', async () => {
    const cleared = await setClinicTaxRegistrationBranches(ctx, bihar, { branchIds: [] });
    expect(cleared.coverageMode).toBe('JURISDICTION');

    // Patna comes back by geography; Gaya stays where it was explicitly put.
    expect(cleared.coveredBranches.map((branch) => branch.name)).toEqual(['Coverage IN Main']);
    expect((await priceAt(ctx, mumbai)).issuerTaxId).toBe('27AAACR1234K1ZP');

    // Put it back, so the history block below reads against a known arrangement.
    await setClinicTaxRegistrationBranches(ctx, bihar, { branchIds: [patna] });
  });
});

describe('active and historical registrations, side by side', () => {
  let successor = '';

  /*
   * ⚠️ IMPOSSIBLE BEFORE, AND SILENTLY SO. The old check told the caller to "end
   *   it with a lapse date" — but it ignored `effective_to`, so the lapsed row
   *   went on blocking its own successor and the only way forward was to
   *   overwrite the number, destroying the record of what earlier invoices were
   *   issued under.
   */
  it('lapses the Mumbai registration and records the one that replaces it', async () => {
    const registrations = await listClinicTaxRegistrations(ctx);
    const old = registrations.find((row) => row.registrationNumber === '27AAACR1234K1ZP');

    await owner.query(
      `UPDATE issuer_tax_registrations SET effective_to = '2026-03-31' WHERE id = $1`,
      [old?.id]
    );

    const created = await record({
      countryCode: 'IN',
      regionCode: 'MH',
      scheme: 'GST',
      registrationNumber: '27NEWNEW0000Z1Z',
      effectiveFrom: '2026-04-01',
    });
    successor = created.id;

    const after = await listClinicTaxRegistrations(ctx);
    const lapsed = after.find((row) => row.registrationNumber === '27AAACR1234K1ZP');
    const active = after.find((row) => row.id === successor);

    // Both rows exist, in one jurisdiction, saying different things about time.
    expect(lapsed?.status).toBe('LAPSED');
    expect(active?.status).toBe('ACTIVE');
  });

  it('bills today under the successor', async () => {
    expect((await priceAt(ctx, mumbai)).issuerTaxRegistrationId).toBe(successor);
  });

  it('and bills a supply made while the old one was in force under the OLD number', async () => {
    /*
     * The whole reason the lapsed row is kept. A credit note raised in April
     * against a March invoice cites what March was issued under, and re-reading
     * today's registrations would put the wrong number on a document that has to
     * reconcile against the old return.
     */
    const priced = await withTenant(ctx, (tx) =>
      priceDraftInvoice(tx, ctx, {
        branchId: mumbai,
        suppliedAt: new Date('2026-02-15T06:00:00Z'),
        currency: 'INR',
        lines: [
          {
            description: 'Amoxicillin 500mg',
            taxCategory: 'MEDICINE',
            unitPrice: inr('1000.00'),
            quantityMilli: 1000,
          },
        ],
      } as Parameters<typeof priceDraftInvoice>[2])
    );

    expect(priced.issuerTaxId).toBe('27AAACR1234K1ZP');
  });

  it('still lists the lapsed one, because a screen that hides it cannot explain an old invoice', async () => {
    const numbers = (await listClinicTaxRegistrations(ctx)).map((row) => row.registrationNumber);
    expect(numbers).toContain('27AAACR1234K1ZP');
  });
});

describe('a country that is not India and a scheme that is not GST', () => {
  it('registers an Irish clinic for VAT, country-wide, with no region anywhere', async () => {
    const created = await record({
      countryCode: 'IE',
      regionCode: null,
      scheme: 'VAT',
      registrationNumber: 'IE1234567FA',
      legalName: 'Coverage IE Pvt Ltd',
      effectiveFrom: '2025-01-01',
      context: ctxIE,
    });

    expect(created.scheme).toBe('VAT');
    // Country-wide, which is what most of the world's registrations are.
    expect(created.placeOfSupply).toBe('IE');
    expect(created.coveredBranches).toHaveLength(1);
  });

  it('put its branch in Ireland at signup rather than defaulting it to India', async () => {
    /*
     * ⚠️ THE BUG THIS BLOCK EXISTS FOR. `branches.country_code` defaults to `IN`
     *   and registration never set it, so an Irish clinic's only branch was
     *   created Indian — its VAT registration matched nothing, and every invoice
     *   came out untaxed with no error anywhere.
     */
    const { rows } = await owner.query<{ country_code: string }>(
      'SELECT country_code FROM branches WHERE id = $1',
      [dublin.branchId]
    );
    expect(rows[0]?.country_code).toBe('IE');
  });

  it('prices an Irish invoice under the VAT number', async () => {
    const priced = await priceAt(ctxIE, dublin.branchId, 'EUR');
    expect(priced.issuerTaxId).toBe('IE1234567FA');
  });
});
