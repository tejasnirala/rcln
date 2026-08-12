/**
 * PI-3: transfers, reservations and the reason-code vocabulary — against a real
 * Postgres, through the real services (PI-3.7).
 *
 * ── WHAT THIS SUITE IS ACTUALLY FOR ─────────────────────────────────────────
 * `stock-ledger.test.ts` proves the ledger and its cache agree. This one proves
 * the three things built on top of them keep that true:
 *
 *   TRANSFER ATOMICITY   a dispatch writes every leg or none. A transfer marked
 *                        sent whose legs did not write is stock the sender still
 *                        shows on its shelves and the receiver is expecting.
 *   NO NEGATIVE BALANCE  a transfer, a reservation and an adjustment all go
 *                        through the same bucket lock, and all three must lose
 *                        the race with a 409 rather than a negative shelf.
 *   THE VOCABULARY       an adjustment citing a code this clinic does not use,
 *                        or one pointing the wrong way, is refused.
 *
 * ⚠️ AND THE ONE THAT WOULD BE QUIETLY WRONG: `verifyBalances()` IS RUN AFTER
 *   EVERY FLOW. Every operation here writes movements through `recordMovementIn`
 *   and then updates a DOCUMENT, and a document that disagreed with the ledger
 *   would show correct numbers on its own screen while the shelves said
 *   something else. The replay is the assertion that they cannot.
 *
 * Every fixture is prefixed `MOV-` and is torn down with the organizations.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch } from '../../src/services/inventory/batch.service.js';
import { createSerial } from '../../src/services/inventory/serial.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { verifyBalances } from '../../src/services/inventory/balance.service.js';
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
} from '../../src/services/inventory/transfer.service.js';
import {
  listReservations,
  releaseReservation,
  reserveStock,
} from '../../src/services/inventory/reservation.service.js';
import { listReasonCodes } from '../../src/services/inventory/reason-code.service.js';
import { receiveStockTransferRequest } from '@rcln/contracts';
import { planStockAllocation } from '../../src/services/inventory/allocation.service.js';

const SUFFIX = `m${Date.now().toString(36)}`;
const SLUG = `mov-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
/** Scoped to BOTH branches — the org-wide storekeeper. */
let ctx: TenantContext;
/** Scoped to the SENDING branch only. Proves a sender needs nothing more. */
let senderCtx: TenantContext;
/** Scoped to the RECEIVING branch only. The whole point of the design. */
let receiverCtx: TenantContext;

let branchTwo: string;
let baseUnit: string;
let product: string;
let untracked: string;
let pharmacy: string;
let fridge: string;
/** At branch two. Where an inter-branch transfer lands. */
let farStore: string;
let lot: string;

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

/** Put a known quantity into a bucket, through the one writer. */
async function stockUp(
  context: TenantContext,
  branchId: string,
  locationId: string,
  productId: string,
  batchId: string | null,
  quantity: string
): Promise<void> {
  await recordMovement(context, {
    branchId,
    productId,
    ...(batchId === null ? {} : { batchId }),
    movementType: 'RETURN',
    quantity,
    locationId,
    referenceType: 'MANUAL',
  });
}

async function balanceOf(
  locationId: string,
  status: string,
  productId: string = product
): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_balances
      WHERE location_id = $1 AND status = $2 AND product_id = $3`,
    [locationId, status, productId]
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** How many ledger rows this transfer produced. The atomicity assertion. */
async function legsFor(transferId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM stock_ledger
      WHERE reference_type = 'TRANSFER' AND reference_id = $1`,
    [transferId]
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Mov'));

  const second = await owner.query<{ id: string }>(
    `INSERT INTO branches (id, organization_id, code, name, timezone, updated_at)
     VALUES (gen_random_uuid(), $1, 'MOV2', 'Mov Second', 'Asia/Kolkata', now()) RETURNING id`,
    [org.organizationId]
  );
  branchTwo = second.rows[0]?.id ?? '';

  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId, branchTwo],
    userId: org.ownerUserId,
  };
  senderCtx = { ...ctx, branchIds: [org.branchId] };
  receiverCtx = { ...ctx, branchIds: [branchTwo] };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const products = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, is_expiry_controlled, updated_at)
     VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'MOV-MAIN', 'Mov Main Product', $2, 'LOT_BATCH', false, now()),
            (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'MOV-PLAIN','Mov Plain Product',$2, 'NONE',      false, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  product = products.rows[0]?.id ?? '';
  untracked = products.rows[1]?.id ?? '';

  pharmacy = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'MOV_PHARM',
      name: 'Mov Pharmacy',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  fridge = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'REFRIGERATOR',
      code: 'MOV_FRIDGE',
      name: 'Mov Fridge',
      isDispensingPoint: false,
      requiresControlledAccess: false,
    })
  ).id;

  farStore = (
    await createLocation(ctx, {
      branchId: branchTwo,
      kind: 'CENTRAL_WAREHOUSE',
      code: 'MOV_FAR',
      name: 'Mov Far Store',
      isDispensingPoint: false,
      requiresControlledAccess: false,
    })
  ).id;

  lot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: product,
      lotNumber: 'MOV-LOT-1',
      expiresOn: '2029-12-31',
    })
  ).id;
}, 40_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM stock_transfer_lines WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM stock_transfers WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM stock_reservations WHERE organization_id = ANY($1)', [ids]);
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

/* ------------------------------------------------------------------ *
 * Reason codes (PI-3.1)
 * ------------------------------------------------------------------ */

describe('the reason-code vocabulary', () => {
  it('ships platform codes every clinic can cite from the day it opens', async () => {
    const { reasonCodes } = await listReasonCodes(ctx, { includeInactive: false });

    expect(reasonCodes.length).toBeGreaterThanOrEqual(13);
    // ⚠️ Platform rows, so `organizationId` is NULL — the clinic reads them and
    //   cannot edit them. That is the whole point of the tenancy class.
    expect(reasonCodes.every((r) => r.organizationId === null)).toBe(true);
    expect(reasonCodes.map((r) => r.code)).toContain('COUNT_SHORT');
  });

  /**
   * ⚠️ `BOTH` MUST SURVIVE A DIRECTION FILTER, AND THE NAIVE FILTER DROPS IT.
   *   Filtering on equality alone loses `STOCK_TAKE` and `OTHER` from every
   *   picker — the two codes most likely to be the right answer.
   */
  it('keeps the both-ways codes when a direction is asked for', async () => {
    const { reasonCodes } = await listReasonCodes(ctx, {
      direction: 'DECREASE',
      includeInactive: false,
    });

    const codes = reasonCodes.map((r) => r.code);
    expect(codes).toContain('COUNT_SHORT'); // DECREASE
    expect(codes).toContain('STOCK_TAKE'); // BOTH
    expect(codes).not.toContain('COUNT_OVER'); // INCREASE — the decoy
  });

  it('refuses an adjustment citing a code this clinic does not use', async () => {
    await stockUp(ctx, org.branchId, pharmacy, product, lot, '50');

    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        movementType: 'ADJUSTMENT',
        adjustmentDirection: 'DECREASE',
        quantity: '1',
        locationId: pharmacy,
        reasonCode: 'BECAUSE_I_SAID_SO',
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/not a reason code/i);
  });

  /**
   * ⚠️ THE ONE A FREE-TEXT FIELD COULD NEVER CATCH. "Found, previously
   *   unrecorded" cannot explain stock going missing, and an adjustment that
   *   cited it downwards would file a discovery as a loss in the report a clinic
   *   uses to decide whether it has a theft problem.
   */
  it('refuses a reason that points the other way', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        movementType: 'ADJUSTMENT',
        adjustmentDirection: 'DECREASE',
        quantity: '1',
        locationId: pharmacy,
        reasonCode: 'FOUND_STOCK',
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/explains stock going up/i);
  });

  it('refuses a code that demands a note when none is given', async () => {
    await expect(
      recordMovement(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        movementType: 'ADJUSTMENT',
        adjustmentDirection: 'DECREASE',
        quantity: '1',
        locationId: pharmacy,
        reasonCode: 'THEFT_OR_LOSS',
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow(/needs a note/i);
  });

  it('accepts one that is right in every respect, and moves the stock', async () => {
    const before = await balanceOf(pharmacy, 'AVAILABLE');

    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      movementType: 'ADJUSTMENT',
      adjustmentDirection: 'DECREASE',
      quantity: '3',
      locationId: pharmacy,
      reasonCode: 'COUNT_SHORT',
      referenceType: 'MANUAL',
    });

    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(before - 3);
  });
});

/* ------------------------------------------------------------------ *
 * Transfers (PI-3.2, PI-3.3)
 * ------------------------------------------------------------------ */

describe('an intra-branch transfer', () => {
  /**
   * ⚠️ THE ATOMIC PAIR PI-3.2 ASKS FOR. Two ledger rows citing one transfer,
   *   written in ONE transaction — which is exactly why `manualMovementType`
   *   still refuses to expose `TRANSFER_IN` and `TRANSFER_OUT` one at a time. A
   *   caller that could post one leg could leave stock that has left one shelf
   *   and arrived at none.
   */
  it('writes both legs and lands as received, in one step', async () => {
    await stockUp(ctx, org.branchId, pharmacy, product, lot, '40');
    const beforePharmacy = await balanceOf(pharmacy, 'AVAILABLE');
    const beforeFridge = await balanceOf(fridge, 'AVAILABLE');

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: org.branchId,
      fromLocationId: pharmacy,
      toLocationId: fridge,
      lines: [{ productId: product, batchId: lot, quantity: '10' }],
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.isIntraBranch).toBe(true);
    // A draft has moved nothing and burned no number.
    expect(await legsFor(draft.id)).toBe(0);
    expect(draft.transferNumber).toBeNull();

    const sent = await dispatchTransfer(senderCtx, draft.id);

    expect(sent.status).toBe('RECEIVED');
    expect(sent.transferNumber).toMatch(/^TRF-\d+$/);
    expect(await legsFor(draft.id)).toBe(2);
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(beforePharmacy - 10);
    expect(await balanceOf(fridge, 'AVAILABLE')).toBe(beforeFridge + 10);
  });

  it('refuses a move from a shelf to itself', async () => {
    await expect(
      createTransfer(senderCtx, {
        fromBranchId: org.branchId,
        toBranchId: org.branchId,
        fromLocationId: pharmacy,
        toLocationId: pharmacy,
        lines: [{ productId: product, batchId: lot, quantity: '1' }],
      })
    ).rejects.toThrow(/changes nothing/i);
  });

  it('insists on a destination shelf, because there is no later moment to pick one', async () => {
    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: org.branchId,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '1' }],
    });

    await expect(dispatchTransfer(senderCtx, draft.id)).rejects.toThrow(/which shelf/i);
    // ⚠️ AND NOTHING MOVED. A refused dispatch must leave the draft a draft.
    expect(await legsFor(draft.id)).toBe(0);
    expect((await getTransfer(senderCtx, draft.id)).status).toBe('DRAFT');
  });
});

describe('an inter-branch transfer', () => {
  let transferId: string;

  /**
   * ⚠️ THE SENDER IS SCOPED TO THE SENDING BRANCH **ONLY**, WHICH IS THE WHOLE
   *   POINT OF PI-3'S IN-TRANSIT DECISION. Dispatch writes `TRANSFER_OUT` at the
   *   sender and nothing anywhere else, so it needs nothing but the sending
   *   branch — and the architecture doc's sender-owned `IN_TRANSIT` bucket would
   *   have needed the RECEIVER to write against a branch they cannot see.
   */
  it('is dispatched by somebody who can only see the sending branch', async () => {
    await stockUp(senderCtx, org.branchId, pharmacy, product, lot, '60');
    const before = await balanceOf(pharmacy, 'AVAILABLE');

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '25' }],
    });
    transferId = draft.id;
    expect(draft.isIntraBranch).toBe(false);

    const sent = await dispatchTransfer(senderCtx, draft.id);

    expect(sent.status).toBe('DISPATCHED');
    // ONE leg, not two. Nothing has arrived anywhere.
    expect(await legsFor(draft.id)).toBe(1);
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(before - 25);
    expect(await balanceOf(farStore, 'AVAILABLE')).toBe(0);
  });

  /**
   * ⚠️ AND IN-TRANSIT STOCK IS IN NEITHER BRANCH'S BALANCES, WHICH IS THE COST
   *   OF THE DECISION AND IS PINNED HERE SO PI-22 DOES NOT REDISCOVER IT. A
   *   valuation report that sums `stock_balances` and stops is under-counting by
   *   whatever is on a van; it must add the outstanding transfer lines. This
   *   assertion is what makes that a documented property rather than a surprise.
   */
  it('holds the quantity on the document, not in any bucket', async () => {
    const { rows } = await owner.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_balances
        WHERE product_id = $1 AND status = 'IN_TRANSIT'`,
      [product]
    );
    expect(Number(rows[0]?.quantity ?? 0)).toBe(0);

    const detail = await getTransfer(senderCtx, transferId);
    expect(detail.lines[0]?.outstandingQuantityBase).toBe('25');
  });

  /**
   * ⚠️ THE RECEIVER IS SCOPED TO THE RECEIVING BRANCH ONLY, AND WRITES NOTHING
   *   AT THE SENDER'S. Every row this produces — the `TRANSFER_IN` leg and the
   *   destination lot — carries `branchTwo`.
   */
  it('is received by somebody who can only see the receiving branch', async () => {
    const detail = await getTransfer(receiverCtx, transferId);
    const line = detail.lines[0];
    if (!line) throw new Error('the transfer has no lines');

    const received = await receiveTransfer(receiverCtx, transferId, {
      toLocationId: farStore,
      lines: [{ lineId: line.id, quantityBase: '25' }],
    });

    expect(received.status).toBe('RECEIVED');
    expect(await legsFor(transferId)).toBe(2);
    expect(await balanceOf(farStore, 'AVAILABLE')).toBe(25);
  });

  /**
   * ⚠️ A SECOND LOT ROW FOR ONE MANUFACTURER'S LOT, AT THE RECEIVING BRANCH.
   *   `batches` is branch-scoped, so the sender's row cannot be cited by a
   *   movement at the receiver — the number, expiry and cost are copied and the
   *   line records which row it became. That is what makes traceability cross
   *   the gap.
   */
  it('creates the receiving branch its own row for the same lot', async () => {
    const detail = await getTransfer(receiverCtx, transferId);
    const line = detail.lines[0];

    expect(line?.destinationBatchId).toBeTruthy();
    expect(line?.destinationBatchId).not.toBe(line?.batchId);

    const { rows } = await owner.query<{ branch_id: string; lot_number: string }>(
      `SELECT branch_id, lot_number FROM batches WHERE id = $1`,
      [line?.destinationBatchId]
    );
    expect(rows[0]?.branch_id).toBe(branchTwo);
    expect(rows[0]?.lot_number).toBe('MOV-LOT-1');
  });

  it('leaves the ledger and the cache agreeing', async () => {
    const report = await verifyBalances(ctx, {});
    expect(report.discrepancies).toHaveLength(0);
  });
});

describe('a partly-received transfer', () => {
  let transferId: string;
  let lineId: string;

  it('stays outstanding when less arrives than was sent', async () => {
    await stockUp(senderCtx, org.branchId, pharmacy, product, lot, '30');

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '20' }],
    });
    transferId = draft.id;
    await dispatchTransfer(senderCtx, draft.id);

    lineId = (await getTransfer(receiverCtx, transferId)).lines[0]?.id ?? '';

    const partial = await receiveTransfer(receiverCtx, transferId, {
      toLocationId: farStore,
      lines: [{ lineId, quantityBase: '12' }],
    });

    expect(partial.status).toBe('PARTIALLY_RECEIVED');
    expect(partial.lines[0]?.outstandingQuantityBase).toBe('8');
    // ⚠️ `received_at` STAYS NULL. A delivery with a box still missing has not
    //   closed, and stamping it would say it had.
    expect(partial.receivedAt).toBeNull();
  });

  it('appears in the outstanding list, which is what answers "where is my box"', async () => {
    const { transfers } = await listTransfers(receiverCtx, {
      outstandingOnly: true,
      page: 1,
      limit: 50,
    });

    const mine = transfers.find((t) => t.id === transferId);
    expect(mine).toBeDefined();
    expect(mine?.outstandingLineCount).toBe(1);
  });

  /**
   * ⚠️ OVER-RECEIPT IS REFUSED RATHER THAN ABSORBED. On the tenth occasion it is
   *   a genuine discovery of stock, which is an ADJUSTMENT with a reason code at
   *   the receiving branch — letting the transfer absorb it would file a
   *   discovery as a delivery and the sending branch's books would never balance.
   */
  it('refuses more than was sent', async () => {
    await expect(
      receiveTransfer(receiverCtx, transferId, {
        toLocationId: farStore,
        lines: [{ lineId, quantityBase: '9' }],
      })
    ).rejects.toThrow(/still outstanding/i);
  });

  it('closes when the rest turns up', async () => {
    const done = await receiveTransfer(receiverCtx, transferId, {
      toLocationId: farStore,
      lines: [{ lineId, quantityBase: '8' }],
    });

    expect(done.status).toBe('RECEIVED');
    expect(done.receivedAt).not.toBeNull();
    expect(done.lines[0]?.outstandingQuantityBase).toBe('0');
  });
});

describe('cancelling a transfer', () => {
  /**
   * ⚠️ A COMPENSATING MOVEMENT, NEVER AN EDIT OR A DELETE (PI-ADR-004 rule 3).
   *   The quantity has already left the sending branch's shelves and has to land
   *   somewhere; the original send stays in the ledger with the cancellation
   *   beside it.
   */
  it('sends what is still outstanding back to the sender', async () => {
    await stockUp(senderCtx, org.branchId, pharmacy, product, lot, '15');
    const before = await balanceOf(pharmacy, 'AVAILABLE');

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '15' }],
    });
    await dispatchTransfer(senderCtx, draft.id);
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(before - 15);

    const cancelled = await cancelTransfer(senderCtx, draft.id, {
      reason: 'The van broke down and the stock came back.',
    });

    expect(cancelled.status).toBe('CANCELLED');
    // Two legs: the send, and the compensating return.
    expect(await legsFor(draft.id)).toBe(2);
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(before);
  });

  it('writes no movement at all when the transfer never left', async () => {
    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '1' }],
    });

    const cancelled = await cancelTransfer(senderCtx, draft.id, { reason: 'Changed our minds.' });

    expect(cancelled.status).toBe('CANCELLED');
    expect(await legsFor(draft.id)).toBe(0);
  });
});

describe('a transfer that cannot go', () => {
  /**
   * ⚠️ NO NEGATIVE BALANCE, THROUGH THE SAME BUCKET LOCK EVERY OTHER MOVEMENT
   *   USES. A transfer of more than the shelf holds loses with a 409, exactly as
   *   a dispense would — and `stock_balances_non_negative` is the layer beneath
   *   that for the callers this one cannot see.
   */
  it('refuses to send more than the shelf holds, and leaves the draft a draft', async () => {
    const held = await balanceOf(fridge, 'AVAILABLE');

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: fridge,
      lines: [{ productId: product, batchId: lot, quantity: String(held + 1000) }],
    });

    await expect(dispatchTransfer(senderCtx, draft.id)).rejects.toThrow();
    expect(await legsFor(draft.id)).toBe(0);
    expect((await getTransfer(senderCtx, draft.id)).status).toBe('DRAFT');
    expect(await balanceOf(fridge, 'AVAILABLE')).toBe(held);
  });

  /**
   * ⚠️ AND THE WHOLE DISPATCH ROLLS BACK, NOT JUST THE BAD LINE. This is the
   *   atomicity assertion PI-3.7 names: a transfer whose first leg committed and
   *   whose second did not is stock that has left one shelf and arrived nowhere,
   *   under a document that says it is on its way.
   */
  it('rolls the whole dispatch back when one line of several cannot go', async () => {
    await stockUp(senderCtx, org.branchId, pharmacy, product, lot, '5');
    const beforePharmacy = await balanceOf(pharmacy, 'AVAILABLE');
    const beforeUntracked = await balanceOf(pharmacy, 'AVAILABLE', untracked);

    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [
        // This one could go.
        { productId: product, batchId: lot, quantity: '1' },
        // This one cannot: there is none of it on this shelf at all.
        { productId: untracked, quantity: '999' },
      ],
    });

    await expect(dispatchTransfer(senderCtx, draft.id)).rejects.toThrow();

    expect(await legsFor(draft.id)).toBe(0);
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(beforePharmacy);
    expect(await balanceOf(pharmacy, 'AVAILABLE', untracked)).toBe(beforeUntracked);
    expect((await getTransfer(senderCtx, draft.id)).status).toBe('DRAFT');
  });

  /**
   * ⚠️ NOT FOUND, NOT FORBIDDEN — the rule the whole codebase follows. A branch
   *   outside the caller's scope is invisible to RLS anyway, so a 403 would
   *   confirm to somebody probing that the id is real.
   */
  it('is invisible to a sender who does not work at the sending branch', async () => {
    await expect(
      createTransfer(receiverCtx, {
        fromBranchId: org.branchId,
        toBranchId: branchTwo,
        fromLocationId: pharmacy,
        lines: [{ productId: product, batchId: lot, quantity: '1' }],
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('the receipt bugs the review found', () => {
  let transferId: string;
  let lineId: string;

  beforeAll(async () => {
    await stockUp(senderCtx, org.branchId, pharmacy, product, lot, '40');
    const draft = await createTransfer(senderCtx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: product, batchId: lot, quantity: '10' }],
    });
    transferId = draft.id;
    await dispatchTransfer(senderCtx, draft.id);
    lineId = (await getTransfer(receiverCtx, transferId)).lines[0]?.id ?? '';
  });

  /**
   * ⚠️ THE ONE THAT MINTED STOCK, AND NOTHING ELSE WOULD HAVE CAUGHT IT. The
   *   service read each line's outstanding quantity from the transfer it loaded
   *   ONCE, so two entries naming one line both measured themselves against the
   *   same untouched value: both passed the over-receipt check, both wrote a
   *   `TRANSFER_IN` leg, and the row recorded only the last. Ten units sent
   *   became twenty received, the document read fully received with nothing
   *   outstanding, and `stock_transfer_lines_quantities_sane` was satisfied
   *   throughout because the ROW never held more than was sent.
   *
   *   `verifyBalances()` agreed with the inflated figure, because both legs are
   *   genuine ledger rows. The contract refuses the duplicate now; the service
   *   also accumulates per line, so neither layer is load-bearing alone.
   */
  it('refuses the same line twice, at the contract', () => {
    /*
     * The FIRST layer, and the one the route applies. Asserted against the
     * schema directly because these tests call services, not routes — the
     * `validate()` middleware is what runs this in production.
     */
    const parsed = receiveStockTransferRequest.safeParse({
      toLocationId: farStore,
      lines: [
        { lineId, quantityBase: '10' },
        { lineId, quantityBase: '10' },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/each line may appear once/i);
  });

  it('refuses the same line twice in the SERVICE too, having accumulated it', async () => {
    /*
     * ⚠️ THE SECOND LAYER, AND THE ONE THAT MATTERS. A caller that reaches the
     *   service without the contract — a later phase, an import, a test — must
     *   not be able to mint stock. The loop now tracks what each line has taken
     *   IN THIS REQUEST, so the second entry sees 0 outstanding and is refused
     *   as an over-receipt rather than sailing past a stale reading.
     */
    const before = await balanceOf(farStore, 'AVAILABLE');

    await expect(
      receiveTransfer(receiverCtx, transferId, {
        toLocationId: farStore,
        lines: [
          { lineId, quantityBase: '10' },
          { lineId, quantityBase: '10' },
        ],
      })
    ).rejects.toThrow(/0 pc still outstanding/i);

    // And the whole receipt rolled back — no half-applied first entry.
    expect(await balanceOf(farStore, 'AVAILABLE')).toBe(before);
    const detail = await getTransfer(receiverCtx, transferId);
    expect(detail.lines[0]?.receivedQuantityBase).toBe('0');
    expect(detail.status).toBe('DISPATCHED');
  });

  /**
   * ⚠️ THE DELIVERY NOTE HAS TO BE READABLE BY THE PERSON SIGNING IT. `batches`
   *   is branch-scoped, so the line's batch JOIN resolves to NULL for the
   *   receiver — the same shape as the location bug, one level down. Reading the
   *   join rather than the line's own snapshot rendered "no lot number, no
   *   expiry" for the one person who checks them against the pack.
   */
  it('shows the receiver the lot number and expiry, from the snapshot', async () => {
    const line = (await getTransfer(receiverCtx, transferId)).lines[0];

    expect(line?.lotNumber).toBe('MOV-LOT-1');
    expect(line?.expiresOn).toBe('2029-12-31');
  });

  /**
   * ⚠️ A DEVICE FITTED TO A PATIENT BETWEEN DRAFT AND DISPATCH. `assignSerial`
   *   writes NO ledger movement — the quantity stays in AVAILABLE — and
   *   `recordMovementIn`'s serial read selects neither the patient link nor the
   *   status, so nothing downstream notices. Without the re-check, receipt moved
   *   `serials.branch_id` and carried a PHI-bearing row into the receiving
   *   branch's RLS scope. Draft-time validation alone cannot see it: the two
   *   moments are days apart.
   */
  it('refuses to send a serial that was fitted to a patient after drafting', async () => {
    const serialProduct = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES (gen_random_uuid(), $1, 'IMPLANT', 'ACTIVE', 'MOV-DEV', 'Mov Device', $2, 'SERIAL', now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    const deviceId = serialProduct.rows[0]?.id ?? '';

    const serial = await createSerial(ctx, {
      branchId: org.branchId,
      productId: deviceId,
      serialNumber: 'MOV-SER-PHI',
    });

    await recordMovement(ctx, {
      branchId: org.branchId,
      productId: deviceId,
      serialId: serial.id,
      movementType: 'RETURN',
      quantity: '1',
      locationId: pharmacy,
      referenceType: 'MANUAL',
    });

    const draft = await createTransfer(ctx, {
      fromBranchId: org.branchId,
      toBranchId: branchTwo,
      fromLocationId: pharmacy,
      lines: [{ productId: deviceId, serialId: serial.id, quantity: '1' }],
    });

    // Fitted AFTER the draft was accepted — which the draft-time check cannot see.
    const patient = await owner.query<{ id: string }>(
      `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, updated_at)
       VALUES (gen_random_uuid(), $1, 'MOV-UHID-1', 'Movtest', 'Patientfixture', now())
       RETURNING id`,
      [org.organizationId]
    );
    await owner.query(
      `UPDATE serials SET assigned_patient_id = $1, assigned_at = now(), status = 'ISSUED'
        WHERE id = $2`,
      [patient.rows[0]?.id, serial.id]
    );

    await expect(dispatchTransfer(ctx, draft.id)).rejects.toThrow(/issued to a patient/i);
    expect(await legsFor(draft.id)).toBe(0);

    // ⚠️ AND THE REFUSAL NAMES THE DEVICE, NEVER THE PATIENT.
    await expect(dispatchTransfer(ctx, draft.id)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Movtest') })
    );

    await owner.query('DELETE FROM stock_transfer_lines WHERE transfer_id = $1', [draft.id]);
    await owner.query('DELETE FROM stock_transfers WHERE id = $1', [draft.id]);
    await owner.query('DELETE FROM stock_ledger WHERE serial_id = $1', [serial.id]);
    await owner.query('DELETE FROM stock_balances WHERE serial_id = $1', [serial.id]);
    await owner.query('DELETE FROM serials WHERE id = $1', [serial.id]);
    await owner.query('DELETE FROM patients WHERE id = $1', [patient.rows[0]?.id]);
    await owner.query('DELETE FROM products WHERE id = $1', [deviceId]);
  });
});

/* ------------------------------------------------------------------ *
 * Reservations (PI-3.4)
 * ------------------------------------------------------------------ */

describe('reserving stock', () => {
  let reservationId: string;

  const inThreeDays = (): string => new Date(Date.now() + 3 * 86_400_000).toISOString();

  it('moves the quantity out of available and into reserved', async () => {
    await stockUp(ctx, org.branchId, pharmacy, product, lot, '50');
    const beforeAvailable = await balanceOf(pharmacy, 'AVAILABLE');

    const reservation = await reserveStock(ctx, {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      locationId: pharmacy,
      quantity: '20',
      expiresAt: inThreeDays(),
      referenceType: 'MANUAL',
    });
    reservationId = reservation.id;

    expect(reservation.status).toBe('ACTIVE');
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(beforeAvailable - 20);
    expect(await balanceOf(pharmacy, 'RESERVED')).toBe(20);
  });

  /**
   * ⚠️ THE POINT OF THE WHOLE TABLE: RESERVED STOCK IS NOT ALLOCATABLE. Only
   *   `AVAILABLE` is, which is what stops two pharmacists dispensing the same
   *   last strip — and the allocation plan is where that becomes visible.
   */
  it('takes the reserved quantity out of what allocation will offer', async () => {
    const available = await balanceOf(pharmacy, 'AVAILABLE');

    const plan = await planStockAllocation(ctx, {
      branchId: org.branchId,
      productId: product,
      locationId: pharmacy,
      quantity: String(available + 20),
    });

    // It can offer what is available and no more — the reserved 20 is not in it.
    expect(Number(plan.allocatedQuantityBase)).toBe(available);
    expect(Number(plan.shortfallQuantityBase)).toBe(20);
    expect(plan.strategy).toBe('FEFO');
    expect(plan.strategySource).toBe('DEFAULT');
  });

  it('refuses to hold more than the shelf has', async () => {
    const available = await balanceOf(pharmacy, 'AVAILABLE');

    await expect(
      reserveStock(ctx, {
        branchId: org.branchId,
        productId: product,
        batchId: lot,
        locationId: pharmacy,
        quantity: String(available + 1),
        expiresAt: inThreeDays(),
        referenceType: 'MANUAL',
      })
    ).rejects.toThrow();
  });

  /**
   * ⚠️ A HOLD NOBODY REMEMBERS IS A MEDICINE THE CLINIC CAN SEE AND CANNOT
   *   DISPENSE, WITH NO ERROR ANYWHERE. The cap is what stops one being created.
   */
  it('refuses a hold longer than the cap, and one that has already run out', async () => {
    const base = {
      branchId: org.branchId,
      productId: product,
      batchId: lot,
      locationId: pharmacy,
      quantity: '1',
      referenceType: 'MANUAL' as const,
    };

    await expect(
      reserveStock(ctx, {
        ...base,
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      })
    ).rejects.toThrow(/at most/i);

    await expect(
      reserveStock(ctx, { ...base, expiresAt: new Date(Date.now() - 60_000).toISOString() })
    ).rejects.toThrow(/in the past/i);
  });

  it('gives it back, with the movement and the row committing together', async () => {
    const beforeAvailable = await balanceOf(pharmacy, 'AVAILABLE');

    const released = await releaseReservation(ctx, reservationId, {});

    expect(released.status).toBe('RELEASED');
    expect(released.releasedAt).not.toBeNull();
    // ⚠️ A PERSON did it, so the actor is recorded. NULL there means the sweep.
    expect(released.releasedByName).not.toBeNull();
    expect(await balanceOf(pharmacy, 'AVAILABLE')).toBe(beforeAvailable + 20);
    expect(await balanceOf(pharmacy, 'RESERVED')).toBe(0);
  });

  it('refuses to release the same hold twice', async () => {
    await expect(releaseReservation(ctx, reservationId, {})).rejects.toThrow(/already released/i);
  });

  it('lists what is being held, and excludes what is not', async () => {
    const active = await listReservations(ctx, { status: 'ACTIVE', page: 1, limit: 50 });
    expect(active.reservations.map((r) => r.id)).not.toContain(reservationId);

    const released = await listReservations(ctx, { status: 'RELEASED', page: 1, limit: 50 });
    expect(released.reservations.map((r) => r.id)).toContain(reservationId);
  });

  it('leaves the ledger and the cache agreeing, after everything above', async () => {
    const report = await verifyBalances(ctx, {});
    expect(report.discrepancies).toHaveLength(0);
  });
});
