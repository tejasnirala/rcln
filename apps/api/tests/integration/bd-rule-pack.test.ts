/**
 * The Bangladesh rule pack, tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('BD')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ THE CASES WORTH READING ARE THE THREE ABOUT WHAT BANGLADESHI LAW DOES NOT
 *   SAY. There is no prescription validity anywhere, no repeat rule for an
 *   ordinary prescription medicine, and no dispensing label except for a
 *   Schedule D poison. All three are PERMISSIVE gaps — the direction this
 *   programme is normally shaped against — and all three are the law rather than
 *   the pack. Each is pinned below so that closing one with a plausible number
 *   fails the suite instead of quietly legislating for Bangladesh.
 *
 * ⚠️ AND THE ONE ABOUT THE VETERINARY PRESCRIPTION, WHICH IS PINNED IN THE
 *   REFUSING DIRECTION. Section 2(12) of the মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮
 *   defines চিকিৎসক to include a Registered Veterinary Practitioner; the ঔষধ ও
 *   কসমেটিকস্ আইন, ২০২৩ defines চিকিৎসক nowhere. So a vet may prescribe a
 *   narcotic here and — on this pack's reading — may not prescribe an
 *   antibiotic. Both halves are asserted, because the inversion looks so much
 *   like a bug that somebody will "fix" it.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACK, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run. `packages/regulatory/tests/engine.test.ts` proves
 *   the engine handles each SHAPE against a fictional jurisdiction; this file is
 *   the only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the
 *   instruments they were read from.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF BANGLADESHI LAW IS CORRECT — and the
 *   authentic text is Bangla, which nobody who has read this pack has had
 *   confirmed by a qualified person. It claims the engine acts on the pack as
 *   configured. Whether it says the right thing is `RulePackMaturity`.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `b${Date.now().toString(36)}`;
const SLUG = `bdp-${SUFFIX}`;
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
 * The three people section 45(1) admits, and the one it does not.
 *
 * ⚠️ THESE ARE LICENCE TYPES AND NOT ROLE CODES, and they are Bangladesh's own
 *   words for them — the Bangladesh Pharmacy Council's ‘এ’, ‘বি’ and ‘সি’
 *   categories, which section 45's Explanation and section 2(23) name. Ireland
 *   says `REGISTERED_PHARMACIST`, the United States `LICENSED_PHARMACIST`,
 *   Singapore `QUALIFIED_PHARMACIST`. A licence type is a fact about one
 *   country's register, so no constant is shared between packs.
 */
const GRADE_A = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['GRADE_A_PHARMACIST'],
};

const GRADE_B = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['GRADE_B_DIPLOMA_PHARMACIST'],
};

const GRADE_C = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['GRADE_C_PHARMACY_TECHNICIAN'],
};

/** The same person with no Council registration at all — a shop assistant. */
const ASSISTANT = { roleCodes: ['pharmacy.dispense.create'] };

/**
 * The doctor dispensing to their own patient.
 *
 * ⚠️ NOT AN EXEMPTION HERE, WHICH IS THE DIFFERENCE FROM INDIA. Section 45(1)
 *   says "কোনো ব্যক্তি" — any person — and writes no own-patient proviso of the
 *   kind India's Pharmacy Act s. 42(1) contains, so
 *   `exemptWhenActorIsPrescriber` is deliberately not set on any BD rule and
 *   this actor is refused like any other unregistered one.
 */
const PRESCRIBING_DOCTOR = { roleCodes: ['pharmacy.dispense.create'], isPrescriber: true };

const DOCTOR_RX = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['REGISTERED_MEDICAL_PRACTITIONER'],
};

const DENTIST_RX = { ...DOCTOR_RX, prescriberClasses: ['REGISTERED_DENTAL_PRACTITIONER'] };
const VET_RX = { ...DOCTOR_RX, prescriberClasses: ['REGISTERED_VETERINARY_PRACTITIONER'] };
const HOMEOPATH_RX = {
  ...DOCTOR_RX,
  prescriberClasses: ['REGISTERED_HOMEOPATHIC_PRACTITIONER'],
};

/** A prescription written exactly `years` calendar years ago, to the day. */
function yearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString();
}

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Limited`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'BD',
      timezone: 'Asia/Dhaka',
      /*
       * ⚠️ NO `currency`, AND ITS ABSENCE IS A FINDING RATHER THAN A FIXTURE
       *   CONVENIENCE. `seed/plans.ts` publishes prices in INR, USD, EUR, GBP,
       *   AED, SGD and AUD and **not in BDT**, so `registerOrganization` with
       *   `currency: 'BDT'` finds no monthly price and throws
       *   `PLAN_UNAVAILABLE` — a 503. **A Bangladeshi clinic cannot register
       *   today**, which is a platform gap this pack surfaced and does not fix;
       *   pricing per currency is a business decision and the seed's own comment
       *   says prices are never converted.
       *
       *   Omitting it exercises `currencyForCountry`'s fallback, which is the
       *   path a real Bangladeshi registration would take once someone decides
       *   whether to publish a BDT price or bill in USD. Recorded in
       *   KNOWN_ISSUES; nothing in this file depends on the currency, because
       *   the regulatory engine reads the BRANCH's country and never the
       *   organization's billing currency.
       */
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+8801${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

/**
 * ⚠️ EVERY PROFILE RECORDS `online_sale_position = 'PERMITTED'`, AND WITHOUT
 *   THAT NOTHING BELOW WOULD PROVE ANYTHING ABOUT BANGLADESH'S ONLINE PHARMACY
 *   RULES. `onlineSaleGap` runs BEFORE any rule: a profile whose position is
 *   `UNKNOWN` — the column's default — answers `UNDETERMINED` for every
 *   `ONLINE_DISPENSE`, which refuses. Every remote-supply case here would have
 *   "passed" on PI-12's gate while the DGDA rules sat inert behind it.
 *
 *   So the fixture says the clinic HAS looked at each product and recorded that
 *   it may be sold online, and the refusals that follow are the criteria's.
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
    [org.organizationId, `BDP-${SUFFIX}-${key}`, `BD pack ${key}`, unitId]
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
      WHERE j.country_code = 'BD' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const jurisdictionId = pack.rows[0]?.jurisdiction_id;
  if (!jurisdictionId) {
    throw new Error('the Bangladesh rule pack is not seeded — run `pnpm db:seed` first');
  }

  org = await registerOrganization(payload(SLUG, 'BD Pack Co'));

  /*
   * ⚠️ THE BRANCH'S OWN COUNTRY IS SET HERE RATHER THAN THROUGH REGISTRATION.
   *   `branches.country_code` defaults to `IN` in the schema and registration
   *   does not derive it from the organization's, so a Bangladeshi organization
   *   can hold a branch the regulatory engine believes is in India.
   *
   * ⚠️ AND `region_code` IS NULL BECAUSE BANGLADESHI MEDICINES LAW IS NATIONAL.
   *   `CountryInfo.regions` for `BD` is empty; DGDA and the Department of
   *   Narcotics Control are national bodies and a district regulates no part of
   *   this, so unlike Victoria and Dubai there is no sub-national pack this
   *   emptiness could make inert. The check was still run.
   */
  await owner.query(`UPDATE branches SET country_code = 'BD', region_code = NULL WHERE id = $1`, [
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
    ['OTC', 'OVER_THE_COUNTER'],
    ['RX', 'PRESCRIPTION_ONLY'],
    ['SCH_G', 'SCHEDULE_G'],
    ['SCH_D', 'SCHEDULE_D_POISON'],
    ['SCH_C', 'SCHEDULE_C_BIOLOGICAL'],
    ['CD_KA', 'NARCOTIC_CLASS_KA'],
    ['CD_KHA', 'NARCOTIC_CLASS_KHA'],
    ['CD_GA', 'NARCOTIC_CLASS_GA'],
    /* A string this pack does not define — the fail-open PI-18 found. */
    ['SCHEDULE_H', 'SCHEDULE_H'],
    ['UNCLASSIFIED', null],
  ] as const) {
    await makeProduct(key, classification, unitId, jurisdictionId);
  }

  for (const [key, kind, controlled] of [
    ['SHELF', 'MAIN_PHARMACY', false],
    ['LOCKED', 'CONTROLLED_CABINET', true],
  ] as const) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, requires_controlled_access, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::"LocationKind", $4, $5, $6, now())
       RETURNING id`,
      [org.organizationId, org.branchId, kind, `BDP-${key}`, `BD pack ${key}`, controlled]
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
  actor: Record<string, unknown> = GRADE_A
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
 * Section 40(ঘ) — a prescription for everything that is not OTC
 * ------------------------------------------------------------------ */

describe('the prescription requirement, and the one carve-out from it', () => {
  it('refuses a prescription medicine with no prescription', async () => {
    const decision = await evaluate('RX');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-RX-RX');
  });

  it('permits it once a registered physician’s prescription is presented', async () => {
    const decision = await evaluate('RX', { prescription: DOCTOR_RX });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
  });

  it('sells an Over the Counter medicine with no prescription at all', async () => {
    /*
     * Section 40(ঘ) forbids selling "an antibiotic or any other drug, other than
     * an Over the Counter drug, without the prescription of a registered
     * physician". OTC is the whole of the exception, so there is no
     * `PRESCRIPTION_REQUIRED` rule for it — and section 45(1) still applies.
     */
    const decision = await evaluate('OTC', { transaction: 'COUNTER_SALE' });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision).some((code) => code.startsWith('BD-RX-'))).toBe(false);
  });

  it('carries the requirement onto a narcotic, from the medicines Act', async () => {
    /*
     * ⚠️ A NARCOTIC NEVER SEES `BD-RX-RX`, BECAUSE `mostSpecific` SELECTS PER
     *   CLASSIFICATION. Section 12 of the 2018 Act says who may WRITE a
     *   prescription and that it may not be used twice; it does not itself
     *   impose the requirement. So the row on each narcotic class cites section
     *   40(ঘ) of the 2023 Act, and dropping it "because the narcotics Act covers
     *   it" would have left a class ‘ক’ narcotic sellable across a counter.
     */
    const decision = await evaluate('CD_KA');

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-RX-CD-KA');
  });

  it('honours a prescription written twenty years ago, because no law here expires one', async () => {
    /*
     * ⚠️ THIS IS A PERMISSIVE GAP, IT IS PINNED ON PURPOSE, AND IT IS THE LAW
     *   RATHER THAN THE PACK. Section 40(ঘ) requires a prescription and says
     *   nothing about its age. Rule 24(10) of the Bengal Drugs Rules lists what
     *   one must contain — in writing, signed, dated, the patient's name and
     *   address, the total amount and the dose — and imposes no expiry. Neither
     *   does the 2018 Act.
     *
     *   `validityDays: 180` would have been the comfortable choice and would
     *   have been this pack inventing a rule for a sovereign state. If somebody
     *   later finds a Gazette notification that sets a period, this case is what
     *   turns adding it into a deliberate change rather than a quiet one.
     */
    const decision = await evaluate('RX', {
      prescription: { ...DOCTOR_RX, issuedOn: yearsAgo(20) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('still refuses a prescription dated after the day it is dispensed', async () => {
    /*
     * The engine's own guard rather than Bangladesh's, and it now runs.
     *
     * ⚠️ THIS CASE USED TO ASSERT THE OPPOSITE OF ITS OWN TITLE, AND THAT IS
     *   WORTH KEEPING IN VIEW. It read `not.toBe('REFUSED')` and explained,
     *   honestly, that the future-dating guard sat INSIDE the validity
     *   conditional — so a pack configuring no validity never ran it, and a
     *   prescription dated thirty days from now was dispensed. Bangladesh
     *   deliberately configures none, because no Gazette notification sets a
     *   period, and India is in the same position. So the gap was live in two
     *   countries and this file pinned it rather than reporting it.
     *
     *   PI-24 hoisted the guard out of the conditional: no jurisdiction permits
     *   dispensing against a prescription that has not been written yet, and
     *   `evaluateRefillRule` had always checked it unconditionally. The
     *   twenty-year-old prescription above is still permitted — that gap is
     *   Bangladesh's own and is unchanged.
     */
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 30);
    const decision = await evaluate('RX', {
      prescription: { ...DOCTOR_RX, issuedOn: future.toISOString() },
    });

    expect(decision.outcome).toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * Who may have written it — and the inversion between the two statutes
 * ------------------------------------------------------------------ */

describe('the prescriber, whom the two Acts define differently', () => {
  it('accepts a registered dental practitioner for an ordinary medicine', async () => {
    const decision = await evaluate('RX', { prescription: DENTIST_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('REFUSES a veterinary prescription for an ordinary medicine', async () => {
    /*
     * ⚠️ WRITTEN IN THE REFUSING DIRECTION KNOWINGLY, AND THIS CASE IS WHY THE
     *   CHEAP FIX FAILS THE SUITE. The 2023 Act never defines চিকিৎসক and
     *   section 40(ঘ) says only "রেজিস্টার্ড চিকিৎসক". The 2018 Act's definition
     *   — which does include a Registered Veterinary Practitioner — belongs to a
     *   different statute, and importing it is a step no source authorises.
     *
     *   The cost is real: this refuses what is very probably a lawful supply,
     *   routinely, in exactly the veterinary clinics PI-11 built for. It is in
     *   KNOWN_ISSUES. The fix is a source, not a bolder reading.
     */
    const decision = await evaluate('RX', { prescription: VET_RX });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-PRESCRIBER-RX');
  });

  it('ACCEPTS the same veterinary prescription for a narcotic', async () => {
    /*
     * ⚠️ THE INVERSION, ASSERTED SO NOBODY "FIXES" IT. Section 2(12) of the
     *   মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮ defines চিকিৎসক to include a Registered
     *   Veterinary Practitioner under the Bangladesh Veterinary Practitioner
     *   Ordinance, 1982. Bangladesh's narcotics law admits a WIDER set of
     *   prescribers than its medicines law, and both rows are faithful to their
     *   own statute.
     */
    const decision = await evaluate('CD_KA', { prescription: VET_RX });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('accepts a homeopathic practitioner for a narcotic and refuses one for a medicine', async () => {
    const narcotic = await evaluate('CD_KHA', { prescription: HOMEOPATH_RX });
    const medicine = await evaluate('RX', { prescription: HOMEOPATH_RX });

    expect(narcotic.outcome).not.toBe('REFUSED');
    expect(medicine.outcome).toBe('REFUSED');
  });

  it('refuses to answer when the prescriber’s registration class was not supplied', async () => {
    /*
     * `evaluatePrescriberAuthority` answers `UNDETERMINED`, which refuses.
     * Section 40(ঘ) turns entirely on the prescriber being REGISTERED; a
     * platform that dispenses without establishing what they are registered as
     * has accepted a prescription rather than read one.
     */
    const { prescriberClasses: _omitted, ...anonymous } = DOCTOR_RX;
    const decision = await evaluate('RX', { prescription: anonymous });

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Section 45(1) — who may hand it over, and the narrower list online
 * ------------------------------------------------------------------ */

describe('personal supervision, in three grades at the counter and one online', () => {
  it('refuses an unregistered assistant', async () => {
    const decision = await evaluate('RX', { prescription: DOCTOR_RX }, ASSISTANT);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-DISPENSER-RX');
  });

  it('accepts a Pharmacy Technician at the counter, which section 45(1) admits', async () => {
    /*
     * ⚠️ WIDER THAN MOST PACKS IN THIS PROGRAMME, AND THAT IS THE SECTION.
     *   Ireland requires a registered pharmacist. Section 45(1) admits a
     *   Pharmacist, a Diploma Pharmacist OR a Pharmacy Technician — categories
     *   ‘এ’, ‘বি’ and ‘সি’ of the Bangladesh Pharmacy Council register.
     *   Narrowing this to grade A would refuse the ordinary staffing of most
     *   Bangladeshi retail pharmacies.
     */
    const decision = await evaluate('RX', { prescription: DOCTOR_RX }, GRADE_C);

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('accepts a Diploma Pharmacist selling an OTC medicine over the counter', async () => {
    const decision = await evaluate('OTC', { transaction: 'COUNTER_SALE' }, GRADE_B);

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('refuses an assistant even for an OTC sale, because section 45(1) is not about prescriptions', async () => {
    const decision = await evaluate('OTC', { transaction: 'COUNTER_SALE' }, ASSISTANT);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-DISPENSER-OTC');
  });

  it('does NOT stand aside for a doctor dispensing to their own patient', async () => {
    /*
     * ⚠️ THE DIFFERENCE FROM INDIA AND IRELAND, PINNED BECAUSE IT IS THE
     *   ASSUMPTION SOMEBODY WILL CARRY IN. India's Pharmacy Act s. 42(1)
     *   excludes "the dispensing by a medical practitioner of medicine for his
     *   own patients"; Ireland's regulation 20(3)(c) does the same for a
     *   practitioner and a dentist. Section 45(1) says "কোনো ব্যক্তি" — any
     *   person — and writes no proviso, so `exemptWhenActorIsPrescriber` is not
     *   set on any rule in this pack and the doctor is refused.
     */
    const decision = await evaluate('RX', { prescription: DOCTOR_RX }, PRESCRIBING_DOCTOR);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-DISPENSER-RX');
  });

  it('refuses a Pharmacy Technician supplying the same medicine online', async () => {
    /*
     * ⚠️ THE ONE PLACE A GUIDANCE DOCUMENT NARROWS A STATUTE. Online Pharmacy
     *   Criteria clause 2: "The pharmacy should be operated by the presence of
     *   Grade ‘A’ Pharmacist. There may be presence of B, C grade pharmacist as
     *   associate." Clause 6(a) makes the registered pharmacist verify the
     *   prescription. A licence condition may be stricter than the section it is
     *   granted under; this one is.
     */
    const decision = await evaluate(
      'RX',
      { transaction: 'ONLINE_DISPENSE', prescription: DOCTOR_RX },
      GRADE_C
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-DISPENSER-ONLINE-RX');
  });

  it('permits a Grade A Pharmacist to supply it online', async () => {
    const decision = await evaluate(
      'RX',
      { transaction: 'ONLINE_DISPENSE', prescription: DOCTOR_RX },
      GRADE_A
    );

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('imposes no supervision on a wholesale movement, which section 45(4) exempts', async () => {
    /*
     * "পাইকারীভাবে ঔষধ বিক্রয়ের ক্ষেত্রে … তত্ত্বাবধানের প্রয়োজন হইবে না."
     * `STOCK` and `TRANSFER` are deliberately off every dispenser rule's
     * transaction list; adding them would impose a pharmacist on a warehouse
     * the Act exempts.
     */
    const decision = await evaluate(
      'RX',
      { transaction: 'TRANSFER', locationId: locations['SHELF'] },
      ASSISTANT
    );

    expect(codes(decision).some((code) => code.startsWith('BD-DISPENSER'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Repeats — one schedule has a rule, and the ordinary medicine has none
 * ------------------------------------------------------------------ */

describe('repeats, where the Rules provide for them and where nothing does', () => {
  it('refuses a second Schedule G supply with no endorsement', async () => {
    const decision = await evaluate('SCH_G', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-REPEAT-SCH-G');
  });

  it('refuses to answer when the prescriber endorsed a repeat but stated no number', async () => {
    /*
     * ⚠️ RULE 24(11)(b) SETS NO CEILING OF ITS OWN — it says the prescription
     *   "must not be dispensed otherwise than in accordance with directions" —
     *   so there is no `maxEndorsedRepeats` to fall back on. "The prescriber
     *   allowed repeats but nobody can say how many" is a reason to ring the
     *   prescriber, not a licence to keep dispensing, and `evaluateRefillRule`
     *   answers `UNDETERMINED`, which refuses.
     */
    const decision = await evaluate('SCH_G', {
      prescription: { ...DOCTOR_RX, refillsUsed: 1, repeatsAuthorised: true },
    });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('permits it where the endorsement states a number that has not been used up', async () => {
    const decision = await evaluate('SCH_G', {
      prescription: {
        ...DOCTOR_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 2,
      },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('permits an unlimited repeat of an ordinary prescription medicine', async () => {
    /*
     * ⚠️ THE SECOND PERMISSIVE GAP, PINNED FOR THE SAME REASON AS THE FIRST.
     *   Rule 24(11) opens "the person dispensing a prescription containing a
     *   drug specified in Schedule G", and that limitation is the rule. Nothing
     *   in the 2023 Act or the Rules restricts how often an ordinary
     *   prescription medicine may be dispensed on one prescription, so
     *   `PRESCRIPTION_ONLY` carries no `REFILL_RULE` at all.
     *
     *   Copying `BD-REPEAT-SCH-G` onto it would be a refusal nobody legislated.
     *   Recorded in KNOWN_ISSUES beside the missing validity — together they
     *   mean one Bangladeshi prescription is, on this pack's reading, good
     *   forever and for any number of supplies.
     */
    const decision = await evaluate('RX', {
      prescription: { ...DOCTOR_RX, refillsUsed: 40 },
    });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision).some((code) => code.startsWith('BD-REPEAT-'))).toBe(false);
  });

  it('refuses a second narcotic supply even where the prescriber endorsed one', async () => {
    /*
     * ⚠️ `endorsedRepeatsPermitted: false` IS THE DIFFERENCE FROM SCHEDULE G AND
     *   IS WHAT SECTION 12(2) SAYS: a narcotic "may not be bought more than once
     *   on the basis of the prescription", with no "unless the prescriber has
     *   stated". A prescriber's endorsement cannot authorise what the statute
     *   forbids.
     */
    const decision = await evaluate('CD_GA', {
      prescription: {
        ...DOCTOR_RX,
        refillsUsed: 1,
        repeatsAuthorised: true,
        repeatsAuthorisedLimit: 5,
      },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-REPEAT-CD-GA');
  });
});

/* ------------------------------------------------------------------ *
 * Section 9 — the licence a narcotic supply rests on
 * ------------------------------------------------------------------ */

describe('the Department of Narcotics Control licence, raised and not checked', () => {
  it('raises it as a condition rather than refusing for want of a record', async () => {
    /*
     * ⚠️ GAP 2's SHAPE. Section 9(1) forbids the supply, sale, purchase,
     *   possession, storage and display of a narcotic; section 9(3)(ক) permits
     *   all of it "লাইসেন্সবলে" where the narcotic is needed for an authorised
     *   medicine or for treatment. Whether this branch holds a current DNC
     *   licence is not a fact rcln holds: `UNDETERMINED` would refuse every
     *   lawful narcotic supply in Bangladesh, and a silent permission would drop
     *   the thing that makes the supply lawful.
     */
    const decision = await evaluate('CD_KA', { prescription: DOCTOR_RX });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
    expect(codes(decision)).toContain('BD-CD-CD-KA');
    expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_AUTHORISATION');
  });

  it('names the authority on the condition, so the screen can say where to look', async () => {
    const decision = await evaluate('CD_KHA', { prescription: DOCTOR_RX });
    const raised = decision.conditions.find((c) => c.kind === 'VERIFY_PRIOR_AUTHORISATION');

    expect(raised?.parameters?.['authority']).toBe('the Department of Narcotics Control');
  });

  it('raises no controlled register and no safe, because the বিধিমালা were not retrieved', async () => {
    /*
     * ⚠️ THE AUSTRALIAN FAILURE SHAPE, AVOIDED DELIBERATELY AND ASSERTED HERE.
     *   `AU-SCHEDULE-S8` carries only `scheduleName`, which
     *   `parseControlledSchedule` REJECTS as imposing no obligation — so it
     *   resolves `UNDETERMINED` and refuses every Schedule 8 transaction in
     *   seven Australian jurisdictions, while its behaviour case asserts only
     *   that the code appears.
     *
     *   These rows carry `priorAuthorisationRequired`, so they are readable. But
     *   `registerRequired` is NOT set: section 48(1)(অ)'s power to inspect
     *   "হিসাববহি অথবা নিবন্ধনবহি" presupposes an obligation living in rules
     *   dnc.gov.bd did not serve, and an obligation inferred from an inspection
     *   power is an obligation this pack would have written itself. The outcome
     *   assertion above is what proves the row is readable rather than inert.
     */
    const decision = await evaluate('CD_KA', { prescription: DOCTOR_RX });

    expect(conditionKinds(decision)).not.toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(conditionKinds(decision)).not.toContain('WITNESS_REQUIRED');
  });

  it('lets a narcotic be stocked on an open shelf, because no source requires a safe', async () => {
    /*
     * ⚠️ PERMISSIVE, AND HONEST. Ireland's Safe Custody Regulations and
     *   Victoria's welded steel cabinet exist because those instruments were
     *   read. Bangladesh's equivalent is in বিধিমালা made under section 68 that
     *   could not be retrieved, and `storageLocationKinds` invented from the
     *   shape of other countries' law would refuse lawful stock movements at
     *   every Bangladeshi pharmacy.
     */
    const decision = await evaluate('CD_KA', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * The 1946 Rules — the cupboard, the label and the registers
 * ------------------------------------------------------------------ */

describe('Schedule D, which is about poisons rather than narcotics', () => {
  it('refuses to stock a Schedule D poison where customers can reach it', async () => {
    /*
     * Rule 24(12): "(a) in a cupboard or drawer reserved solely for the storage
     * of poisons; or (b) in a part of the premises separated from the remainder
     * of the premises and to which customers are not permitted to have access."
     * A location the public can reach satisfies neither limb.
     */
    const decision = await evaluate('SCH_D', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('BD-STORE-SCH-D');
  });

  it('permits it into a location with controlled access', async () => {
    const decision = await evaluate('SCH_D', {
      transaction: 'STOCK',
      locationId: locations['LOCKED'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('labels a dispensed Schedule D medicine with four things', async () => {
    const decision = await evaluate('SCH_D', { prescription: DOCTOR_RX });
    const label = decision.conditions.find((c) => c.kind === 'LABEL_FIELDS');

    expect(codes(decision)).toContain('BD-LABEL-SCH-D');
    expect(label?.parameters?.['fields']).toEqual([
      'SUPPLIER_NAME',
      'SUPPLIER_ADDRESS',
      'DOSE',
      'POISON_WARNING',
    ]);
  });

  it('labels nothing else, because rule 53(2) disapplies the labelling part', async () => {
    /*
     * ⚠️ THE THIRD PERMISSIVE GAP, AND THE ONE THAT READS BACKWARDS. Rule 53(2)
     *   does not narrow a general dispensing label to poisons; it DISAPPLIES
     *   rules 55 to 60 from a medicine made up ready for treatment and supplied
     *   on a prescription, and then re-imposes four conditions only where the
     *   medicine contains a Schedule D substance. There is no general dispensing
     *   label in Bangladeshi law to narrow, so an ordinary prescription medicine
     *   leaves the counter with nothing required on it at all.
     */
    const decision = await evaluate('RX', { prescription: DOCTOR_RX });

    expect(conditionKinds(decision)).not.toContain('LABEL_FIELDS');
  });
});

describe('the registers, and the one period that is not two years', () => {
  it('keeps the prescription register for two years, with rule 24(3)’s particulars', async () => {
    const decision = await evaluate('RX', { prescription: DOCTOR_RX });
    const retention = decision.conditions.find((c) => c.kind === 'RETAIN_RECORD');

    expect(codes(decision)).toContain('BD-RETAIN-RX');
    expect(retention?.parameters?.['years']).toBe(2);
  });

  it('keeps a wholesale Schedule C trail for three years instead', async () => {
    /*
     * ⚠️ TWO RETENTION ROWS COEXIST FOR ONE CLASSIFICATION, AND NEITHER
     *   SUPPRESSES THE OTHER, BECAUSE `selectApplicableRules` FILTERS BY
     *   TRANSACTION BEFORE `mostSpecific` RUNS. The retail row is silent about
     *   `STOCK` and `TRANSFER`; this one speaks to nothing else. Rule 24(5) sets
     *   its own three years and rule 24(7)'s two-year floor applies "except
     *   where otherwise provided in these rules".
     */
    const decision = await evaluate('SCH_C', {
      transaction: 'TRANSFER',
      locationId: locations['SHELF'],
    });
    const retention = decision.conditions.find((c) => c.kind === 'RETAIN_RECORD');

    expect(codes(decision)).toContain('BD-RETAIN-WHOLESALE-SCH-C');
    expect(retention?.parameters?.['years']).toBe(3);
  });

  it('raises exactly ONE retention obligation on that transfer, not two', async () => {
    /*
     * ⚠️ THIS CASE EXISTS BECAUSE THE PACK'S FIRST DRAFT RAISED TWO, AND THE
     *   ASSERTION ABOVE WOULD NOT HAVE CAUGHT IT ON ITS OWN. `BD-RETAIN-SCH-C`
     *   was written with `appliesToTransactions: []` — the shape `IE-RETAIN-*`
     *   uses, where a pack has one retention rule per classification. An empty
     *   list means EVERY transaction, so it also matched a `TRANSFER`, tied
     *   with the wholesale rule under `mostSpecific` (ties are kept and both
     *   are evaluated), and the decision came back saying "keep this for two
     *   years" and "keep this for three years" at once.
     *
     *   `.find()` in the case above happened to return the wrong one, which is
     *   why it failed loudly. It might just as easily have returned the right
     *   one and left the duplicate obligation on screen forever.
     */
    const decision = await evaluate('SCH_C', {
      transaction: 'TRANSFER',
      locationId: locations['SHELF'],
    });

    expect(conditionKinds(decision).filter((kind) => kind === 'RETAIN_RECORD')).toHaveLength(1);
    expect(codes(decision)).not.toContain('BD-RETAIN-SCH-C');
  });

  it('raises no retention obligation on an over-the-counter sale', async () => {
    /*
     * Rule 24(3) is about a supply "on the prescription of a registered
     * practitioner" and rule 24(4) about Schedule C and Schedule D. Neither
     * reaches an ordinary counter sale, and inventing one would be an obligation
     * nobody wrote.
     */
    const decision = await evaluate('OTC', { transaction: 'COUNTER_SALE' });

    expect(conditionKinds(decision)).not.toContain('RETAIN_RECORD');
  });
});

/* ------------------------------------------------------------------ *
 * Remote supply — licensed, and closed to controlled drugs
 * ------------------------------------------------------------------ */

describe('the DGDA Online Pharmacy licence, and the one thing it forbids', () => {
  it('permits a remote supply subject to the online pharmacy licence', async () => {
    /*
     * ⚠️ GAP 6's SECOND OUTING. Ireland's regulation 19A(1) needed
     *   `requiresDistanceSellingAuthorisation` because a bare `permitted: true`
     *   asserted the opposite of a provision that permits distance selling only
     *   from a supplier on a register. DGDA's Online Pharmacy licence is the
     *   same thing under a different name — a separate licence, valid two years,
     *   on top of the retail drug licence.
     */
    const decision = await evaluate('RX', {
      transaction: 'ONLINE_DISPENSE',
      prescription: DOCTOR_RX,
    });
    const raised = decision.conditions.find((c) => c.kind === 'VERIFY_PRIOR_AUTHORISATION');

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision)).toContain('BD-ONLINE-RX');
    expect(raised?.parameters?.['authority']).toBe(
      'the Directorate General of Drug Administration'
    );
  });

  it('refuses a controlled drug remotely, whatever else is in order', async () => {
    /*
     * Online Pharmacy Criteria clause 7(d): "Prescription for Controlled Drugs
     * (CDs) should not be supplied." `permitted: false` refuses before the
     * licence, the pharmacist or the destination is looked at.
     *
     * ⚠️ CITED TO THE CRITERIA AND NOT TO THE 2018 ACT, WHICH SAYS NOTHING ABOUT
     *   REMOTE SUPPLY — Ireland's discipline in reverse, where the mail-order
     *   ban lived in the medicines Regulations and not the misuse-of-drugs ones.
     */
    for (const key of ['CD_KA', 'CD_KHA', 'CD_GA']) {
      const decision = await evaluate(key, {
        transaction: 'ONLINE_DISPENSE',
        prescription: DOCTOR_RX,
      });

      expect(decision.outcome).toBe('REFUSED');
    }
  });

  it('does not restrict where a permitted remote supply may be sent', async () => {
    /*
     * ⚠️ ASSERTED SO THAT AN INVENTED DESTINATION LIST FAILS. Clause 4(a)
     *   requires the website to be hosted on a Bangladesh domain and clause 5(j)
     *   forbids selling or transferring the DATA abroad; neither says where a
     *   parcel may go. `destinationCountryCodes: ['BD']` would be this pack
     *   legislating — and `evaluateOnlineDispensing` answers `UNDETERMINED` when
     *   a destination list exists and none was supplied, so it would also start
     *   refusing orders that name no country.
     */
    const decision = await evaluate('OTC', {
      transaction: 'ONLINE_DISPENSE',
      destinationCountryCode: 'IN',
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});

/* ------------------------------------------------------------------ *
 * What this pack deliberately does not say
 * ------------------------------------------------------------------ */

describe('the absences, each of which somebody will want to close', () => {
  it('refuses a medicine with no regulatory profile at all', async () => {
    const decision = await evaluate('UNCLASSIFIED', { prescription: DOCTOR_RX });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('refuses a medicine filed under a classification this pack does not define', async () => {
    /*
     * ⚠️ THE FAIL-OPEN PI-18 FOUND IN FOUR PACKS, ASSERTED CLOSED IN THIS ONE.
     *   `coversProduct` matches a rule with NO classification against ANY
     *   product, and `needsClassificationButHasNone` does not fire for a product
     *   that HAS a classification the pack simply does not define. So in a pack
     *   carrying one unclassified obligation, a product filed under an
     *   unrecognised string matches only that obligation — and an obligation
     *   never refuses.
     *
     *   `SCHEDULE_H` is India's word, and a Bangladeshi clinic migrating its
     *   catalogue is exactly who would type it. Every rule in this pack names a
     *   classification, so nothing matches and the decision is `UNDETERMINED`.
     */
    const decision = await evaluate('SCHEDULE_H', { prescription: DOCTOR_RX });

    expect(decision.outcome).toBe('UNDETERMINED');
  });

  it('raises no traceability obligation, because no Bangladeshi source imposes one', async () => {
    /*
     * ⚠️ AND THERE IS A SECOND REASON TO BE GLAD. `evaluateTraceability` REFUSES
     *   on a missing identifier, and `createDispenseWithin` passes lot, expiry
     *   and serial but no GTIN. A rule written from the shape of other packs as
     *   `requiredIdentifiers: ['GTIN', ...]` would have refused every
     *   Bangladeshi dispense on the platform, for a field the caller never
     *   sends.
     */
    const decision = await evaluate('SCH_C', { prescription: DOCTOR_RX });

    expect(codes(decision).some((code) => code.startsWith('BD-TRACE'))).toBe(false);
  });

  it('raises no reporting or disposal obligation on a narcotic', async () => {
    /*
     * Sections 27 and 28 of the 2018 Act govern the destruction of SEIZED
     * narcotics by the Directorate and a court, which is not a pharmacy
     * destroying expired stock, and the rules made under section 68 could not be
     * retrieved. A `DISPOSAL_REQUIREMENT` written from the seizure sections
     * would put a witness requirement on a pharmacy on the strength of a
     * provision about evidence.
     */
    const decision = await evaluate('CD_KA', { transaction: 'DISPOSE' });

    expect(conditionKinds(decision)).not.toContain('WITNESS_REQUIRED');
    expect(conditionKinds(decision)).not.toContain('REPORT_TO_AUTHORITY');
  });

  it('imposes no quantity limit and no age restriction anywhere', async () => {
    /*
     * Neither Act sets a quantity ceiling on a dispense, and neither sets a
     * minimum age for buying a medicine. Singapore's 240 ml codeine limit and
     * Ireland's over-18 distance check exist because those provisions were read;
     * Bangladesh has no equivalent this pack found.
     */
    const decision = await evaluate('SCH_G', {
      prescription: DOCTOR_RX,
      quantityBase: '5000',
      patient: { subjectType: 'HUMAN', ageYears: 12 },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });
});
