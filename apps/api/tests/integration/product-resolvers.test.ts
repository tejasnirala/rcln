/**
 * The two product RESOLVERS, over real HTTP and against a real database.
 *
 * These are the reads that answer "what did I just scan?" and "what tax applies
 * here?", and both shipped with the same defect: a Prisma `where` built as
 *
 *     { ...(cond ? { OR: a } : {}), someOtherKey, OR: b }
 *
 * An object literal takes the LAST value for a repeated key, and a SPREAD
 * COUNTS. So `OR: a` was silently discarded in both, and neither TypeScript nor
 * eslint had anything to say about it. The predicate that vanished was the
 * jurisdiction filter in each case, which is the one that decides correctness.
 *
 * ⚠️ THE FAILURE MODE IS "ANSWERS CONFIDENTLY, ANSWERS WRONG", WHICH IS WHY
 *   THESE TESTS EXIST AT THE HTTP LAYER. Both resolvers kept returning a row.
 *   Nothing threw, nothing logged, no count went to zero — the barcode resolved
 *   to a real product and the tax lookup returned a real category, just not the
 *   right ones. The only way to catch that is to plant a DECOY in another
 *   jurisdiction and assert which of the two comes back.
 *
 * Every fixture is prefixed `RSV-` and is torn down with the organizations.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { resolveTaxCategoryForTenant } from '../../src/services/product/tax-classification.service.js';
import { createUnitConversion } from '../../src/services/product/unit.service.js';

const SUFFIX = `r${Date.now().toString(36)}`;
const SLUG_A = `rsv-a-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let A: ReturnType<typeof asOrg>;

/** The two products these tests resolve against, and the unit they share. */
let productIn: string;
let productUs: string;
let baseUnit: string;

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

async function clearRateLimits(): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function tokenFor(slug: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier: `${slug}@example.test`, password: PASSWORD });
  return res.body.data.accessToken as string;
}

const asOrg = (slug: string, token: string) => ({
  get: (path: string) =>
    request(app)
      .get(`/api/v1/products${path}`)
      .set('Host', hostFor(slug))
      .set('Authorization', `Bearer ${token}`),
});

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  orgA = await registerOrganization(payload(SLUG_A, 'Rsv A'));
  A = asOrg(SLUG_A, await tokenFor(SLUG_A));

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');
  baseUnit = unitId;

  /*
   * Two products in ONE tenant. The point is not isolation — tenant-isolation
   * covers that — it is that a jurisdiction predicate distinguishes two rows the
   * caller is fully entitled to see. That is the case a tenancy test cannot
   * reach, and it is the case that was broken.
   */
  const made = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'RSV-PROD-IN', 'Resolver Product IN', $2, now()),
            (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'RSV-PROD-US', 'Resolver Product US', $2, now())
     RETURNING id`,
    [orgA.organizationId, baseUnit]
  );
  productIn = made.rows[0]?.id ?? '';
  productUs = made.rows[1]?.id ?? '';
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId].filter(Boolean);

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

/* ------------------------------------------------------------------ *
 * GET /products/resolve — the barcode scanner's endpoint
 * ------------------------------------------------------------------ */

describe('resolving an identifier', () => {
  /**
   * ⚠️ THE SAME VALUE AGAINST TWO COUNTRIES IS THE WHOLE POINT, NOT AN EDGE
   *   CASE. National drug codes are assigned per country and genuinely collide
   *   — that is why `product_identifiers.country_code` exists at all. If the
   *   country predicate is dropped, a scan in India can resolve to whatever
   *   medicine holds that code in the United States.
   */
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO product_identifiers
         (id, organization_id, product_id, type, value, country_code, is_primary, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'NATIONAL_CODE', 'RSV-COLLIDE-1', 'IN', true, now()),
              (gen_random_uuid(), $1, $3, 'NATIONAL_CODE', 'RSV-COLLIDE-1', 'US', true, now())`,
      [orgA.organizationId, productIn, productUs]
    );
  });

  /**
   * ⚠️ THE ENDPOINT ANSWERS WITH EVERY MATCH, DELIBERATELY, so the assertion
   *   that matters is what is ABSENT. `resolveIdentifierResponse.matches` is an
   *   array because the same digits legitimately resolve to more than one
   *   product and the caller has to disambiguate rather than be handed a guess.
   *
   *   That makes `toHaveLength(1)` the load-bearing half of each test below,
   *   not `[0].product.code`. With the country predicate dropped, the IN scan
   *   still contained the right product — it just also contained the American
   *   one, and a caller that takes the first match, or a screen that skips
   *   disambiguation when there is "only one obvious" answer, dispenses on it.
   */
  const codesFrom = (res: { body: { data: { matches: { product: { code: string } }[] } } }) =>
    res.body.data.matches.map((m) => m.product.code);

  it('returns only the asked-for country’s product, not the collision', async () => {
    const res = await A.get('/resolve?value=RSV-COLLIDE-1&countryCode=IN');

    expect(res.status).toBe(200);
    expect(codesFrom(res)).toEqual(['RSV-PROD-IN']);
  });

  it('returns the OTHER country’s product when that country is asked for', async () => {
    /*
     * Both directions, because a bug that always returns the first row by some
     * incidental ordering passes the test above by luck. Asking for each in turn
     * and getting a different answer each time is the only assertion that
     * distinguishes "filtered" from "happened to be first".
     */
    const res = await A.get('/resolve?value=RSV-COLLIDE-1&countryCode=US');

    expect(res.status).toBe(200);
    expect(codesFrom(res)).toEqual(['RSV-PROD-US']);
  });

  it('returns BOTH when no country is named, because both are genuine matches', async () => {
    /*
     * The unqualified scan is not supposed to filter — it is supposed to hand
     * the caller the ambiguity to resolve. This is what stops a fix from
     * over-correcting into "always filter by something".
     */
    const res = await A.get('/resolve?value=RSV-COLLIDE-1');

    expect(res.status).toBe(200);
    expect(codesFrom(res).sort()).toEqual(['RSV-PROD-IN', 'RSV-PROD-US']);
  });

  it('still matches an identifier recorded with NO country', async () => {
    /*
     * NULL country means "valid everywhere", and most of the platform catalogue
     * is recorded that way. A fix that scoped the country predicate too tightly
     * would drop all of it — so this is the guard on the guard.
     */
    await owner.query(
      `INSERT INTO product_identifiers
         (id, organization_id, product_id, type, value, country_code, is_primary, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'GTIN', 'RSV-GLOBAL-1', NULL, true, now())`,
      [orgA.organizationId, productIn]
    );

    const res = await A.get('/resolve?value=RSV-GLOBAL-1&countryCode=IN');

    expect(res.status).toBe(200);
    expect(codesFrom(res)).toEqual(['RSV-PROD-IN']);
  });

  it('answers with an empty list, not a 404, for a value that does not exist', async () => {
    const res = await A.get('/resolve?value=RSV-NOT-A-CODE&countryCode=IN');

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * resolveTaxCategoryForTenant — no route yet, called directly
 * ------------------------------------------------------------------ */

describe('resolving a tax category', () => {
  /**
   * ⚠️ THIS RESOLVER HAS NO ROUTE YET, AND IS TESTED ANYWAY. It is the seam
   *   billing will call in a later phase, and it shipped with the region filter
   *   silently discarded. Waiting for a caller to exist before testing it means
   *   the first caller is what discovers the bug — on an invoice.
   *
   *   The ordering rule is what makes the broken version dangerous rather than
   *   merely wrong: with the region predicate gone the query returns EVERY
   *   region in the country, and `regionCode: 'desc'` then deliberately prefers
   *   a non-NULL region. So the wrong state's rate wins over the correct
   *   country-wide default.
   */
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO product_tax_classifications
         (id, organization_id, product_id, country_code, region_code, tax_category,
          item_code, effective_from, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'IN', NULL, 'GST_12', 'RSV-HSN-CTY', DATE '2026-01-01', now()),
         (gen_random_uuid(), $1, $2, 'IN', 'KA', 'GST_05', 'RSV-HSN-KA',  DATE '2026-01-01', now()),
         (gen_random_uuid(), $1, $2, 'IN', 'TN', 'GST_28', 'RSV-HSN-TN',  DATE '2026-01-01', now())`,
      [orgA.organizationId, productIn]
    );
  });

  const ctx = () => ({
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  });

  it('prefers the asked-for region over the country default', async () => {
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'IN', regionCode: 'KA' },
      new Date('2026-06-01')
    );

    expect(res.taxCategory).toBe('GST_05');
    expect(res.itemCode).toBe('RSV-HSN-KA');
  });

  it('never returns a DIFFERENT region’s rate', async () => {
    /*
     * `TN` sorts after `KA`, so under the broken version this exact call
     * returned GST_28 — Tamil Nadu's rate, on a Karnataka invoice. This is the
     * assertion the bug fails.
     */
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'IN', regionCode: 'KA' },
      new Date('2026-06-01')
    );

    expect(res.taxCategory).not.toBe('GST_28');
  });

  it('falls back to the country row for a region with no entry of its own', async () => {
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'IN', regionCode: 'MH' },
      new Date('2026-06-01')
    );

    expect(res.taxCategory).toBe('GST_12');
    expect(res.itemCode).toBe('RSV-HSN-CTY');
  });

  it('takes the country row when no region is named at all', async () => {
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'IN' },
      new Date('2026-06-01')
    );

    expect(res.taxCategory).toBe('GST_12');
  });

  it('returns nothing for a country with no classification', async () => {
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'AE' },
      new Date('2026-06-01')
    );

    expect(res.taxCategory).toBeNull();
  });

  it('ignores a classification that is not yet effective', async () => {
    const res = await resolveTaxCategoryForTenant(
      ctx(),
      productIn,
      { countryCode: 'IN', regionCode: 'KA' },
      new Date('2025-06-01')
    );

    expect(res.taxCategory).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Recording a unit conversion — the third thing that resolves against
 * data already in the database rather than against its own arguments.
 * ------------------------------------------------------------------ */

describe('recording a unit conversion', () => {
  /**
   * ⚠️ THE DUPLICATE-PAIR CHECK IS NOT THE INTERESTING ONE. A contradiction does
   *   not need two rows for the same pair — it only needs a new edge that
   *   disagrees with a path the graph already has. And because
   *   `conversionFactor` is breadth-first, the new SHORTER edge WINS over the
   *   correct longer path, so the clinic's answer to "how many of these in one
   *   of those" changes silently for every product involved.
   *
   *   `product-units.test.ts` proves the one-hop-wins behaviour on a pure graph.
   *   This proves the write is refused before it can get in.
   */
  let boxId: string;
  let stripId: string;
  let tabId: string;

  const ctx = () => ({
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  });

  beforeAll(async () => {
    const units = await owner.query<{ id: string }>(
      `INSERT INTO units_of_measure (id, organization_id, code, name, symbol, unit_class, updated_at)
       VALUES (gen_random_uuid(), $1, 'RSV-BOX',   'Rsv Box',   'rbx', 'COUNT', now()),
              (gen_random_uuid(), $1, 'RSV-STRIP', 'Rsv Strip', 'rst', 'COUNT', now()),
              (gen_random_uuid(), $1, 'RSV-TAB',   'Rsv Tab',   'rtb', 'COUNT', now())
       RETURNING id`,
      [orgA.organizationId]
    );
    boxId = units.rows[0]?.id ?? '';
    stripId = units.rows[1]?.id ?? '';
    tabId = units.rows[2]?.id ?? '';

    // STRIP = 10 TAB, BOX = 10 STRIP. So BOX is 100 TAB, by the two-hop path.
    await createUnitConversion(ctx(), {
      fromUnitId: stripId,
      toUnitId: tabId,
      numerator: 10,
      denominator: 1,
    });
    await createUnitConversion(ctx(), {
      fromUnitId: boxId,
      toUnitId: stripId,
      numerator: 10,
      denominator: 1,
    });
  });

  it('refuses an edge that contradicts a path already in the graph', async () => {
    await expect(
      createUnitConversion(ctx(), {
        fromUnitId: boxId,
        toUnitId: tabId,
        numerator: 90,
        denominator: 1,
      })
    ).rejects.toThrow(/already converts/i);
  });

  it('accepts an edge that AGREES with the existing path', async () => {
    /*
     * Redundant but consistent. Refusing this too would be the easy
     * over-correction, and it would block a clinic recording the shortcut it
     * actually thinks in — "a box is a hundred tablets" — which is legitimate.
     */
    const created = await createUnitConversion(ctx(), {
      fromUnitId: boxId,
      toUnitId: tabId,
      numerator: 100,
      denominator: 1,
    });

    expect(created).toBeDefined();
  });

  it('still refuses a second row for the same pair, in either direction', async () => {
    await expect(
      createUnitConversion(ctx(), {
        fromUnitId: tabId,
        toUnitId: boxId,
        numerator: 1,
        denominator: 100,
      })
    ).rejects.toThrow(/already exists/i);
  });
});
