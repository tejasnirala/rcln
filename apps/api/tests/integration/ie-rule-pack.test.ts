/**
 * The Ireland rule pack, tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('IE')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ THE CASES WORTH READING ARE THE ONES ABOUT DISTANCE SUPPLY. Ireland is the
 *   first jurisdiction in this programme that FORBIDS remote supply outright,
 *   and the first whose non-prescription permission hangs on a registration the
 *   platform cannot see. Both directions are pinned, because a pack that refused
 *   everything remotely would look identical to a correct one from the outside.
 *
 * ⚠️ AND THE ONES ABOUT WHAT IS DELIBERATELY ABSENT. There is no Part C
 *   classification and no twelve-month validity, and both omissions are
 *   arguable enough that somebody will eventually "fix" one. The assertions
 *   below are what turns that into a failing test rather than a silent change to
 *   the law at every Irish clinic.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACK, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run. `packages/regulatory/tests/engine.test.ts` proves
 *   the engine handles each SHAPE against a fictional jurisdiction; this file is
 *   the only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the
 *   instruments they were read from.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF IRISH LAW IS CORRECT. It claims the
 *   engine acts on the pack as configured. Whether it says the right thing is
 *   `RulePackMaturity` and a named human.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG = `iep-${SUFFIX}`;
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

const products: Record<string, string> = {};
const locations: Record<string, string> = {};

/**
 * A registered pharmacist at the counter. The licence, never the role code.
 *
 * ⚠️ `REGISTERED_PHARMACIST` IS IRELAND'S OWN WORD FOR IT — section 20 of the
 *   Pharmacy Act 2007 — and the packs deliberately do not share one vocabulary:
 *   the United States says `LICENSED_PHARMACIST` and Singapore says
 *   `QUALIFIED_PHARMACIST`. A licence type is a fact about a jurisdiction's
 *   register, so each pack names its own. Australia happens to say the same
 *   thing as Ireland, which is a coincidence and not a shared constant.
 */
const PHARMACIST = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['REGISTERED_PHARMACIST'],
};

/** The same person without the registration — a dispensary assistant. */
const ASSISTANT = { roleCodes: ['pharmacy.dispense.create'] };

/** The doctor dispensing to their own patient, which regulation 20(3)(c) exempts. */
const PRESCRIBING_DOCTOR = { roleCodes: ['pharmacy.dispense.create'], isPrescriber: true };

const DOCTOR_RX = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['REGISTERED_MEDICAL_PRACTITIONER'],
};

const NURSE_RX = { ...DOCTOR_RX, prescriberClasses: ['REGISTERED_NURSE'] };
const EEA_RX = { ...DOCTOR_RX, prescriberClasses: ['EEA_EQUIVALENT_PRACTITIONER'] };
const VET_RX = { ...DOCTOR_RX, prescriberClasses: ['REGISTERED_VETERINARY_PRACTITIONER'] };

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

/** A prescription written exactly `months` calendar months ago, to the day. */
function monthsAgo(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Limited`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'IE',
      timezone: 'Europe/Dublin',
      currency: 'EUR',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+3538${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

/**
 * ⚠️ EVERY PROFILE RECORDS `online_sale_position = 'PERMITTED'`, AND WITHOUT
 *   THAT THIS WHOLE FILE WOULD PROVE NOTHING ABOUT IRELAND. `onlineSaleGap` runs
 *   BEFORE any rule is consulted: a profile whose position is `UNKNOWN` — the
 *   column's default — answers `UNDETERMINED` for every `ONLINE_DISPENSE`, which
 *   refuses. Every remote-supply case below would have "passed" on PI-12's gate
 *   while the Irish rules sat inert behind it.
 *
 *   So the fixture says the clinic HAS looked at each product and recorded that
 *   it may be sold online — the most permissive state a clinic can put a product
 *   in — and the refusals that follow are the law's, not the absence of a
 *   record. `refuses a remote supply the clinic itself has marked as permitted`
 *   is the case that pins the difference.
 */
async function makeProduct(
  key: string,
  classification: string | null,
  unitId: string,
  jurisdictionId: string
): Promise<void> {
  const product = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE'::"ProductType", 'ACTIVE', $2, $3, $4, now())
     RETURNING id`,
    [org.organizationId, `IEP-${SUFFIX}-${key}`, `IE pack ${key}`, unitId]
  );
  const id = product.rows[0]?.id ?? '';
  products[key] = id;

  if (classification !== null) {
    await owner.query(
      `INSERT INTO product_regulatory_profiles
         (id, organization_id, product_id, jurisdiction_id, classification,
          prescription_requirement, online_sale_position, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESCRIPTION_REQUIRED',
               'PERMITTED', DATE '2020-01-01', now())`,
      [org.organizationId, id, jurisdictionId, classification]
    );
  }
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  const pack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'IE' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const jurisdictionId = pack.rows[0]?.jurisdiction_id;
  if (!jurisdictionId) {
    throw new Error('the Ireland rule pack is not seeded — run `pnpm db:seed` first');
  }

  org = await registerOrganization(payload(SLUG, 'IE Pack Co'));

  /*
   * ⚠️ THE BRANCH'S OWN COUNTRY IS SET HERE RATHER THAN THROUGH REGISTRATION.
   *   `branches.country_code` defaults to `IN` in the schema and registration
   *   does not derive it from the organization's, so an Irish organization can
   *   hold a branch the regulatory engine believes is in India.
   *
   * ⚠️ AND `region_code` IS NULL FOR A REASON THAT IS NOT AUSTRALIA'S OR THE
   *   UAE'S. `CountryInfo.regions` for `IE` is empty because Irish medicines law
   *   is made by the Minister for Health for the whole State and a county
   *   regulates nothing — so unlike Victoria and Dubai, there is no sub-national
   *   pack this emptiness could make inert. The check was still run.
   */
  await owner.query(`UPDATE branches SET country_code = 'IE', region_code = NULL WHERE id = $1`, [
    org.branchId,
  ]);

  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId],
    userId: org.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  for (const [key, classification] of [
    ['PART_A', 'PRESCRIPTION_ONLY_PART_A'],
    ['PART_B', 'PRESCRIPTION_ONLY_PART_B'],
    ['POM', 'PRESCRIPTION_ONLY'],
    ['PHARMACY_ONLY', 'PHARMACY_ONLY'],
    ['CD2', 'CD_SCHEDULE_2'],
    ['CD3', 'CD_SCHEDULE_3'],
    ['CD4A', 'CD_SCHEDULE_4_PART_1'],
    ['PART_C', 'PRESCRIPTION_ONLY_PART_C'],
    ['UNCLASSIFIED', null],
  ] as const) {
    await makeProduct(key, classification, unitId, jurisdictionId);
  }

  for (const [key, kind, controlled] of [
    ['SHELF', 'MAIN_PHARMACY', false],
    ['SAFE', 'CONTROLLED_CABINET', true],
  ] as const) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, requires_controlled_access, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::"LocationKind", $4, $5, $6, now())
       RETURNING id`,
      [org.organizationId, org.branchId, kind, `IEP-${key}`, `IE pack ${key}`, controlled]
    );
    locations[key] = row.rows[0]?.id ?? '';
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

const evaluate = async (
  key: string,
  over: Record<string, unknown> = {},
  actor: Record<string, unknown> = PHARMACIST
) =>
  evaluateFor(
    ctx,
    {
      productId: products[key],
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
 * The prescription, and the six months that may lawfully be twelve
 * ------------------------------------------------------------------ */

describe('a prescription only medicine needs a prescription that is still in date', () => {
  it('refuses a supply with no prescription', async () => {
    const decision = await evaluate('PART_A');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-PART-A');
  });

  it('permits it once a doctor’s prescription is presented', async () => {
    const decision = await evaluate('PART_A', { prescription: DOCTOR_RX });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
  });

  it('accepts a registered nurse, because S.I. 201 of 2007 put one in the definition', async () => {
    const decision = await evaluate('PART_B', { prescription: NURSE_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('accepts an equivalent practitioner from another Member State', async () => {
    /*
     * ⚠️ AND THIS PASSES WITHOUT ANY OF THE THREE PROVISOS BEING CHECKED. The
     *   definition admits such a prescription only where the practitioner's
     *   address in that Member State is on it, they have no practice here, and
     *   it was not issued to enable a mail-order supply. None of the three is a
     *   fact rcln holds. The case is pinned so that the honest half-rule is a
     *   decision somebody made rather than one they will discover.
     */
    const decision = await evaluate('PART_B', { prescription: EEA_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses a veterinary prescription for an ordinary medicine', async () => {
    /*
     * The definition of "prescription" in regulation 4(1) names a medical
     * practitioner, a dentist and a nurse. It does not name a vet — and the
     * controlled-drug list, from a different instrument, does. Both are pinned.
     */
    const decision = await evaluate('PART_B', { prescription: VET_RX });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-PRESCRIBER-PART-B');
  });

  it('refuses a prescription written seven months ago', async () => {
    const decision = await evaluate('PART_B', {
      prescription: { ...DOCTOR_RX, issuedOn: monthsAgo(7) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-PART-B');
  });

  it('refuses at 183 days a dispense that may well be lawful, and that is deliberate', async () => {
    /*
     * ⚠️ THE MOST LIKELY "BUG FIX" IN THIS PACK, PINNED AS BEHAVIOUR.
     *   Regulation 7(5)(a) as substituted by S.I. No. 73 of 2024 permits up to
     *   TWELVE months where the prescription says so, or where a pharmacist has
     *   recorded a decision under regulation 9A(1) of the Regulation of Retail
     *   Pharmacy Businesses Regulations 2008. rcln holds neither fact —
     *   `PresentedPrescription` has no prescriber-stated validity and no record
     *   of a pharmacist's review — so the pack configures limb (i) alone and
     *   this dispense is refused.
     *
     *   ⚠️ ANYBODY TEMPTED TO WRITE `validityMonths: 12` SHOULD READ WHAT IT
     *   COSTS: it would permit, silently, the far larger set of prescriptions on
     *   which nobody specified anything and no pharmacist reviewed anything. The
     *   fix is the missing field, not a bolder reading. KNOWN_ISSUES records it.
     */
    const decision = await evaluate('PART_B', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(200) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-PART-B');
  });

  it('refuses a prescription dated after today', async () => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 3);

    const decision = await evaluate('PART_A', {
      prescription: { ...DOCTOR_RX, issuedOn: date.toISOString() },
    });

    expect(decision.outcome).toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Part A repeats on one occasion, Part B on as many as the pharmacist
 * thinks right — and that difference is the First Schedule's own
 * ------------------------------------------------------------------ */

describe('the First Schedule Part decides whether a prescription repeats', () => {
  it('refuses a second supply of a Part A medicine with no endorsement', async () => {
    const decision = await evaluate('PART_A', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-REPEAT-PART-A');
  });

  it('permits an endorsed Part A repeat, up to three occasions in all', async () => {
    const decision = await evaluate('PART_A', {
      prescription: { ...DOCTOR_RX, refillsUsed: 2, repeatsAuthorised: true },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses the fourth occasion, because “not more than three” is two repeats', async () => {
    /*
     * ⚠️ THE OFF-BY-ONE THIS CASE EXISTS TO CATCH. `refillsUsed` counts PRIOR
     *   supplies, so regulation 7(2)(c)'s "not more than three occasions" is
     *   `maxEndorsedRepeats: 2`. Writing 3 would permit four occasions and the
     *   rule would still look correctly configured.
     */
    const decision = await evaluate('PART_A', {
      prescription: { ...DOCTOR_RX, refillsUsed: 3, repeatsAuthorised: true },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-REPEAT-PART-A');
  });

  it('permits a fourth supply of a Part B medicine inside the six months', async () => {
    /*
     * ⚠️ NO NUMBER ANYWHERE, WHICH IS THE RULE AND NOT A GAP. Regulation
     *   7(2)(b) leaves the count to the person dispensing, "having regard to the
     *   specified rate of dosage". `IE-REPEAT-PART-B` therefore states the
     *   validity and nothing else, and this case is what stops somebody adding
     *   `refillsAllowed: 5` because every other pack has a number.
     */
    const decision = await evaluate('PART_B', {
      prescription: { ...DOCTOR_RX, refillsUsed: 3, issuedOn: monthsAgo(2) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses a Part B repeat once the six months have run out', async () => {
    const decision = await evaluate('PART_B', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1, issuedOn: monthsAgo(8) },
    });

    expect(decision.outcome).toBe('REFUSED');
  });

  it('treats a parenteral or new-molecule medicine as Part A, because regulation 7(4) says so', async () => {
    const decision = await evaluate('POM', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-REPEAT-POM');
  });
});

/* ------------------------------------------------------------------ *
 * Distance supply — the first outright prohibition in this programme
 * ------------------------------------------------------------------ */

describe('a prescription medicine may not be sent anywhere, by any route', () => {
  it('refuses a remote supply even with a perfect prescription', async () => {
    /*
     * ⚠️ THE POINT OF THE WHOLE PACK, IN ONE ASSERTION. Every earlier pack
     *   either said nothing about remote supply — which PERMITS it, on the
     *   strength of rules about a counter, as `online-sale-gap.test.ts` shows —
     *   or conditioned it. Ireland forbids it: regulation 19(1), extended to
     *   information society services by regulation 19(5), and regulation
     *   19A(8)(b) for the avoidance of any doubt.
     */
    const decision = await evaluate('PART_B', {
      transaction: 'ONLINE_DISPENSE',
      prescription: DOCTOR_RX,
      destinationCountryCode: 'IE',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-ONLINE-PART-B');
  });

  it('refuses it to another EEA State too, because the prohibition is on the supply', async () => {
    const decision = await evaluate('PART_A', {
      transaction: 'ONLINE_DISPENSE',
      prescription: DOCTOR_RX,
      destinationCountryCode: 'FR',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-ONLINE-PART-A');
  });

  it('refuses a controlled drug remotely, citing the 2003 Regulations and not the 2017 ones', async () => {
    const decision = await evaluate('CD2', {
      transaction: 'ONLINE_DISPENSE',
      prescription: DOCTOR_RX,
      destinationCountryCode: 'IE',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-ONLINE-CD2');
  });

  it('refuses a remote supply the clinic itself has marked as permitted', async () => {
    /*
     * ⚠️ THE CASE THAT SEPARATES THE TWO GATES. Every product in this fixture
     *   carries `online_sale_position = 'PERMITTED'` — the clinic has looked at
     *   it and said it may be sold online, so PI-12's `onlineSaleGap` has
     *   nothing to say and `confirmOnlineOrder` would let it through. What
     *   refuses is regulation 19, cited by name. Without this case, every
     *   assertion above would pass against a pack with no online rules at all,
     *   on the strength of a gate that answers `UNDETERMINED` for an unrecorded
     *   position.
     */
    const decision = await evaluate('POM', {
      transaction: 'ONLINE_DISPENSE',
      prescription: DOCTOR_RX,
      destinationCountryCode: 'IE',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-ONLINE-POM');
    expect(decision.reasons.some((r) => (r.message ?? '').includes('mail order'))).toBe(true);
  });

  it('still permits the same Part A medicine over the counter', async () => {
    /*
     * The prohibition is on the CHANNEL. A pack that refused everything would
     * pass every case above and be wrong, so this is the case that says the
     * `ONLINE_DISPENSING` rules are narrowed to `ONLINE_DISPENSE`.
     */
    const decision = await evaluate('PART_A', { prescription: DOCTOR_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

describe('a non-prescription medicine may be sent within the EEA, on a registration', () => {
  it('permits it to an EEA State and raises the ISS supply list as a condition', async () => {
    /*
     * ⚠️ THE CONDITION IS THE RULE. Regulation 19A(1) does not authorise
     *   distance selling; it forbids it unless the seller "has been entered on
     *   the ISS supply list". Before PI-18 the closest expressible rule was a
     *   bare `permitted: true`, which asserts the opposite — the same inversion
     *   `requiresPriorInPersonEvaluation` was added to stop in the United
     *   States pack. `VERIFY_PRIOR_AUTHORISATION` is what the engine can
     *   honestly do: permit, and say who has to have said so.
     */
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'PT',
      patient: { subjectType: 'HUMAN', ageYears: 40 },
    });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
    expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_AUTHORISATION');
    expect(codes(decision)).toContain('IE-ONLINE-PHARMACY-ONLY');
  });

  it('will not permit a distance sale to a purchaser of unknown age', async () => {
    /*
     * ⚠️ THE AGE IS COMPULSORY HERE IN A WAY IT IS NOWHERE ELSE IN THIS PACK,
     *   AND THE FIRST DRAFT OF THIS SUITE TRIPPED OVER IT. Regulation
     *   19A(6)(c)(i) makes the check part of the transaction — "prior to
     *   supplying to the purchaser ... checks that the purchaser is over 18
     *   years old" — so `evaluateAgeRestriction` answers `UNDETERMINED`, which
     *   refuses, when no age is supplied. Not knowing how old somebody is is not
     *   the same as their being old enough.
     */
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'PT',
    });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(codes(decision)).toContain('IE-AGE-DISTANCE');
  });

  it('refuses it outside the EEA, which is what regulation 19A(8)(a) says', async () => {
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'US',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-ONLINE-PHARMACY-ONLY');
  });

  it('refuses it to Great Britain, which is the case the paragraph was rewritten for', async () => {
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'GB',
    });

    expect(decision.outcome).toBe('REFUSED');
  });

  it('refuses to answer at all when no destination is supplied', async () => {
    /*
     * `evaluateOnlineDispensing` answers `UNDETERMINED` — which refuses — when a
     * rule restricts the destination and none was given. An order with no
     * delivery country is not an order that can be shown to be lawful.
     */
    const decision = await evaluate('PHARMACY_ONLY', { transaction: 'ONLINE_DISPENSE' });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('refuses a distance supply to a purchaser under 18', async () => {
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'IE',
      patient: { subjectType: 'HUMAN', ageYears: 17 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-AGE-DISTANCE');
  });

  it('applies no age limit to the same medicine over the counter', async () => {
    /*
     * ⚠️ REGULATION 19A(6)(c) OPENS "in the course of each transaction for such
     *   supply", where "such supply" is supply at a distance. Ireland sets no
     *   general age limit on an over-the-counter sale, and a rule that reached
     *   `COUNTER_SALE` would invent one.
     */
    const decision = await evaluate('PHARMACY_ONLY', {
      transaction: 'COUNTER_SALE',
      patient: { subjectType: 'HUMAN', ageYears: 15 },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Who may hand it over
 * ------------------------------------------------------------------ */

describe('personal supervision by a registered pharmacist', () => {
  it('refuses an unregistered assistant', async () => {
    const decision = await evaluate('PART_A', { prescription: DOCTOR_RX }, ASSISTANT);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-DISPENSER-PART-A');
  });

  it('refuses an assistant selling a pharmacy-only medicine over the counter', async () => {
    const decision = await evaluate('PHARMACY_ONLY', { transaction: 'COUNTER_SALE' }, ASSISTANT);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-DISPENSER-PHARMACY-ONLY');
  });

  it('stands aside for a practitioner dispensing to their own patient', async () => {
    /*
     * Regulation 20(3)(c) disapplies regulations 5 and 6 from "the supply of a
     * medicinal product to a patient of his by a registered medical practitioner
     * or registered dentist in the course of his professional practice" — the
     * same shape as India's Pharmacy Act s. 42(1), and the reason
     * `exemptWhenActorIsPrescriber` is opted into here.
     *
     * ⚠️ THE EXEMPTION IS WIDER IN THIS PACK THAN IN THE REGULATION, AND THE
     *   GAP IS PINNED IN KNOWN_ISSUES RATHER THAN HIDDEN. Regulation 20(3)(c)
     *   names a practitioner and a dentist, not a nurse; `isPrescriber` does not
     *   carry the class, so a nurse prescriber dispensing their own prescription
     *   is exempted here and is not exempted there.
     */
    const decision = await evaluate('PART_A', { prescription: DOCTOR_RX }, PRESCRIBING_DOCTOR);

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('does not let the same exemption rescue a controlled drug', async () => {
    /*
     * There is no `PHARMACIST_AUTHORITY` rule for a controlled schedule in this
     * pack, so nothing here turns on the exemption — but the prescription rules
     * still apply, and a doctor with no prescription is refused like anybody
     * else. The case exists because "the doctor is exempt" is exactly the
     * sentence somebody would over-generalise.
     */
    const decision = await evaluate('CD2', {}, PRESCRIBING_DOCTOR);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-CD2');
  });
});

/* ------------------------------------------------------------------ *
 * Controlled drugs — three schedules that agree about almost nothing
 * ------------------------------------------------------------------ */

describe('the fourteen days, and the one schedule that does not get them', () => {
  it('refuses a Schedule 2 prescription fifteen days old', async () => {
    const decision = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(15) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-CD2');
  });

  it('permits it on day fourteen', async () => {
    const decision = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(14) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('applies the same fourteen days to Schedule 3', async () => {
    const decision = await evaluate('CD3', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(20) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-CD3');
  });

  it('gives Part 1 of Schedule 4 six months instead, from a different instrument', async () => {
    /*
     * ⚠️ REGULATION 16(3)(b) DISAPPLIES THE FOURTEEN DAYS FROM PART 1 OF
     *   SCHEDULE 4 AND 16(3)(a) SENDS THE DISPENSER TO REGULATION 7 OF THE 2003
     *   REGULATIONS. A benzodiazepine prescription is therefore good for six
     *   months, not a fortnight — and a pack that gave every controlled schedule
     *   fourteen days would refuse most of them wrongly, while looking
     *   consistent.
     */
    const decision = await evaluate('CD4A', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(60) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('still refuses a Part 1 Schedule 4 prescription after seven months', async () => {
    const decision = await evaluate('CD4A', {
      prescription: { ...DOCTOR_RX, issuedOn: monthsAgo(7) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-RX-CD4A');
  });

  it('accepts a veterinary prescription for a controlled drug, unlike an ordinary one', async () => {
    const decision = await evaluate('CD2', { prescription: VET_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

describe('instalments, and the endorsement that has to say how many', () => {
  it('refuses a second supply with no direction on the prescription', async () => {
    const decision = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-REPEAT-CD2');
  });

  it('cannot decide when the prescription allows instalments but does not count them', async () => {
    /*
     * ⚠️ `UNDETERMINED` HERE IS REGULATION 15(2)(h) ENFORCED, NOT A FRAMEWORK
     *   LIMITATION SHOWING THROUGH. The Regulations set no ceiling of their own
     *   — they require the PRESCRIPTION to state "the number of instalments and
     *   the intervals at which the instalments may be dispensed". So a rule with
     *   no `maxEndorsedRepeats` meeting an endorsement with no number is exactly
     *   the case the regulation forbids, and the decision says to ring the
     *   prescriber.
     */
    const decision = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1, repeatsAuthorised: true },
    });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('permits an instalment when the prescription says how many', async () => {
    const decision = await evaluate('CD2', {
      prescription: {
        ...DOCTOR_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 3,
        issuedOn: daysAgo(10),
      },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses an instalment more than two months after the date on the prescription', async () => {
    /*
     * Regulation 16(1)(e)(ii)(II): a subsequent instalment may not be supplied
     * "later than two months after the date specified in the prescription".
     * Both numbers in regulation 16(1)(e) are live at once — the fourteen days
     * bound the first instalment and live on `IE-RX-CD2`, the two months bound
     * the later ones and live here.
     */
    const decision = await evaluate('CD2', {
      prescription: {
        ...DOCTOR_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 3,
        issuedOn: monthsAgo(3),
      },
    });

    expect(decision.outcome).toBe('REFUSED');
  });
});

describe('the register, the safe, and the two lists that are not the same list', () => {
  it('raises the controlled drugs register for Schedule 2', async () => {
    const decision = await evaluate('CD2', { prescription: { ...DOCTOR_RX } });

    expect(conditionKinds(decision)).toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(codes(decision)).toContain('IE-SCHEDULE-CD2');
  });

  it('carries no schedule rule for Schedule 3 at all, which is a framework limit', async () => {
    /*
     * ⚠️ THE FIRST DRAFT OF THIS PACK GAVE SCHEDULE 3 AND PART 1 OF SCHEDULE 4 A
     *   `CONTROLLED_SCHEDULE` RULE CARRYING ONLY `scheduleName`, ON THE
     *   AUSTRALIAN PACK'S PRECEDENT — AND IT REFUSED EVERY TRANSACTION.
     *   `parseControlledSchedule` rejects a document that imposes no obligation,
     *   so such a rule resolves `UNDETERMINED`, which refuses. Regulation 19(1)
     *   reaches Schedules 1 and 2 and stops, so there was nothing honest for the
     *   rule to carry.
     *
     *   ⚠️ `AU-SCHEDULE-S8` STILL HAS EXACTLY THAT SHAPE, and its own behaviour
     *   case asserts the rule code appears and no conditions were raised — which
     *   is precisely what an unreadable rule produces. Recorded in KNOWN_ISSUES.
     *
     *   The cost here is that a Schedule 3 decision does not name the schedule.
     *   That is worth having and there is no way to get it without asserting an
     *   obligation the Regulations do not impose.
     */
    const decision = await evaluate('CD3', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(1) },
    });

    expect(decision.outcome).not.toBe('UNDETERMINED');
    expect(codes(decision)).not.toContain('IE-SCHEDULE-CD3');
    expect(conditionKinds(decision)).not.toContain('RECORD_IN_CONTROLLED_REGISTER');
  });

  it('refuses to receive Schedule 3 stock into a location with no controlled access', async () => {
    const decision = await evaluate('CD3', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IE-STORE-CD3');
  });

  it('permits it into the safe', async () => {
    const decision = await evaluate('CD3', {
      transaction: 'STOCK',
      locationId: locations['SAFE'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('lets Part 1 of Schedule 4 sit on the open shelf, which article 5 does not reach', async () => {
    /*
     * ⚠️ THE SECOND OF THE TWO LISTS THAT ARE NOT "THE CONTROLLED DRUGS".
     *   Article 5(1) of the Safe Custody Regulations binds a pharmacy in respect
     *   of "any controlled drug specified in Schedule 1, 2 or 3", and stops.
     *   Benzodiazepines are Part 1 of Schedule 4 and are not required to be in
     *   the safe. A pack that put every controlled schedule in it would refuse
     *   lawful stock movements at every Irish pharmacy.
     */
    const decision = await evaluate('CD4A', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision)).not.toContain('IE-STORE-CD4A');
  });

  it('requires a witness to destroy any of the three schedules', async () => {
    for (const key of ['CD2', 'CD3', 'CD4A']) {
      const decision = await evaluate(key, { transaction: 'DISPOSE' });

      expect(conditionKinds(decision)).toContain('WITNESS_REQUIRED');
      expect(codes(decision)).toContain(`IE-DISPOSE-${key}`);
    }
  });

  it('keeps every controlled record for two years', async () => {
    const decision = await evaluate('CD2', { prescription: { ...DOCTOR_RX } });
    const retention = decision.conditions.find((c) => c.kind === 'RETAIN_RECORD');

    expect(retention).toBeDefined();
    expect(retention?.parameters?.['years']).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * What this pack deliberately does not say
 * ------------------------------------------------------------------ */

describe('the absences, each of which somebody will want to close', () => {
  it('refuses a Part C medicine outright, because no classification claims it', async () => {
    /*
     * ⚠️ THE ABSENCE THAT IS A REFUSAL RATHER THAN A GAP, AND THE FOURTH
     *   JURISDICTION TO ASK FOR `branch.licence_type`. Regulation 7(6) says a
     *   Part C prescription "shall not be dispensed except in a hospital" —
     *   a restriction on the PREMISES, which rcln does not model, after
     *   Singapore's retail pharmacy versus clinic and Dubai's and Abu Dhabi's
     *   facility categories.
     *
     *   The tempting move is to define `PRESCRIPTION_ONLY_PART_C` and give it
     *   the ordinary prescription rules. That would be WORSE than defining
     *   nothing: a community pharmacy would get a clean `PERMITTED` for a supply
     *   the regulation forbids. With no classification for it the product
     *   matches nothing, resolves `UNDETERMINED`, and refuses.
     */
    const decision = await evaluate('PART_C', { prescription: DOCTOR_RX });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('refuses a medicine with no regulatory profile at all', async () => {
    const decision = await evaluate('UNCLASSIFIED', { prescription: DOCTOR_RX });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('raises no traceability obligation, because eur-lex could not be reached', async () => {
    /*
     * ⚠️ COMMISSION DELEGATED REGULATION (EU) 2016/161 IS DIRECTLY APPLICABLE IN
     *   IRELAND AND IS NOT CONFIGURED. Its consolidated text could not be
     *   retrieved — eur-lex.europa.eu answers `202` with a client-side challenge
     *   — and no source means no rule, the same discipline as the DSCSA gap in
     *   the United States pack.
     *
     *   ⚠️ AND THERE IS A SECOND REASON TO BE GLAD. `evaluateTraceability`
     *   REFUSES on a missing identifier, and `createDispenseWithin` passes lot,
     *   expiry and serial but no GTIN. A rule written from memory as
     *   `requiredIdentifiers: ['GTIN', ...]` would have refused every Irish
     *   dispense on the platform, for a field the caller simply never sends.
     */
    const decision = await evaluate('PART_A', { prescription: DOCTOR_RX });

    expect(codes(decision).some((code) => code.startsWith('IE-TRACE'))).toBe(false);
  });

  it('raises no reporting obligation on an ordinary transaction', async () => {
    /*
     * Regulation 24 requires particulars ON DEMAND, within fourteen days of a
     * written demand from the Minister. There is no periodic return of the kind
     * Abu Dhabi files monthly, and a `REPORTING_REQUIREMENT` rule raises its
     * condition on every evaluation — so writing one would attach a standing
     * obligation to every Irish transaction to answer a demand nobody made.
     */
    const decision = await evaluate('CD2', { prescription: { ...DOCTOR_RX } });

    expect(conditionKinds(decision)).not.toContain('REPORT_TO_AUTHORITY');
  });

  it('labels a dispensed medicine, and does so for an over-the-counter sale too', async () => {
    /*
     * Regulation 9(1) defines a "dispensed medicinal product" by HOW it was
     * supplied, not by what it is — including where the supervising pharmacist
     * "exercises his own judgement as to the treatment required". So the
     * labelling rule is the one rule in this pack with no classification, and it
     * reaches a counter sale.
     */
    const decision = await evaluate('PHARMACY_ONLY', { transaction: 'COUNTER_SALE' });

    expect(conditionKinds(decision)).toContain('LABEL_FIELDS');
    expect(codes(decision)).toContain('IE-LABEL-PHARMACY_ONLY');
  });
});
