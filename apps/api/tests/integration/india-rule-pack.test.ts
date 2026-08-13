/**
 * The India rule pack, tested by BEHAVIOUR.
 *
 * ⚠️ NOT ONE ASSERTION IN THIS FILE CHECKS A COUNTRY CODE, AND THAT IS THE RULE
 *   THE WHOLE PROGRAMME IS BUILT ON. `expect(country).toBe('IN')` would pass
 *   against a pack whose every rule was inert, which is the failure mode this
 *   domain keeps producing: configured, visible in the console, and matching
 *   nothing. What is pinned here is what the engine DECIDES — the outcome, the
 *   conditions, and the rule codes in the reasons.
 *
 * ⚠️ THESE RUN AGAINST THE SEEDED PACK, NOT AGAINST FIXTURES. `regulatory.test.ts`
 *   builds a fictional `ZQ` jurisdiction so that nothing in it can be read as a
 *   legal position; this file is the opposite and deliberately so — it is the
 *   only place that proves the ROWS THE SEED ACTUALLY WRITES behave as the rules
 *   they were read from. A pack that is right in a fixture and wrong in the seed
 *   is a pack that is wrong.
 *
 *   So it depends on `pnpm db:seed` having run. Every rule code it names comes
 *   from `packages/db/prisma/seed/data/regulatory-in.ts`.
 *
 * ⚠️ NOTHING HERE CLAIMS THE READING OF INDIAN LAW IS CORRECT. It claims the
 *   engine acts on the pack as configured. Whether the pack says the right thing
 *   is `RulePackMaturity` and a named human — and passing this file does NOT by
 *   itself move the pack up the ladder, because `RULES_IMPLEMENTED` is about the
 *   call sites consulting it and not about the tests existing.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { evaluateFor } from '../../src/services/regulatory/evaluation.service.js';

const SUFFIX = `i${Date.now().toString(36)}`;
const SLUG = `inp-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: { organizationId: string; branchIds: string[]; userId: string };

/** Product ids by the classification their profile asserts. */
const products: Record<string, string> = {};

/** Two places to put stock: an ordinary shelf and a controlled cabinet. */
const locations: Record<string, string> = {};

/** A registered pharmacist at the counter. The licence, never the role code. */
const PHARMACIST = {
  roleCodes: ['pharmacy.dispense.create'],
  licenceTypes: ['REGISTERED_PHARMACIST'],
};

const VALID_PRESCRIPTION = {
  presented: true,
  signedByQualifiedPrescriber: true,
  issuedOn: new Date().toISOString(),
  refillsUsed: 0,
};

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

/** A product of `type`, with a profile asserting `classification` where given. */
async function makeProduct(
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
    [org.organizationId, type, `INP-${key}`, `India pack ${key}`, unitId]
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

  const pack = await owner.query<{ id: string; maturity: string; jurisdiction_id: string }>(
    `SELECT p.id, p.maturity, p.jurisdiction_id
       FROM regulatory_rule_packs p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
      WHERE j.country_code = 'IN' AND j.region_code IS NULL AND p.version = '1.0.0'`
  );
  const jurisdictionId = pack.rows[0]?.jurisdiction_id;
  if (!jurisdictionId) {
    throw new Error('the India rule pack is not seeded — run `pnpm db:seed` before this suite');
  }

  org = await registerOrganization(payload(SLUG, 'India Pack Co'));
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

  await makeProduct('H', 'MEDICINE', 'SCHEDULE_H', unitId, jurisdictionId);
  await makeProduct('H1', 'MEDICINE', 'SCHEDULE_H1', unitId, jurisdictionId);
  await makeProduct('X', 'MEDICINE', 'SCHEDULE_X', unitId, jurisdictionId);
  await makeProduct('UNCLASSIFIED', 'MEDICINE', null, unitId, jurisdictionId);
  await makeProduct('VET', 'VETERINARY_MEDICINE', 'SCHEDULE_H', unitId, jurisdictionId);
  await makeProduct('CONSUMABLE', 'CONSUMABLE', null, unitId, jurisdictionId);

  /*
   * The cabinet is marked controlled ON THE LOCATION and carries no storage
   * profile, which is the shape a clinic actually creates one in — and the shape
   * that read as an open shelf until `evaluateFor` was fixed to consult both
   * flags rather than only the profile's.
   */
  for (const [key, kind, controlled] of [
    ['SHELF', 'MAIN_PHARMACY', false],
    ['CABINET', 'CONTROLLED_CABINET', true],
  ] as const) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inventory_locations
         (id, organization_id, branch_id, kind, code, name, requires_controlled_access, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::"LocationKind", $4, $5, $6, now())
       RETURNING id`,
      [org.organizationId, org.branchId, kind, `INP-${key}`, `India pack ${key}`, controlled]
    );
    locations[key] = row.rows[0]?.id ?? '';
  }
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

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

const evaluateProduct = async (key: string, over: Record<string, unknown> = {}) =>
  evaluateFor(
    ctx,
    {
      productId: products[key],
      transaction: 'DISPENSE',
      quantityBase: '1',
      ...over,
    } as never,
    PHARMACIST
  );

const codes = (decision: { reasons: { ruleCode: string | null }[] }): string[] =>
  decision.reasons.map((r) => r.ruleCode ?? '').filter(Boolean);

/* ------------------------------------------------------------------ *
 * A prescription is required, and its absence refuses
 * ------------------------------------------------------------------ */

describe('a scheduled medicine is not supplied without a prescription', () => {
  it.each([
    ['H', 'IN-RX-SCH-H'],
    ['H1', 'IN-RX-SCH-H1'],
    ['X', 'IN-RX-SCH-X'],
  ])('refuses a %s product and cites %s', async (key, code) => {
    const decision = await evaluateProduct(key);

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain(code);
  });

  it('permits a Schedule H supply once a signed prescription is presented', async () => {
    const decision = await evaluateProduct('H', { prescription: VALID_PRESCRIPTION });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  it('refuses a prescription that nobody qualified signed', async () => {
    const decision = await evaluateProduct('H', {
      prescription: { ...VALID_PRESCRIPTION, signedByQualifiedPrescriber: false },
    });

    expect(decision.outcome).toBe('REFUSED');
  });

  it('applies to a remote supply exactly as it does over a counter', async () => {
    const decision = await evaluateProduct('H', { transaction: 'ONLINE_DISPENSE' });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IN-RX-SCH-H');
  });

  it('does not expire a prescription, because no rule sets a validity period', async () => {
    const decision = await evaluateProduct('H', {
      prescription: {
        ...VALID_PRESCRIPTION,
        issuedOn: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      },
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });
});

/* ------------------------------------------------------------------ *
 * The registers, and what they oblige
 * ------------------------------------------------------------------ */

describe('supplying a Schedule H1 drug obliges a register entry', () => {
  it('raises the register condition and names the schedule', async () => {
    const decision = await evaluateProduct('H1', { prescription: VALID_PRESCRIPTION });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
    const register = decision.conditions.find((c) => c.kind === 'RECORD_IN_CONTROLLED_REGISTER');
    expect(register?.ruleCode).toBe('IN-CD-SCH-H1-REGISTER');
    expect(register?.parameters?.['schedule']).toBe('Schedule H1');
  });

  it('carries the three-year retention, not the two-year default', async () => {
    const decision = await evaluateProduct('H1', { prescription: VALID_PRESCRIPTION });

    const retention = decision.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(retention.map((c) => c.ruleCode)).toContain('IN-RETAIN-SCH-H1-REGISTER');
    expect(
      retention.find((c) => c.ruleCode === 'IN-RETAIN-SCH-H1-REGISTER')?.parameters?.['years']
    ).toBe(3);
  });

  it('leaves the general two-year retention to products with no longer period', async () => {
    const decision = await evaluateProduct('H', { prescription: VALID_PRESCRIPTION });

    const retention = decision.conditions.filter((c) => c.kind === 'RETAIN_RECORD');
    expect(retention.map((c) => c.ruleCode)).toContain('IN-RETAIN-RECORDS');
  });
});

/* ------------------------------------------------------------------ *
 * Substitution and repeats
 * ------------------------------------------------------------------ */

describe('a scheduled prescription is dispensed as written', () => {
  it('refuses any substitution, with or without consent', async () => {
    const decision = await evaluateProduct('H', {
      prescription: VALID_PRESCRIPTION,
      substitution: { isSubstitution: true, prescriberConsented: true, patientConsented: true },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IN-SUBST-SCH-H');
  });

  it('refuses a repeat the prescriber has not endorsed', async () => {
    const decision = await evaluateProduct('H', {
      prescription: { ...VALID_PRESCRIPTION, refillsUsed: 1 },
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IN-REPEAT-SCH-H');
  });
});

/* ------------------------------------------------------------------ *
 * Who may dispense
 * ------------------------------------------------------------------ */

describe('only a registered pharmacist dispenses', () => {
  it('refuses somebody holding the rcln role but no registration', async () => {
    const decision = await evaluateFor(
      ctx,
      {
        productId: products['H'],
        transaction: 'DISPENSE',
        quantityBase: '1',
        prescription: VALID_PRESCRIPTION,
      } as never,
      { roleCodes: ['pharmacy.dispense.create', 'PHARMACIST'] }
    );

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IN-DISPENSER-REGISTERED-PHARMACIST');
  });
});

/* ------------------------------------------------------------------ *
 * Storage, at the point stock arrives
 * ------------------------------------------------------------------ */

describe('a Schedule X drug is kept under lock and key', () => {
  it('refuses a receipt onto an ordinary shelf', async () => {
    const decision = await evaluateProduct('X', {
      transaction: 'STOCK',
      locationId: locations['SHELF'],
    });

    expect(decision.outcome).toBe('REFUSED');
    expect(codes(decision)).toContain('IN-CD-SCH-X-STORAGE');
  });

  it('permits a receipt into a controlled cabinet', async () => {
    const decision = await evaluateProduct('X', {
      transaction: 'STOCK',
      locationId: locations['CABINET'],
    });

    expect(decision.outcome).toBe('PERMITTED_WITH_CONDITIONS');
  });

  /*
   * ⚠️ UNDETERMINED, NOT PERMITTED, AND THIS IS THE CASE WORTH HAVING. A receipt
   *   that names no location has not satisfied the storage rule — it has failed
   *   to say anything about it — and the engine refuses rather than waving it
   *   through. A caller that omits the location by accident finds out.
   */
  it('cannot decide when the receipt names no location at all', async () => {
    const decision = await evaluateProduct('X', { transaction: 'STOCK' });

    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * The gap that is a gap, not a permission
 * ------------------------------------------------------------------ */

describe('a medicine nobody has classified', () => {
  it('is UNDETERMINED rather than permitted, even though other rules apply', async () => {
    const decision = await evaluateProduct('UNCLASSIFIED', {
      prescription: VALID_PRESCRIPTION,
    });

    expect(decision.outcome).toBe('UNDETERMINED');
    expect(decision.reasons[0]?.message).toContain('Record its regulatory profile');
  });

  it('does not make an unclassified consumable undecidable', async () => {
    const decision = await evaluateProduct('CONSUMABLE', {
      prescription: VALID_PRESCRIPTION,
    });

    expect(decision.outcome).not.toBe('UNDETERMINED');
  });
});

/* ------------------------------------------------------------------ *
 * Veterinary
 * ------------------------------------------------------------------ */

describe('a veterinary medicine is labelled for animals', () => {
  it('raises the label obligation from the product type alone', async () => {
    const decision = await evaluateProduct('VET', { prescription: VALID_PRESCRIPTION });

    const label = decision.conditions.filter((c) => c.ruleCode === 'IN-LABEL-VETERINARY');
    expect(label.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The pack says what it is
 * ------------------------------------------------------------------ */

describe('the pack does not overstate itself', () => {
  it('reports a maturity below PRODUCTION_ENABLED on every decision it makes', async () => {
    const decision = await evaluateProduct('H', { prescription: VALID_PRESCRIPTION });

    expect(decision.lowestPackMaturity).not.toBe('PRODUCTION_ENABLED');
    expect(decision.lowestPackMaturity).not.toBe('REGULATORY_REVIEWED');
  });
});
