/**
 * The regulatory framework end to end, over real HTTP and a real database.
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE ONES WHERE NOTHING IS CONFIGURED. A
 *   permissive default is invisible in every other test — everything works,
 *   every request succeeds — and the failure is a controlled medicine handed
 *   over in a jurisdiction nobody set up. `UNDETERMINED` refuses, and this file
 *   pins that at the HTTP boundary rather than only in the pure package, because
 *   a service that quietly answered `PERMITTED` when no rule matched would still
 *   pass every unit test in `@rcln/regulatory`.
 *
 * ⚠️ NO COUNTRY'S REAL RULES APPEAR HERE. The fixtures are a fictional `ZQ` so
 *   that nothing in this file can be read as a legal position on anywhere real.
 *
 * Every fixture is prefixed `REG-` and torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import request from 'supertest';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { createApp } from '../../src/app.js';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';
import { replaceRegulatoryProfiles } from '../../src/services/regulatory/profile.service.js';
import {
  approveRulePack,
  createRule,
  updateRulePack,
} from '../../src/services/platform/regulatory.service.js';

const SUFFIX = `g${Date.now().toString(36)}`;
const SLUG = `reg-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ROOT = process.env['ROOT_DOMAIN'] ?? 'lvh.me';
const hostFor = (slug: string): string => `${slug}.${ROOT}`;

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;
let app: ReturnType<typeof createApp>;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: { organizationId: string; branchIds: string[]; userId: string };
let token: string;

let jurisdictionCountry: string;
let authorityId: string;
let sourceId: string;
let packId: string;
let productId: string;

/** The actor every evaluation in this file speaks for. */
const PHARMACY_ACTOR = { roleCodes: ['pharmacy.dispense.create'] };

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

/**
 * Remove this file's own platform fixtures, wherever a previous run left them.
 *
 * `ZQ` is not a real ISO country and nothing but this suite writes it, so this
 * is safe to run unconditionally — and it is what makes the suite re-runnable
 * after an interrupted one.
 */
async function clearFictionalJurisdictions(): Promise<void> {
  await owner.query(`
    DELETE FROM regulatory_rules
     WHERE pack_id IN (
       SELECT p.id FROM regulatory_rule_packs p
         JOIN jurisdictions j ON j.id = p.jurisdiction_id
        WHERE j.country_code = 'ZQ')`);
  await owner.query(`
    DELETE FROM product_regulatory_profiles
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZQ')`);
  await owner.query(`
    DELETE FROM regulatory_rule_packs
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZQ')`);
  await owner.query(`
    DELETE FROM regulatory_sources
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZQ')`);
  await owner.query(`
    DELETE FROM regulatory_authorities
     WHERE jurisdiction_id IN (SELECT id FROM jurisdictions WHERE country_code = 'ZQ')`);
  await owner.query(`DELETE FROM jurisdictions WHERE country_code = 'ZQ'`);
}

async function tokenFor(slug: string): Promise<string> {
  await clearRateLimits();
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', hostFor(slug))
    .send({ identifier: `${slug}@example.test`, password: PASSWORD });
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();
  app = createApp();

  org = await registerOrganization(payload(SLUG, 'Reg Co'));
  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId],
    userId: org.ownerUserId,
  };
  token = await tokenFor(SLUG);

  /*
   * The branch registers in IN, so the jurisdiction under test is deliberately a
   * DIFFERENT, fictional country: every evaluation below names `ZQ` explicitly,
   * and the one that does not is the one asserting that an unconfigured place
   * refuses.
   *
   * ⚠️ THE FIXTURE CLEANS UP BEFORE IT SEEDS, NOT ONLY AFTER. `jurisdictions` is
   *   platform data keyed on `(country_code, region_code)`, so unlike a
   *   tenant-scoped fixture it cannot be made unique per run — and a run killed
   *   part way through (a hung concurrency test, a Ctrl-C) leaves `ZQ` behind
   *   and every subsequent run dies in `beforeAll` on a duplicate key. That
   *   happened once while writing the lock test, and it presents as eighteen
   *   unrelated failures.
   */
  await clearFictionalJurisdictions();

  const places = await owner.query<{ id: string }>(
    `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
     VALUES (gen_random_uuid(), 'ZQ', NULL, 'Reg Country', now()),
            (gen_random_uuid(), 'ZQ', 'RG', 'Reg Region',  now())
     RETURNING id`
  );
  /*
   * Both rows are created even though only the country one is referenced here:
   * the region row is what makes `loadRules`' "country-wide AND regional packs
   * are both loaded" query meaningful rather than trivially single-row.
   */
  jurisdictionCountry = places.rows[0]?.id ?? '';

  const authority = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_authorities (id, jurisdiction_id, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'REG-AUTH-${SUFFIX}', 'Reg Authority', now())
     RETURNING id`,
    [jurisdictionCountry]
  );
  authorityId = authority.rows[0]?.id ?? '';

  const source = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_sources (id, jurisdiction_id, authority_id, title, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Reg Country Medicines Act', now())
     RETURNING id`,
    [jurisdictionCountry, authorityId]
  );
  sourceId = source.rows[0]?.id ?? '';

  const pack = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_rule_packs
       (id, jurisdiction_id, authority_id, version, name, maturity, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '1.0.0', 'Reg Country pack', 'RULES_CONFIGURED',
             DATE '2020-01-01', now())
     RETURNING id`,
    [jurisdictionCountry, authorityId]
  );
  packId = pack.rows[0]?.id ?? '';

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  const product = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'REG-PROD', 'Reg Product', $2, now())
     RETURNING id`,
    [org.organizationId, unitId]
  );
  productId = product.rows[0]?.id ?? '';
}, 30_000);

afterAll(async () => {
  if (org?.ownerUserId) {
    await owner?.query('DELETE FROM sessions WHERE user_id = $1', [org.ownerUserId]);
  }
  if (org?.organizationId) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = $1', [org.organizationId]);
    await owner?.query('DELETE FROM organizations WHERE id = $1', [org.organizationId]);
  }
  if (org?.ownerUserId) {
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }

  // By country code rather than by id, so anything this file created — including
  // a pack a mid-suite failure left behind — goes with it.
  await clearFictionalJurisdictions();

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

/* ------------------------------------------------------------------ *
 * Nothing configured
 * ------------------------------------------------------------------ */

describe('a jurisdiction nobody has configured', () => {
  it('answers UNDETERMINED rather than permitting', async () => {
    const decision = await evaluateFor(
      ctx,
      {
        productId,
        transaction: 'DISPENSE',
        countryCode: 'ZW',
        quantityBase: '1',
      } as never,
      PHARMACY_ACTOR
    );

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.packVersionIds).toEqual([]);
    expect(decision.reasons[0]?.message).toContain('No regulatory rule covers');
  });

  it('says whether the product had a profile at all, so the gap is nameable', async () => {
    const decision = await evaluateFor(
      ctx,
      { productId, transaction: 'DISPENSE', countryCode: 'ZQ', quantityBase: '1' } as never,
      PHARMACY_ACTOR
    );

    expect(decision.hasProfile).toBe(false);
    expect(decision.jurisdiction).toBe('ZQ');
  });
});

/* ------------------------------------------------------------------ *
 * Configured
 * ------------------------------------------------------------------ */

describe('once the place has rules and the product has a profile', () => {
  beforeAll(async () => {
    await createRule(packId, {
      ruleType: 'PRESCRIPTION_REQUIRED',
      code: 'REG_POM',
      statement: 'This medicine may only be supplied against a prescription.',
      status: 'ACTIVE',
      appliesToClassification: 'REG_SCHEDULE',
      appliesToTransactions: ['DISPENSE', 'COUNTER_SALE'],
      parameters: { required: true, validityDays: 30 },
      sourceId,
      effectiveFrom: '2020-01-01',
    } as never);

    await replaceRegulatoryProfiles(ctx, productId, {
      profiles: [
        {
          jurisdictionId: jurisdictionCountry,
          classification: 'REG_SCHEDULE',
          registrationStatus: 'REGISTERED',
          prescriptionRequirement: 'PRESCRIPTION_REQUIRED',
          onlineSalePosition: 'UNKNOWN',
          effectiveFrom: '2020-01-01',
        },
      ],
    } as never);
  });

  it('refuses a dispense with no prescription', async () => {
    const decision = await evaluateFor(
      ctx,
      { productId, transaction: 'DISPENSE', countryCode: 'ZQ', quantityBase: '1' } as never,
      PHARMACY_ACTOR
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(decision.reasons[0]?.ruleCode).toBe('REG_POM');
    expect(decision.hasProfile).toBe(true);
  });

  it('permits it when a valid prescription is presented', async () => {
    const issuedOn = new Date().toISOString().slice(0, 10);
    const decision = await evaluateFor(
      ctx,
      {
        productId,
        transaction: 'DISPENSE',
        countryCode: 'ZQ',
        quantityBase: '1',
        prescription: {
          presented: true,
          signedByQualifiedPrescriber: true,
          issuedOn,
          refillsUsed: 0,
        },
      } as never,
      PHARMACY_ACTOR
    );

    expect(decision.outcome).toBe('PERMITTED');
  });

  it('reports the pack maturity, so the screen cannot imply compliance', async () => {
    const decision = await evaluateFor(
      ctx,
      { productId, transaction: 'DISPENSE', countryCode: 'ZQ', quantityBase: '1' } as never,
      PHARMACY_ACTOR
    );

    expect(decision.lowestPackMaturity).toBe('RULES_CONFIGURED');
    expect(decision.packVersionIds).toEqual([packId]);
  });

  it('does not apply the rule to a transaction it does not name', async () => {
    // The rule speaks to DISPENSE and COUNTER_SALE. A stock movement is neither,
    // so nothing applies — and nothing applying is UNDETERMINED, not permitted.
    const decision = await evaluateFor(
      ctx,
      { productId, transaction: 'STOCK', countryCode: 'ZQ', quantityBase: '1' } as never,
      PHARMACY_ACTOR
    );

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('stops applying the rule once the profile’s classification no longer matches', async () => {
    await replaceRegulatoryProfiles(ctx, productId, {
      profiles: [
        {
          jurisdictionId: jurisdictionCountry,
          classification: 'REG_GENERAL_SALE',
          registrationStatus: 'REGISTERED',
          prescriptionRequirement: 'NOT_REQUIRED',
          onlineSalePosition: 'UNKNOWN',
          effectiveFrom: '2020-01-01',
        },
      ],
    } as never);

    const decision = await evaluateFor(
      ctx,
      { productId, transaction: 'DISPENSE', countryCode: 'ZQ', quantityBase: '1' } as never,
      PHARMACY_ACTOR
    );

    /*
     * ⚠️ AND IT IS UNDETERMINED RATHER THAN PERMITTED, which is the whole point:
     *   the clinic saying "no prescription needed" removes the rule that MATCHED,
     *   it does not add a rule that permits. A design where a clinic's own
     *   assertion could authorise a supply would make every clinic the author of
     *   its own legal position.
     */
    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * The sign-off ladder
 * ------------------------------------------------------------------ */

describe('advancing a rule pack', () => {
  it('refuses to reach a reviewed state through an ordinary update', async () => {
    await expect(
      updateRulePack(packId, { maturity: 'PRODUCTION_ENABLED' } as never)
    ).rejects.toThrow(/named person/);
  });

  it('refuses a sign-off from a pack that has not been handed over', async () => {
    await expect(
      approveRulePack(
        packId,
        {
          maturity: 'REGULATORY_REVIEWED',
          reviewedBy: 'A. Reviewer',
          reviewNotes: 'Checked every source against the register.',
        },
        org.ownerUserId
      )
    ).rejects.toThrow(/REGULATORY_REVIEW_PENDING/);
  });

  it('records the reviewer’s name and the account that entered it', async () => {
    await updateRulePack(packId, { maturity: 'SOURCE_VERIFIED' } as never);
    await updateRulePack(packId, { maturity: 'REGULATORY_REVIEW_PENDING' } as never);

    const reviewed = await approveRulePack(
      packId,
      {
        maturity: 'REGULATORY_REVIEWED',
        reviewedBy: 'A. Reviewer, MPharm',
        reviewNotes: 'Checked every source against the published register.',
      },
      org.ownerUserId
    );

    expect(reviewed.maturity).toBe('REGULATORY_REVIEWED');
    expect(reviewed.reviewedBy).toBe('A. Reviewer, MPharm');
    expect(reviewed.isProductionEnabled).toBe(false);

    const row = await owner.query<{ reviewed_by_user_id: string }>(
      'SELECT reviewed_by_user_id FROM regulatory_rule_packs WHERE id = $1',
      [packId]
    );
    // ⚠️ TWO DIFFERENT QUESTIONS, BOTH ANSWERED: who reviewed it, and whose
    //   account recorded that. An audit of a sign-off asks both.
    expect(row.rows[0]?.reviewed_by_user_id).toBe(org.ownerUserId);
  });

  it('refuses to move the dates of a signed-off pack, not just its maturity', async () => {
    /*
     * ⚠️ THE GUARDS USED TO FIRE ONLY WHEN A REQUEST CARRIED A `maturity` KEY,
     *   so this PATCH sailed past both — and `loadRules` filters on exactly this
     *   window, so every rule in a reviewed pack left force platform-wide with
     *   the reviewer's name still on the screen. Moving `effectiveFrom` instead
     *   changes WHICH law applies under an unchanged sign-off, which is worse.
     */
    await expect(updateRulePack(packId, { effectiveTo: '2020-01-02' } as never)).rejects.toThrow(
      /signed off/
    );
    await expect(updateRulePack(packId, { name: 'Renamed after review' } as never)).rejects.toThrow(
      /signed off/
    );
  });

  it('refuses to add a rule to a pack somebody has signed off', async () => {
    await expect(
      createRule(packId, {
        ruleType: 'LABELLING_REQUIREMENT',
        code: 'REG_LATE',
        statement: 'A rule slipped in after the review.',
        status: 'ACTIVE',
        appliesToTransactions: [],
        parameters: { fields: ['dose'] },
        sourceId,
        effectiveFrom: '2020-01-01',
      } as never)
    ).rejects.toThrow(/signed off/);
  });

  /**
   * ⚠️ THE ONE TEST IN THIS PHASE THAT WAS WATCHED FAILING BEFORE IT WAS KEPT,
   *   AND THE THIRD ATTEMPT AT WRITING IT. PI-4's review recorded that a
   *   concurrency test nobody has seen fail is not a concurrency test, and the
   *   first two versions here proved it twice over:
   *
   *     1. Two real calls racing under `Promise.allSettled` passed with the lock
   *        REMOVED. The interleaving that breaks `createRule` needs its read
   *        before the sign-off commits and its insert after, and two
   *        transactions started microseconds apart mostly decline to oblige.
   *     2. Holding the row and asserting `approveRulePack` blocks passed with
   *        the lock removed TOO — because that function's own `UPDATE` takes a
   *        row lock anyway. It was measuring Postgres, not the code.
   *
   *   `createRule` is the one that discriminates: its DECISION reads the pack
   *   and its WRITE inserts into `regulatory_rules`, a different table entirely.
   *   With no `FOR UPDATE` there is nothing to block on, so it sails past a
   *   sign-off in flight and lands a rule inside a pack a named human has
   *   signed — which is the whole failure, and exactly the shape of PI-4's:
   *   the row being locked has to be the row the decision is made AGAINST.
   */
  it('will not add a rule while a sign-off on that pack is in flight', async () => {
    const created = await owner.query<{ id: string }>(
      `INSERT INTO regulatory_rule_packs
         (id, jurisdiction_id, authority_id, version, name, maturity, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '9.0.0', 'Race pack', 'REGULATORY_REVIEW_PENDING',
               DATE '2020-01-01', now())
       RETURNING id`,
      [jurisdictionCountry, authorityId]
    );
    const racedPackId = created.rows[0]?.id ?? '';

    /*
     * A second connection standing in for a sign-off mid-transaction: it holds
     * the pack row and has not committed its decision yet.
     */
    const reviewer = new Client({ connectionString: ownerUrl });
    await reviewer.connect();
    await reviewer.query('BEGIN');
    await reviewer.query('SELECT id FROM regulatory_rule_packs WHERE id = $1 FOR UPDATE', [
      racedPackId,
    ]);

    let settled = false;
    const adding = createRule(racedPackId, {
      ruleType: 'LABELLING_REQUIREMENT',
      code: 'REG_RACE',
      statement: 'A rule that tried to arrive during the sign-off.',
      status: 'ACTIVE',
      appliesToTransactions: [],
      parameters: { fields: ['dose'] },
      sourceId,
      effectiveFrom: '2020-01-01',
    } as never).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      }
    );

    // Long enough that an unlocked read would certainly have inserted by now.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);

    // The reviewer signs off and commits. `createRule` now re-reads under the
    // lock it was waiting on, sees a signed-off pack, and refuses.
    await reviewer.query(
      `UPDATE regulatory_rule_packs
          SET maturity = 'REGULATORY_REVIEWED', reviewed_by = 'A. Reviewer, MPharm',
              reviewed_at = now()
        WHERE id = $1`,
      [racedPackId]
    );
    await reviewer.query('COMMIT');
    await reviewer.end();

    await expect(adding).rejects.toThrow(/signed off/);

    const rules = await owner.query('SELECT id FROM regulatory_rules WHERE pack_id = $1', [
      racedPackId,
    ]);
    expect(rules.rowCount).toBe(0);

    await owner.query('DELETE FROM regulatory_rule_packs WHERE id = $1', [racedPackId]);
  }, 15_000);

  it('refuses to lower the maturity of a reviewed pack', async () => {
    await expect(updateRulePack(packId, { maturity: 'RULES_CONFIGURED' } as never)).rejects.toThrow(
      /new version/
    );
  });
});

/* ------------------------------------------------------------------ *
 * The HTTP surface
 * ------------------------------------------------------------------ */

describe('the tenant API', () => {
  it('lists the law without letting a clinic write it', async () => {
    const listed = await request(app)
      .get('/api/v1/regulatory/rule-packs')
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`);

    expect(listed.status).toBe(200);
    expect(listed.body.data.packs.length).toBeGreaterThan(0);

    // There is no tenant-facing write, by design: nothing is mounted at all.
    const attempted = await request(app)
      .post('/api/v1/regulatory/rule-packs')
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mine now' });

    expect(attempted.status).toBe(404);
  });

  it('answers an evaluation over HTTP, and an unconfigured one refuses', async () => {
    const res = await request(app)
      .post('/api/v1/regulatory/evaluate')
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, transaction: 'DISPENSE', countryCode: 'ZW', quantityBase: '1' });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('UNDETERMINED');
  });

  it('refuses two overlapping profiles for one place', async () => {
    const res = await request(app)
      .put(`/api/v1/products/${productId}/regulatory-profiles`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({
        profiles: [
          {
            jurisdictionId: jurisdictionCountry,
            classification: 'A',
            effectiveFrom: '2020-01-01',
            effectiveTo: '2026-01-01',
          },
          {
            jurisdictionId: jurisdictionCountry,
            classification: 'B',
            effectiveFrom: '2025-01-01',
          },
        ],
      });

    /*
     * ⚠️ THE UNIQUE INDEX DOES NOT CATCH THIS — it keys on `effective_from`, so
     *   two rows starting on different days and overlapping in the middle are
     *   legal to Postgres and leave the resolver picking whichever sorts first.
     */
    // A ValidationError is a 400 on this API — see utils/errors.ts.
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('overlap');
  });

  it('refuses a profile naming a jurisdiction that does not exist', async () => {
    const res = await request(app)
      .put(`/api/v1/products/${productId}/regulatory-profiles`)
      .set('Host', hostFor(SLUG))
      .set('Authorization', `Bearer ${token}`)
      .send({
        profiles: [
          {
            jurisdictionId: '00000000-0000-4000-8000-000000000000',
            effectiveFrom: '2020-01-01',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('does not exist');
  });
});
