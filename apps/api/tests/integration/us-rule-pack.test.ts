/**
 * The United States rule packs — federal and California — tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('US')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACKS, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run. `packages/regulatory/tests/engine.test.ts` proves
 *   the engine handles each SHAPE against a fictional jurisdiction; this file is
 *   the only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the
 *   statutes they were read from. A pack that is right in a fixture and wrong in
 *   the seed is a pack that is wrong.
 *
 * ⚠️ THE CALIFORNIA CASES ARE THE POINT OF THE PHASE. PI-5 built regional
 *   supersession and nothing has ever exercised it. Until this file existed, a
 *   regression that made every state pack inert would have broken no test.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF US LAW IS CORRECT. It claims the engine
 *   acts on the packs as configured. Whether they say the right thing is
 *   `RulePackMaturity` and a named human.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `u${Date.now().toString(36)}`;
const FEDERAL_SLUG = `usp-${SUFFIX}`;
const CALIFORNIA_SLUG = `uspca-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

interface Org {
  organizationId: string;
  ownerUserId: string;
  branchId: string;
}
interface Ctx {
  organizationId: string;
  branchIds: string[];
  userId: string;
}

/**
 * TWO organizations, because the jurisdiction under which a decision is made
 * comes from the BRANCH, not from a parameter. A California branch is the only
 * honest way to ask what California law says.
 */
let federalOrg: Org;
let californiaOrg: Org;
let federalCtx: Ctx;
let californiaCtx: Ctx;

const federalProducts: Record<string, string> = {};
const californiaProducts: Record<string, string> = {};

/** A licensed pharmacist at the counter. The licence, never the role code. */
const PHARMACIST = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['LICENSED_PHARMACIST'],
};

/**
 * A prescription from a DEA-registered practitioner.
 *
 * ⚠️ `prescriberClasses` IS NOT OPTIONAL DECORATION HERE, UNLIKE THE INDIA
 *   SUITE. The US pack carries `PRESCRIBER_AUTHORITY` rules, which resolve
 *   UNDETERMINED — and therefore REFUSE — when the prescriber's registration
 *   class is not supplied. That is deliberate: dispensing a Schedule II drug
 *   without establishing the prescriber holds a DEA registration is the failure
 *   US enforcement cares most about. One test below pins the refusal.
 */
const VALID_PRESCRIPTION = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['DEA_REGISTERED_PRACTITIONER'],
};

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Inc`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

async function makeProduct(
  into: Record<string, string>,
  organizationId: string,
  key: string,
  type: string,
  classification: string | null,
  unitId: string,
  jurisdictionId: string
): Promise<void> {
  const product = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2::"ProductType", 'ACTIVE', $3, $4, $5, now())
     RETURNING id`,
    [organizationId, type, `USP-${SUFFIX}-${key}`, `US pack ${key}`, unitId]
  );
  const id = product.rows[0]?.id ?? '';
  into[key] = id;

  if (classification !== null) {
    await owner.query(
      `INSERT INTO product_regulatory_profiles
         (id, organization_id, product_id, jurisdiction_id, classification,
          prescription_requirement, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESCRIPTION_REQUIRED', DATE '2020-01-01', now())
       RETURNING id`,
      [organizationId, id, jurisdictionId, classification]
    );
  }
}

/**
 * Say where a product stands on remote supply.
 *
 * ⚠️ WITHOUT THIS, EVERY `ONLINE_DISPENSE` CASE ANSWERS `UNDETERMINED` BEFORE A
 *   SINGLE RULE IS READ. PI-12's remote-supply gate runs ahead of the whole
 *   engine and refuses a product whose profile has not taken a position — the
 *   deliberate fail-closed for a transaction that would otherwise be decided by
 *   rules written about a counter. It is a property of the CLINIC's profile, not
 *   of the pack, so it has to be set here.
 */
async function allowOnlineSale(organizationId: string, productId: string): Promise<void> {
  await owner.query(
    `UPDATE product_regulatory_profiles
        SET online_sale_position = 'PERMITTED'
      WHERE organization_id = $1 AND product_id = $2`,
    [organizationId, productId]
  );
}

/**
 * The branch's own country and region, which is what the engine reads.
 *
 * ⚠️ SET HERE RATHER THAN THROUGH REGISTRATION, AND THE COUNTRY IS SET TOO.
 *   `branches.country_code` defaults to `IN` in the schema and registration does
 *   not derive it from the organization's, so a US organization can hold a
 *   branch the regulatory engine believes is in India — which would load the
 *   India pack and pass none of the assertions below for reasons that look like
 *   the US pack being broken. `region_code` is the column the tax engine reads;
 *   `state` beside it is free text for printing on an address and is not this.
 */
async function setBranchJurisdiction(branchId: string, regionCode: string | null): Promise<void> {
  await owner.query(`UPDATE branches SET country_code = 'US', region_code = $2 WHERE id = $1`, [
    branchId,
    regionCode,
  ]);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  const federalPack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'US' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const federalJurisdictionId = federalPack.rows[0]?.jurisdiction_id;
  if (!federalJurisdictionId) {
    throw new Error('the US federal rule pack is not seeded — run `pnpm db:seed` first');
  }

  const caPack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'US' AND j.region_code = 'CA' AND p.version = '1.0.0'`
  );
  if (!caPack.rows[0]?.jurisdiction_id) {
    throw new Error('the California rule pack is not seeded — run `pnpm db:seed` first');
  }

  federalOrg = await registerOrganization(payload(FEDERAL_SLUG, 'US Pack Co'));
  californiaOrg = await registerOrganization(payload(CALIFORNIA_SLUG, 'CA Pack Co'));
  await setBranchJurisdiction(federalOrg.branchId, null);
  await setBranchJurisdiction(californiaOrg.branchId, 'CA');

  federalCtx = {
    organizationId: federalOrg.organizationId,
    branchIds: [federalOrg.branchId],
    userId: federalOrg.ownerUserId,
  };
  californiaCtx = {
    organizationId: californiaOrg.organizationId,
    branchIds: [californiaOrg.branchId],
    userId: californiaOrg.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  for (const [key, type, classification] of [
    ['CII', 'MEDICINE', 'SCHEDULE_II'],
    ['CIII', 'MEDICINE', 'SCHEDULE_III'],
    ['CIV', 'MEDICINE', 'SCHEDULE_IV'],
    ['CV', 'MEDICINE', 'SCHEDULE_V'],
    ['LEGEND', 'MEDICINE', 'PRESCRIPTION_ONLY'],
    ['EXEMPT', 'MEDICINE', 'EXEMPT_NARCOTIC_OTC'],
    ['UNCLASSIFIED', 'MEDICINE', null],
    ['VET', 'VETERINARY_MEDICINE', 'VETERINARY_PRESCRIPTION'],
  ] as const) {
    await makeProduct(
      federalProducts,
      federalOrg.organizationId,
      key,
      type,
      classification,
      unitId,
      federalJurisdictionId
    );
    await makeProduct(
      californiaProducts,
      californiaOrg.organizationId,
      key,
      type,
      classification,
      unitId,
      federalJurisdictionId
    );
  }

  await allowOnlineSale(federalOrg.organizationId, federalProducts['CIII'] ?? '');
  await allowOnlineSale(californiaOrg.organizationId, californiaProducts['LEGEND'] ?? '');
}, 45_000);

afterAll(async () => {
  for (const org of [federalOrg, californiaOrg]) {
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
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const evaluateFederal = async (key: string, over: Record<string, unknown> = {}) =>
  evaluateFor(
    federalCtx,
    {
      productId: federalProducts[key],
      transaction: 'DISPENSE',
      quantityBase: '1',
      ...over,
    } as never,
    PHARMACIST
  );

const evaluateCalifornia = async (key: string, over: Record<string, unknown> = {}) =>
  evaluateFor(
    californiaCtx,
    {
      productId: californiaProducts[key],
      transaction: 'DISPENSE',
      quantityBase: '1',
      ...over,
    } as never,
    PHARMACIST
  );

const codes = (decision: { reasons: { ruleCode: string | null }[] }): string[] =>
  decision.reasons.map((r) => r.ruleCode ?? '').filter(Boolean);

const conditionKinds = (decision: { conditions: { kind: string }[] }): string[] =>
  decision.conditions.map((c) => c.kind);

/* ------------------------------------------------------------------ *
 * A prescription is required, and its absence refuses
 * ------------------------------------------------------------------ */

describe('a controlled substance is not supplied without a prescription', () => {
  it.each([
    ['CII', 'US-RX-SCH-II'],
    ['CIII', 'US-RX-SCH-III'],
    ['CIV', 'US-RX-SCH-IV'],
    ['CV', 'US-RX-SCH-V'],
  ])('refuses a %s product and cites %s', async (key, code) => {
    const decision = await evaluateFederal(key);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain(code);
  });

  it('refuses a non-controlled legend drug too, citing § 503(b)', async () => {
    const decision = await evaluateFederal('LEGEND');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-RX-LEGEND');
  });

  it('permits a Schedule III supply once a valid prescription is presented', async () => {
    const decision = await evaluateFederal('CIII', { prescription: VALID_PRESCRIPTION });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('refuses an unclassified medicine rather than permitting it', async () => {
    /*
     * The classification is what every schedule rule keys on, so a product
     * nobody classified matches none of them. `needsClassificationButHasNone`
     * makes that UNDETERMINED — which refuses — instead of letting the
     * every-product rules answer on their own.
     */
    const decision = await evaluateFederal('UNCLASSIFIED');

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Who may prescribe — the rule that refuses when it cannot tell
 * ------------------------------------------------------------------ */

describe('the prescriber must be established, not assumed', () => {
  it('refuses when the prescriber’s registration class was never supplied', async () => {
    /*
     * ⚠️ THE COST OF CARRYING A `PRESCRIBER_AUTHORITY` RULE, PINNED SO IT IS
     *   NEVER "FIXED" BY SOFTENING THE RULE. A prescription that is present and
     *   signed is still not enough: 21 CFR 1306.03(a) requires DEA registration,
     *   and a platform that permits because nobody passed a field has checked
     *   nothing.
     */
    const decision = await evaluateFederal('CII', {
      prescription: {
        presented: true,
        signedByQualifiedPrescriber: true,
        issuedOn: new Date().toISOString(),
        refillsUsed: 0,
      },
    });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(codes(decision)).toContain('US-PRESCRIBER-SCH-II');
  });

  it('refuses a prescriber holding no recognised registration', async () => {
    const decision = await evaluateFederal('CII', {
      prescription: { ...VALID_PRESCRIPTION, prescriberClasses: ['UNREGISTERED'] },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-PRESCRIBER-SCH-II');
  });
});

/* ------------------------------------------------------------------ *
 * Refills — the flat prohibition and the five-in-six-months rule
 * ------------------------------------------------------------------ */

describe('Schedule II is never refilled', () => {
  it('refuses a second dispense of the same prescription', async () => {
    const decision = await evaluateFederal('CII', {
      prescription: { ...VALID_PRESCRIPTION, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-REPEAT-SCH-II');
  });

  it('refuses even where the prescriber endorsed a repeat', async () => {
    /*
     * ⚠️ THE DELIBERATE CONTRAST WITH INDIA, PINNED. India's rule 65(11) lets a
     *   prescriber's endorsement lift the bar, so its pack opts in with
     *   `endorsedRepeatsPermitted`. 21 CFR 1306.12(a) offers no such route, the
     *   key is absent, and absent means no. A regression that made the
     *   endorsement globally effective would break here and nowhere else.
     */
    const decision = await evaluateFederal('CII', {
      prescription: {
        ...VALID_PRESCRIPTION,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 3,
      },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-REPEAT-SCH-II');
  });
});

describe('Schedule III and IV get five refills across six months', () => {
  it('permits a fifth refill', async () => {
    const decision = await evaluateFederal('CIII', {
      prescription: { ...VALID_PRESCRIPTION, refillsUsed: 5 },
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('refuses a sixth', async () => {
    const decision = await evaluateFederal('CIII', {
      prescription: { ...VALID_PRESCRIPTION, refillsUsed: 6 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-REPEAT-SCH-III');
  });

  it('refuses a prescription written more than six calendar months ago', async () => {
    /*
     * ⚠️ THE `validityMonths` CASE THAT A DAY COUNT GETS WRONG. Seven months
     *   back is unambiguously expired however the months are counted, so this
     *   pins the behaviour without pinning the arithmetic — the arithmetic's own
     *   boundary cases are in `packages/regulatory/tests/engine.test.ts`, where
     *   they can be tested against fixed dates rather than against `now`.
     */
    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setUTCMonth(sevenMonthsAgo.getUTCMonth() - 7);

    const decision = await evaluateFederal('CIII', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: sevenMonthsAgo.toISOString() },
    });

    expect(decision.outcome).toBe('REFUSED');
  });

  it('permits one written five months ago', async () => {
    const fiveMonthsAgo = new Date();
    fiveMonthsAgo.setUTCMonth(fiveMonthsAgo.getUTCMonth() - 5);

    const decision = await evaluateFederal('CIII', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: fiveMonthsAgo.toISOString() },
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('applies no validity period to Schedule II, which federal law does not give one', async () => {
    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setUTCMonth(sevenMonthsAgo.getUTCMonth() - 7);

    const decision = await evaluateFederal('CII', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: sevenMonthsAgo.toISOString() },
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });
});

/* ------------------------------------------------------------------ *
 * Remote supply — the proviso that must not vanish
 * ------------------------------------------------------------------ */

describe('remote supply of a controlled substance carries the Ryan Haight proviso', () => {
  it('raises the in-person evaluation condition rather than permitting silently', async () => {
    const decision = await evaluateFederal('CIII', {
      transaction: 'ONLINE_DISPENSE',
      prescription: VALID_PRESCRIPTION,
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_IN_PERSON_EVALUATION');
    expect(codes(decision)).toContain('US-ONLINE-SCH-III');
  });

  it('does not raise it for an ordinary counter dispense', async () => {
    const decision = await evaluateFederal('CIII', { prescription: VALID_PRESCRIPTION });

    expect(conditionKinds(decision)).not.toContain('VERIFY_PRIOR_IN_PERSON_EVALUATION');
  });
});

/* ------------------------------------------------------------------ *
 * Over-the-counter exempt narcotics — age and quantity
 * ------------------------------------------------------------------ */

describe('an exempt over-the-counter narcotic is age-restricted and rationed', () => {
  it('refuses a purchaser under eighteen', async () => {
    const decision = await evaluateFederal('EXEMPT', {
      transaction: 'COUNTER_SALE',
      patient: { subjectType: 'HUMAN', ageYears: 17 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-AGE-EXEMPT');
  });

  it('refuses more than 24 dosage units across the 48-hour window', async () => {
    const decision = await evaluateFederal('EXEMPT', {
      transaction: 'COUNTER_SALE',
      quantityBase: '10',
      priorQuantityInPeriodBase: '20',
      patient: { subjectType: 'HUMAN', ageYears: 40 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-QTY-EXEMPT');
  });

  it('refuses when what has already been supplied is unknown', async () => {
    const decision = await evaluateFederal('EXEMPT', {
      transaction: 'COUNTER_SALE',
      quantityBase: '10',
      patient: { subjectType: 'HUMAN', ageYears: 40 },
    });

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * California — the sub-national pack. The point of the phase.
 * ------------------------------------------------------------------ */

describe('a California branch is governed by the state pack where it speaks', () => {
  it('keeps records for three years, not the federal two', async () => {
    /*
     * ⚠️ THE SUPERSESSION THIS WHOLE PHASE EXISTS TO PROVE. Federal 21 CFR
     *   1304.04(a) is two years and is keyed to a classification; California
     *   B&P § 4081(a) is three and is keyed to nothing at all. The state rule is
     *   BROADER, and it must still win — `mostSpecific()` filters to the
     *   regional level before comparing specificity. Get that ordering wrong and
     *   the state pack is configured, visible and inert.
     */
    const decision = await evaluateCalifornia('CIII', { prescription: VALID_PRESCRIPTION });

    expect(codes(decision)).toContain('CA-RETAIN-RECORDS');
    expect(codes(decision)).not.toContain('US-RETAIN-SCH-III');

    const retention = decision.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(retention).toHaveLength(1);
    expect(retention[0]?.parameters?.['years'] ?? retention[0]?.detail).toBeDefined();
  });

  it('still applies every federal rule of a type California does not carry', async () => {
    /*
     * ⚠️ THE OTHER HALF, AND THE ONE A BROKEN IMPLEMENTATION PASSES WITHOUT.
     *   Superseding across TYPES would let a state retention rule switch off the
     *   federal prescription requirement — which would read as California
     *   permitting an unprescribed Schedule III supply.
     */
    const decision = await evaluateCalifornia('CIII');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('US-RX-SCH-III');
  });

  it('applies the federal two-year retention outside California', async () => {
    const decision = await evaluateFederal('CIII', { prescription: VALID_PRESCRIPTION });

    expect(codes(decision)).toContain('US-RETAIN-SCH-III');
    expect(codes(decision)).not.toContain('CA-RETAIN-RECORDS');
  });

  it('adds generic substitution, which federal law does not regulate', async () => {
    const inCalifornia = await evaluateCalifornia('LEGEND', {
      prescription: VALID_PRESCRIPTION,
      substitution: { isSubstitution: true },
    });
    expect(inCalifornia.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(codes(inCalifornia)).toContain('CA-SUBST-GENERIC');

    const elsewhere = await evaluateFederal('LEGEND', {
      prescription: VALID_PRESCRIPTION,
      substitution: { isSubstitution: true },
    });
    expect(codes(elsewhere)).not.toContain('CA-SUBST-GENERIC');
  });

  it('replaces the federal dispensing label with California’s longer one', async () => {
    const decision = await evaluateCalifornia('LEGEND', { prescription: VALID_PRESCRIPTION });

    expect(codes(decision)).toContain('CA-LABEL-DISPENSED');
    expect(codes(decision)).not.toContain('US-LABEL-LEGEND');
  });
});
