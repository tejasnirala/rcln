/**
 * `GET /stock/resolve` — PI-23's decode → resolve layer, over real HTTP.
 *
 * The decoder itself is pinned exhaustively in `tests/unit/gs1.test.ts`; what is
 * asserted here is the half a unit test cannot reach — that one scanned string
 * finds a product AND a lot AND a device in one round trip, that it finds them
 * when the catalogue and the pack disagree about how long a GTIN is, and that it
 * says so rather than choosing when it cannot tell.
 *
 * ⚠️ THE FAILURE MODE IS "ANSWERS CONFIDENTLY, ANSWERS WRONG", exactly as it is
 *   for `product-resolvers.test.ts` next door. Every defect this file guards
 *   returns a 200 with a real product in it.
 *
 * ⚠️ AND ONE ASSERTION HERE IS ABOUT WHAT IS *NOT* IN THE RESPONSE.
 *   `serials.assigned_patient_id` is PHI, its reads write `data_access_logs`,
 *   and this endpoint runs at a loading bay — so a serial comes back without it.
 *   Adding the field back would be a one-word change that no other test notices.
 *
 * Every fixture is prefixed `SCN-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

const SUFFIX = `s${Date.now().toString(36)}`;
const SLUG = `scn-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

/** ASCII 29 — FNC1. Written as an escape so it is visible in review. */
const GS = '\u001D';

/** A real GTIN: `890` is India's GS1 prefix and the check digit is computed. */
const GTIN13 = '8901234567890';
const GTIN14 = '08901234567890';

const LOT = 'SCN24K118';
const EXPIRY = '2027-08-31';
const SERIAL = 'SCN-DEV-7742';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let token: string;

let productId: string;
let deviceId: string;

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

const resolve = (query: string) =>
  request(app)
    .get(`/api/v1/stock/resolve?${query}`)
    .set('Host', hostFor(SLUG))
    .set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Scan Clinic'));

  await clearRateLimits();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(SLUG))
    .send({ identifier: `${SLUG}@example.test`, password: PASSWORD });
  token = login.body.data.accessToken as string;

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const baseUnit = unit.rows[0]?.id;
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const products = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_expiry_controlled, is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'SCN-AMOX', 'Scan Amoxicillin', $2,
             'LOT_BATCH', true, true, now()),
            (gen_random_uuid(), $1, 'IMPLANT', 'ACTIVE', 'SCN-IMPL', 'Scan Implant', $2,
             'SERIAL', false, true, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  productId = products.rows[0]?.id ?? '';
  deviceId = products.rows[1]?.id ?? '';

  /*
   * ⚠️ THE CATALOGUE HOLDS THIRTEEN DIGITS AND THE PACK CARRIES FOURTEEN, ON
   *   PURPOSE. This is the shape a real clinic ends up in — somebody typed what
   *   was printed under the bars — and it is the case a resolver that normalises
   *   only one way silently fails to find.
   */
  await owner.query(
    `INSERT INTO product_identifiers
       (id, organization_id, product_id, type, value, country_code, is_primary, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'GTIN', $3, NULL, true, now())`,
    [org.organizationId, productId, GTIN13]
  );

  await owner.query(
    `INSERT INTO batches
       (id, organization_id, branch_id, product_id, lot_number, expires_on, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::date, 'ACTIVE', now())`,
    [org.organizationId, org.branchId, productId, LOT, EXPIRY]
  );

  await owner.query(
    `INSERT INTO serials
       (id, organization_id, branch_id, product_id, serial_number, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'IN_STOCK', now())`,
    [org.organizationId, org.branchId, deviceId, SERIAL]
  );
}, 30_000);

afterAll(async () => {
  if (org?.organizationId) {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('one scan, three answers', () => {
  it('reads a DataMatrix into the product, the lot and the expiry at once', async () => {
    const code = `01${GTIN14}17270831${GS}10${LOT}`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.format).toBe('GS1');
    expect(res.body.data.decoded.gtin).toBe(GTIN14);
    expect(res.body.data.decoded.lotNumber).toBe(LOT);
    expect(res.body.data.decoded.expiresOn).toBe(EXPIRY);

    /*
     * ⚠️ THE PRODUCT IS FOUND THROUGH A THIRTEEN-DIGIT CATALOGUE ROW FROM A
     *   FOURTEEN-DIGIT SCAN. Search one form only and this is empty — with no
     *   error, no log and nothing to reproduce it from.
     */
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.products[0].productCode).toBe('SCN-AMOX');
    expect(res.body.data.products[0].matchedOn.value).toBe(GTIN13);

    expect(res.body.data.batches).toHaveLength(1);
    expect(res.body.data.batches[0].lotNumber).toBe(LOT);
    expect(res.body.data.batches[0].isDispensable).toBe(true);
    expect(res.body.data.batches[0].expiryMatchesScan).toBe(true);
    expect(res.body.data.isAmbiguous).toBe(false);
  });

  it('resolves the same product from the plain thirteen-digit barcode', async () => {
    const res = await resolve(`code=${GTIN13}`);

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.format).toBe('GTIN');
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.products[0].productCode).toBe('SCN-AMOX');
  });

  /*
   * ⚠️ THE REASON TO SCAN AT A GOODS RECEIPT AT ALL. The pack says one date and
   *   the lot on file says another: either the wrong lot was picked or the wrong
   *   date was typed at receipt, and this is the only moment anybody is holding
   *   both. Reported, never silently reconciled.
   */
  it('reports a pack whose expiry disagrees with the lot on file', async () => {
    const code = `01${GTIN14}17280831${GS}10${LOT}`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.expiresOn).toBe('2028-08-31');
    expect(res.body.data.batches[0].expiryMatchesScan).toBe(false);
  });

  /*
   * ⚠️ THE LOT IS FOUND EVEN WHEN THE PRODUCT IS NOT. A GTIN nobody has
   *   catalogued still carries a lot number that is very often already on file
   *   from a delivery somebody keyed by hand — refusing to look because the
   *   product half failed throws away the half that succeeded.
   */
  it('finds the lot when the barcode belongs to no product here', async () => {
    const code = `0100000012345670${GS}10${LOT}`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
    expect(res.body.data.batches).toHaveLength(1);
    expect(res.body.data.batches[0].lotNumber).toBe(LOT);
  });

  it('finds a device by its serial number', async () => {
    const code = `21${SERIAL}`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.serials).toHaveLength(1);
    expect(res.body.data.serials[0].serialNumber).toBe(SERIAL);
    expect(res.body.data.serials[0].status).toBe('IN_STOCK');
  });

  /*
   * ⚠️ NO PATIENT FIELD, AND THIS IS THE ASSERTION THAT KEEPS IT THAT WAY.
   *   Selecting `assigned_patient_id` here would be one word, would break no
   *   other test, and would put a PHI disclosure on the hottest endpoint in the
   *   programme — one `data_access_logs` row per scan, at a loading bay, for a
   *   question nobody at a loading bay asked.
   */
  it('never returns which patient a device is in', async () => {
    const res = await resolve(`code=${encodeURIComponent(`21${SERIAL}`)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.serials[0]).not.toHaveProperty('assignedPatientId');
    expect(JSON.stringify(res.body)).not.toContain('assignedPatient');
  });
});

describe('what it does when it cannot be sure', () => {
  /*
   * ⚠️ A CODE THAT MATCHES NOTHING IS A 200, NOT A 404. "This is GTIN X, lot Y,
   *   expiring next August, and you have never stocked it" is the sentence that
   *   tells a storekeeper the DELIVERY is wrong rather than the scanner.
   */
  it('answers with the decode and three empty lists for stock it has never held', async () => {
    const code = `0100000012345670${GS}10SCN-NEVER-SEEN`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.lotNumber).toBe('SCN-NEVER-SEEN');
    expect(res.body.data.products).toEqual([]);
    expect(res.body.data.batches).toEqual([]);
    expect(res.body.data.serials).toEqual([]);
  });

  /*
   * ⚠️ AN UNKNOWN AI STOPS THE PARSE AND THE REMAINDER COMES BACK VERBATIM.
   *   Skipping it would resume reading in the MIDDLE of somebody's data and
   *   produce a lot number that looks entirely plausible and is not the one on
   *   the box.
   */
  it('hands back what it refused to read, rather than guessing past it', async () => {
    const code = `01${GTIN14}9912345`;
    const res = await resolve(`code=${encodeURIComponent(code)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.unparsed).toBe('9912345');
    expect(res.body.data.decoded.warnings).toContain('UNKNOWN_APPLICATION_IDENTIFIER');
  });

  it('reports a mis-read check digit instead of resolving it quietly', async () => {
    const res = await resolve('code=8901234567891');

    expect(res.status).toBe(200);
    expect(res.body.data.decoded.warnings).toContain('CHECK_DIGIT_FAILED');
  });

  /*
   * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a branch outside the caller's scope. RLS
   *   has already made the row invisible and a 403 would confirm the id is real
   *   to somebody probing.
   */
  it('answers 404 for a branch the caller may not see', async () => {
    const res = await resolve(`code=${GTIN13}&branchId=00000000-0000-4000-8000-000000000000`);

    expect(res.status).toBe(404);
  });

  it('refuses an empty code at the contract, before any lookup runs', async () => {
    const res = await resolve('code=');

    expect(res.status).toBe(400);
  });
});
