/**
 * `QUANTITY_LIMIT` over a period — the rule that could not be answered until
 * PI-8 (KNOWN_ISSUES #10).
 *
 * ── WHY THIS WAS UNANSWERABLE ───────────────────────────────────────────────
 * The engine needs "how much has this person already had", and the WINDOW it is
 * measured over is `periodDays` on the RULE. So a caller could not compute it
 * before evaluating, and `@rcln/regulatory` is pure by design (PI-ADR-007) and
 * cannot look it up itself. Every period limit therefore resolved
 * `UNDETERMINED`, which refuses — correct, and an unimplemented feature.
 *
 * PI-8 turned the value into a LOOKUP: `evaluateWithin` selects the applicable
 * rules, reads the window off them, and calls back into the pharmacy service,
 * which is the only party that knows who the supply is for.
 *
 * ── WHAT THIS SUITE PINS ────────────────────────────────────────────────────
 *   WITHIN THE LIMIT IS PERMITTED       and the prior quantity was actually
 *                                       counted rather than assumed zero.
 *   OVER THE LIMIT IS REFUSED           across SEPARATE dispenses, which is the
 *                                       whole point of a period limit — a
 *                                       per-transaction check cannot see it.
 *   OUTSIDE THE WINDOW DOES NOT COUNT   an older supply falls out of the period.
 *   NO PATIENT MEANS UNDETERMINED       a counter sale has no history to sum,
 *                                       and zero would let anyone buy the shelf
 *                                       one transaction at a time.
 *   TWO WINDOWS MEAN UNDETERMINED       one scalar cannot serve two periods, and
 *                                       guessing either way is wrong. Refusing
 *                                       is the only safe answer.
 *
 * ⚠️ NOTHING HERE ASSERTS A THROWN ERROR, AND THAT IS NOT AN OVERSIGHT. The pack
 *   is `RULES_IMPLEMENTED`, and `enforcement.ts` lets a decision STOP a document
 *   only from `PRODUCTION_ENABLED`. So the supply proceeds and the decision is
 *   SNAPSHOTTED — which is exactly the state the platform is in today, and the
 *   snapshot is what these cases read.
 *
 * The fictional country `ZQ` keeps this pack away from India's and from
 * `regulatory-enforcement.test.ts`'s `ZY`.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { createDispense } from '../../src/services/pharmacy/dispense.service.js';

const SUFFIX = `q${Date.now().toString(36)}`;
const SLUG = `qty-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let jurisdictionId: string;
let packId: string;
let sourceId: string;
let baseUnit: string;
let productId: string;
let counterId: string;
let patientId: string;
/** A second person, so one patient's history cannot leak into another's sum. */
let otherPatientId: string;

const CLASSIFICATION = 'QTY_CONTROLLED';

async function clearFixtures(): Promise<void> {
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

/** Add a `QUANTITY_LIMIT` rule to the pack. Removed between cases that need to. */
async function addPeriodLimit(code: string, maxPerPeriodBase: string, periodDays: number) {
  await owner.query(
    `INSERT INTO regulatory_rules
       (id, pack_id, rule_type, code, statement, status, applies_to_classification,
        applies_to_transactions, parameters, source_id, version, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, 'QUANTITY_LIMIT', $2,
             'No more than the stated quantity may be supplied in the stated period.',
             'ACTIVE', $3,
             ARRAY['DISPENSE','COUNTER_SALE']::"RegulatoryTransactionType"[],
             $4::jsonb, $5, 1, DATE '2020-01-01', now())`,
    [packId, code, CLASSIFICATION, JSON.stringify({ maxPerPeriodBase, periodDays }), sourceId]
  );
}

async function dropRule(code: string): Promise<void> {
  await owner.query('DELETE FROM regulatory_rules WHERE pack_id = $1 AND code = $2', [
    packId,
    code,
  ]);
}

/** Supply some, and hand back the decision that was snapshotted for the line. */
async function supply(
  quantity: string,
  subject: string | null
): Promise<{ outcome: string; reasons: unknown }> {
  const dispense = await createDispense(ctx, {
    kind: 'COUNTER_SALE',
    branchId: org.branchId,
    locationId: counterId,
    ...(subject ? { patientId: subject } : {}),
    lines: [{ productId, quantity, unitId: baseUnit }],
  } as never);

  const { rows } = await owner.query<{ outcome: string; reasons: unknown }>(
    `SELECT rd.outcome, rd.reasons
       FROM dispense_lines dl
       JOIN regulatory_decisions rd ON rd.id = dl.regulatory_decision_id
      WHERE dl.dispense_id = $1`,
    [dispense.id]
  );
  return rows[0] ?? { outcome: 'MISSING', reasons: null };
}

/** Backdate a supply, so the window can be tested from both sides. */
async function backdateEverything(days: number): Promise<void> {
  await owner.query(
    `UPDATE dispenses SET dispensed_at = dispensed_at - ($2 || ' days')::interval
      WHERE organization_id = $1`,
    [org.organizationId, String(days)]
  );
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization({
    organization: {
      legalName: 'Quantity Co Pvt Ltd',
      displayName: 'Quantity Co',
      slug: SLUG,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: 'Quantity Main', code: 'MAIN' },
    owner: {
      fullName: 'Quantity Owner',
      email: `${SLUG}@example.test`,
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  } as never);
  ctx = { organizationId: org.organizationId, branchIds: [org.branchId], userId: org.ownerUserId };

  /* The BRANCH decides the jurisdiction — a supply happens where the counter is. */
  await owner.query(`UPDATE branches SET country_code = 'ZQ' WHERE id = $1`, [org.branchId]);

  await clearFixtures();

  const place = await owner.query<{ id: string }>(
    `INSERT INTO jurisdictions (id, country_code, region_code, name, updated_at)
     VALUES (gen_random_uuid(), 'ZQ', NULL, 'Quantity Country', now()) RETURNING id`
  );
  jurisdictionId = place.rows[0]?.id ?? '';

  const authority = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_authorities (id, jurisdiction_id, code, name, updated_at)
     VALUES (gen_random_uuid(), $1, 'QTY-AUTH-${SUFFIX}', 'Quantity Authority', now())
     RETURNING id`,
    [jurisdictionId]
  );

  const source = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_sources (id, jurisdiction_id, authority_id, title, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Quantity Country Medicines Act', now()) RETURNING id`,
    [jurisdictionId, authority.rows[0]?.id]
  );
  sourceId = source.rows[0]?.id ?? '';

  const pack = await owner.query<{ id: string }>(
    `INSERT INTO regulatory_rule_packs
       (id, jurisdiction_id, authority_id, version, name, maturity, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '1.0.0', 'Quantity pack', 'RULES_IMPLEMENTED',
             DATE '2020-01-01', now())
     RETURNING id`,
    [jurisdictionId, authority.rows[0]?.id]
  );
  packId = pack.rows[0]?.id ?? '';

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const product = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'QTY-PROD', 'Quantity Product', $2,
             'NONE', true, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  productId = product.rows[0]?.id ?? '';

  await owner.query(
    `INSERT INTO product_regulatory_profiles
       (id, organization_id, product_id, jurisdiction_id, classification,
        prescription_requirement, effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NOT_REQUIRED', DATE '2020-01-01', now())`,
    [org.organizationId, productId, jurisdictionId, CLASSIFICATION]
  );

  counterId = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'QTY_COUNTER',
      name: 'Quantity Counter',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  await recordMovement(ctx, {
    branchId: org.branchId,
    productId,
    movementType: 'RETURN',
    quantity: '1000',
    locationId: counterId,
    referenceType: 'MANUAL',
  });

  const patients = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, updated_at)
     VALUES (gen_random_uuid(), $1, 'QTY00001', 'Quantity', now()),
            (gen_random_uuid(), $1, 'QTY00002', 'Other', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patients.rows[0]?.id ?? '';
  otherPatientId = patients.rows[1]?.id ?? '';
}, 60_000);

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
    await owner?.query('DELETE FROM users WHERE id = $1', [org.ownerUserId]);
  }
  await clearFixtures();

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

describe('a period limit, now that the window can be answered', () => {
  beforeEach(async () => {
    await addPeriodLimit('QTY_30D', '20', 30);
  });

  afterEach(async () => {
    await dropRule('QTY_30D');
    /* Each case starts from a clean history, or the sums accumulate across them. */
    await owner.query('DELETE FROM charge_requests WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner.query(
      `DELETE FROM stock_ledger WHERE organization_id = $1 AND reference_type = 'DISPENSE'`,
      [org.organizationId]
    );
    await owner.query('DELETE FROM dispense_allocations WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner.query('DELETE FROM dispense_lines WHERE organization_id = $1', [
      org.organizationId,
    ]);
    await owner.query('DELETE FROM dispenses WHERE organization_id = $1', [org.organizationId]);
  });

  /**
   * ⚠️ THE CASE THAT PROVES THE LOOKUP RAN AT ALL. Before PI-8 this came back
   *   `UNDETERMINED`, because the engine was told nothing about prior supply.
   *   `PERMITTED` here means the window was resolved, the sum was taken, and it
   *   came to zero — which is a different fact from "we did not check".
   */
  it('permits a first supply inside the limit', async () => {
    const decision = await supply('15', patientId);
    expect(decision.outcome).toBe('PERMITTED');
  });

  /**
   * ⚠️ THE POINT OF A PERIOD LIMIT: TWO SEPARATE DISPENSES. Neither exceeds the
   *   limit on its own, so a per-transaction check sees nothing wrong. Only the
   *   sum over the window does.
   */
  it('refuses a second supply that takes the period total over the limit', async () => {
    expect((await supply('15', patientId)).outcome).toBe('PERMITTED');

    const second = await supply('10', patientId);
    expect(second.outcome).toBe('REFUSED');
    expect(JSON.stringify(second.reasons)).toMatch(/25/);
  });

  /** Right up to the limit is not over it. */
  it('permits a second supply that lands exactly on the limit', async () => {
    await supply('15', patientId);
    expect((await supply('5', patientId)).outcome).toBe('PERMITTED');
  });

  /**
   * ⚠️ ONE PERSON'S HISTORY IS NOT ANOTHER'S. A sum keyed on the product alone
   *   would refuse the second patient because of the first — the kind of bug
   *   that looks like the rule working.
   */
  it('does not count another patient’s supplies', async () => {
    await supply('18', otherPatientId);
    expect((await supply('15', patientId)).outcome).toBe('PERMITTED');
  });

  /** A supply older than the window has fallen out of it. */
  it('does not count a supply from before the window', async () => {
    await supply('18', patientId);
    await backdateEverything(40);

    expect((await supply('15', patientId)).outcome).toBe('PERMITTED');
  });

  /** And one inside it still counts, which is the other half of the same fence. */
  it('counts a supply from inside the window', async () => {
    await supply('18', patientId);
    await backdateEverything(20);

    expect((await supply('15', patientId)).outcome).toBe('REFUSED');
  });

  /**
   * ⚠️ NO PATIENT MEANS NO HISTORY, AND NO HISTORY MEANS `UNDETERMINED`. A
   *   counter sale to somebody with no record cannot be summed, and reading that
   *   as zero would let anyone take the limit again on every visit — which is
   *   precisely the pattern a quantity limit exists to stop.
   */
  it('refuses to guess for a sale with no patient', async () => {
    const decision = await supply('5', null);
    expect(decision.outcome).toBe('UNDETERMINED');
  });
});

/**
 * ⚠️ ONE SCALAR CANNOT SERVE TWO WINDOWS, SO TWO WINDOWS REFUSE.
 *   `RegulatoryRequest` carries a single `priorQuantityInPeriodBase`. Taking the
 *   longer window over-counts for the shorter rule and refuses lawful supplies;
 *   taking the shorter one UNDER-counts for the longer rule and PERMITS what the
 *   law forbids — the direction this domain may never fail in. So the value is
 *   left absent and the engine says `UNDETERMINED`, which refuses.
 *
 *   If this test ever goes green as `PERMITTED`, somebody has picked a window.
 */
describe('two rules with different periods', () => {
  beforeAll(async () => {
    await addPeriodLimit('QTY_30D_B', '20', 30);
    await addPeriodLimit('QTY_90D_B', '50', 90);
  });

  afterAll(async () => {
    await dropRule('QTY_30D_B');
    await dropRule('QTY_90D_B');
  });

  it('refuses rather than choosing one of them', async () => {
    const decision = await supply('1', patientId);
    expect(decision.outcome).toBe('UNDETERMINED');
  });
});
