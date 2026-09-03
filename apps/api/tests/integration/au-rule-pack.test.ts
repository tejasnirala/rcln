/**
 * The Australian rule packs — national and Victoria — tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE. `expect(country)
 *   .toBe('AU')` would pass against a pack whose every rule was inert, which is
 *   the failure this domain keeps producing: configured, visible in the console,
 *   matching nothing. What is pinned here is what the engine DECIDES.
 *
 * ⚠️ AND AUSTRALIA IS THE PACK WHERE "CONFIGURED AND INERT" WAS NOT
 *   HYPOTHETICAL. `locale.ts` gave Australia an empty `regions` list, scoped to
 *   the question "does GST register per state" — so `isValidRegion` refused
 *   `VIC` on a branch, `branches.region_code` could never hold it, and the
 *   Victorian pack would have seeded and matched nothing forever. The Victorian
 *   cases below are the only thing that would have caught that, and they are the
 *   reason `AUSTRALIA_REGIONS` now exists.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACKS, NOT AGAINST FIXTURES, and so depend on
 *   `pnpm db:seed` having run. `packages/regulatory/tests/engine.test.ts` proves
 *   the engine handles each SHAPE against a fictional jurisdiction; this file is
 *   the only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the
 *   instruments they were read from.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF AUSTRALIAN LAW IS CORRECT. It claims the
 *   engine acts on the packs as configured. Whether they say the right thing is
 *   `RulePackMaturity` and a named human.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `a${Date.now().toString(36)}`;
const NATIONAL_SLUG = `aup-${SUFFIX}`;
const VICTORIA_SLUG = `aupvic-${SUFFIX}`;
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
 * comes from the BRANCH, not from a parameter. The national organization stands
 * for a branch in a state that has no pack yet — Sydney, Brisbane, Perth — which
 * is seven of the eight jurisdictions and therefore the common case rather than
 * the edge one.
 */
let nationalOrg: Org;
let victoriaOrg: Org;
let nationalCtx: Ctx;
let victoriaCtx: Ctx;

const nationalProducts: Record<string, string> = {};
const victoriaProducts: Record<string, string> = {};
const victoriaLocations: Record<string, string> = {};

/** A registered pharmacist at the counter. The licence, never the role code. */
const PHARMACIST = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['REGISTERED_PHARMACIST'],
};

/** The same person without the registration — a dispensary assistant. */
const UNLICENSED = { roleCodes: ['pharmacy.dispense.create'] };

/**
 * A prescription from a registered medical practitioner.
 *
 * ⚠️ `prescriberClasses` IS LOAD-BEARING FOR THE VICTORIAN CASES AND INERT FOR
 *   THE NATIONAL ONES, WHICH IS ITSELF THE POINT. The Poisons Standard names no
 *   prescriber classes — it says "persons permitted by State or Territory
 *   legislation to prescribe", which is a pointer to eight lists rather than a
 *   list — so the national pack carries no `PRESCRIBER_AUTHORITY` rule at all.
 *   Victoria's regulations 47 and 48 name theirs, and differ by two.
 */
const VALID_PRESCRIPTION = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
  prescriberClasses: ['MEDICAL_PRACTITIONER'],
};

function monthsAgo(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pty Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'AU',
      timezone: 'Australia/Melbourne',
      currency: 'AUD',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+6141${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
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
  classification: string | null,
  unitId: string,
  jurisdictionId: string
): Promise<void> {
  const product = await owner.query<{ id: string }>(
    `INSERT INTO products (id, organization_id, type, status, code, name, base_unit_id, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE'::"ProductType", 'ACTIVE', $2, $3, $4, now())
     RETURNING id`,
    [organizationId, `AUP-${SUFFIX}-${key}`, `AU pack ${key}`, unitId]
  );
  const id = product.rows[0]?.id ?? '';
  into[key] = id;

  if (classification !== null) {
    await owner.query(
      `INSERT INTO product_regulatory_profiles
         (id, organization_id, product_id, jurisdiction_id, classification,
          prescription_requirement, effective_from, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PRESCRIPTION_REQUIRED', DATE '2020-01-01', now())`,
      [organizationId, id, jurisdictionId, classification]
    );
  }
}

/**
 * The branch's own country and region, which is what the engine reads.
 *
 * ⚠️ SET HERE RATHER THAN THROUGH REGISTRATION, AND THE COUNTRY IS SET TOO.
 *   `branches.country_code` defaults to `IN` in the schema and registration does
 *   not derive it from the organization's, so an Australian organization can
 *   hold a branch the regulatory engine believes is in India.
 */
async function setBranchJurisdiction(branchId: string, regionCode: string | null): Promise<void> {
  await owner.query(`UPDATE branches SET country_code = 'AU', region_code = $2 WHERE id = $1`, [
    branchId,
    regionCode,
  ]);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  const nationalPack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'AU' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const nationalJurisdictionId = nationalPack.rows[0]?.jurisdiction_id;
  if (!nationalJurisdictionId) {
    throw new Error('the Australian national rule pack is not seeded — run `pnpm db:seed` first');
  }

  const vicPack = await owner.query<{ jurisdiction_id: string }>(
    `SELECT p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'AU' AND j.region_code = 'VIC' AND p.version = '1.0.0'`
  );
  if (!vicPack.rows[0]?.jurisdiction_id) {
    throw new Error('the Victorian rule pack is not seeded — run `pnpm db:seed` first');
  }

  nationalOrg = await registerOrganization(payload(NATIONAL_SLUG, 'AU Pack Co'));
  victoriaOrg = await registerOrganization(payload(VICTORIA_SLUG, 'VIC Pack Co'));
  await setBranchJurisdiction(nationalOrg.branchId, null);
  await setBranchJurisdiction(victoriaOrg.branchId, 'VIC');

  nationalCtx = {
    organizationId: nationalOrg.organizationId,
    branchIds: [nationalOrg.branchId],
    userId: nationalOrg.ownerUserId,
  };
  victoriaCtx = {
    organizationId: victoriaOrg.organizationId,
    branchIds: [victoriaOrg.branchId],
    userId: victoriaOrg.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  const unitId = unit.rows[0]?.id;
  if (!unitId) throw new Error('the seed is missing the PIECE unit');

  for (const [key, classification] of [
    ['S3', 'SCHEDULE_3'],
    ['S4', 'SCHEDULE_4'],
    ['S8', 'SCHEDULE_8'],
    ['UNCLASSIFIED', null],
  ] as const) {
    await makeProduct(
      nationalProducts,
      nationalOrg.organizationId,
      key,
      classification,
      unitId,
      nationalJurisdictionId
    );
    await makeProduct(
      victoriaProducts,
      victoriaOrg.organizationId,
      key,
      classification,
      unitId,
      nationalJurisdictionId
    );
  }

  /*
   * The safe is marked controlled ON THE LOCATION and carries no storage
   * profile, which is the shape a clinic actually creates one in.
   */
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
        victoriaOrg.organizationId,
        victoriaOrg.branchId,
        kind,
        `AUP-${key}`,
        `AU pack ${key}`,
        controlled,
      ]
    );
    victoriaLocations[key] = row.rows[0]?.id ?? '';
  }
}, 45_000);

afterAll(async () => {
  for (const org of [nationalOrg, victoriaOrg]) {
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

const evaluateNational = async (
  key: string,
  over: Record<string, unknown> = {},
  actor: Record<string, unknown> = PHARMACIST
) =>
  evaluateFor(
    nationalCtx,
    {
      productId: nationalProducts[key],
      transaction: 'DISPENSE',
      quantityBase: '1',
      ...over,
    } as never,
    actor as never
  );

const evaluateVictoria = async (
  key: string,
  over: Record<string, unknown> = {},
  actor: Record<string, unknown> = PHARMACIST
) =>
  evaluateFor(
    victoriaCtx,
    {
      productId: victoriaProducts[key],
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
 * The national floor — four rules, and the absences that matter
 * ------------------------------------------------------------------ */

describe('the Poisons Standard floor applies where no state pack does', () => {
  it.each([
    ['S4', 'AU-RX-S4'],
    ['S8', 'AU-RX-S8'],
  ])('refuses a %s supply with no prescription and cites %s', async (key, code) => {
    const decision = await evaluateNational(key);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain(code);
  });

  it('permits a Schedule 4 supply once a prescription is presented', async () => {
    const decision = await evaluateNational('S4', { prescription: VALID_PRESCRIPTION });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');
  });

  it('names the schedule on a Schedule 8 supply, and imposes nothing else', async () => {
    /*
     * ⚠️ THE HONEST THINNESS OF THE NATIONAL PACK, PINNED SO NOBODY "FIXES" IT
     *   BY INVENTING A COMMONWEALTH OBLIGATION. There is no national register,
     *   no national safe and no national retention period, because Australia has
     *   none — every one of those is state law. A regression that added a
     *   `registerRequired` to `AU-SCHEDULE-S8` would raise a register obligation
     *   in all eight jurisdictions on the authority of an instrument that
     *   imposes none.
     */
    const decision = await evaluateNational('S8', { prescription: VALID_PRESCRIPTION });

    /*
     * ⚠️ THE OUTCOME IS ASSERTED FIRST, AND IT WAS NOT BEFORE — WHICH IS WHY
     *   THIS CASE PASSED FOR TWO PHASES WHILE THE RULE REFUSED EVERY SCHEDULE 8
     *   TRANSACTION IN SEVEN JURISDICTIONS. `AU-SCHEDULE-S8` carried only a
     *   `scheduleName`, the parser refused it as imposing no obligation, and an
     *   unreadable rule resolves UNDETERMINED — which refuses. The three
     *   assertions below cannot tell that apart from a permissive rule: an
     *   unreadable rule ALSO puts its code in the reasons and ALSO raises none
     *   of these conditions. Asserting the absence of obligations without
     *   asserting the presence of a permission describes both equally well.
     *   Fixed in PI-24; `rule-pack-readable.test.ts` now guards the class.
     */
    expect(decision.outcome).not.toBe('REFUSED');
    expect(decision.outcome).not.toBe('UNDETERMINED');

    expect(codes(decision)).toContain('AU-SCHEDULE-S8');
    expect(conditionKinds(decision)).not.toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(conditionKinds(decision)).not.toContain('VERIFY_PRIOR_AUTHORISATION');
    expect(conditionKinds(decision)).not.toContain('RETAIN_RECORD');
  });

  it('applies no prescription validity, because the Poisons Standard sets none', async () => {
    const decision = await evaluateNational('S8', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: monthsAgo(7) },
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('lets a pharmacist supply a Schedule 3 medicine without a prescription', async () => {
    const decision = await evaluateNational('S3');

    expect(decision.outcome).not.toBe('REFUSED');
    expect(codes(decision)).toContain('AU-SUPPLY-S3');
  });

  it('refuses a Schedule 3 supply by someone holding no pharmacist registration', async () => {
    const decision = await evaluateNational('S3', {}, UNLICENSED);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('AU-SUPPLY-S3');
  });

  it('refuses an unclassified medicine rather than permitting it', async () => {
    const decision = await evaluateNational('UNCLASSIFIED');

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Victoria — the state pack PI-15 exists to ship
 * ------------------------------------------------------------------ */

describe('a Victorian branch is governed by the state pack where it speaks', () => {
  it('expires a Schedule 4 prescription at twelve months, which national law does not', async () => {
    /*
     * ⚠️ THE SUPERSESSION THIS WHOLE PHASE EXISTS TO PROVE, AND THE HALF THAT
     *   FAILS SILENTLY IS THE SECOND ASSERTION. If `VIC-RX-S4` did not displace
     *   `AU-RX-S4`, both would apply, both would permit a prescribed supply, and
     *   only a script older than twelve months would ever show the difference.
     */
    const stale = await evaluateVictoria('S4', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: monthsAgo(13) },
    });

    expect(stale.outcome).toBe('REFUSED');
    expect(codes(stale)).toContain('VIC-RX-S4');
    expect(codes(stale)).not.toContain('AU-RX-S4');

    const current = await evaluateVictoria('S4', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: monthsAgo(11) },
    });

    expect(current.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('expires a Schedule 8 prescription at six months, where the same script stands nationally', async () => {
    const inVictoria = await evaluateVictoria('S8', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: monthsAgo(7) },
    });
    expect(inVictoria.outcome).toBe('REFUSED');
    expect(codes(inVictoria)).toContain('VIC-RX-S8');

    const elsewhere = await evaluateNational('S8', {
      prescription: { ...VALID_PRESCRIPTION, issuedOn: monthsAgo(7) },
    });
    expect(elsewhere.outcome).not.toBe('REFUSED');
  });

  it('raises the drugs register and the Schedule 8 permit', async () => {
    /*
     * ⚠️ THE FIRST `VERIFY_PRIOR_AUTHORISATION` RAISED BY A REAL PACK. PI-13a
     *   built the condition kind with Australia's Schedule 8 permits named in
     *   the comment and nothing has ever exercised it; until this assertion
     *   existed, a regression that dropped `priorAuthorisationRequired` from
     *   `parseControlledSchedule` would have broken no test.
     */
    const decision = await evaluateVictoria('S8', { prescription: VALID_PRESCRIPTION });

    expect(conditionKinds(decision)).toContain('RECORD_IN_CONTROLLED_REGISTER');
    expect(conditionKinds(decision)).toContain('VERIFY_PRIOR_AUTHORISATION');
    expect(codes(decision)).toContain('VIC-SCHEDULE-S8');
    expect(codes(decision)).toContain('VIC-PERMIT-S8');
    expect(codes(decision)).not.toContain('AU-SCHEDULE-S8');
  });

  it('lets an optometrist prescribe Schedule 4 and not Schedule 8', async () => {
    /*
     * ⚠️ THE TWO-NAME DIFFERENCE BETWEEN REGULATIONS 47(1)(a)(i) AND
     *   48(1)(a)(i), PINNED. Sharing one prescriber list between the two rules
     *   would permit an optometrist's Schedule 8 prescription and would break no
     *   other assertion in this file.
     */
    const optometrist = { ...VALID_PRESCRIPTION, prescriberClasses: ['AUTHORISED_OPTOMETRIST'] };

    const onS4 = await evaluateVictoria('S4', { prescription: optometrist });
    expect(onS4.outcome).not.toBe('REFUSED');

    const onS8 = await evaluateVictoria('S8', { prescription: optometrist });
    expect(onS8.outcome).toBe('REFUSED');
    expect(codes(onS8)).toContain('VIC-PRESCRIBER-S8');
  });

  it('keeps records for three years, where national law says nothing at all', async () => {
    const decision = await evaluateVictoria('S4', { prescription: VALID_PRESCRIPTION });

    expect(codes(decision)).toContain('VIC-RETAIN-S4');

    const retention = decision.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(retention).toHaveLength(1);
    expect(retention[0]?.parameters?.['years']).toBe(3);
  });

  it('reports a Schedule 8 supply to the monitored poisons database, and a Schedule 4 one not', async () => {
    const onS8 = await evaluateVictoria('S8', { prescription: VALID_PRESCRIPTION });
    expect(conditionKinds(onS8)).toContain('REPORT_TO_AUTHORITY');
    expect(codes(onS8)).toContain('VIC-REPORT-S8');

    const onS4 = await evaluateVictoria('S4', { prescription: VALID_PRESCRIPTION });
    expect(conditionKinds(onS4)).not.toContain('REPORT_TO_AUTHORITY');
  });
});

/* ------------------------------------------------------------------ *
 * Storage — the asymmetry between a lockable cupboard and a safe
 * ------------------------------------------------------------------ */

describe('Victoria demands a safe for Schedule 8 and a lockable cupboard for Schedule 4', () => {
  it('refuses a Schedule 8 receipt into ordinary stock', async () => {
    const decision = await evaluateVictoria('S8', {
      transaction: 'STOCK',
      locationId: victoriaLocations['SHELF'],
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('VIC-STORE-S8');
  });

  it('permits the same receipt into a controlled location', async () => {
    const decision = await evaluateVictoria('S8', {
      transaction: 'STOCK',
      locationId: victoriaLocations['SAFE'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
  });

  it('permits a Schedule 4 receipt into ordinary stock, which is the whole asymmetry', async () => {
    /*
     * ⚠️ THE ASSERTION THAT STOPS `controlledAccessRequired` BEING COPIED ONTO
     *   THE SCHEDULE 4 RULE "FOR CONSISTENCY". Regulation 73(2) asks for a
     *   lockable storage facility, which every dispensary is; setting the key
     *   there would refuse routine, lawful goods receipt of ordinary
     *   prescription medicines and would look like the engine being broken.
     */
    const decision = await evaluateVictoria('S4', {
      transaction: 'STOCK',
      locationId: victoriaLocations['SHELF'],
    });

    expect(decision.outcome).not.toBe('REFUSED');
    expect(conditionKinds(decision)).toContain('STORE_UNDER_CONDITIONS');
  });
});

/* ------------------------------------------------------------------ *
 * Destruction, dispensing authority, and what the state pack left alone
 * ------------------------------------------------------------------ */

describe('the remaining Victorian obligations', () => {
  it('requires a witness to destroy a Schedule 8 poison, and asks for no permit', async () => {
    /*
     * ⚠️ THE SECOND ASSERTION IS WHY `VIC-PERMIT-S8` IS A SEPARATE RULE FROM
     *   `VIC-SCHEDULE-S8`. Folded into one, the register obligation — which does
     *   reach a destruction — would have dragged "check the Schedule 8 permit"
     *   onto a transaction no permit has anything to say about.
     */
    const decision = await evaluateVictoria('S8', { transaction: 'DISPOSE' });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    expect(codes(decision)).toContain('VIC-DISPOSE-S8');
    expect(conditionKinds(decision)).toContain('WITNESS_REQUIRED');
    expect(conditionKinds(decision)).not.toContain('VERIFY_PRIOR_AUTHORISATION');
  });

  it('refuses an unregistered dispenser, and exempts the prescriber dispensing to their own patient', async () => {
    const assistant = await evaluateVictoria(
      'S4',
      { prescription: VALID_PRESCRIPTION },
      UNLICENSED
    );
    expect(assistant.outcome).toBe('REFUSED');
    expect(codes(assistant)).toContain('VIC-DISPENSER-S4');

    /*
     * ⚠️ REGULATION 36(a), AND THE DELIBERATE CONTRAST WITH THE UNITED STATES.
     *   21 CFR 1306.06 makes filling a prescription a pharmacist's act whoever
     *   wrote it, so the US pack sets no exemption. Victoria writes the
     *   doctor-dispensing case into regulation 36 as its own authority, and a
     *   doctor-run Victorian clinic is a common shape.
     */
    const prescriber = await evaluateVictoria(
      'S4',
      { prescription: VALID_PRESCRIPTION },
      { ...UNLICENSED, isPrescriber: true }
    );
    expect(prescriber.outcome).not.toBe('REFUSED');
  });

  it('leaves the national Schedule 3 rule standing in Victoria', async () => {
    /*
     * ⚠️ THE HALF A BROKEN IMPLEMENTATION PASSES WITHOUT. Every Victorian rule
     *   names `SCHEDULE_4` or `SCHEDULE_8`. A `PHARMACIST_AUTHORITY` rule here
     *   with no classification would cover a Schedule 3 product too and, being
     *   regional, would displace `AU-SUPPLY-S3` — silently repealing the
     *   pharmacist-only control on pharmacist only medicines in the one state
     *   that has a pack.
     */
    const permitted = await evaluateVictoria('S3');
    expect(permitted.outcome).not.toBe('REFUSED');
    expect(codes(permitted)).toContain('AU-SUPPLY-S3');

    const refused = await evaluateVictoria('S3', {}, UNLICENSED);
    expect(refused.outcome).toBe('REFUSED');
    expect(codes(refused)).toContain('AU-SUPPLY-S3');
  });
});
