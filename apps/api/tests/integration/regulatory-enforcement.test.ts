/**
 * PI-6.7 — the call sites actually consult the law, and the gate decides whether
 * the answer stops them.
 *
 * ⚠️ THE FIRST TEST IS THE ONE THAT MATTERS MOST AND IT ASSERTS THAT NOTHING
 *   HAPPENS. A rule that refuses, from a pack nobody has signed off, must let
 *   the receipt post. Get that wrong and every clinic in every unconfigured
 *   country — which is all but one — stops being able to receive stock, and it
 *   presents as the regulatory feature working.
 *
 * ⚠️ THE FICTIONAL COUNTRY IS `ZY`, NOT `ZQ`. `regulatory.test.ts` owns `ZQ` and
 *   DELETES every `ZQ` row in its own `beforeAll` and `afterAll` — jest runs
 *   suites in parallel, so sharing the code would have this file's fixtures
 *   vanish mid-run, intermittently, in whichever suite lost the race.
 *
 * Nothing here is a legal position on anywhere real.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { withTenant } from '@rcln/db';
import { consultForStockMovement } from '../../src/services/regulatory/consult.js';

const SUFFIX = `e${Date.now().toString(36)}`;
const SLUG = `enf-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: { organizationId: string; branchIds: string[]; userId: string };

let packId = '';
let productId = '';
let locationId = '';

async function clearFixtures(): Promise<void> {
  await owner.query(`
    DELETE FROM regulatory_rules
     WHERE pack_id IN (
       SELECT p.id FROM regulatory_rule_packs p
         JOIN jurisdictions j ON j.id = p.jurisdiction_id
        WHERE j.country_code = 'ZY')`);
  await owner.query(`
    DELETE FROM product_regulatory_profiles
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZY')`);
  await owner.query(`
    DELETE FROM regulatory_rule_packs
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZY')`);
  await owner.query(`
    DELETE FROM regulatory_sources
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZY')`);
  await owner.query(`
    DELETE FROM regulatory_authorities
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZY')`);
  await owner.query(`DELETE FROM jurisdictions WHERE country_code = 'ZY'`);
}

/**
 * Move the fixture pack up or down the ladder, by hand.
 *
 * ⚠️ THE REVIEWER FIELDS ARE SET TOO, BECAUSE THE DATABASE INSISTS AND IS RIGHT
 *   TO. `regulatory_rule_packs_review_recorded` refuses `REGULATORY_REVIEWED` or
 *   `PRODUCTION_ENABLED` unless `reviewed_by` and `reviewed_at` are both
 *   present — a sign-off with nobody's name on it is not a sign-off. This test
 *   writes them directly rather than going through `approveRulePack` only
 *   because it needs to move the pack up and down repeatedly; the constraint is
 *   what makes the shortcut honest.
 */
async function setMaturity(maturity: string): Promise<void> {
  const reviewed = maturity === 'REGULATORY_REVIEWED' || maturity === 'PRODUCTION_ENABLED';
  await owner.query(
    `UPDATE regulatory_rule_packs
        SET maturity = $1::"RulePackMaturity",
            reviewed_by = $2,
            reviewed_at = $3
      WHERE id = $4`,
    [maturity, reviewed ? 'Test Reviewer' : null, reviewed ? new Date() : null, packId]
  );
}

const consult = async () =>
  withTenant(ctx, async (tx) =>
    consultForStockMovement(tx, ctx, {
      branchId: org.branchId,
      productId,
      locationId,
      quantityBase: '1',
      transaction: 'STOCK',
      occurredAt: new Date(),
      documentType: 'GOODS_RECEIPT',
      documentId: '00000000-0000-0000-0000-000000000000',
    })
  );

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization({
    organization: {
      legalName: 'Enforcement Co Pvt Ltd',
      displayName: 'Enforcement Co',
      slug: SLUG,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: 'Enforcement Main', code: 'MAIN' },
    owner: {
      fullName: 'Enforcement Owner',
      email: `${SLUG}@example.test`,
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  } as never);
  ctx = { organizationId: org.organizationId, branchIds: [org.branchId], userId: org.ownerUserId };

  /*
   * ⚠️ THE BRANCH IS MOVED TO THE FICTIONAL COUNTRY, NOT THE ORGANIZATION. The
   *   evaluation takes its jurisdiction from the BRANCH — a supply happens where
   *   the counter is — so this is the field that decides which pack applies.
   */
  await owner.query(`UPDATE branches SET country_code = 'ZY' WHERE id = $1`, [org.branchId]);

  await clearFixtures();

  const place = await owner.query<{ id: string }>(
    `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
     VALUES (gen_random_uuid(), 'ZY', NULL, 'Enforcement Country', now()) RETURNING id`
  );
  const jurisdictionId = place.rows[0]?.id ?? '';

  const authority = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_authorities (id, jurisdiction_id, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'ENF-AUTH-${SUFFIX}', 'Enforcement Authority', now())
     RETURNING id`,
    [jurisdictionId]
  );
  const authorityId = authority.rows[0]?.id ?? '';

  const source = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_sources (id, jurisdiction_id, authority_id, title, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Enforcement Country Medicines Act', now()) RETURNING id`,
    [jurisdictionId, authorityId]
  );
  const sourceId = source.rows[0]?.id ?? '';

  const pack = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_rule_packs
       (id, jurisdiction_id, authority_id, version, name, maturity, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '1.0.0', 'Enforcement pack', 'RULES_IMPLEMENTED',
             DATE '2020-01-01', now())
     RETURNING id`,
    [jurisdictionId, authorityId]
  );
  packId = pack.rows[0]?.id ?? '';

  // A storage rule that refuses everything: it may only be kept somewhere this
  // fixture never puts it.
  await owner.query(
    `INSERT INTO regulatory_rules
       (id, pack_id, rule_type, code, statement, status, applies_to_classification,
        applies_to_transactions, parameters, source_id, version, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'STORAGE_REQUIREMENT', 'ENF_LOCKED',
             'Keep this in the controlled cabinet.', 'ACTIVE', 'ENF_SCHEDULED',
             ARRAY['STOCK','TRANSFER']::"RegulatoryTransactionType"[],
             $2::jsonb, $3, 1, DATE '2020-01-01', now())`,
    [packId, JSON.stringify({ locationKinds: ['CONTROLLED_CABINET'] }), sourceId]
  );

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  const product = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'ENF-PROD', 'Enforcement Product', $2, now())
     RETURNING id`,
    [org.organizationId, unitId]
  );
  productId = product.rows[0]?.id ?? '';

  await owner.query(
    `INSERT INTO product_regulatory_profiles
       (id, organization_id, product_id, jurisdiction_id, classification,
        prescription_requirement, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'ENF_SCHEDULED', 'PRESCRIPTION_REQUIRED',
             DATE '2020-01-01', now())`,
    [org.organizationId, productId, jurisdictionId]
  );

  const location = await owner.query<{ id: string }>(
    `INSERT INTO inventory_locations
       (id, organization_id, branch_id, kind, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'MAIN_PHARMACY', 'ENF-SHELF', 'Enforcement Shelf', now())
     RETURNING id`,
    [org.organizationId, org.branchId]
  );
  locationId = location.rows[0]?.id ?? '';
}, 30_000);

afterAll(async () => {
  if (org?.ownerUserId) {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
  }
  if (org?.organizationId) {
    await owner?.query('DELETE FROM product_regulatory_profiles WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
  }
  if (org?.ownerUserId) {
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }
  await clearFixtures();

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('a rule that refuses, from a pack nobody has signed off', () => {
  it.each([
    'RULES_CONFIGURED',
    'RULES_IMPLEMENTED',
    'AUTOMATED_TESTED',
    'SOURCE_VERIFIED',
    'REGULATORY_REVIEW_PENDING',
    'REGULATORY_REVIEWED',
  ])('lets the movement through at %s', async (maturity) => {
    await setMaturity(maturity);

    await expect(consult()).resolves.toBeUndefined();
  });
});

describe('once a human has signed the pack off', () => {
  it('stops the movement', async () => {
    await setMaturity('PRODUCTION_ENABLED');

    await expect(consult()).rejects.toThrow(/controlled cabinet/i);
  });

  it('gives back the rule’s own sentence, which says what to do', async () => {
    await setMaturity('PRODUCTION_ENABLED');

    await expect(consult()).rejects.toThrow(/Keep this in the controlled cabinet\./);
  });
});

describe('a jurisdiction nobody has configured', () => {
  it('does not stop the movement, even though it answers UNDETERMINED', async () => {
    /*
     * ⚠️ THE CASE THAT WOULD HAVE BROKEN EVERY CLINIC ON THE PLATFORM. With the
     *   branch moved somewhere with no pack at all, the engine answers
     *   UNDETERMINED — which refuses — and the gate is the only thing between
     *   that and a receipt path nobody outside one country could use.
     */
    await owner.query(`UPDATE branches SET country_code = 'ZX' WHERE id = $1`, [org.branchId]);

    await expect(consult()).resolves.toBeUndefined();

    await owner.query(`UPDATE branches SET country_code = 'ZY' WHERE id = $1`, [org.branchId]);
  });
});
