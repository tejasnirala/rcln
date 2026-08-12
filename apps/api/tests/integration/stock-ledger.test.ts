/**
 * The ledger, the balance cache it maintains, and the query layer that reads
 * both — against a real Postgres, through the real services.
 *
 * ── WHY THIS FILE EXISTS IN THIS SHAPE ──────────────────────────────────────
 * PI-1's three worst bugs were ALL in the query layer, and every one of them
 * RETURNED A PLAUSIBLE ROW rather than failing: a dropped jurisdiction filter,
 * and a NULLS-FIRST sort that made every regional tax override silently inert.
 * The isolation suite tests the database and the unit suite tests pure
 * arithmetic, and nothing sat between them — so an assertion that "a row came
 * back" passed on all three.
 *
 * So every read below plants a DECOY: a second branch, a second lot, a second
 * status, a second product. The load-bearing assertion is what is ABSENT.
 *
 * ── AND THE THING THE WHOLE PHASE RESTS ON ──────────────────────────────────
 * `describe('under concurrency')` is the one that would be quietly wrong.
 * `stock_balances` is a cache maintained by a trigger; fifty parallel movements
 * against one bucket must leave it agreeing with a replay of the ledger, or the
 * cache is fiction and every stock figure on every screen is a guess. It mirrors
 * the numbering service's gaplessness test, which proves the same class of
 * property about the same class of mechanism.
 *
 * Every fixture is prefixed `STK-` and is torn down with the organizations.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch, setBatchHold } from '../../src/services/inventory/batch.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import {
  listBalances,
  listLedger,
  verifyBalances,
} from '../../src/services/inventory/balance.service.js';
import { sweepExpiredStock } from '../../src/services/inventory/expiry.service.js';

const SUFFIX = `s${Date.now().toString(36)}`;
const SLUG = `stk-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

/** The second branch. Every branch-filtered read below has to exclude it. */
let branchTwo: string;

let baseUnit: string;
let product: string;
/** A second product at the same location — the decoy for every product filter. */
let decoyProduct: string;
let expiringProduct: string;

let pharmacy: string;
/** A second location at the same branch — the decoy for every location filter. */
let fridge: string;
let lot: string;
let decoyLot: string;

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

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Stk'));

  const second = await owner.query<{ id: string }>(
    `INSERT INTO branches (id, organization_id, code, name, timezone, updated_at)
     VALUES (gen_random_uuid(), $1, 'STK2', 'Stk Second', 'Asia/Kolkata', now()) RETURNING id`,
    [org.organizationId]
  );
  branchTwo = second.rows[0]?.id ?? '';

  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId, branchTwo],
    userId: org.ownerUserId,
  };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const products = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, is_expiry_controlled, updated_at)
     VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'STK-MAIN',  'Stk Main Product',  $2, 'LOT_BATCH', false, now()),
            (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'STK-DECOY', 'Stk Decoy Product', $2, 'LOT_BATCH', false, now()),
            (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'STK-EXP',   'Stk Expiring',      $2, 'LOT_BATCH', true,  now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  product = products.rows[0]?.id ?? '';
  decoyProduct = products.rows[1]?.id ?? '';
  expiringProduct = products.rows[2]?.id ?? '';

  const main = await createLocation(ctx, {
    branchId: org.branchId,
    kind: 'MAIN_PHARMACY',
    code: 'STK_PHARM',
    name: 'Stk Pharmacy',
    isDispensingPoint: true,
    requiresControlledAccess: false,
  });
  pharmacy = main.id;

  const cold = await createLocation(ctx, {
    branchId: org.branchId,
    kind: 'REFRIGERATOR',
    code: 'STK_FRIDGE',
    name: 'Stk Fridge',
    isDispensingPoint: false,
    requiresControlledAccess: false,
  });
  fridge = cold.id;

  const created = await createBatch(ctx, {
    branchId: org.branchId,
    productId: product,
    lotNumber: 'STK-LOT-1',
  });
  lot = created.id;

  const decoy = await createBatch(ctx, {
    branchId: org.branchId,
    productId: decoyProduct,
    lotNumber: 'STK-LOT-DECOY',
  });
  decoyLot = decoy.id;
}, 40_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM stock_ledger WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM stock_balances WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
});

/** How much of one bucket the cache says there is. Read straight, not derived. */
async function balanceOf(batchId: string, locationId: string, status: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity FROM stock_balances
      WHERE batch_id = $1 AND location_id = $2 AND status = $3`,
    [batchId, locationId, status]
  );
  return Number(rows[0]?.quantity ?? 0);
}

/* ------------------------------------------------------------------ *
 * The write path
 * ------------------------------------------------------------------ */

describe('recording a movement', () => {
  it('derives the sign from the movement type, not from the caller', async () => {
    const receipt = await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'RETURN',
      quantity: '100',
      locationId: pharmacy,
      referenceType: 'MANUAL',
    });

    // Positive on the way in, and the caller never said so.
    expect(Number(receipt.quantityBase)).toBe(100);
    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(100);

    const issue = await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'DISPOSAL',
      quantity: '10',
      locationId: pharmacy,
      statusFrom: 'AVAILABLE',
      referenceType: 'MANUAL',
    });

    // Negative on the way out, from the same positive `quantity`.
    expect(Number(issue.quantityBase)).toBe(-10);
    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(90);
  });

  /**
   * ⚠️ THE ONE THAT MAKES QUARANTINE WORK. A status transition is NET ZERO
   *   across the branch's total holding: the quantity changes which bucket it
   *   sits in, not whether it exists. Written as a `−` it would vanish from
   *   every count on the day it was held, and the clinic could not say what it
   *   was about to send back.
   */
  it('moves quantity between buckets without changing what the branch holds', async () => {
    const before =
      (await balanceOf(lot, pharmacy, 'AVAILABLE')) +
      (await balanceOf(lot, pharmacy, 'QUARANTINED'));

    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'QUARANTINE',
      quantity: '20',
      locationId: pharmacy,
      referenceType: 'MANUAL',
    });

    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(70);
    expect(await balanceOf(lot, pharmacy, 'QUARANTINED')).toBe(20);

    const after =
      (await balanceOf(lot, pharmacy, 'AVAILABLE')) +
      (await balanceOf(lot, pharmacy, 'QUARANTINED'));
    expect(after).toBe(before);
  });

  it('releases it again', async () => {
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'QUARANTINE_RELEASE',
      quantity: '20',
      locationId: pharmacy,
      referenceType: 'MANUAL',
    });

    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(90);
    expect(await balanceOf(lot, pharmacy, 'QUARANTINED')).toBe(0);
  });

  /**
   * ⚠️ A NORMAL 409, NOT AN ERROR. Losing the race for the last strip is an
   *   ordinary outcome in a busy pharmacy. The service takes the bucket FOR
   *   UPDATE and re-verifies, so the caller is told "there is less than that"
   *   rather than being handed a constraint violation from the layer beneath.
   */
  it('refuses an issue larger than the bucket holds, and says how much there is', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        movementType: 'DISPOSAL',
        quantity: '1000',
        locationId: pharmacy,
        statusFrom: 'AVAILABLE',
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/which is less than/i);

    // And the shelf is untouched.
    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(90);
  });

  it('refuses a batch-tracked movement with no lot', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        movementType: 'RETURN',
        quantity: '1',
        locationId: pharmacy,
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/must name a lot/i);
  });

  /**
   * ⚠️ THE COMPOSITE FK PROVES THE LOT IS THIS TENANT'S AND SAYS NOTHING ABOUT
   *   WHETHER IT IS THIS PRODUCT'S. A movement of lot X against product Y is a
   *   perfectly valid insert that quietly makes both lots' remaining quantities
   *   wrong, so the service re-reads rather than trusting.
   */
  it('refuses a lot that belongs to a different product', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: decoyLot,
        movementType: 'RETURN',
        quantity: '1',
        locationId: pharmacy,
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/is not a lot of/i);
  });

  it('refuses a location at another branch', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: branchTwo,
        productId: product,
        batchId: lot,
        movementType: 'RETURN',
        quantity: '1',
        locationId: pharmacy,
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/not at the branch/i);
  });

  it('refuses a branch outside the caller’s scope as NOT FOUND, never FORBIDDEN', async () => {
    const narrow: TenantContext = { ...ctx, branchIds: [branchTwo] };
    await expect(
      recordMovement(narrow, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        movementType: 'RETURN',
        quantity: '1',
        locationId: pharmacy,
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/Branch not found/i);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency — the property the whole phase rests on
 * ------------------------------------------------------------------ */

describe('under concurrency', () => {
  /**
   * ⚠️ FIFTY PARALLEL MOVEMENTS AGAINST ONE BUCKET.
   *
   *   The ledger is append-only, so writes to it do not contend. The CACHE does:
   *   two transactions reading the same starting quantity and both adding to it
   *   is a lost update, and the symptom is a stock figure that is simply too
   *   high — no error, no log line, and nothing to reconcile it against except
   *   the ledger itself.
   *
   *   The trigger serialises on the balance row (an `UPDATE` takes a row lock,
   *   and the `INSERT` arm resolves a race through the unique index), so the sum
   *   must come out exactly. This mirrors the numbering service's fifty-parallel
   *   gaplessness test, which proves the same class of property.
   */
  it('leaves the cache agreeing with the ledger after 50 parallel movements', async () => {
    const before = await balanceOf(lot, fridge, 'AVAILABLE');

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        recordMovement(ctx, {
          branchId: org.branchId,
          productId: product,
          batchId: lot,
          movementType: 'RETURN',
          quantity: '2',
          locationId: fridge,
          referenceType: 'MANUAL',
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    // Nothing here contends for scarce stock — every one of them adds — so all
    // fifty must succeed. A failure here is a deadlock or a lock timeout.
    expect(succeeded).toBe(50);

    expect(await balanceOf(lot, fridge, 'AVAILABLE')).toBe(before + 100);
  }, 60_000);

  /**
   * ⚠️ AND THE OTHER DIRECTION, WHERE THE STOCK RUNS OUT. Twenty parallel
   *   attempts to take 10 from a bucket holding 100: exactly ten must succeed
   *   and ten must be refused. Nine successes would mean a lock held too long;
   *   eleven would mean a negative shelf.
   */
  it('lets exactly as many issues succeed as there is stock for', async () => {
    // A bucket with a known, isolated starting quantity.
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: decoyProduct,
      batchId: decoyLot,
      movementType: 'RETURN',
      quantity: '100',
      locationId: fridge,
      referenceType: 'MANUAL',
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        recordMovement(ctx, {
          branchId: org.branchId,
          productId: decoyProduct,
          batchId: decoyLot,
          movementType: 'DISPOSAL',
          quantity: '10',
          locationId: fridge,
          statusFrom: 'AVAILABLE',
          referenceType: 'MANUAL',
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(10);
    expect(await balanceOf(decoyLot, fridge, 'AVAILABLE')).toBe(0);
  }, 60_000);

  /**
   * The verifier, run over everything this suite has done.
   *
   * ⚠️ IT REPLAYS THE LEDGER AND COMPARES. A disagreement is a bug in the
   *   trigger, and the LEDGER WINS (PI-ADR-004 rule 4) — so an empty
   *   `discrepancies` array is the assertion that the cache is not fiction. It
   *   is deliberately checked AFTER the concurrent blocks above, because a lost
   *   update is exactly what it is built to find.
   */
  it('replays to the same numbers the cache holds', async () => {
    const report = await verifyBalances(ctx, { branchId: org.branchId });

    expect(report.bucketsChecked).toBeGreaterThan(0);
    expect(report.discrepancies).toEqual([]);
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * The query layer — every case plants a decoy
 * ------------------------------------------------------------------ */

describe('reading balances', () => {
  it('filters by location and excludes the other shelf', async () => {
    const res = await listBalances(ctx, {
      branchId: org.branchId,
      locationId: pharmacy,
      hideEmpty: true,
      page: 1,
      limit: 50,
    });

    expect(res.balances.length).toBeGreaterThan(0);
    // The decoy: the fridge holds stock of the same lot, and must not appear.
    expect(res.balances.every((b) => b.locationId === pharmacy)).toBe(true);
  });

  it('filters by product and excludes the other product on the same shelf', async () => {
    const res = await listBalances(ctx, {
      branchId: org.branchId,
      productId: product,
      hideEmpty: true,
      page: 1,
      limit: 50,
    });

    expect(res.balances.length).toBeGreaterThan(0);
    expect(res.balances.every((b) => b.productId === product)).toBe(true);
    expect(res.balances.some((b) => b.productId === decoyProduct)).toBe(false);
  });

  it('hides the zero rows a fully-issued bucket leaves behind', async () => {
    const shown = await listBalances(ctx, {
      branchId: org.branchId,
      productId: decoyProduct,
      locationId: fridge,
      hideEmpty: true,
      page: 1,
      limit: 50,
    });
    expect(shown.balances).toEqual([]);

    // And keeps them when asked, because "we used to hold this here" is a fact.
    const all = await listBalances(ctx, {
      branchId: org.branchId,
      productId: decoyProduct,
      locationId: fridge,
      hideEmpty: false,
      page: 1,
      limit: 50,
    });
    expect(all.balances.length).toBeGreaterThan(0);
  });

  it('shows a branch-scoped reader nothing from the other branch', async () => {
    const narrow: TenantContext = { ...ctx, branchIds: [branchTwo] };
    const res = await listBalances(narrow, {
      branchId: branchTwo,
      hideEmpty: true,
      page: 1,
      limit: 50,
    });
    expect(res.balances).toEqual([]);
  });
});

describe('reading the ledger', () => {
  it('filters by movement type and excludes the others', async () => {
    const res = await listLedger(ctx, {
      branchId: org.branchId,
      movementType: 'QUARANTINE',
      page: 1,
      limit: 50,
    });

    expect(res.movements.length).toBeGreaterThan(0);
    expect(res.movements.every((m) => m.movementType === 'QUARANTINE')).toBe(true);
  });

  /**
   * ⚠️ A LOCATION FILTER HAS TO LOOK AT BOTH ENDS OF A MOVEMENT. An issue names
   *   the shelf in `from_location_id` and a receipt names it in
   *   `to_location_id`; filtering on either alone shows half that shelf's
   *   history and looks complete. The decoy here is that the pharmacy has both
   *   kinds.
   */
  it('finds movements into AND out of a location', async () => {
    const res = await listLedger(ctx, {
      branchId: org.branchId,
      locationId: pharmacy,
      page: 1,
      limit: 100,
    });

    const kinds = new Set(res.movements.map((m) => m.movementType));
    expect(kinds.has('RETURN')).toBe(true); // in
    expect(kinds.has('DISPOSAL')).toBe(true); // out
    expect(
      res.movements.every((m) => m.fromLocationId === pharmacy || m.toLocationId === pharmacy)
    ).toBe(true);
  });

  /**
   * ⚠️ `to` IS A CALENDAR DAY AND `occurred_at` IS AN INSTANT, so the filter has
   *   to be exclusive of the NEXT day. `occurredAt <= '2026-08-15'` means "at or
   *   before midnight on the 15th" and silently drops everything that happened
   *   DURING the 15th — a whole-day-off filter that looks right and returns
   *   almost the right rows. `invoices.test.ts` shipped exactly this shape of
   *   bug and failed only between 18:30 and midnight UTC.
   */
  it('includes movements made today when today is the end of the range', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await listLedger(ctx, {
      branchId: org.branchId,
      productId: product,
      from: today,
      to: today,
      page: 1,
      limit: 100,
    });

    expect(res.movements.length).toBeGreaterThan(0);
  });

  it('paginates rather than returning the whole table', async () => {
    const page1 = await listLedger(ctx, { branchId: org.branchId, page: 1, limit: 5 });
    const page2 = await listLedger(ctx, { branchId: org.branchId, page: 2, limit: 5 });

    expect(page1.movements).toHaveLength(5);
    expect(page1.meta.total).toBeGreaterThan(5);
    expect(page1.movements[0]?.id).not.toBe(page2.movements[0]?.id);
  });

  it('records what the user typed beside what was stored', async () => {
    const res = await listLedger(ctx, {
      branchId: org.branchId,
      movementType: 'DISPOSAL',
      page: 1,
      limit: 5,
    });

    const first = res.movements[0];
    expect(first).toBeDefined();
    // Both negative, and both pointing the same way — the CHECK insists on it.
    expect(Number(first?.quantityBase)).toBeLessThan(0);
    expect(Number(first?.quantityEntered)).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Holds, recalls and expiry
 * ------------------------------------------------------------------ */

describe('holding a lot', () => {
  /**
   * ⚠️ THE FLAG AND THE QUANTITY MOVE TOGETHER OR NOT AT ALL. A batch marked
   *   QUARANTINED whose stock is still in the AVAILABLE bucket is dispensable,
   *   because allocation reads the balance and not the batch. That is two
   *   answers to one question, and the dispensing screen reads the one that lets
   *   it dispense.
   */
  it('moves every location’s stock and sets the batch status in one go', async () => {
    const held = await setBatchHold(ctx, lot, 'QUARANTINE', {
      reason: 'Suspected cold-chain excursion',
    });

    expect(held.status).toBe('QUARANTINED');
    expect(held.quarantineReason).toBe('Suspected cold-chain excursion');

    // Both shelves, not just the one somebody happened to look at.
    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(0);
    expect(await balanceOf(lot, fridge, 'AVAILABLE')).toBe(0);
    expect(await balanceOf(lot, pharmacy, 'QUARANTINED')).toBeGreaterThan(0);
    expect(await balanceOf(lot, fridge, 'QUARANTINED')).toBeGreaterThan(0);
  }, 30_000);

  it('releases it, and the numbers come back', async () => {
    const released = await setBatchHold(ctx, lot, 'QUARANTINE_RELEASE', {
      reason: 'Temperature log reviewed and cleared',
    });

    expect(released.status).toBe('ACTIVE');
    expect(released.quarantineReason).toBeNull();
    expect(await balanceOf(lot, pharmacy, 'AVAILABLE')).toBe(90);
  }, 30_000);

  /**
   * A recall of a lot with nothing left is not an error, and refusing it would
   * make the most urgent case unrecordable — a fully-dispensed lot is exactly
   * the one where somebody has to ask who received it.
   */
  it('records a recall of a lot that has no stock left', async () => {
    const empty = await createBatch(ctx, {
      branchId: org.branchId,
      productId: product,
      lotNumber: 'STK-LOT-EMPTY',
    });

    const recalled = await setBatchHold(ctx, empty.id, 'RECALL', {
      reason: 'Manufacturer notice',
      recallReference: 'MFR-2026-0042',
    });

    expect(recalled.status).toBe('RECALLED');
    expect(recalled.recallReference).toBe('MFR-2026-0042');
  });
});

describe('the expiry sweep', () => {
  /**
   * ⚠️ THE DAY IS THE BRANCH'S DAY. This suite's branch is `Asia/Kolkata` and
   *   the test container is UTC, so a lot dated yesterday-in-Kolkata is the case
   *   that separates a correct sweep from one comparing against `CURRENT_DATE`.
   *   The fixture dates the lot two days back so the assertion does not itself
   *   depend on what time the suite happens to run.
   */
  it('moves expired stock into the EXPIRED bucket and leaves fresh stock alone', async () => {
    const expiredLot = await createBatch(ctx, {
      branchId: org.branchId,
      productId: expiringProduct,
      lotNumber: 'STK-LOT-OLD',
      expiresOn: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
    });

    const freshLot = await createBatch(ctx, {
      branchId: org.branchId,
      productId: expiringProduct,
      lotNumber: 'STK-LOT-FRESH',
      expiresOn: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
    });

    for (const batchId of [expiredLot.id, freshLot.id]) {
      await recordMovement(ctx, {
        branchId: org.branchId,
        productId: expiringProduct,
        batchId,
        movementType: 'RETURN',
        quantity: '40',
        locationId: pharmacy,
        referenceType: 'MANUAL',
      });
    }

    const result = await sweepExpiredStock(ctx, org.branchId);

    expect(result.batchesExpired).toBe(1);
    expect(await balanceOf(expiredLot.id, pharmacy, 'AVAILABLE')).toBe(0);
    expect(await balanceOf(expiredLot.id, pharmacy, 'EXPIRED')).toBe(40);

    // The decoy: a lot expiring in a year must not be touched.
    expect(await balanceOf(freshLot.id, pharmacy, 'AVAILABLE')).toBe(40);

    /*
     * ⚠️ IDEMPOTENT BY CONSTRUCTION, NOT BY A GUARD. The second run finds
     *   nothing because the first emptied the AVAILABLE bucket — there is no
     *   `last_swept_at` column, and there must not be one.
     */
    const again = await sweepExpiredStock(ctx, org.branchId);
    expect(again.movementsWritten).toBe(0);
  }, 40_000);

  it('leaves the cache agreeing with the ledger afterwards', async () => {
    const report = await verifyBalances(ctx, { branchId: org.branchId });
    expect(report.discrepancies).toEqual([]);
  }, 30_000);
});
