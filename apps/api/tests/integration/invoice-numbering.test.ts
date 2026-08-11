/**
 * Invoice serials against real Postgres, real RLS and a real branch row.
 *
 * `numbering.test.ts` already proves the counter is gapless under concurrency.
 * What only this suite can prove is the part that is specific to an invoice, and
 * every case is one where the failure is silent and permanent once numbers have
 * been issued:
 *
 *   1. The branch code really is in the number. Without it two branches sharing
 *      one GSTIN issue two different invoices with the same serial, which is the
 *      one thing a GST series may not do — and every total on both is correct.
 *   2. The reset cadence is read from the branch's country, not assumed. An
 *      Indian series that restarted on 1 January would split one financial
 *      year's return in two.
 *   3. The printed year is the START of the period, so February 2027 inside FY
 *      2026-27 still reads INV-2026-.
 *   4. The period is the BRANCH-LOCAL date. 23:40 IST on 31 March is the year
 *      that ends that day; read in UTC it lands in the next one.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { issueInvoiceNumber } =
  await import('../../src/services/invoicing/invoice-number.service.js');

const SUFFIX = `n${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;
/** A second Indian branch, sharing nothing but the tenant. */
let branch2: string;
/** An Irish branch — calendar year, not financial. */
let branchIE: string;

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

  org = await registerOrganization(payload(`invnum-${SUFFIX}`, 'InvNum'));

  const second = await owner.query<{ id: string }>(
    `INSERT INTO branches (id, organization_id, code, name, country_code, region_code,
                           timezone, updated_at)
     VALUES (gen_random_uuid(), $1, 'ANNEX', 'InvNum Annex', 'IN', 'KA', 'Asia/Kolkata', now())
     RETURNING id`,
    [org.organizationId]
  );
  branch2 = second.rows[0]!.id;

  const irish = await owner.query<{ id: string }>(
    `INSERT INTO branches (id, organization_id, code, name, country_code,
                           timezone, updated_at)
     VALUES (gen_random_uuid(), $1, 'DUB', 'InvNum Dublin', 'IE', 'Europe/Dublin', now())
     RETURNING id`,
    [org.organizationId]
  );
  branchIE = irish.rows[0]!.id;

  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId, branch2, branchIE],
    userId: org.ownerUserId,
  };
}, 30_000);

afterAll(async () => {
  if (org?.organizationId) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
  }
  if (org?.ownerUserId) {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }
  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const issue = (branchId: string, sourceType: 'APPOINTMENT' | 'PHARMACY' | 'OTHER', at: Date) =>
  withTenant(ctx, (tx) => issueInvoiceNumber(tx, ctx, { branchId, sourceType, issuedAt: at }));

const AUGUST_2026 = new Date('2026-08-09T06:00:00Z');

describe('the shape of an invoice number', () => {
  it('is INV-{year}-{source}-{branch}-{seq}, and counts up', async () => {
    const first = await issue(org.branchId, 'APPOINTMENT', AUGUST_2026);
    const second = await issue(org.branchId, 'APPOINTMENT', AUGUST_2026);

    expect(first.formatted).toBe('INV-2026-APP-MAIN-000001');
    expect(second.formatted).toBe('INV-2026-APP-MAIN-000002');
  });

  /*
   * ⚠️ THE CASE THE BRANCH SEGMENT EXISTS FOR. Two branches sharing one GSTIN
   *   both start at 1, which is correct — each is its own series, and several
   *   series under one registration are allowed. What is NOT allowed is the same
   *   number appearing twice, and without the branch code in the string that is
   *   exactly what these two produce. The arithmetic on both invoices is right,
   *   which is why nothing else would catch it.
   */
  it('gives two branches separate series that cannot collide', async () => {
    const main = await issue(org.branchId, 'PHARMACY', AUGUST_2026);
    const annex = await issue(branch2, 'PHARMACY', AUGUST_2026);

    expect(main.number).toBe(1);
    expect(annex.number).toBe(1);
    expect(main.formatted).toBe('INV-2026-PHA-MAIN-000001');
    expect(annex.formatted).toBe('INV-2026-PHA-ANNEX-000001');
    expect(main.formatted).not.toBe(annex.formatted);
  });

  it('gives each source its own series at the same branch', async () => {
    const other = await issue(branch2, 'OTHER', AUGUST_2026);
    expect(other.formatted).toBe('INV-2026-OTH-ANNEX-000001');
  });
});

describe('the reset cadence comes from the country', () => {
  /*
   * ⚠️ India's GST series runs on the financial year, so a February invoice is
   *   still inside FY 2026-27 and still prints INV-2026-. A number that flipped
   *   to INV-2027- on 1 January would split one return's series in two.
   */
  it('keeps the start year across the new calendar year in India', async () => {
    const february = await issue(branch2, 'APPOINTMENT', new Date('2027-02-14T06:00:00Z'));
    expect(february.formatted).toBe('INV-2026-APP-ANNEX-000001');

    // April is the next financial year: a fresh counter, back to 1.
    const april = await issue(branch2, 'APPOINTMENT', new Date('2027-04-02T06:00:00Z'));
    expect(april.formatted).toBe('INV-2027-APP-ANNEX-000001');
  });

  /*
   * ⚠️ Ireland has no financial-year series. Hard-coding India's cadence here is
   *   the "do not assume India" failure, and it is not correctable once numbers
   *   have been issued.
   */
  it('uses the calendar year outside India', async () => {
    const february = await issue(branchIE, 'APPOINTMENT', new Date('2027-02-14T06:00:00Z'));
    expect(february.formatted).toBe('INV-2027-APP-DUB-000001');
  });
});

/*
 * ⚠️ 23:40 on 31 March in Kolkata is 18:10 UTC on the same day, so both readings
 *   agree — the case that separates them is the other side of midnight. 00:30 IST
 *   on 1 April is 19:00 UTC on 31 MARCH: read as an instant it belongs to the old
 *   financial year, read in the clinic's own zone it starts the new one. The
 *   clinic's zone is the answer, and it is resolved in Postgres because the
 *   container's zone is UTC and the browser's is the user's.
 */
describe('the period is the branch-local date', () => {
  it('files a just-after-midnight IST invoice in the new financial year', async () => {
    const issued = await issue(org.branchId, 'OTHER', new Date('2027-03-31T19:00:00Z'));
    expect(issued.formatted).toBe('INV-2027-OTH-MAIN-000001');
  });

  it('files a just-before-midnight IST invoice in the old one', async () => {
    const issued = await issue(org.branchId, 'OTHER', new Date('2027-03-31T18:00:00Z'));
    expect(issued.formatted).toBe('INV-2026-OTH-MAIN-000001');
  });
});

/*
 * Under RLS another tenant's branch is indistinguishable from one that does not
 * exist, and both answers are the same: there is no series to issue from.
 * Falling back to the organization would print a plausible number on the wrong
 * series — the same call `loadTaxContext` makes about the place of supply.
 */
it('refuses a branch it cannot see rather than falling back', async () => {
  await expect(issue('00000000-0000-4000-8000-000000000000', 'OTHER', AUGUST_2026)).rejects.toThrow(
    /branch/i
  );
});
