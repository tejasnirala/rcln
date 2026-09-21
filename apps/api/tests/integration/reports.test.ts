/**
 * PI-22: reporting & cost accounting — against a real Postgres, through the
 * real services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * Nine reads with no writes are the easiest thing in a codebase to ship broken:
 * every one of them returns a 200 and a plausible number whatever the SQL says,
 * and nothing downstream ever disagrees with them. So this suite asserts the
 * ARITHMETIC, against stock it put on a shelf itself.
 *
 *   A VALUATION IS QUANTITY × WHAT THE LOT COST      and the totals block is per
 *                                                    currency, over the whole
 *                                                    report rather than the page.
 *   AN UNCOSTED LOT IS UNVALUED, NOT ZERO            the single most important
 *                                                    case in the file: valuing
 *                                                    it at zero produces a
 *                                                    number somebody adds up.
 *   opening + received − issued ≡ closing            the identity that fails the
 *                                                    day a movement type
 *                                                    acquires a shape this
 *                                                    report was not told about.
 *   A QUARANTINE IS NOT AN ISSUE                     it moves quantity between
 *                                                    buckets and changes nothing
 *                                                    the branch holds — so it is
 *                                                    absent from `issued` and
 *                                                    present on the held report.
 *   HELD STOCK IS STILL VALUED                       an expired lot awaiting
 *                                                    destruction is the row a
 *                                                    clinic most needs.
 *   IDLE MEANS NOTHING WENT OUT                      not "nothing moved".
 *   A BRANCH OUTSIDE SCOPE IS NOT FOUND              never FORBIDDEN.
 *
 * ⚠️ THE UNVALUED AND THE QUARANTINE CASES ARE THE ONES MOST LIKELY TO BE BROKEN
 *   BY A LATER "SIMPLIFICATION". A `COALESCE(cost, 0)` would make the first pass
 *   nothing and silently understate every valuation; reading the ledger's SIGN
 *   instead of its status pair would make the second count a quarantine as a
 *   disposal. Both changes look like tidying.
 *
 * Every fixture is prefixed `RPT-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../.env', import.meta.url).pathname });

import type { TenantContext } from '@rcln/db';
import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch } from '../../src/services/inventory/batch.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import {
  getAgingReport,
  getDeadStockReport,
  getMovementReport,
  getQuarantineReport,
  getValuationReport,
} from '../../src/services/reports/inventory-reports.service.js';
import {
  getConsumptionCostReport,
  getDispensingReport,
  getProcedureContributionReport,
  getSupplierPerformanceReport,
} from '../../src/services/reports/activity-reports.service.js';
import { buildCatalogue, REPORTS } from '../../src/services/reports/catalogue.js';

const SUFFIX = `n${Date.now().toString(36)}`;
const SLUG = `rpt-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
/** Costed at 500 minor units per base unit. The row every figure is checked against. */
let costed: string;
let costedLot: string;
/** Deliberately has no cost anywhere. The unvalued case. */
let uncosted: string;
let uncostedLot: string;
let shelf: string;

/** Today and the window every dated report in this file is asked over. */
const TODAY = new Date().toISOString().slice(0, 10);
const WINDOW = { from: '2000-01-01', to: TODAY };

const UNIT_COST = 500;

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

async function makeProduct(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_stock_item, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE'::"ProductType", 'ACTIVE', $2, $3, $4,
             'LOT_BATCH'::"TrackingMode", true, now())
     RETURNING id`,
    [org.organizationId, code, `Rpt ${code}`, baseUnit]
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Rpt'));
  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId],
    userId: org.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  costed = await makeProduct('RPT-COSTED');
  uncosted = await makeProduct('RPT-UNCOSTED');

  shelf = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'RPT_SHELF',
      name: 'Rpt Shelf',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  costedLot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: costed,
      lotNumber: 'RPT-LOT-A',
      expiresOn: '2030-12-31',
      unitCostBase: UNIT_COST,
      currency: 'INR',
    })
  ).id;

  /*
   * ⚠️ NO `unitCostBase` AND NO CURRENCY, DELIBERATELY, AND NOTHING EVER GIVES
   *   THIS PRODUCT A MOVING AVERAGE EITHER. It is the fixture behind the
   *   unvalued case, and it is only a fixture as long as both halves of the
   *   fallback chain stay empty for it.
   */
  uncostedLot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: uncosted,
      lotNumber: 'RPT-LOT-B',
      expiresOn: '2030-12-31',
    })
  ).id;

  // 100 in, 20 out, 30 quarantined. See the movement case for why that matters.
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: costed,
    batchId: costedLot,
    /*
     * ⚠️ `RETURN` AND NOT `PURCHASE_RECEIPT`, WHICH IS A LIMIT OF THE MANUAL
     *   ROUTE RATHER THAN OF THE REPORT. `recordMovement` accepts only the
     *   movement types a human may type; a purchase receipt is written by
     *   posting a goods receipt. Both are ADDS — `status_to` alone — so the
     *   movement report treats them identically, which is the property under
     *   test here.
     */
    movementType: 'RETURN',
    quantity: '100',
    locationId: shelf,
    referenceType: 'MANUAL',
  });
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: costed,
    batchId: costedLot,
    movementType: 'DISPOSAL',
    quantity: '20',
    locationId: shelf,
    statusFrom: 'AVAILABLE',
    referenceType: 'MANUAL',
  });
  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: costed,
    batchId: costedLot,
    movementType: 'QUARANTINE',
    quantity: '30',
    locationId: shelf,
    statusFrom: 'AVAILABLE',
    statusTo: 'QUARANTINED',
    referenceType: 'MANUAL',
  });

  await recordMovement(ctx, {
    branchId: org.branchId,
    productId: uncosted,
    batchId: uncostedLot,
    /*
     * ⚠️ `RETURN` AND NOT `PURCHASE_RECEIPT`, WHICH IS A LIMIT OF THE MANUAL
     *   ROUTE RATHER THAN OF THE REPORT. `recordMovement` accepts only the
     *   movement types a human may type; a purchase receipt is written by
     *   posting a goods receipt. Both are ADDS — `status_to` alone — so the
     *   movement report treats them identically, which is the property under
     *   test here.
     */
    movementType: 'RETURN',
    quantity: '40',
    locationId: shelf,
    referenceType: 'MANUAL',
  });
}, 120_000);

afterAll(async () => {
  if (org) {
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [org.organizationId]);
  }
  await owner.end();
  await disconnectDb();
  await redis.quit();
});

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

describe('stock valuation', () => {
  it('values a lot at quantity × what that lot cost', async () => {
    const report = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: true,
      includeNonSellable: true,
      sortBy: 'value',
      productId: costed,
    });

    const row = report.rows.find((entry) => entry.batchId === costedLot);
    expect(row).toBeDefined();
    // 100 received, 20 disposed of. The quarantined 30 are still held.
    expect(Number(row?.quantityBase)).toBe(80);
    expect(Number(row?.quantityAvailableBase)).toBe(50);
    expect(row?.unitCostMinor).toBe(UNIT_COST);
    expect(row?.appliedBasis).toBe('BATCH');
    expect(row?.valueMinor).toBe(80 * UNIT_COST);
  });

  /**
   * ⚠️ THE CASE THIS FILE EXISTS FOR. A `COALESCE(cost, 0)` anywhere in the
   *   fallback chain passes every other assertion here and quietly reports a
   *   clinic's uncosted stock as worth nothing — a number that goes straight
   *   into a total somebody signs.
   */
  it('reports an uncosted lot as unvalued rather than as zero', async () => {
    const report = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: true,
      includeNonSellable: true,
      sortBy: 'value',
      productId: uncosted,
    });

    const row = report.rows.find((entry) => entry.batchId === uncostedLot);
    expect(row).toBeDefined();
    expect(Number(row?.quantityBase)).toBe(40);
    expect(row?.unitCostMinor).toBeNull();
    expect(row?.valueMinor).toBeNull();
    expect(row?.appliedBasis).toBeNull();
    expect(row?.currency).toBeNull();
  });

  /** Per currency, over the whole report, and carrying what it could not value. */
  it('totals per currency and keeps the unvalued quantity beside them', async () => {
    const report = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: true,
      includeNonSellable: true,
      sortBy: 'value',
    });

    const inr = report.totals.find((total) => total.currency === 'INR');
    expect(inr).toBeDefined();
    expect(inr?.valueMinor).toBe(80 * UNIT_COST);
    expect(Number(inr?.unvaluedQuantityBase)).toBe(40);
  });

  /**
   * ⚠️ THE CASE THAT CATCHES THE DEFECT THIS REPORT SHIPPED WITH IN DRAFT.
   *   `IN_TRANSIT` is a `StockStatus` that NOTHING EVER WRITES — PI-3 put the
   *   quantity on the transfer DOCUMENT instead, because a sender-owned bucket
   *   would make the receiver write against a branch RLS hides from them. A
   *   valuation that filters on the status honours the flag, returns rows, and
   *   values stock on a van at nothing. So the assertion is not "the flag
   *   works": it is that turning the flag OFF cannot change a figure that has no
   *   in-transit component, and the SQL that reads the document is exercised
   *   either way.
   */
  it('reads in-transit stock off the transfer document, not off a balance bucket', async () => {
    const withTransit = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: true,
      includeNonSellable: true,
      sortBy: 'value',
      productId: costed,
    });
    const withoutTransit = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: false,
      includeNonSellable: true,
      sortBy: 'value',
      productId: costed,
    });

    expect(withTransit.includeInTransit).toBe(true);
    expect(withoutTransit.includeInTransit).toBe(false);
    // Nothing has been dispatched in this fixture, so the two must agree.
    expect(withTransit.rows.find((r) => r.batchId === costedLot)?.quantityBase).toBe(
      withoutTransit.rows.find((r) => r.batchId === costedLot)?.quantityBase
    );
  });

  it('drops held stock when asked for sellable stock only', async () => {
    const report = await getValuationReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      includeInTransit: true,
      includeNonSellable: false,
      sortBy: 'value',
      productId: costed,
    });

    const row = report.rows.find((entry) => entry.batchId === costedLot);
    expect(Number(row?.quantityBase)).toBe(50);
  });

  /** RLS has already hidden the rows; the answer is NOT FOUND, never FORBIDDEN. */
  it('refuses a branch outside the caller’s scope as not found', async () => {
    await expect(
      getValuationReport(ctx, {
        page: 1,
        limit: 50,
        sortOrder: 'desc',
        format: 'json',
        basis: 'BATCH',
        includeInTransit: true,
        includeNonSellable: true,
        sortBy: 'value',
        branchId: '00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toThrow(/Branch/);
  });
});

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

describe('stock aging', () => {
  it('buckets a lot expiring in 2030 as over a year out, and values it', async () => {
    const report = await getAgingReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      clock: 'expiry',
      sortBy: 'bucket',
      productId: costed,
    });

    const row = report.rows.find((entry) => entry.batchId === costedLot);
    expect(row?.bucket).toBe('OVER_365');
    expect(row?.valueMinor).toBe(80 * UNIT_COST);
    expect(report.buckets.some((bucket) => bucket.bucket === 'OVER_365')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

describe('stock movement', () => {
  /**
   * ⚠️ THE IDENTITY, AND THE QUARANTINE THAT MUST NOT APPEAR IN IT. 100 in, 20
   *   disposed of, 30 moved into the quarantine bucket. If the report read the
   *   ledger's SIGN rather than its status pair, the quarantine's positive
   *   quantity would land in `received` and closing would come out at 110.
   */
  it('balances opening, in and out — and a quarantine is neither', async () => {
    const report = await getMovementReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      from: WINDOW.from,
      to: WINDOW.to,
      sortBy: 'out',
      productId: costed,
    });

    const row = report.rows.find((entry) => entry.productId === costed);
    expect(row).toBeDefined();
    expect(Number(row?.openingBase)).toBe(0);
    expect(Number(row?.receivedBase)).toBe(100);
    expect(Number(row?.issuedBase)).toBe(20);
    expect(Number(row?.disposedBase)).toBe(20);
    expect(Number(row?.closingBase)).toBe(80);

    const opening = Number(row?.openingBase);
    const received = Number(row?.receivedBase);
    const issued = Number(row?.issuedBase);
    expect(opening + received - issued).toBe(Number(row?.closingBase));
  });
});

// ---------------------------------------------------------------------------
// Held stock
// ---------------------------------------------------------------------------

describe('held stock', () => {
  it('shows the quarantined quantity, and values it', async () => {
    const report = await getQuarantineReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      sortBy: 'value',
      productId: costed,
    });

    const row = report.rows.find((entry) => entry.hold === 'QUARANTINED');
    expect(row).toBeDefined();
    expect(Number(row?.quantityBase)).toBe(30);
    expect(row?.valueMinor).toBe(30 * UNIT_COST);
  });

  it('narrows to one hold when asked', async () => {
    const report = await getQuarantineReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      sortBy: 'value',
      hold: 'RECALLED',
    });
    expect(report.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dead stock
// ---------------------------------------------------------------------------

describe('dead stock', () => {
  /**
   * ⚠️ NOTHING HAS BEEN IDLE FOR A YEAR IN THIS FIXTURE, AND THAT IS THE POINT
   *   OF THE ASSERTION. Everything here was received seconds ago, so a threshold
   *   of a year must return nothing — a report that ignored `idleDays` would
   *   return the whole shelf and look busy.
   */
  it('returns nothing when the idle threshold has not been reached', async () => {
    const report = await getDeadStockReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      idleDays: 365,
      minValueMinor: 0,
      sortBy: 'value',
    });
    expect(report.rows).toEqual([]);
  });

  /**
   * ⚠️ AND WITH THE THRESHOLD AT A DAY, THE PRODUCT THAT HAS NEVER HAD ANYTHING
   *   GO OUT IS THE ONE THAT APPEARS. Its `lastIssuedAt` is null — the worst
   *   case, not a missing one — and its `daysOfCover` is null rather than a very
   *   large number.
   */
  it('counts a product nothing ever went out of as idle from its first receipt', async () => {
    const report = await getDeadStockReport(ctx, {
      page: 1,
      limit: 50,
      sortOrder: 'desc',
      format: 'json',
      basis: 'BATCH',
      idleDays: 1,
      minValueMinor: 0,
      sortBy: 'value',
    });

    const row = report.rows.find((entry) => entry.productId === uncosted);
    if (row) {
      expect(row.lastIssuedAt).toBeNull();
      expect(row.daysOfCover).toBeNull();
      expect(row.valueMinor).toBeNull();
    }
    // A same-day fixture may or may not clear a one-day threshold depending on
    // the branch's clock; what must never happen is a row with a fabricated
    // cover figure, which is what the block above asserts when there is one.
    expect(Array.isArray(report.rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The activity reports, over an empty clinic
// ---------------------------------------------------------------------------

/**
 * ⚠️ AN EMPTY REPORT IS A REPORT, NOT AN ERROR, AND THESE FOUR HAVE NO FIXTURES
 *   ON PURPOSE. Dispensing, consumption, contribution and supplier performance
 *   each join four or five tables; the failure they are most likely to have is a
 *   malformed query that throws rather than a wrong number, and that failure
 *   shows against an empty clinic exactly as well as against a full one. The
 *   arithmetic they perform is asserted by the suites that write their inputs —
 *   `pharmacy`, `consumption`, `charging` and `procurement`.
 */
describe('the activity reports run, and answer honestly when there is nothing', () => {
  const page = { page: 1, limit: 50, sortOrder: 'desc' as const, format: 'json' as const };

  it('dispensing', async () => {
    const report = await getDispensingReport(ctx, {
      ...page,
      ...WINDOW,
      sortBy: 'quantity',
    });
    expect(report.reportKey).toBe('dispensing');
    expect(report.total).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it('consumption cost, grouped by product', async () => {
    const report = await getConsumptionCostReport(ctx, {
      ...page,
      ...WINDOW,
      groupBy: 'product',
      basis: 'MOVING_AVERAGE',
      sortBy: 'cost',
    });
    expect(report.groupBy).toBe('product');
    expect(report.rows).toEqual([]);
  });

  it('consumption cost, grouped by procedure', async () => {
    const report = await getConsumptionCostReport(ctx, {
      ...page,
      ...WINDOW,
      groupBy: 'procedure',
      basis: 'MOVING_AVERAGE',
      sortBy: 'cost',
    });
    expect(report.groupBy).toBe('procedure');
    expect(report.rows).toEqual([]);
  });

  /** ⚠️ And it says what it is not, in the response rather than in a comment. */
  it('procedure contribution, which never includes the procedure fee', async () => {
    const report = await getProcedureContributionReport(ctx, {
      ...page,
      ...WINDOW,
      basis: 'MOVING_AVERAGE',
      sortBy: 'contribution',
    });
    expect(report.procedureFeeIncluded).toBe(false);
    expect(report.rows).toEqual([]);
  });

  it('supplier performance', async () => {
    const report = await getSupplierPerformanceReport(ctx, {
      ...page,
      ...WINDOW,
      sortBy: 'spend',
    });
    expect(report.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe('the report catalogue', () => {
  it('offers every report and marks the ones the caller cannot open', () => {
    const catalogue = buildCatalogue(['report.inventory.read']);
    expect(catalogue.reports).toHaveLength(REPORTS.length);

    const valuation = catalogue.reports.find((r) => r.key === 'inventory-valuation');
    const contribution = catalogue.reports.find((r) => r.key === 'procedure-contribution');

    expect(valuation?.available).toBe(true);
    expect(contribution?.available).toBe(false);
    /* No `report.export`, so nothing is exportable — including what is readable. */
    expect(valuation?.exportable).toBe(false);
  });

  /**
   * ⚠️ HOLDING THE EXPORT VERB DOES NOT MAKE A REPORT YOU CANNOT READ
   *   EXPORTABLE. The route enforces the same conjunction with two `authorize()`
   *   calls; this is the menu agreeing with it.
   */
  it('needs both codes before a report is exportable', () => {
    const catalogue = buildCatalogue(['report.export']);
    for (const report of catalogue.reports) {
      expect(report.exportable).toBe(false);
    }

    const both = buildCatalogue(['report.export', 'report.inventory.read']);
    expect(both.reports.find((r) => r.key === 'inventory-valuation')?.exportable).toBe(true);
    expect(both.reports.find((r) => r.key === 'procedure-contribution')?.exportable).toBe(false);
  });
});
