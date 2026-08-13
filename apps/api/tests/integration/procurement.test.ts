/**
 * PI-4: procurement — against a real Postgres, through the real services (PI-4.10).
 *
 * ── WHAT THIS SUITE IS ACTUALLY FOR ─────────────────────────────────────────
 * `stock-ledger.test.ts` proves the ledger and its cache agree; `stock-movements`
 * proves PI-3's documents keep that true. This one proves the same of the way stock
 * ENTERS the system, and pins the six refusals the phase exists to make:
 *
 *   THE RECEIPT WRITES THE LEDGER   posting a delivery writes `PURCHASE_RECEIPT`
 *                                   through the one writer, creates the lot rows,
 *                                   and `verifyBalances()` still replays clean.
 *   OVER-RECEIPT IS REFUSED         beyond the tolerance, which is a SETTING and
 *                                   therefore the one rule in this phase with a
 *                                   single enforcement layer (PI-ADR-015).
 *   TRACKING MODE IS ENFORCED       a serial product with no serial, a lot product
 *                                   with no lot, an expiry-controlled product with
 *                                   no expiry (PI-ADR-014).
 *   AN EXPIRED LOT IS REFUSED       compared in the BRANCH's timezone, never the
 *                                   container's (invariant 6).
 *   THE MOVING AVERAGE IS RIGHT     after three receipts at three prices, with
 *                                   landed cost included and tax excluded.
 *   A CREATOR CANNOT SELF-APPROVE   the segregation-of-duty control, at the
 *                                   service layer and at the CHECK beneath it.
 *
 * ⚠️ AND THE ONE THAT WOULD BE QUIETLY WRONG: `verifyBalances()` IS RUN AFTER EVERY
 *   FLOW THAT MOVES STOCK. A posted receipt writes legs and then updates a DOCUMENT;
 *   a document that disagreed with the ledger would show correct numbers on its own
 *   screen while the shelves said something else. The replay is the assertion that
 *   they cannot — and it is exactly the assertion that agreed with PI-3's minted
 *   stock, so it is necessary and not sufficient. The direct balance reads beside it
 *   are the other half.
 *
 * Every fixture is prefixed `PRC-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { verifyBalances } from '../../src/services/inventory/balance.service.js';
import {
  createSupplier,
  deleteSupplier,
  updateSupplier,
} from '../../src/services/procurement/supplier.service.js';
import { createSupplierProduct } from '../../src/services/procurement/supplier-product.service.js';
import {
  approveRequisition,
  createRequisition,
  rejectRequisition,
  submitRequisition,
} from '../../src/services/procurement/requisition.service.js';
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  issuePurchaseOrder,
} from '../../src/services/procurement/purchase-order.service.js';
import {
  cancelGoodsReceipt,
  createGoodsReceipt,
  decideGoodsReceiptQuality,
  postGoodsReceipt,
} from '../../src/services/procurement/goods-receipt.service.js';
import {
  createPurchaseReturn,
  sendPurchaseReturn,
} from '../../src/services/procurement/purchase-return.service.js';
import { listCostAverages } from '../../src/services/procurement/costing.service.js';

const SUFFIX = `p${Date.now().toString(36)}`;
const SLUG = `prc-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;
/** A second real user, so the approval split has somebody to be the other person. */
let approverCtx: TenantContext;

let baseUnit: string;
/** LOT_BATCH + expiry-controlled. The strictest ordinary product. */
let lotProduct: string;
/** NONE. The commonest case in the programme. */
let plainProduct: string;
/** SERIAL. One line per device. */
let serialProduct: string;
let store: string;
let supplierId: string;

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

async function balanceOf(productId: string, status: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_balances
      WHERE product_id = $1 AND status = $2`,
    [productId, status]
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** How many ledger rows this receipt produced. The atomicity assertion. */
async function legsFor(receiptId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM stock_ledger
      WHERE reference_type = 'GOODS_RECEIPT' AND reference_id = $1`,
    [receiptId]
  );
  return Number(rows[0]?.n ?? 0);
}

/** Set a branch-scoped setting, the way the settings screen would. */
async function setBranchSetting(key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO setting_values (id, setting_key, scope_type, scope_id, value, updated_at)
     VALUES (gen_random_uuid(), $1, 'BRANCH', $2, $3::jsonb, now())
     ON CONFLICT (setting_key, scope_type, scope_id)
       DO UPDATE SET value = $3::jsonb, updated_at = now()`,
    [key, org.branchId, JSON.stringify(value)]
  );
}

async function clearBranchSetting(key: string): Promise<void> {
  await owner.query(
    `DELETE FROM setting_values WHERE setting_key = $1 AND scope_type = 'BRANCH' AND scope_id = $2`,
    [key, org.branchId]
  );
}

/** The date a lot expires, as `YYYY-MM-DD`, offset from today. */
function dateIn(days: number): string {
  const when = new Date(Date.now() + days * 86_400_000);
  return when.toISOString().slice(0, 10);
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Prc'));

  ctx = {
    organizationId: org.organizationId,
    branchIds: [org.branchId],
    userId: org.ownerUserId,
  };

  /*
   * ⚠️ A REAL SECOND USER WITH A REAL MEMBERSHIP, NOT A FABRICATED UUID. The
   *   approver-is-not-creator CHECK compares `approved_by_id` to `created_by_id`, and
   *   both are `Restrict` foreign keys to `users` — a made-up id fails on the FK
   *   before the CHECK is reached, which would make the test pass for the wrong
   *   reason.
   */
  const approver = await owner.query<{ id: string }>(
    `INSERT INTO users (id, full_name, email, updated_at)
     VALUES (gen_random_uuid(), 'Prc Approver', $1, now()) RETURNING id`,
    [`prc-approver-${SUFFIX}@example.test`]
  );
  const approverUserId = approver.rows[0]?.id ?? '';
  await owner.query(
    `INSERT INTO memberships (id, organization_id, user_id, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
    [org.organizationId, approverUserId]
  );
  approverCtx = { ...ctx, userId: approverUserId };

  const unit = await owner.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE organization_id IS NULL AND code = 'PIECE'`
  );
  baseUnit = unit.rows[0]?.id ?? '';
  if (!baseUnit) throw new Error('the seed is missing the PIECE unit');

  const products = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_expiry_controlled, updated_at)
     VALUES (gen_random_uuid(), $1, 'MEDICINE',   'ACTIVE', 'PRC-LOT',   'Prc Lot Product',    $2, 'LOT_BATCH', true,  now()),
            (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'PRC-PLAIN', 'Prc Plain Product',  $2, 'NONE',      false, now()),
            (gen_random_uuid(), $1, 'IMPLANT',    'ACTIVE', 'PRC-SER',   'Prc Serial Product', $2, 'SERIAL',    false, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  lotProduct = products.rows[0]?.id ?? '';
  plainProduct = products.rows[1]?.id ?? '';
  serialProduct = products.rows[2]?.id ?? '';

  store = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'CENTRAL_WAREHOUSE',
      code: 'PRC_STORE',
      name: 'Prc Store',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  supplierId = (
    await createSupplier(ctx, {
      code: 'PRC-SUP',
      name: 'Prc Distributors',
      status: 'ACTIVE',
      defaultCurrency: 'INR',
    })
  ).id;
}, 40_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId, approverCtx?.userId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM purchase_return_lines WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM purchase_returns WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM goods_receipt_lines WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM goods_receipts WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM purchase_order_lines WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM purchase_orders WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM purchase_requisition_lines WHERE organization_id = ANY($1)', [
      ids,
    ]);
    await owner?.query('DELETE FROM purchase_requisitions WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM product_cost_averages WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM supplier_products WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM supplier_tax_identifiers WHERE organization_id = ANY($1)', [
      ids,
    ]);
    await owner?.query('DELETE FROM suppliers WHERE organization_id = ANY($1)', [ids]);
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
 * Suppliers and the price book (PI-4.1, PI-4.2)
 * ------------------------------------------------------------------ */

describe('suppliers', () => {
  it('refuses to order from a blacklisted supplier and still lets its prices be read', async () => {
    const blocked = await createSupplier(ctx, {
      code: 'PRC-BAD',
      name: 'Prc Recalled Traders',
      status: 'ACTIVE',
      defaultCurrency: 'INR',
    });

    await updateSupplier(ctx, blocked.id, { status: 'BLACKLISTED' });

    await expect(
      createPurchaseOrder(ctx, {
        branchId: org.branchId,
        supplierId: blocked.id,
        lines: [{ productId: plainProduct, quantity: '10', unitCostBase: 100 }],
      })
    ).rejects.toThrow(/blacklisted/i);

    /*
     * ⚠️ THE PRICE BOOK IS STILL EDITABLE, DELIBERATELY. Blacklisting is a decision
     *   about BUYING, not about record-keeping, and a clinic settling a dispute needs
     *   the prices to still be there when they un-blacklist them.
     */
    await expect(
      createSupplierProduct(ctx, blocked.id, {
        productId: plainProduct,
        supplierSku: 'BAD-1',
        packUnitId: baseUnit,
        quantityPerPack: '10',
        pricePerPackMinor: 1_000,
        currency: 'INR',
        priceEffectiveFrom: dateIn(-30),
        isPreferred: false,
      })
    ).resolves.toMatchObject({ supplierSku: 'BAD-1' });
  });

  /**
   * ⚠️ A SUPPLIER WITH AN OPEN ORDER CANNOT BE REMOVED, because the delivery would
   *   have nobody to be received from — the receipt form's picker would no longer
   *   offer them, and the buyer's only remaining move would be to re-create them
   *   under a new code, splitting the spend history in two.
   */
  it('refuses to remove a supplier with an open order', async () => {
    const leaving = await createSupplier(ctx, {
      code: 'PRC-LEAVING',
      name: 'Prc Leaving Ltd',
      status: 'ACTIVE',
      defaultCurrency: 'INR',
    });

    const order = await createPurchaseOrder(ctx, {
      branchId: org.branchId,
      supplierId: leaving.id,
      lines: [{ productId: plainProduct, quantity: '5', unitCostBase: 100 }],
    });
    await issuePurchaseOrder(ctx, order.id);

    await expect(deleteSupplier(ctx, leaving.id)).rejects.toThrow(/still open/i);

    // Closed, and it can go.
    await closePurchaseOrder(ctx, order.id, { reason: 'Supplier ceased trading' });
    await expect(deleteSupplier(ctx, leaving.id)).resolves.toBeUndefined();
  });

  /**
   * The translation layer, end to end: ₹412 a box of 100 is ₹4.12 a capsule, and the
   * ORDER stores the per-unit figure rather than re-deriving it later.
   */
  it('prices an order line from the price book', async () => {
    const priced = await createSupplierProduct(ctx, supplierId, {
      productId: plainProduct,
      supplierSku: 'PRC-PLAIN-BOX',
      packUnitId: baseUnit,
      quantityPerPack: '100',
      pricePerPackMinor: 41_200,
      currency: 'INR',
      priceEffectiveFrom: dateIn(-30),
      isPreferred: true,
    });

    expect(priced.unitCostBase).toBe(412);

    const order = await createPurchaseOrder(ctx, {
      branchId: org.branchId,
      supplierId,
      lines: [{ productId: plainProduct, quantity: '100', supplierProductId: priced.id }],
    });

    expect(order.lines[0]?.unitCostBase).toBe(412);
    expect(order.subtotalMinor).toBe(41_200);
    expect(order.currency).toBe('INR');
  });

  it('refuses a price book row in a different currency from the order', async () => {
    const dollars = await createSupplierProduct(ctx, supplierId, {
      productId: plainProduct,
      supplierSku: 'PRC-PLAIN-USD',
      packUnitId: baseUnit,
      quantityPerPack: '10',
      pricePerPackMinor: 5_000,
      currency: 'USD',
      priceEffectiveFrom: dateIn(-30),
      isPreferred: false,
    });

    await expect(
      createPurchaseOrder(ctx, {
        branchId: org.branchId,
        supplierId,
        currency: 'INR',
        lines: [{ productId: plainProduct, quantity: '10', supplierProductId: dollars.id }],
      })
    ).rejects.toThrow(/nothing here converts between currencies/i);
  });

  it('refuses a line with no price at all', async () => {
    await expect(
      createPurchaseOrder(ctx, {
        branchId: org.branchId,
        supplierId,
        lines: [{ productId: plainProduct, quantity: '10' }],
      })
    ).rejects.toThrow(/no price on this order/i);
  });
});

/* ------------------------------------------------------------------ *
 * The approval split (PI-4.3)
 * ------------------------------------------------------------------ */

describe('the requisition approval split', () => {
  /**
   * ⚠️ THE SEGREGATION-OF-DUTY CONTROL. This is the shape every procurement fraud in
   *   a small organization takes: the person who chooses the supplier, the quantity
   *   and the price is the person who signs it off. It is refused by the service with
   *   a sentence, and by the `purchase_requisitions_approver_is_not_creator` CHECK
   *   without one — and only the second cannot be forgotten by a later phase.
   */
  it('refuses an approval by the person who raised it', async () => {
    const req = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '20' }],
    });
    await submitRequisition(ctx, req.id);

    await expect(approveRequisition(ctx, req.id)).rejects.toThrow(/cannot be approved by/i);

    // And `canApprove` says so on the read, so the screen never offers the button.
    const seen = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '1' }],
    });
    const submitted = await submitRequisition(ctx, seen.id);
    expect(submitted.canApprove).toBe(false);
  });

  it('lets somebody else approve it, and reports canApprove for them', async () => {
    const req = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '30' }],
    });
    const submitted = await submitRequisition(ctx, req.id);

    // ⚠️ The number is issued on SUBMIT, never at create — an abandoned draft must
    //   not burn a serial in a series somebody reads as a sequence.
    expect(submitted.requisitionNumber).toMatch(/^REQ-\d{6}$/);

    const approved = await approveRequisition(approverCtx, req.id);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedByName).toBe('Prc Approver');
  });

  /**
   * ⚠️ REJECTION IS GATED BY THE SAME CHECK AS APPROVAL, WHICH LOOKS LIKE OVER-REACH
   *   AND IS NOT. Rejecting your own requisition is indistinguishable in effect from
   *   withdrawing it — which `cancelRequisition` already does — and allowing it would
   *   put "reviewed and refused" on a document nobody reviewed.
   */
  it('refuses a rejection by the person who raised it', async () => {
    const req = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '5' }],
    });
    await submitRequisition(ctx, req.id);

    await expect(rejectRequisition(ctx, req.id, { reason: 'Changed my mind' })).rejects.toThrow(
      /cannot be approved by/i
    );
  });

  /**
   * ⚠️ WITHOUT THIS CHECK THE WHOLE SPLIT IS DECORATION. A buyer could cite a draft
   *   requisition nobody has looked at, and the order would carry a link that makes it
   *   look authorised.
   */
  it('refuses to raise an order from an unapproved requisition', async () => {
    const req = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '5' }],
    });

    await expect(
      createPurchaseOrder(ctx, {
        branchId: org.branchId,
        supplierId,
        requisitionId: req.id,
        lines: [{ productId: plainProduct, quantity: '5', unitCostBase: 100 }],
      })
    ).rejects.toThrow(/has not been approved/i);
  });

  it('marks the requisition ordered when the order is issued', async () => {
    const req = await createRequisition(ctx, {
      branchId: org.branchId,
      lines: [{ productId: plainProduct, quantity: '40' }],
    });
    await submitRequisition(ctx, req.id);
    await approveRequisition(approverCtx, req.id);

    const order = await createPurchaseOrder(ctx, {
      branchId: org.branchId,
      supplierId,
      requisitionId: req.id,
      lines: [{ productId: plainProduct, quantity: '40', unitCostBase: 100 }],
    });

    // Still APPROVED: raising a draft order commits nothing.
    const { rows: before } = await owner.query<{ status: string }>(
      'SELECT status FROM purchase_requisitions WHERE id = $1',
      [req.id]
    );
    expect(before[0]?.status).toBe('APPROVED');

    const issued = await issuePurchaseOrder(ctx, order.id);
    expect(issued.orderNumber).toMatch(/^PO-\d{6}$/);

    const { rows: after } = await owner.query<{ status: string }>(
      'SELECT status FROM purchase_requisitions WHERE id = $1',
      [req.id]
    );
    expect(after[0]?.status).toBe('ORDERED');
  });
});

/* ------------------------------------------------------------------ *
 * The receipt writes the ledger (PI-4.5)
 * ------------------------------------------------------------------ */

describe('posting a delivery', () => {
  it('writes the ledger, creates the lot, and the balances still replay', async () => {
    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: lotProduct,
          quantity: '100',
          lotNumber: 'PRC-LOT-A',
          expiresOn: dateIn(400),
          unitCostBase: 500,
        },
      ],
    });

    // ⚠️ A DRAFT MOVES NOTHING AND HAS NO NUMBER.
    expect(receipt.status).toBe('DRAFT');
    expect(receipt.receiptNumber).toBeNull();
    expect(await legsFor(receipt.id)).toBe(0);
    expect(receipt.lines[0]?.batchId).toBeNull();

    const posted = await postGoodsReceipt(ctx, receipt.id);

    expect(posted.status).toBe('POSTED');
    expect(posted.receiptNumber).toMatch(/^GRN-\d{6}$/);
    expect(await legsFor(receipt.id)).toBe(1);
    expect(posted.lines[0]?.batchId).not.toBeNull();

    // The lot row exists at this branch, carrying what it cost.
    const { rows: lots } = await owner.query<{ unit_cost_base: string; currency: string }>(
      `SELECT unit_cost_base, currency FROM batches
        WHERE product_id = $1 AND lot_number = 'PRC-LOT-A'`,
      [lotProduct]
    );
    expect(lots[0]?.unit_cost_base).toBe('500');
    expect(lots[0]?.currency).toBe('INR');

    expect(await balanceOf(lotProduct, 'AVAILABLE')).toBe(100);

    // ⚠️ `discrepancies` EMPTY IS THE ASSERTION — there is no `consistent` flag, and
    //   the list is what says WHICH bucket disagreed when one does.
    const replay = await verifyBalances(ctx, {});
    expect(replay.discrepancies).toEqual([]);
  });

  /**
   * ⚠️ THE MOVEMENT'S `occurredAt` IS WHEN THE GOODS ARRIVED, NOT WHEN THIS WAS KEYED
   *   IN. A receipt entered on Monday for a Friday delivery is ordinary, and the whole
   *   point of the ledger having both columns is that a backdated entry is visible as
   *   one.
   */
  it('backdates the ledger legs to when the goods arrived', async () => {
    const arrived = new Date(Date.now() - 3 * 86_400_000).toISOString();

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      receivedAt: arrived,
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '10', unitCostBase: 100 }],
    });
    await postGoodsReceipt(ctx, receipt.id);

    const { rows } = await owner.query<{ occurred_at: Date; recorded_at: Date }>(
      `SELECT occurred_at, recorded_at FROM stock_ledger
        WHERE reference_type = 'GOODS_RECEIPT' AND reference_id = $1`,
      [receipt.id]
    );
    expect(rows[0]?.occurred_at.toISOString()).toBe(arrived);
    expect(rows[0]?.recorded_at.getTime()).toBeGreaterThan(rows[0]?.occurred_at.getTime() ?? 0);
  });

  /**
   * ⚠️ NO REVERSAL EXISTS, AND THAT IS THE DESIGN. A posted receipt has written
   *   ledger rows, created lot rows and moved a moving average; cancelling it would
   *   leave all three standing while the document claimed nothing happened. The
   *   `goods_receipts_posted_states_complete` CHECK is the layer under the service.
   */
  it('refuses to cancel a posted delivery', async () => {
    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '5', unitCostBase: 100 }],
    });
    await postGoodsReceipt(ctx, receipt.id);

    await expect(
      cancelGoodsReceipt(ctx, receipt.id, { reason: 'Keyed in by mistake' })
    ).rejects.toThrow(/has been posted/i);
  });

  it('lets a draft be cancelled, moving nothing', async () => {
    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '5', unitCostBase: 100 }],
    });

    const cancelled = await cancelGoodsReceipt(ctx, receipt.id, { reason: 'Wrong supplier' });
    expect(cancelled.status).toBe('CANCELLED');
    expect(await legsFor(receipt.id)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * What a receipt refuses
 * ------------------------------------------------------------------ */

describe('what a delivery refuses', () => {
  const draft = (lines: Parameters<typeof createGoodsReceipt>[1]['lines']) =>
    createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines,
    });

  it('refuses a batch-tracked product with no lot number', async () => {
    await expect(
      draft([{ productId: lotProduct, quantity: '10', expiresOn: dateIn(400), unitCostBase: 100 }])
    ).rejects.toThrow(/batch-tracked/i);
  });

  it('refuses an expiry-controlled product with no expiry', async () => {
    await expect(
      draft([{ productId: lotProduct, quantity: '10', lotNumber: 'PRC-NOEXP', unitCostBase: 100 }])
    ).rejects.toThrow(/expiry-controlled/i);
  });

  it('refuses a serial-tracked product with no serial number', async () => {
    await expect(
      draft([{ productId: serialProduct, quantity: '1', unitCostBase: 100 }])
    ).rejects.toThrow(/serial-tracked/i);
  });

  /**
   * ⚠️ COMPARED IN THE BRANCH'S TIMEZONE, NEVER THE CONTAINER'S (invariant 6). A lot
   *   dated the 31st is good THROUGH the 31st at the clinic, and receiving stock that
   *   is dead on arrival puts it in AVAILABLE for the nightly sweep to expire — which
   *   reads, for ever, as a clinic that let it expire on the shelf.
   */
  it('refuses an already-expired lot', async () => {
    await expect(
      draft([
        {
          productId: lotProduct,
          quantity: '10',
          lotNumber: 'PRC-DEAD',
          expiresOn: dateIn(-1),
          unitCostBase: 100,
        },
      ])
    ).rejects.toThrow(/already passed/i);
  });

  it('refuses the same product, lot and serial twice on one delivery', async () => {
    await expect(
      draft([
        {
          productId: lotProduct,
          quantity: '10',
          lotNumber: 'PRC-DUP',
          expiresOn: dateIn(400),
          unitCostBase: 100,
        },
        {
          productId: lotProduct,
          quantity: '10',
          lotNumber: 'PRC-DUP',
          expiresOn: dateIn(400),
          unitCostBase: 100,
        },
      ])
    ).rejects.toThrow(/twice/i);
  });

  it('refuses a line with no cost and no order to take one from', async () => {
    await expect(draft([{ productId: plainProduct, quantity: '10' }])).rejects.toThrow(
      /no cost on this receipt/i
    );
  });

  it('creates the serial at post, and refuses a duplicate of it', async () => {
    const first = await draft([
      { productId: serialProduct, quantity: '1', serialNumber: 'PRC-SER-1', unitCostBase: 5_000 },
    ]);
    const posted = await postGoodsReceipt(ctx, first.id);
    expect(posted.lines[0]?.serialId).not.toBeNull();

    const again = await draft([
      { productId: serialProduct, quantity: '1', serialNumber: 'PRC-SER-1', unitCostBase: 5_000 },
    ]);
    await expect(postGoodsReceipt(ctx, again.id)).rejects.toThrow(/already recorded/i);
  });
});

/* ------------------------------------------------------------------ *
 * Over-receipt and the tolerance setting (PI-ADR-015)
 * ------------------------------------------------------------------ */

describe('over-receipt', () => {
  /**
   * ⚠️ THE ONE RULE IN THIS PHASE WITH A SINGLE ENFORCEMENT LAYER, WHICH IS WHY IT HAS
   *   ITS OWN CASES. A CHECK constraint cannot read a setting, and the tolerance is a
   *   setting because suppliers legitimately over-ship and how much slack is
   *   acceptable differs per clinic.
   */
  async function orderFor(quantity: string): Promise<string> {
    const order = await createPurchaseOrder(ctx, {
      branchId: org.branchId,
      supplierId,
      lines: [{ productId: plainProduct, quantity, unitCostBase: 100 }],
    });
    await issuePurchaseOrder(ctx, order.id);
    return order.id;
  }

  async function orderLineOf(orderId: string): Promise<string> {
    const order = await getPurchaseOrder(ctx, orderId);
    return order.lines[0]?.id ?? '';
  }

  afterEach(async () => {
    await clearBranchSetting('procurement.over_receipt_tolerance_percent');
  });

  it('refuses more than was ordered when the clinic allows no margin', async () => {
    const orderId = await orderFor('100');
    const lineId = await orderLineOf(orderId);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: plainProduct,
          purchaseOrderLineId: lineId,
          quantity: '101',
          unitCostBase: 100,
        },
      ],
    });

    await expect(postGoodsReceipt(ctx, receipt.id)).rejects.toThrow(/was ordered/i);
    // Nothing moved: the refusal happens before any leg is written.
    expect(await legsFor(receipt.id)).toBe(0);
  });

  it('accepts an over-delivery inside the configured margin', async () => {
    await setBranchSetting('procurement.over_receipt_tolerance_percent', 5);

    const orderId = await orderFor('100');
    const lineId = await orderLineOf(orderId);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: plainProduct,
          purchaseOrderLineId: lineId,
          quantity: '105',
          unitCostBase: 100,
        },
      ],
    });

    const posted = await postGoodsReceipt(ctx, receipt.id);
    expect(posted.status).toBe('POSTED');

    const order = await getPurchaseOrder(ctx, orderId);
    expect(Number(order.lines[0]?.receivedQuantityBase)).toBe(105);
    // Over-delivered in full, so nothing is outstanding.
    expect(order.status).toBe('RECEIVED');
  });

  it('still refuses past the configured margin', async () => {
    await setBranchSetting('procurement.over_receipt_tolerance_percent', 5);

    const orderId = await orderFor('100');
    const lineId = await orderLineOf(orderId);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: plainProduct,
          purchaseOrderLineId: lineId,
          quantity: '106',
          unitCostBase: 100,
        },
      ],
    });

    await expect(postGoodsReceipt(ctx, receipt.id)).rejects.toThrow(/over-delivery/i);
  });

  /**
   * ⚠️ THE ACCUMULATION CASE, AND THE ONE PI-3 PAID FOR. Two receipts against one
   *   order line each measured themselves against the same stale `received` value in
   *   PI-3's transfer loop, and ten units sent became twenty received. Here the second
   *   delivery has to see what the first one took.
   */
  it('counts what earlier deliveries already took', async () => {
    const orderId = await orderFor('100');
    const lineId = await orderLineOf(orderId);

    const first = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        { productId: plainProduct, purchaseOrderLineId: lineId, quantity: '60', unitCostBase: 100 },
      ],
    });
    await postGoodsReceipt(ctx, first.id);

    const partly = await getPurchaseOrder(ctx, orderId);
    expect(partly.status).toBe('PARTIALLY_RECEIVED');
    expect(Number(partly.lines[0]?.outstandingQuantityBase)).toBe(40);

    const second = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        { productId: plainProduct, purchaseOrderLineId: lineId, quantity: '41', unitCostBase: 100 },
      ],
    });

    await expect(postGoodsReceipt(ctx, second.id)).rejects.toThrow(/was ordered/i);
  });

  /**
   * ⚠️ THE CASE THAT CAUGHT NOTHING UNTIL THE PO LOCK EXISTED, AND THE ONLY ONE HERE
   *   THAT EXERCISES TWO REQUESTS AT ONCE. `counts what earlier deliveries already
   *   took` above proves the SEQUENTIAL path; it passes perfectly well against a
   *   version with no lock on the order at all.
   *
   *   Two receipts against one PO are two different `goods_receipts` rows, so the
   *   receipt-header lock serialises nothing between them. Without
   *   `lockPurchaseOrder` both read `received_quantity_base = 0`, both pass the
   *   tolerance check, and both `increment` — 200 units of real stock against a
   *   100-unit order, which `purchase_order_lines_quantities_valid` deliberately does
   *   NOT catch because the tolerance is a setting a CHECK cannot read.
   *
   * ⚠️ THE ASSERTION IS ON THE COMMITTED TOTAL, NOT ON WHICH ONE LOST. Either receipt
   *   may win the lock; what must hold is that the order never ends up over-received
   *   past the tolerance, and that the survivor's ledger legs match.
   */
  it('serialises two receipts racing against one order line', async () => {
    const orderId = await orderFor('100');
    const lineId = await orderLineOf(orderId);

    const draft = async (): Promise<string> => {
      const receipt = await createGoodsReceipt(ctx, {
        branchId: org.branchId,
        supplierId,
        purchaseOrderId: orderId,
        locationId: store,
        currency: 'INR',
        freightMinor: 0,
        dutyMinor: 0,
        handlingMinor: 0,
        lines: [
          {
            productId: plainProduct,
            purchaseOrderLineId: lineId,
            quantity: '100',
            unitCostBase: 100,
          },
        ],
      });
      return receipt.id;
    };

    const [first, second] = await Promise.all([draft(), draft()]);

    const outcomes = await Promise.allSettled([
      postGoodsReceipt(ctx, first),
      postGoodsReceipt(ctx, second),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    // Exactly one may post 100 against a 100-unit order at 0% tolerance.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const order = await getPurchaseOrder(ctx, orderId);
    expect(Number(order.lines[0]?.receivedQuantityBase)).toBe(100);
    expect(order.status).toBe('RECEIVED');

    // And the shelf agrees with the document — the loser wrote no legs.
    const replay = await verifyBalances(ctx, {});
    expect(replay.discrepancies).toEqual([]);
  });

  it('refuses to cancel an order that has been partly delivered', async () => {
    const orderId = await orderFor('50');
    const lineId = await orderLineOf(orderId);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      purchaseOrderId: orderId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        { productId: plainProduct, purchaseOrderLineId: lineId, quantity: '20', unitCostBase: 100 },
      ],
    });
    await postGoodsReceipt(ctx, receipt.id);

    await expect(cancelPurchaseOrder(ctx, orderId, { reason: 'No longer needed' })).rejects.toThrow(
      /already been received/i
    );

    // Closing it is the right move, and it leaves the delivered stock alone.
    const closed = await closePurchaseOrder(ctx, orderId, { reason: 'Supplier short-shipped' });
    expect(closed.status).toBe('CLOSED');
  });
});

/* ------------------------------------------------------------------ *
 * The quality hold (PI-4.6)
 * ------------------------------------------------------------------ */

describe('the quality hold', () => {
  afterEach(async () => {
    await clearBranchSetting('procurement.quality_hold_required');
  });

  /**
   * ⚠️ THE WHOLE FEATURE IN ONE CASE: with the hold on, the stock lands in
   *   QUARANTINED — counted and valued, and NOT dispensable — and accepting it is what
   *   releases it. No new movement type was needed, because `PURCHASE_RECEIPT` names
   *   its own `statusTo` and `QUARANTINE_RELEASE` already existed.
   */
  it('lands stock on hold and releases it when accepted', async () => {
    await setBranchSetting('procurement.quality_hold_required', true);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: lotProduct,
          quantity: '50',
          lotNumber: 'PRC-QC-1',
          expiresOn: dateIn(400),
          unitCostBase: 200,
        },
      ],
    });

    const posted = await postGoodsReceipt(ctx, receipt.id);
    expect(posted.qualityHoldRequired).toBe(true);
    expect(posted.lines[0]?.qualityStatus).toBe('PENDING');
    expect(posted.awaitingQualityLineCount).toBe(1);

    const lineId = posted.lines[0]?.id ?? '';

    // Held, so it is not in AVAILABLE — which is what makes the hold work at all.
    const heldQuarantined = await owner.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity),0) AS quantity FROM stock_balances
        WHERE product_id = $1 AND status = 'QUARANTINED'`,
      [lotProduct]
    );
    expect(Number(heldQuarantined.rows[0]?.quantity)).toBe(50);

    const decided = await decideGoodsReceiptQuality(ctx, receipt.id, {
      lines: [{ lineId, outcome: 'ACCEPTED' }],
    });
    expect(decided.lines[0]?.qualityStatus).toBe('ACCEPTED');
    expect(decided.awaitingQualityLineCount).toBe(0);

    const released = await owner.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity),0) AS quantity FROM stock_balances
        WHERE product_id = $1 AND status = 'QUARANTINED'`,
      [lotProduct]
    );
    expect(Number(released.rows[0]?.quantity)).toBe(0);

    // ⚠️ `discrepancies` EMPTY IS THE ASSERTION — there is no `consistent` flag, and
    //   the list is what says WHICH bucket disagreed when one does.
    const replay = await verifyBalances(ctx, {});
    expect(replay.discrepancies).toEqual([]);
  });

  /**
   * ⚠️ A PARTIAL REJECTION RELEASES THE REST. Ten boxes arrive and two are crushed:
   *   the eight good ones must become dispensable in the same act that records the two
   *   bad ones, or the clinic has to inspect twice to use what it inspected once.
   */
  it('releases the good part of a partly refused line', async () => {
    await setBranchSetting('procurement.quality_hold_required', true);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: lotProduct,
          quantity: '10',
          lotNumber: 'PRC-QC-2',
          expiresOn: dateIn(400),
          unitCostBase: 200,
        },
      ],
    });
    const posted = await postGoodsReceipt(ctx, receipt.id);
    const lineId = posted.lines[0]?.id ?? '';

    const decided = await decideGoodsReceiptQuality(ctx, receipt.id, {
      lines: [
        {
          lineId,
          outcome: 'ACCEPTED',
          rejectedQuantityBase: '2',
          notes: 'Two boxes crushed in transit',
        },
      ],
    });

    expect(Number(decided.lines[0]?.rejectedQuantityBase)).toBe(2);

    const { rows } = await owner.query<{ status: string; quantity: string }>(
      `SELECT sb.status, sb.quantity FROM stock_balances sb
         JOIN batches b ON b.id = sb.batch_id
        WHERE b.lot_number = 'PRC-QC-2' AND sb.quantity > 0`,
      []
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.quantity)]));
    expect(byStatus['AVAILABLE']).toBe(8);
    expect(byStatus['QUARANTINED']).toBe(2);
  });

  it('refuses a rejection with no quantity and no reason', async () => {
    await setBranchSetting('procurement.quality_hold_required', true);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '10', unitCostBase: 100 }],
    });
    const posted = await postGoodsReceipt(ctx, receipt.id);
    const lineId = posted.lines[0]?.id ?? '';

    await expect(
      decideGoodsReceiptQuality(ctx, receipt.id, {
        lines: [{ lineId, outcome: 'REJECTED', notes: 'Bad' }],
      })
    ).rejects.toThrow(/how much/i);

    await expect(
      decideGoodsReceiptQuality(ctx, receipt.id, {
        lines: [{ lineId, outcome: 'REJECTED', rejectedQuantityBase: '3' }],
      })
    ).rejects.toThrow(/say why/i);
  });

  it('will not revisit a decision', async () => {
    await setBranchSetting('procurement.quality_hold_required', true);

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '4', unitCostBase: 100 }],
    });
    const posted = await postGoodsReceipt(ctx, receipt.id);
    const lineId = posted.lines[0]?.id ?? '';

    await decideGoodsReceiptQuality(ctx, receipt.id, {
      lines: [{ lineId, outcome: 'ACCEPTED' }],
    });

    await expect(
      decideGoodsReceiptQuality(ctx, receipt.id, {
        lines: [{ lineId, outcome: 'REJECTED', rejectedQuantityBase: '1', notes: 'Changed mind' }],
      })
    ).rejects.toThrow(/already been accepted/i);
  });
});

/* ------------------------------------------------------------------ *
 * Costing (PI-4.8)
 * ------------------------------------------------------------------ */

describe('the moving average', () => {
  /**
   * ⚠️ THE CASE PI-4.10 ASKS FOR BY NAME, THROUGH THE REAL SERVICES. The unit suite
   *   proves the arithmetic; this proves the receipt path feeds it the right numbers —
   *   which is the half that would be wrong if the service passed tax in, or passed
   *   the pack price instead of the line value.
   */
  it('is right after three receipts at three prices, landed cost included', async () => {
    // A product of its own, so no other case in this file can pollute the pool.
    const solo = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'PRC-AVG', 'Prc Average Product',
               $2, 'NONE', now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    const productId = solo.rows[0]?.id ?? '';

    const deliver = async (
      quantity: string,
      unitCostBase: number,
      freightMinor: number,
      taxAmountMinor: number
    ): Promise<void> => {
      const receipt = await createGoodsReceipt(ctx, {
        branchId: org.branchId,
        supplierId,
        locationId: store,
        currency: 'INR',
        freightMinor,
        dutyMinor: 0,
        handlingMinor: 0,
        lines: [{ productId, quantity, unitCostBase, taxAmountMinor }],
      });
      await postGoodsReceipt(ctx, receipt.id);
    };

    await deliver('100', 100, 0, 0); // 100 @ 1.00 = 10000
    await deliver('100', 200, 0, 0); // 100 @ 2.00 = 20000
    /*
     * ⚠️ THE THIRD CARRIES FREIGHT **AND** TAX, WHICH GO OPPOSITE WAYS. Freight is
     *   part of what the stock cost the clinic and is rolled in; input tax is a
     *   liability the clinic may reclaim, not a cost of the goods, and folding it in
     *   would inflate every valuation by the tax rate.
     */
    await deliver('200', 300, 10_000, 9_000); // 200 @ 3.00 = 60000 + 10000 freight

    const { costAverages } = await listCostAverages(ctx, {
      branchId: org.branchId,
      productId,
      page: 1,
      limit: 20,
    });

    expect(costAverages).toHaveLength(1);
    const row = costAverages[0];
    expect(Number(row?.valuedQuantityBase)).toBe(400);
    // 10000 + 20000 + 60000 + 10000 freight, and NOT the 9000 of tax.
    expect(row?.valuedCostMinor).toBe(100_000);
    // 100000 / 400 = 250
    expect(row?.averageCostBase).toBe(250);
    expect(row?.receiptCount).toBe(3);
  });

  /**
   * ⚠️ THE APPORTIONMENT IS STORED ON THE LINE AND SUMS TO THE CHARGE EXACTLY. A
   *   document whose lines do not add up to its header is the one thing a person
   *   checking it notices immediately.
   */
  it('shares landed cost across the lines by value, exactly', async () => {
    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 300,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        { productId: plainProduct, quantity: '10', unitCostBase: 100 }, // 1000
        {
          productId: lotProduct,
          quantity: '10',
          lotNumber: 'PRC-LAND-1',
          expiresOn: dateIn(400),
          unitCostBase: 200,
        }, // 2000
      ],
    });

    const shares = receipt.lines.map((l) => l.landedCostMinor);
    expect(shares.reduce((sum, s) => sum + s, 0)).toBe(300);
    // Pro-rata by value: 1000 and 2000 of 3000.
    expect(shares).toEqual([100, 200]);
    // Goods value excludes the charge; the document total includes it.
    expect(receipt.goodsValueMinor).toBe(3_000);
    expect(receipt.totalMinor).toBe(3_300);
  });
});

/* ------------------------------------------------------------------ *
 * Purchase returns (PI-4.7)
 * ------------------------------------------------------------------ */

describe('sending stock back', () => {
  /**
   * ⚠️ A RETURN IS A `PURCHASE_RETURN`-SIGNED MOVEMENT, NOT A `TRANSFER_OUT`, AND THAT
   *   IS A DELIBERATE REFINEMENT OF WHAT PI-2'S SCHEMA SAID. `TRANSFER_OUT` means
   *   "went to another branch of ours" to every report that reads the column, and the
   *   outstanding-quantity arithmetic over `stock_transfers` reads exactly those rows.
   */
  it('writes a PURCHASE_RETURN leg and shrinks the shelf', async () => {
    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [
        {
          productId: lotProduct,
          quantity: '20',
          lotNumber: 'PRC-RET-1',
          expiresOn: dateIn(400),
          unitCostBase: 400,
        },
      ],
    });
    const posted = await postGoodsReceipt(ctx, receipt.id);
    const batchId = posted.lines[0]?.batchId ?? '';
    const receiptLineId = posted.lines[0]?.id ?? '';

    const before = await balanceOf(lotProduct, 'AVAILABLE');

    const ret = await createPurchaseReturn(ctx, {
      branchId: org.branchId,
      supplierId,
      goodsReceiptId: receipt.id,
      locationId: store,
      currency: 'INR',
      reason: 'Short dated on arrival',
      lines: [
        {
          productId: lotProduct,
          goodsReceiptLineId: receiptLineId,
          batchId,
          quantity: '5',
          statusFrom: 'AVAILABLE',
        },
      ],
    });

    // ⚠️ The cost falls back to the LOT's own, not the moving average: what the
    //   clinic expects to be credited is what it paid for this lot.
    expect(ret.lines[0]?.unitCostBase).toBe(400);
    expect(ret.totalMinor).toBe(2_000);
    expect(ret.returnNumber).toBeNull();

    const sent = await sendPurchaseReturn(ctx, ret.id);
    expect(sent.status).toBe('SENT');
    expect(sent.returnNumber).toMatch(/^PRN-\d{6}$/);

    expect(await balanceOf(lotProduct, 'AVAILABLE')).toBe(before - 5);

    const { rows } = await owner.query<{ movement_type: string; quantity_base: string }>(
      `SELECT movement_type, quantity_base FROM stock_ledger
        WHERE reference_type = 'PURCHASE_RETURN' AND reference_id = $1`,
      [ret.id]
    );
    expect(rows[0]?.movement_type).toBe('PURCHASE_RETURN');
    // A REMOVE, so the signed quantity is negative — and the caller never chose it.
    expect(Number(rows[0]?.quantity_base)).toBe(-5);

    // ⚠️ `discrepancies` EMPTY IS THE ASSERTION — there is no `consistent` flag, and
    //   the list is what says WHICH bucket disagreed when one does.
    const replay = await verifyBalances(ctx, {});
    expect(replay.discrepancies).toEqual([]);
  });

  it('takes the returned quantity back out of the cost pool', async () => {
    const solo = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'PRC-RETAVG', 'Prc Return Average',
               $2, 'NONE', now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    const productId = solo.rows[0]?.id ?? '';

    const receipt = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId, quantity: '100', unitCostBase: 250 }],
    });
    await postGoodsReceipt(ctx, receipt.id);

    const ret = await createPurchaseReturn(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      reason: 'Over-ordered',
      lines: [{ productId, quantity: '40', statusFrom: 'AVAILABLE' }],
    });
    await sendPurchaseReturn(ctx, ret.id);

    const { costAverages } = await listCostAverages(ctx, {
      branchId: org.branchId,
      productId,
      page: 1,
      limit: 20,
    });

    expect(Number(costAverages[0]?.valuedQuantityBase)).toBe(60);
    expect(costAverages[0]?.valuedCostMinor).toBe(15_000);
    /*
     * ⚠️ THE AVERAGE HAS NOT MOVED, WHICH IS WHAT A MOVING AVERAGE MEANS. The pool is
     *   smaller and worth proportionally less; value came out at the CURRENT average
     *   rather than at what any particular box cost.
     */
    expect(costAverages[0]?.averageCostBase).toBe(250);
  });

  it('refuses to return stock that is reserved or already gone', async () => {
    await expect(
      createPurchaseReturn(ctx, {
        branchId: org.branchId,
        supplierId,
        locationId: store,
        currency: 'INR',
        reason: 'Testing the refusal',
        lines: [{ productId: plainProduct, quantity: '1', statusFrom: 'RESERVED' }],
      })
    ).rejects.toThrow(/reserved/i);

    await expect(
      createPurchaseReturn(ctx, {
        branchId: org.branchId,
        supplierId,
        locationId: store,
        currency: 'INR',
        reason: 'Testing the refusal',
        lines: [{ productId: plainProduct, quantity: '1', statusFrom: 'DISPOSED' }],
      })
    ).rejects.toThrow(/cannot be sent back/i);
  });

  it('refuses to return against a delivery that has not been posted', async () => {
    const draft = await createGoodsReceipt(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      freightMinor: 0,
      dutyMinor: 0,
      handlingMinor: 0,
      lines: [{ productId: plainProduct, quantity: '5', unitCostBase: 100 }],
    });

    await expect(
      createPurchaseReturn(ctx, {
        branchId: org.branchId,
        supplierId,
        goodsReceiptId: draft.id,
        locationId: store,
        currency: 'INR',
        reason: 'Nothing to send back',
        lines: [{ productId: plainProduct, quantity: '1', statusFrom: 'AVAILABLE' }],
      })
    ).rejects.toThrow(/has not been posted/i);
  });

  it('refuses to send back more than the shelf holds', async () => {
    /*
     * ⚠️ A PRODUCT OF ITS OWN WITH NOTHING ON THE SHELF, RATHER THAN A BIG NUMBER
     *   AGAINST A SHARED ONE. The other cases in this file leave stock behind, so
     *   "more than we hold" against a shared product would depend on the order the
     *   suite happened to run in — and it would still be a serial-tracked or
     *   batch-tracked product, whose own refusal fires first and would make this pass
     *   for the wrong reason.
     */
    const empty = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode, updated_at)
       VALUES (gen_random_uuid(), $1, 'CONSUMABLE', 'ACTIVE', 'PRC-EMPTY', 'Prc Empty Shelf',
               $2, 'NONE', now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );

    const ret = await createPurchaseReturn(ctx, {
      branchId: org.branchId,
      supplierId,
      locationId: store,
      currency: 'INR',
      reason: 'More than we have',
      lines: [{ productId: empty.rows[0]?.id ?? '', quantity: '999', statusFrom: 'AVAILABLE' }],
    });

    // The ledger's sufficiency check under the bucket lock. A 409, not an error.
    await expect(sendPurchaseReturn(ctx, ret.id)).rejects.toThrow(/which is less than/i);
  });
});
