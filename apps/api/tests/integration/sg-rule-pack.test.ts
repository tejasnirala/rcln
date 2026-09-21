/**
 * The Singapore rule pack, tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('SG')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ HALF OF THIS FILE PINS RULES THAT ARE DELIBERATELY ABSENT, AND THOSE CASES
 *   ARE THE ONES WORTH READING. Singapore's pack carries no pharmacist-only rule
 *   for a prescription-only medicine and no expiry on its prescription, and both
 *   omissions are arguable enough that somebody will eventually "fix" one. The
 *   assertions below are what turns that into a failing test rather than a
 *   silent tightening of the law at every Singaporean clinic.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACK, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run. `packages/regulatory/tests/engine.test.ts` proves
 *   the engine handles each SHAPE against a fictional jurisdiction; this file is
 *   the only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the
 *   instruments they were read from.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF SINGAPORE LAW IS CORRECT. It claims the
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

const SUFFIX = `s${Date.now().toString(36)}`;
const SLUG = `sgp-${SUFFIX}`;
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
 * ⚠️ `QUALIFIED_PHARMACIST` IS SINGAPORE'S OWN WORD FOR IT, and the packs
 *   deliberately do not share one vocabulary: the United States says
 *   `LICENSED_PHARMACIST` and Australia says `REGISTERED_PHARMACIST`. A licence
 *   type is a fact about a jurisdiction's register, so each pack names its own.
 */
const PHARMACIST = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['QUALIFIED_PHARMACIST'],
};

/** The same person without the registration — a dispensary assistant. */
const ASSISTANT = { roleCodes: ['pharmacy.dispense.create'] };

const DOCTOR_RX = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['MEDICAL_PRACTITIONER'],
};

const VET_RX = { ...DOCTOR_RX, prescriberClasses: ['VETERINARY_SURGEON'] };

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pte Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'SG',
      timezone: 'Asia/Singapore',
      currency: 'SGD',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+659${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

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
    [org.organizationId, `SGP-${SUFFIX}-${key}`, `SG pack ${key}`, unitId]
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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  const pack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'SG' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const jurisdictionId = pack.rows[0]?.jurisdiction_id;
  if (!jurisdictionId) {
    throw new Error('the Singapore rule pack is not seeded — run `pnpm db:seed` first');
  }

  org = await registerOrganization(payload(SLUG, 'SG Pack Co'));

  /*
   * ⚠️ THE BRANCH'S OWN COUNTRY IS SET HERE RATHER THAN THROUGH REGISTRATION.
   *   `branches.country_code` defaults to `IN` in the schema and registration
   *   does not derive it from the organization's, so a Singaporean organization
   *   can hold a branch the regulatory engine believes is in India. There is no
   *   region: Singapore is a city-state, and `CountryInfo.regions` for `SG` is
   *   empty because there is nothing to list — not, as Australia's was, because
   *   the list was written to answer a question about tax.
   */
  await owner.query(`UPDATE branches SET country_code = 'SG', region_code = NULL WHERE id = $1`, [
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
    ['POM', 'PRESCRIPTION_ONLY_MEDICINE'],
    ['PHARMACY_ONLY', 'PHARMACY_ONLY_MEDICINE'],
    ['CODEINE', 'CODEINE_COUGH_PREPARATION_LIQUID'],
    ['CD2', 'MDA_SECOND_SCHEDULE'],
    ['CD3', 'MDA_THIRD_SCHEDULE'],
    ['CD4', 'MDA_FOURTH_SCHEDULE'],
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
      [org.organizationId, org.branchId, kind, `SGP-${key}`, `SG pack ${key}`, controlled]
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
 * Therapeutic products — the prescription, and the two things it does
 * not come with
 * ------------------------------------------------------------------ */

describe('a prescription-only medicine needs a prescription and nothing more', () => {
  it('refuses a supply with no prescription', async () => {
    const decision = await evaluate('POM');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-RX-POM');
  });

  it('permits it once a doctor’s prescription is presented', async () => {
    const decision = await evaluate('POM', { prescription: DOCTOR_RX });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
  });

  it('applies no expiry, because these Regulations impose none', async () => {
    /*
     * ⚠️ THE ASSERTION THAT STOPS SOMEBODY WRITING `validityMonths: 6` BECAUSE
     *   EVERY OTHER PACK HAS A NUMBER. The Therapeutic Products Regulations say
     *   what makes a prescription valid — reg 2(2) — and set no period at all.
     *   A number invented here would refuse lawful supply while citing a
     *   regulation that permits it, which is a wrong answer in the refusing
     *   direction and therefore one nobody goes back to audit.
     */
    const decision = await evaluate('POM', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(400) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('lets an unregistered assistant hand it over, which is the pack’s sharpest omission', async () => {
    /*
     * ⚠️ THE MOST LIKELY "BUG FIX" IN THIS PACK, PINNED AS BEHAVIOUR. Every
     *   other jurisdiction here has a pharmacist-only rule and Singapore has
     *   none, because regulation 11(c) permits supply by "a person acting in
     *   accordance with the oral or written instructions of a qualified
     *   practitioner", and regulation 3(3) of the Licensing of Retail Pharmacies
     *   Regulations disapplies the pharmacist gate to exactly that case. Whether
     *   the gate applies turns on what the PREMISES are licensed as, which rcln
     *   does not know — so a `PHARMACIST_AUTHORITY` rule would refuse the
     *   ordinary Singapore clinic. Contrast `SG-SUPPLY-CD2` below, where the
     *   Misuse of Drugs Regulations name a closed list and no instructions limb.
     */
    const decision = await evaluate('POM', { prescription: DOCTOR_RX }, ASSISTANT);

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses a veterinary surgeon’s prescription, and accepts one for a controlled drug', async () => {
    /*
     * ⚠️ TWO INSTRUMENTS, TWO PRESCRIBER LISTS, AND THE DIFFERENCE IS ONE WORD.
     *   "Qualified practitioner" in reg 2(1) of the Therapeutic Products
     *   Regulations is a registered medical practitioner or a first-division
     *   dentist. "Practitioner" in reg 2(1) of the Misuse of Drugs Regulations
     *   is a medical practitioner, dentist OR VETERINARY SURGEON, and its
     *   definition of "prescription" names animal treatment expressly. Sharing
     *   one list between the two packs' rules would silently widen the first.
     */
    const onPom = await evaluate('POM', { prescription: VET_RX });
    expect(onPom.outcome).toBe('REFUSED');
    expect(codes(onPom)).toContain('SG-PRESCRIBER-POM');

    const onControlled = await evaluate('CD2', { prescription: VET_RX });
    expect(onControlled.outcome).not.toBe('REFUSED');
  });

  it('sells a pharmacy-only medicine over the counter and asks for a two-year record', async () => {
    const decision = await evaluate('PHARMACY_ONLY', { transaction: 'COUNTER_SALE' });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision)).toContain('SG-RETAIN-PHARMACY-ONLY');

    const retention = decision.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(retention).toHaveLength(1);
    expect(retention[0]?.parameters?.['years']).toBe(2);
  });

  it('refuses an unclassified medicine rather than permitting it', async () => {
    const decision = await evaluate('UNCLASSIFIED');

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Repeats — reg 17(2), and the endorsement with no number
 * ------------------------------------------------------------------ */

describe('a prescription-only medicine is dispensed once unless the prescriber said otherwise', () => {
  it('refuses a second supply on a prescription that authorises no repeat', async () => {
    const decision = await evaluate('POM', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-REPEAT-POM');
  });

  it('cannot decide an endorsement that states no number, and therefore refuses', async () => {
    /*
     * ⚠️ THIS IS SINGAPORE'S ANSWER, NOT THE FRAMEWORK'S DEFAULT SHOWING
     *   THROUGH. Reg 2(2)(b)(v) requires a prescription intended to be repeated
     *   to state the number of times and the interval; one that says "repeat"
     *   and no number is not a valid prescription. `SG-REPEAT-POM` sets no
     *   `maxEndorsedRepeats` for exactly that reason, so the engine has no
     *   ceiling to fall back on and says so.
     */
    const decision = await evaluate('POM', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1, repeatsAuthorised: true },
    });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(codes(decision)).toContain('SG-REPEAT-POM');
  });

  it('permits a repeat within the number the prescription states', async () => {
    const decision = await evaluate('POM', {
      prescription: {
        ...DOCTOR_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 2,
      },
    });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * The dispensing label — reg 17(1)
 * ------------------------------------------------------------------ */

describe('every dispensed therapeutic product carries the six-field label', () => {
  it('raises the label on a dispense, with all six particulars', async () => {
    const decision = await evaluate('POM', { prescription: DOCTOR_RX });

    expect(codes(decision)).toContain('SG-LABEL-DISPENSE');

    const label = decision.conditions.filter((c) => c.kind === 'LABEL_FIELDS');
    expect(label).toHaveLength(1);
    expect(label[0]?.parameters?.['fields']).toEqual([
      'PATIENT_NAME',
      'SUPPLYING_PREMISES',
      'DISPENSING_DATE',
      'DIRECTIONS_FOR_USE',
      'PRODUCT_NAME',
      'ACTIVE_INGREDIENT_PARTICULARS',
    ]);
  });

  it('does not raise it on a counter sale, which is not dispensing', async () => {
    /*
     * ⚠️ REG 2(1) DEFINES "DISPENSE" AS PREPARING AND SUPPLYING TO A PATIENT BY
     *   A PRACTITIONER OR PHARMACIST. A counter sale names no patient, and a
     *   label rule reaching it would demand a patient's name on a transaction
     *   that has none — which is how a correct obligation becomes an
     *   unsatisfiable one.
     */
    const decision = await evaluate('PHARMACY_ONLY', { transaction: 'COUNTER_SALE' });

    expect(codes(decision)).not.toContain('SG-LABEL-DISPENSE');
    expect(conditionKinds(decision)).not.toContain('LABEL_FIELDS');
  });
});

/* ------------------------------------------------------------------ *
 * Controlled drugs — 30 days, the register, and the schedule that has
 * neither
 * ------------------------------------------------------------------ */

describe('a controlled drug prescription runs for thirty days and not a day more', () => {
  it('permits one written 29 days ago and refuses one written 31 days ago', async () => {
    const fresh = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(29) },
    });
    expect(fresh.outcome).not.toBe('REFUSED');

    const stale = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(31) },
    });
    expect(stale.outcome).toBe('REFUSED');
    expect(codes(stale)).toContain('SG-RX-CD2');
  });

  it('refuses one dated after today, which is the other half of reg 12(1)', async () => {
    /*
     * ⚠️ "NOT BEFORE THE DATE SPECIFIED IN THE PRESCRIPTION" IS NOT A PARAMETER
     *   AND IS ENFORCED ANYWAY. `evaluatePrescriptionRequired` refuses a
     *   future-dated prescription whenever a validity is stated at all, so
     *   `validityDays: 30` buys both limbs of regulation 12(1). Nothing else in
     *   this suite would notice if that guard were removed.
     */
    const decision = await evaluate('CD2', {
      prescription: { ...DOCTOR_RX, issuedOn: daysAgo(-2) },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-RX-CD2');
  });

  it('refuses an unregistered assistant, where the same person may hand over a POM', async () => {
    const decision = await evaluate('CD2', { prescription: DOCTOR_RX }, ASSISTANT);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-SUPPLY-CD2');
  });

  it('demands the register for the Second Schedule and not for the Third', async () => {
    /*
     * ⚠️ THE EMPTY THIRD SCHEDULE RULE IS THE ASSERTION THAT MATTERS. Reg 14(1)
     *   binds a supplier of "a drug specified in the Second or Fourth Schedule"
     *   and says nothing about the Third; a `registerRequired` copied onto all
     *   three "for consistency" would impose a bound book the Regulations do not
     *   ask for, and no other case here would fail.
     */
    const second = await evaluate('CD2', { prescription: DOCTOR_RX });
    expect(codes(second)).toContain('SG-SCHEDULE-CD2');
    expect(conditionKinds(second)).toContain('RECORD_IN_CONTROLLED_REGISTER');

    const third = await evaluate('CD3', { prescription: DOCTOR_RX });
    expect(codes(third)).toContain('SG-SCHEDULE-CD3');
    expect(conditionKinds(third)).not.toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(third.outcome).not.toBe('REFUSED');
    /*
     * ⚠️ AND NOT UNDETERMINED EITHER, WHICH IS THE ASSERTION THAT WAS MISSING.
     *   `SG-SCHEDULE-CD3` imposed nothing and did not say it was informational,
     *   so the parser refused it and the rule resolved UNDETERMINED — a Third
     *   Schedule supply was blocked by the rule meant only to label it. Every
     *   assertion above passed throughout: an unreadable rule puts its code in
     *   the reasons and raises no conditions, exactly like the permissive rule
     *   this case is describing. UNDETERMINED is not REFUSED, so the line above
     *   could not catch it. Fixed in PI-24.
     */
    expect(third.outcome).not.toBe('UNDETERMINED');
  });

  it('keeps controlled-drug papers for three years, against a POM’s two', async () => {
    const controlled = await evaluate('CD2', { prescription: DOCTOR_RX });
    const controlledRetention = controlled.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(controlledRetention).toHaveLength(1);
    expect(controlledRetention[0]?.parameters?.['years']).toBe(3);

    const pom = await evaluate('POM', { prescription: DOCTOR_RX });
    const pomRetention = pom.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(pomRetention).toHaveLength(1);
    expect(pomRetention[0]?.parameters?.['years']).toBe(2);
  });

  it('refuses a Fourth Schedule supply outright, whoever is standing there', async () => {
    /*
     * ⚠️ REG 8A NAMES NO PHARMACIST, AND THAT ABSENCE IS THE RULE. A Fourth
     *   Schedule drug may be supplied only by an approved researcher, a
     *   laboratory custodian, an HSA or DSO analyst or an inspector — so a
     *   dispensing point may not supply one at all, and a registered pharmacist
     *   holding a valid prescription is refused exactly like everyone else.
     */
    const decision = await evaluate('CD4', { prescription: DOCTOR_RX });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-SUPPLY-CD4');
  });
});

/* ------------------------------------------------------------------ *
 * Storage and destruction
 * ------------------------------------------------------------------ */

describe('controlled drugs are locked up, and destroyed in front of an inspector', () => {
  it('refuses a controlled receipt into ordinary stock and permits it into a locked store', async () => {
    const shelf = await evaluate('CD2', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });
    expect(shelf.outcome).toBe('REFUSED');
    expect(codes(shelf)).toContain('SG-STORE-CD2');

    const safe = await evaluate('CD2', {
      transaction: 'STOCK',
      locationId: locations['SAFE'],
    });
    expect(safe.outcome).not.toBe('REFUSED');
    expect(conditionKinds(safe)).toContain('STORE_UNDER_CONDITIONS');
  });

  it('requires a witness to destroy a Second Schedule drug, and none for a Third', async () => {
    const second = await evaluate('CD2', { transaction: 'DISPOSE' });
    expect(second.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(codes(second)).toContain('SG-DISPOSE-CD2');
    expect(conditionKinds(second)).toContain('WITNESS_REQUIRED');

    const third = await evaluate('CD3', { transaction: 'DISPOSE' });
    expect(conditionKinds(third)).not.toContain('WITNESS_REQUIRED');
  });
});

/* ------------------------------------------------------------------ *
 * Codeine cough preparations — the half of reg 14 that is expressible
 * ------------------------------------------------------------------ */

describe('codeine cough preparations are capped at 240 ml over seven days', () => {
  it('cannot decide the supply until it is told what the patient has already had', async () => {
    /*
     * ⚠️ "WE DID NOT CHECK" IS NOT "THEY HAVE HAD NONE". `maxPerPeriodBase`
     *   without a prior quantity is `UNDETERMINED`, which refuses — and the
     *   caller who cannot answer is precisely the one whose patient history is
     *   incomplete. A per-transaction cap would be readable everywhere and would
     *   say something reg 14(1)(a) does not: the limit is an AGGREGATE over
     *   seven days, so one 240 ml bottle a day would satisfy it.
     */
    const decision = await evaluate('CODEINE', {
      prescription: DOCTOR_RX,
      quantityBase: '100',
    });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(codes(decision)).toContain('SG-QTY-CODEINE-LIQUID');
  });

  it('permits a supply that stays under the aggregate and refuses one that crosses it', async () => {
    const within = await evaluate('CODEINE', {
      prescription: DOCTOR_RX,
      quantityBase: '100',
      priorQuantityInPeriodBase: '100',
    });
    expect(within.outcome).not.toBe('REFUSED');
    expect(within.outcome).not.toBe('UNDETERMINED');

    const over = await evaluate('CODEINE', {
      prescription: DOCTOR_RX,
      quantityBase: '100',
      priorQuantityInPeriodBase: '150',
    });
    expect(over.outcome).toBe('REFUSED');
    expect(codes(over)).toContain('SG-QTY-CODEINE-LIQUID');
  });

  it('still needs a prescription, because a codeine linctus is a POM under another name', async () => {
    /*
     * ⚠️ THE PRICE OF A SINGLE-STRING CLASSIFICATION, PAID DELIBERATELY. A
     *   product filed as `CODEINE_COUGH_PREPARATION_LIQUID` does not match
     *   `SG-RX-POM`, so without `SG-RX-CODEINE-LIQUID` the quantity cap would be
     *   the only thing between a customer and a bottle of it.
     */
    const decision = await evaluate('CODEINE', {
      quantityBase: '100',
      priorQuantityInPeriodBase: '0',
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('SG-RX-CODEINE-LIQUID');
  });
});
