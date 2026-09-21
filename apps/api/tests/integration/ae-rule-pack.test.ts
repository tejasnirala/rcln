/**
 * The two Emirati rule packs — Abu Dhabi and Dubai — tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('AE')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ AND THE UAE IS THE SECOND COUNTRY WHERE "CONFIGURED AND INERT" WAS THE
 *   DEFAULT STATE. `CountryInfo.regions` for `AE` was `[]` — correct about VAT,
 *   which is federal at one rate — so `isValidRegion` would have refused `AZ` and
 *   `DU` on a branch and both packs would have seeded, printed their rule counts
 *   and matched nothing forever. Australia's was the identical defect one phase
 *   earlier. Every case below that names a branch is also a test that
 *   `UAE_REGIONS` exists.
 *
 * ⚠️ THREE BRANCHES IN ONE ORGANIZATION, WHICH IS NOT A CONVENIENCE. The
 *   transfer rules are about moving stock between facilities under one owner —
 *   the most ordinary movement rcln has — so the fixture has to be the shape the
 *   rule is about. The third branch is in Sharjah, which has no pack at all.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACKS, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF EMIRATI REGULATION IS CORRECT. It claims
 *   the engine acts on the packs as configured.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `e${Date.now().toString(36)}`;
const SLUG = `aep-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

interface Org {
  organizationId: string;
  ownerUserId: string;
  branchId: string;
}

let org: Org;
let ctx: { organizationId: string; branchIds: string[]; userId: string };

/** `AZ` Abu Dhabi · `DU` Dubai · `SH` Sharjah, which has no pack. */
const branches: Record<string, string> = {};
const products: Record<string, string> = {};
const locations: Record<string, string> = {};

/**
 * The person at the counter.
 *
 * ⚠️ NO `licenceTypes`, AND THAT IS NOT AN OVERSIGHT. Neither emirate pack
 *   carries a `PHARMACIST_AUTHORITY` rule: DOH's standard and DHA's guidelines
 *   both regulate who may PRESCRIBE these products and leave who may hand them
 *   over to the facility's own licensing. A licence on this actor would change
 *   no outcome in this file, and pretending otherwise would hide that.
 */
const PHARMACIST = { roleCodes: ['pharmacy.dispense.create'] };

const CONSULTANT_RX = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['CONSULTANT'],
};

const GP_RX = { ...CONSULTANT_RX, prescriberClasses: ['GENERAL_PRACTITIONER'] };

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function monthsAgo(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  for (const region of ['AZ', 'DU']) {
    const pack = await owner.query(
      `SELECT 1 FROM regulatory_rule_packs p
         JOIN jurisdictions j ON j.id = p.jurisdiction_id
        WHERE j.country_code = 'AE' AND j.region_code = $1 AND p.version = '1.0.0'`,
      [region]
    );
    if (pack.rowCount === 0) {
      throw new Error(`the AE-${region} rule pack is not seeded — run \`pnpm db:seed\` first`);
    }
  }

  /*
   * ⚠️ A NATIONAL `AE` JURISDICTION ROW WITH NO PACK, CREATED HERE THE WAY A
   *   CLINIC WOULD CREATE ONE — AND IT IS THE POINT OF THE FIXTURE RATHER THAN
   *   SCAFFOLDING. What a medicine IS in the UAE is decided federally: MOHAP
   *   sets the dispensing mode when it registers the product, which is why both
   *   emirate packs share one `AE_CLASSIFICATIONS`. What must be DONE about it
   *   is decided emirate by emirate.
   *
   *   So the product's regulatory profile is filed nationally and the rules that
   *   act on it are regional, and `profileFor` already supports exactly that: for
   *   a place with a region it accepts a profile whose jurisdiction is that
   *   region OR the country, preferring the region. One profile per product
   *   therefore serves both emirates — and a clinic that filed the profile
   *   against Abu Dhabi instead would find its Dubai branch had no
   *   classification at all, which resolves `UNDETERMINED` and refuses.
   */
  const nationalJurisdiction = await owner.query<{ id: string }>(
    `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
     VALUES (gen_random_uuid(), 'AE', NULL, 'United Arab Emirates', now())
     ON CONFLICT DO NOTHING
     RETURNING id`
  );
  const jurisdictionId =
    nationalJurisdiction.rows[0]?.id ??
    (
      await owner.query<{ id: string }>(
        `SELECT id FROM jurisdictions WHERE country_code = 'AE' AND region_code IS NULL`
      )
    ).rows[0]?.id;
  if (!jurisdictionId) throw new Error('could not resolve the national AE jurisdiction');

  org = await registerOrganization({
    organization: {
      legalName: 'AE Pack LLC',
      displayName: 'AE Pack',
      slug: SLUG,
      orgType: 'CLINIC' as const,
      countryCode: 'AE',
      timezone: 'Asia/Dubai',
      currency: 'AED',
    },
    branch: { name: 'Abu Dhabi Main', code: 'MAIN' },
    owner: {
      fullName: 'AE Pack Owner',
      email: `${SLUG}@example.test`,
      phone: `+9715${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  });

  branches['AZ'] = org.branchId;
  await owner.query(`UPDATE branches SET country_code = 'AE', region_code = 'AZ' WHERE id = $1`, [
    org.branchId,
  ]);

  for (const [region, name] of [
    ['DU', 'Dubai Branch'],
    ['SH', 'Sharjah Branch'],
  ] as const) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO branches (id, organization_id, name, code, country_code, region_code, timezone, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'AE', $4, 'Asia/Dubai', now())
       RETURNING id`,
      [org.organizationId, name, region, region]
    );
    branches[region] = row.rows[0]?.id ?? '';
  }

  ctx = {
    organizationId: org.organizationId,
    branchIds: Object.values(branches),
    userId: org.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  for (const [key, classification] of [
    ['NARCOTIC', 'NARCOTIC'],
    ['CD', 'CONTROLLED_DRUG'],
    ['SCD', 'SEMI_CONTROLLED_DRUG'],
    ['POM', 'PRESCRIPTION_ONLY_MEDICINE'],
    ['UNCLASSIFIED', null],
  ] as const) {
    const product = await owner.query<{ id: string }>(
      `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'MEDICINE'::"ProductType", 'ACTIVE', $2, $3, $4, now())
       RETURNING id`,
      [org.organizationId, `AEP-${SUFFIX}-${key}`, `AE pack ${key}`, unitId]
    );
    const id = product.rows[0]?.id ?? '';
    products[key] = id;

    if (classification !== null) {
      await owner.query(
        `INSERT INTO product_regulatory_profiles
           (id, organization_id, product_id, jurisdiction_id, classification,
            prescription_requirement, effective_from, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESCRIPTION_REQUIRED', DATE '2020-01-01', now())`,
        [org.organizationId, id, jurisdictionId, classification]
      );
    }
  }

  for (const region of ['AZ', 'DU'] as const) {
    for (const [key, kind, controlled] of [
      ['SHELF', 'MAIN_PHARMACY', false],
      ['SAFE', 'CONTROLLED_CABINET', true],
    ] as const) {
      const row = await owner.query<{ id: string }>(
        `INSERT INTO inventory_locations
           (id, organization_id, branch_id, kind, code, name, requires_controlled_access, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::"LocationKind", $4, $5, $6, now())
         RETURNING id`,
        [
          org.organizationId,
          branches[region],
          kind,
          `AEP-${region}-${key}`,
          `AE pack ${region} ${key}`,
          controlled,
        ]
      );
      locations[`${region}-${key}`] = row.rows[0]?.id ?? '';
    }
  }
}, 45_000);

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

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const evaluateIn = async (
  region: string,
  key: string,
  over: Record<string, unknown> = {},
  actor: Record<string, unknown> = PHARMACIST
) =>
  evaluateFor(
    ctx,
    {
      productId: products[key],
      branchId: branches[region],
      transaction: 'DISPENSE',
      quantityBase: '1',
      ...over,
    } as never,
    actor as never
  );

const codes = (decision: { reasons: { ruleCode: string | null }[] }): string[] =>
  decision.reasons.map((r) => r.ruleCode ?? '').filter(Boolean);

const conditionKinds = (decision: { conditions: { kind: string }[] }): string[] =>
  decision.conditions.map((c) => c.kind);

/* ------------------------------------------------------------------ *
 * Abu Dhabi — the three-day prescription
 * ------------------------------------------------------------------ */

describe('an Abu Dhabi controlled prescription runs for three days', () => {
  it.each([
    ['NARCOTIC', 'AZ-RX-NARCOTIC'],
    ['CD', 'AZ-RX-CD'],
    ['SCD', 'AZ-RX-SCD'],
  ])('refuses a %s supply with no prescription and cites %s', async (key, code) => {
    const decision = await evaluateIn('AZ', key);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain(code);
  });

  it('permits a prescription written two days ago and refuses one written four days ago', async () => {
    const fresh = await evaluateIn('AZ', 'CD', {
      prescription: { ...CONSULTANT_RX, issuedOn: daysAgo(2) },
    });
    expect(fresh.outcome).not.toBe('REFUSED');
    expect(fresh.outcome).not.toBe('UNDETERMINED');

    const stale = await evaluateIn('AZ', 'CD', {
      prescription: { ...CONSULTANT_RX, issuedOn: daysAgo(4) },
    });
    expect(stale.outcome).toBe('REFUSED');
    expect(codes(stale)).toContain('AZ-RX-CD');
  });

  it('refuses a prescription dated after today', async () => {
    const decision = await evaluateIn('AZ', 'CD', {
      prescription: { ...CONSULTANT_RX, issuedOn: daysAgo(-2) },
    });

    expect(decision.outcome).toBe('REFUSED');
  });

  it('lets a consultant prescribe a narcotic and refuses a general practitioner', async () => {
    /*
     * ⚠️ § 5.3.1 IS THE ONLY PLACE THE PRESCRIBER'S GRADE IS EXPRESSIBLE, and
     *   the contrast with the psychotropic tier is the reason the rule is
     *   narcotic-only: § 5.4.1 lets a GP prescribe a psychotropic, for three
     *   days. Copying `AZ-PRESCRIBER-NARCOTIC` onto the other tiers "for
     *   consistency" would refuse every GP's psychotropic prescription in the
     *   emirate.
     */
    const consultant = await evaluateIn('AZ', 'NARCOTIC', { prescription: CONSULTANT_RX });
    expect(consultant.outcome).not.toBe('REFUSED');

    const gp = await evaluateIn('AZ', 'NARCOTIC', { prescription: GP_RX });
    expect(gp.outcome).toBe('REFUSED');
    expect(codes(gp)).toContain('AZ-PRESCRIBER-NARCOTIC');

    const gpPsychotropic = await evaluateIn('AZ', 'CD', { prescription: GP_RX });
    expect(gpPsychotropic.outcome).not.toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Refills — the one place the grade ladder is expressible
 * ------------------------------------------------------------------ */

describe('a narcotic is never refilled and the other tiers are refilled to their endorsement', () => {
  it('refuses a narcotic refill even where the prescriber purported to authorise one', async () => {
    /*
     * ⚠️ THE SECOND HALF IS THE ASSERTION THAT MATTERS. `AZ-REFILL-NARCOTIC`
     *   carries no `endorsedRepeatsPermitted`, so an endorsement changes
     *   nothing — which is § 5.3.2, "Refill prescriptions are NOT permitted for
     *   narcotic products", with no proviso. Adding the key to match the other
     *   two rules would open a door the standard does not have.
     */
    const plain = await evaluateIn('AZ', 'NARCOTIC', {
      prescription: { ...CONSULTANT_RX, refillsUsed: 1 },
    });
    expect(plain.outcome).toBe('REFUSED');
    expect(codes(plain)).toContain('AZ-REFILL-NARCOTIC');

    const endorsed = await evaluateIn('AZ', 'NARCOTIC', {
      prescription: {
        ...CONSULTANT_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 2,
      },
    });
    expect(endorsed.outcome).toBe('REFUSED');
    expect(codes(endorsed)).toContain('AZ-REFILL-NARCOTIC');
  });

  it('honours the number the prescription states, up to the consultant ceiling of two', async () => {
    const specialistsOneRefill = await evaluateIn('AZ', 'SCD', {
      prescription: {
        ...CONSULTANT_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 1,
      },
    });
    expect(specialistsOneRefill.outcome).not.toBe('REFUSED');

    const beyondWhatWasWritten = await evaluateIn('AZ', 'SCD', {
      prescription: {
        ...CONSULTANT_RX,
        refillsUsed: 2,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 1,
      },
    });
    expect(beyondWhatWasWritten.outcome).toBe('REFUSED');
    expect(codes(beyondWhatWasWritten)).toContain('AZ-REFILL-SCD');

    /*
     * ⚠️ THE RULE'S OWN CEILING BITES EVEN WHEN THE PRESCRIPTION CLAIMS MORE.
     *   `evaluateRefillRule` takes the MINIMUM of the endorsement and
     *   `maxEndorsedRepeats`, so a prescription purporting to allow four refills
     *   is still cut off at the consultant's two.
     */
    const beyondTheRule = await evaluateIn('AZ', 'SCD', {
      prescription: {
        ...CONSULTANT_RX,
        refillsUsed: 3,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 4,
      },
    });
    expect(beyondTheRule.outcome).toBe('REFUSED');
    expect(codes(beyondTheRule)).toContain('AZ-REFILL-SCD');
  });

  it('refuses an unendorsed refill, which is the general practitioner’s position', async () => {
    const decision = await evaluateIn('AZ', 'SCD', {
      prescription: { ...GP_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('AZ-REFILL-SCD');
  });
});

/* ------------------------------------------------------------------ *
 * The register, the platform, and the obligations
 * ------------------------------------------------------------------ */

describe('Abu Dhabi raises the register and the unified platform', () => {
  it('asks for the register and the platform on all three tiers', async () => {
    for (const key of ['NARCOTIC', 'CD', 'SCD']) {
      const decision = await evaluateIn('AZ', key, { prescription: CONSULTANT_RX });

      expect(conditionKinds(decision)).toContain('RECORD_IN_CONTROLLED_REGISTER');
      expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_AUTHORISATION');
      expect(codes(decision)).toContain(`AZ-SCHEDULE-${key}`);
    }
  });

  it('keeps narcotic papers five years and semi-controlled ones two', async () => {
    const narcotic = await evaluateIn('AZ', 'NARCOTIC', { prescription: CONSULTANT_RX });
    const narcoticRetention = narcotic.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(narcoticRetention).toHaveLength(1);
    expect(narcoticRetention[0]?.parameters?.['years']).toBe(5);

    const semi = await evaluateIn('AZ', 'SCD', { prescription: CONSULTANT_RX });
    const semiRetention = semi.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(semiRetention).toHaveLength(1);
    expect(semiRetention[0]?.parameters?.['years']).toBe(2);
  });

  it('reports narcotics quarterly and the other two monthly', async () => {
    const narcotic = await evaluateIn('AZ', 'NARCOTIC', { prescription: CONSULTANT_RX });
    const narcoticReport = narcotic.conditions.filter((c) => c.kind === 'REPORT_TO_AUTHORITY');
    expect(narcoticReport[0]?.parameters?.['cadence']).toBe('QUARTERLY');

    const controlled = await evaluateIn('AZ', 'CD', { prescription: CONSULTANT_RX });
    const controlledReport = controlled.conditions.filter((c) => c.kind === 'REPORT_TO_AUTHORITY');
    expect(controlledReport[0]?.parameters?.['cadence']).toBe('MONTHLY');
  });

  it('does not refuse for want of a days’ supply, because no such rule was written', async () => {
    /*
     * ⚠️ THE ASSERTION THAT PROTECTS THE PACK'S LARGEST DELIBERATE OMISSION.
     *   Sections 5.3.1 and 5.4.1–5.4.3 set a days'-supply ladder — GP 3,
     *   specialist 15, consultant 30 — and it is not written, for two reasons
     *   set out in the data file: it turns on the PRESCRIBER'S GRADE, which is
     *   not a property of a rule, and nothing in this programme populates
     *   `daysSupply`, so any rule using `maxDaysSupply` answers `UNDETERMINED`
     *   for every caller. A future phase that adds one without a caller that can
     *   fill the field would refuse every controlled supply in Abu Dhabi, and
     *   this case is what would tell them.
     */
    const decision = await evaluateIn('AZ', 'NARCOTIC', { prescription: CONSULTANT_RX });

    expect(decision.outcome).not.toBe('UNDETERMINED');
    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });
});

/* ------------------------------------------------------------------ *
 * Storage, disposal, and the transfer that rcln makes easy
 * ------------------------------------------------------------------ */

describe('controlled stock is locked up and does not move between branches', () => {
  it('refuses a controlled receipt into ordinary stock and permits it into a locked store', async () => {
    const shelf = await evaluateIn('AZ', 'NARCOTIC', {
      transaction: 'STOCK',
      locationId: locations['AZ-SHELF'],
    });
    expect(shelf.outcome).toBe('REFUSED');
    expect(codes(shelf)).toContain('AZ-STORE-NARCOTIC');

    const safe = await evaluateIn('AZ', 'NARCOTIC', {
      transaction: 'STOCK',
      locationId: locations['AZ-SAFE'],
    });
    expect(safe.outcome).not.toBe('REFUSED');
    expect(conditionKinds(safe)).toContain('STORE_UNDER_CONDITIONS');
  });

  it('refuses a transfer of every controlled tier, in both emirates', async () => {
    /*
     * ⚠️ THE RULE MOST LIKELY TO BITE A REAL TENANT, AND THE REASON THE FIXTURE
     *   HAS THREE BRANCHES IN ONE ORGANIZATION. Moving stock between two
     *   branches of one clinic is the most ordinary movement this platform has,
     *   and § 11.1 in Abu Dhabi and clause 18.12.1 in Dubai both call it
     *   prohibited for narcotics. Nothing else in rcln would have stopped it.
     */
    for (const region of ['AZ', 'DU']) {
      for (const key of ['NARCOTIC', 'CD', 'SCD']) {
        const decision = await evaluateIn(region, key, { transaction: 'TRANSFER' });

        expect(decision.outcome).toBe('REFUSED');
        expect(codes(decision)).toContain(`${region}-TRANSFER-${key}`);
      }
    }
  });

  it('leaves goods receipt alone, which the transfer rule must not reach', async () => {
    /*
     * ⚠️ `evaluateImportRestriction` FIRES ON `STOCK` AS WELL AS `TRANSFER`, and
     *   the only thing keeping the prohibition off a lawful goods receipt is
     *   `appliesToTransactions: ['TRANSFER']` on the rule row. Widen it and
     *   every Emirati clinic stops being able to receive controlled stock at all.
     */
    const decision = await evaluateIn('AZ', 'CD', {
      transaction: 'STOCK',
      locationId: locations['AZ-SAFE'],
    });

    expect(codes(decision)).not.toContain('AZ-TRANSFER-CD');
    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('requires a witness to dispose of a controlled product', async () => {
    const decision = await evaluateIn('AZ', 'NARCOTIC', { transaction: 'DISPOSE' });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(codes(decision)).toContain('AZ-DISPOSE-NARCOTIC');
    expect(conditionKinds(decision)).toContain('WITNESS_REQUIRED');
  });
});

/* ------------------------------------------------------------------ *
 * Dubai — the same country, a different regulator
 * ------------------------------------------------------------------ */

describe('a Dubai branch is governed by the Dubai pack', () => {
  it('expires a prescription only medicine at three months, which Abu Dhabi says nothing about', async () => {
    /*
     * ⚠️ THE ONLY RULE IN EITHER PACK FOR AN ORDINARY MEDICINE, and it exists
     *   because clause 12.1.4(f) is a prohibition where its neighbours are
     *   recommendations. Abu Dhabi's standard is about controlled products only,
     *   so the same product in Abu Dhabi matches no rule at all.
     */
    const fresh = await evaluateIn('DU', 'POM', {
      prescription: { ...CONSULTANT_RX, issuedOn: monthsAgo(2) },
    });
    expect(fresh.outcome).not.toBe('REFUSED');

    const stale = await evaluateIn('DU', 'POM', {
      prescription: { ...CONSULTANT_RX, issuedOn: monthsAgo(4) },
    });
    expect(stale.outcome).toBe('REFUSED');
    expect(codes(stale)).toContain('DU-RX-POM');

    const inAbuDhabi = await evaluateIn('AZ', 'POM', {
      prescription: { ...CONSULTANT_RX, issuedOn: monthsAgo(4) },
    });
    expect(inAbuDhabi.outcome).toBe('UNDETERMINED');
  });

  it('runs its controlled prescriptions for three days, like Abu Dhabi', async () => {
    const stale = await evaluateIn('DU', 'NARCOTIC', {
      prescription: { ...CONSULTANT_RX, issuedOn: daysAgo(4) },
    });

    expect(stale.outcome).toBe('REFUSED');
    expect(codes(stale)).toContain('DU-RX-NARCOTIC');
  });

  it('puts narcotics and controlled drugs through the platform and semi-controlled ones not', async () => {
    /*
     * ⚠️ THE TWO EMIRATES DISAGREE HERE AND THE PACKS SAY SO. Dubai's clauses
     *   18.7.3(c) and 18.7.4(d) name the Unified Controlled Medication Platform;
     *   18.7.5, which governs semi controlled drugs, does not. Abu Dhabi's
     *   § 5.5.4 DOES route its semi-controlled refills through its platform.
     *   Inventing the third Dubai condition would assert an obligation DHA has
     *   not written — and copying one pack's tier table into the other is the
     *   obvious way somebody would do it.
     */
    for (const key of ['NARCOTIC', 'CD']) {
      const decision = await evaluateIn('DU', key, { prescription: CONSULTANT_RX });
      expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_AUTHORISATION');
    }

    const semi = await evaluateIn('DU', 'SCD', { prescription: CONSULTANT_RX });
    expect(conditionKinds(semi)).toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(conditionKinds(semi)).not.toContain('VERIFY_PRIOR_AUTHORISATION');

    const sameTierInAbuDhabi = await evaluateIn('AZ', 'SCD', { prescription: CONSULTANT_RX });
    expect(conditionKinds(sameTierInAbuDhabi)).toContain('VERIFY_PRIOR_AUTHORISATION');
  });
});

/* ------------------------------------------------------------------ *
 * The five emirates with nothing
 * ------------------------------------------------------------------ */

describe('an emirate with no pack refuses rather than permits', () => {
  it('answers UNDETERMINED in Sharjah for a product both other emirates regulate', async () => {
    /*
     * ⚠️ THE HONEST CONSEQUENCE OF HAVING NO FEDERAL PACK, PINNED SO NOBODY
     *   "FIXES" IT BY WRITING ONE FROM A SECONDARY SOURCE. Australia's national
     *   pack is a floor under the seven states with no pack of their own; the UAE
     *   has none, because `uaelegislation.gov.ae` returns 403 and mohap.gov.ae
     *   resets the connection, so a branch in Sharjah, Ajman, Fujairah, Ras
     *   al-Khaimah or Umm al-Quwain matches no rule at all.
     *
     *   `UNDETERMINED` refuses, which is the safe direction, and it is visibly a
     *   configuration gap rather than a decision — which is exactly the
     *   difference `REFUSED` and `UNDETERMINED` exist to carry.
     */
    const decision = await evaluateIn('SH', 'NARCOTIC', { prescription: CONSULTANT_RX });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(codes(decision)).toHaveLength(0);
  });

  it('refuses an unclassified medicine in an emirate that does have a pack', async () => {
    const decision = await evaluateIn('AZ', 'UNCLASSIFIED');

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});
