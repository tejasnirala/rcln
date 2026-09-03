/**
 * Importing a catalogue (PI-24).
 *
 * ⚠️ THE CASES THAT MATTER ARE THE ONES WHERE THE FILE IS WRONG, because that is
 *   the ordinary state of a spreadsheet somebody assembled by hand — and the
 *   whole reason this endpoint exists rather than a loop over `createProduct`.
 *   What is pinned here is that a bad file reports EVERY bad row and writes
 *   NOTHING, and that a dry run is indistinguishable from the real thing except
 *   for the writing.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { productImportRequest } from '@rcln/contracts';

import { importProducts } from '../../src/services/product/import.service.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG = `imp-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let org: { organizationId: string; ownerUserId: string; branchId: string };
let unitCode: string;

const ctx = () => ({
  organizationId: org.organizationId,
  branchIds: [org.branchId],
  userId: org.ownerUserId,
});

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
      phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

/** A minimal valid row, so each case can vary exactly one thing. */
const row = (over: Record<string, unknown> = {}) => ({
  type: 'MEDICINE' as const,
  code: `IMP-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Imported Medicine',
  baseUnitCode: unitCode,
  trackingMode: 'NONE' as const,
  isExpiryControlled: false,
  isStockItem: true,
  ...over,
});

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Imp'));

  const unit = await owner.query<{ code: string }>(
    `SELECT code FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const found = unit.rows[0]?.code;
  if (!found) throw new Error('the seed is missing the PIECE unit');
  unitCode = found;
});

afterAll(async () => {
  if (org?.organizationId) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

async function productCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM products WHERE organization_id = $1',
    [org.organizationId]
  );
  return Number(rows[0]?.n ?? '0');
}

describe('a dry run reports everything and writes nothing', () => {
  it('says what would be created without creating it', async () => {
    const before = await productCount();
    const result = await importProducts(ctx(), { rows: [row(), row()], dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.results.every((r) => r.outcome === 'CREATED')).toBe(true);
    /* ⚠️ `created` IS ZERO ON A DRY RUN, whatever the rows say. Reporting two
     *   here would be the screen telling somebody their catalogue had landed. */
    expect(result.created).toBe(0);
    expect(await productCount()).toBe(before);
  });
});

describe('a file with a bad row lands none of it', () => {
  it('reports every problem, not just the first', async () => {
    const before = await productCount();
    const result = await importProducts(ctx(), {
      rows: [
        row(),
        row({ baseUnitCode: 'NO-SUCH-UNIT' }),
        row({ categoryCode: 'NO-SUCH-CATEGORY' }),
      ],
      dryRun: false,
    });

    expect(result.failed).toBe(2);
    expect(result.results[1]?.message).toMatch(/no unit has the code/i);
    expect(result.results[2]?.message).toMatch(/no category has the code/i);
    /* The good row is reported as it would have landed, and did not. */
    expect(result.results[0]?.outcome).toBe('CREATED');
    expect(await productCount()).toBe(before);
  });

  it('catches a code repeated inside the file, which the unique index would not', async () => {
    /*
     * ⚠️ THE INDEX WOULD ABORT THE TRANSACTION ON THE SECOND ONE and lose the
     *   report for every other row — which is the behaviour this service exists
     *   to avoid, so the duplicate is caught in the loop instead.
     */
    const twice = row();
    const result = await importProducts(ctx(), {
      rows: [twice, { ...twice }],
      dryRun: true,
    });

    expect(result.failed).toBe(1);
    expect(result.results[1]?.message).toMatch(/more than once/i);
  });
});

describe('a clean file lands', () => {
  it('creates the products and carries the barcode onto the product', async () => {
    const before = await productCount();
    const one = row({ barcode: `089${Date.now().toString().slice(-10)}` });

    const result = await importProducts(ctx(), { rows: [one], dryRun: false });

    expect(result.failed).toBe(0);
    expect(result.created).toBe(1);
    expect(await productCount()).toBe(before + 1);

    const { rows: identifiers } = await owner.query<{ value: string; type: string }>(
      `SELECT value, type FROM product_identifiers WHERE product_id = $1`,
      [result.results[0]?.productId]
    );
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]?.type).toBe('GTIN');

    /* Level 0 packaging, always — a product without it is one whose packaging
     * maths refuses. */
    const { rows: packagings } = await owner.query<{ level: number }>(
      `SELECT level FROM product_packagings WHERE product_id = $1`,
      [result.results[0]?.productId]
    );
    expect(packagings).toEqual([{ level: 0 }]);
  });

  it('skips a code that already exists rather than rewriting it', async () => {
    const one = row({ name: 'First name wins' });
    await importProducts(ctx(), { rows: [one], dryRun: false });

    const again = await importProducts(ctx(), {
      rows: [{ ...one, name: 'A stale spreadsheet' }],
      dryRun: false,
    });

    expect(again.skipped).toBe(1);
    expect(again.results[0]?.outcome).toBe('SKIPPED_EXISTS');

    /* ⚠️ THE NAME IS UNCHANGED. An import that quietly rewrote an existing
     *   product would let an old file undo a correction made on the screen. */
    const { rows: found } = await owner.query<{ name: string }>(
      `SELECT name FROM products WHERE organization_id = $1 AND code = $2`,
      [org.organizationId, one.code]
    );
    expect(found[0]?.name).toBe('First name wins');
  });

  it('refuses expiry control on an untracked product, at the CONTRACT', () => {
    /*
     * ⚠️ ASSERTED AGAINST THE SCHEMA, NOT THE SERVICE, BECAUSE THAT IS WHERE THE
     *   RULE LIVES. `productImportRow` carries the same `expiryNeedsBatchTracking`
     *   refinement `createProductRequest` does, and the route validates before
     *   the service is called — so a row like this never reaches `importProducts`
     *   through the API. Calling the service directly with one would reach the
     *   database CHECK instead, which refuses it too but with an error nobody
     *   can act on, and would prove nothing about the import.
     */
    const parsed = productImportRequest.safeParse({
      rows: [row({ isExpiryControlled: true, trackingMode: 'NONE' })],
      dryRun: true,
    });
    expect(parsed.success).toBe(false);
  });
});
