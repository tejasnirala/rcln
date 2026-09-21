/**
 * PI-12: online pharmacy — against a real Postgres, through the real services.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * `pharmacy` proves the way stock leaves a COUNTER. This proves the way it
 * leaves in a PARCEL, and pins the four things PI-12 exists to guarantee:
 *
 *   NO PRODUCT IS ONLINEABLE       accepting an order is REFUSED for a product
 *   BY DEFAULT                     nobody has cleared for remote supply here,
 *                                  and permitted once somebody has. The single
 *                                  most important case in the file, because the
 *                                  regulatory engine's own refusal enforces
 *                                  nothing until a pack is signed off.
 *   ACCEPTING HOLDS, PACKING       confirm moves AVAILABLE -> RESERVED and pack
 *   SUPPLIES                       moves RESERVED -> out. Neither double-counts,
 *                                  and `verifyBalances()` replays clean after
 *                                  every one of them.
 *   PACKING IS A DISPENSE          one `dispenses` row of kind ONLINE, with a
 *                                  NOT NULL regulatory snapshot per line and a
 *                                  charge request — through the same function
 *                                  the counter uses, not a second copy.
 *   A REFUSAL LEAVES NOTHING       no hold, no number, no order state change.
 *
 * ⚠️ THE HOLD CITES THE ORDER **LINE**, NOT THE ORDER, AND A CASE PINS IT. That
 *   is what lets packing put the right lots against the right line; the
 *   `online_order_lines_..._product__key` index is the other half of the same
 *   guarantee and has its own case in the isolation suite.
 *
 * Every fixture is prefixed `ONL-` and is torn down with the organization.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { createDispenseRequest } from '@rcln/contracts';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { registerOrganization } from '../../src/services/organization/register.service.js';
import { initDatabase, disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';
import type { TenantContext } from '@rcln/db';
import { createLocation } from '../../src/services/inventory/location.service.js';
import { createBatch } from '../../src/services/inventory/batch.service.js';
import { recordMovement } from '../../src/services/inventory/movement.service.js';
import { verifyBalances } from '../../src/services/inventory/balance.service.js';
import {
  cancelOnlineOrder,
  confirmOnlineOrder,
  createOnlineOrder,
  getOnlineOrder,
  listOnlineOrders,
  updateOnlineOrder,
} from '../../src/services/pharmacy/online-order.service.js';
import {
  deliverOnlineOrder,
  failOnlineOrderDelivery,
  packOnlineOrder,
  shipOnlineOrder,
} from '../../src/services/pharmacy/fulfilment.service.js';
import { createDispense, getDispense } from '../../src/services/pharmacy/dispense.service.js';

const SUFFIX = `o${Date.now().toString(36)}`;
const SLUG = `onl-${SUFFIX}`;
const PASSWORD = 'CorrectHorse9Battery';

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let org: { organizationId: string; ownerUserId: string; branchId: string };
let ctx: TenantContext;

let baseUnit: string;
let medicine: string;
/** A second product, so the remote-supply gate can be proved BOTH ways at once. */
let ointment: string;
let counter: string;
let lot: string;
let ointmentLot: string;
let patientId: string;
let jurisdictionId: string;

const ADDRESS = {
  recipientName: 'Onl Recipient',
  recipientPhone: '+919800000001',
  addressLine1: '1 Test Lane',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  destinationCountryCode: 'IN',
  destinationRegionCode: 'KA',
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

function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function balanceOf(batchId: string, status: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_balances
      WHERE batch_id = $1 AND status = $2`,
    [batchId, status]
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** The `ONLINE_ORDER` counter for this branch, or null before it is ever used. */
async function orderCounter(): Promise<number | null> {
  const { rows } = await owner.query<{ last_number: string }>(
    `SELECT last_number FROM number_sequences
      WHERE organization_id = $1 AND branch_id = $2 AND sequence_type = 'ONLINE_ORDER'`,
    [org.organizationId, org.branchId]
  );
  return rows[0] ? Number(rows[0].last_number) : null;
}

async function reservationsFor(
  lineId: string
): Promise<{ status: string; reference_id: string | null; quantity_base: string }[]> {
  const { rows } = await owner.query<{
    status: string;
    reference_id: string | null;
    quantity_base: string;
  }>(
    `SELECT status, reference_id, quantity_base FROM stock_reservations
      WHERE reference_type = 'ONLINE_ORDER' AND reference_id = $1 ORDER BY created_at`,
    [lineId]
  );
  return rows;
}

/** What the clinic asserts about a product's remote-supply position, here. */
async function recordOnlinePosition(productId: string, position: string): Promise<void> {
  await owner.query(
    `INSERT INTO product_regulatory_profiles
       (id, organization_id, product_id, jurisdiction_id, online_sale_position,
        effective_from, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"OnlineSalePosition", CURRENT_DATE - 1, now())`,
    [org.organizationId, productId, jurisdictionId, position]
  );
}

async function takeOrder(productId = medicine, quantity = '5'): Promise<string> {
  const order = await createOnlineOrder(ctx, {
    branchId: org.branchId,
    locationId: counter,
    channel: 'PHONE',
    patientId,
    address: ADDRESS,
    lines: [{ productId, quantity, unitId: baseUnit }],
  });
  return order.id;
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  org = await registerOrganization(payload(SLUG, 'Onl'));
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

  /*
   * ⚠️ THE BRANCH'S OWN JURISDICTION, LOOKED UP RATHER THAN ASSUMED. The profile
   *   has to line up with the place `evaluateWithin` resolves for this branch, or
   *   the gate reads "no profile" and every case below fails for the wrong
   *   reason. `IN` with no region is the country-wide row PI-6 seeds.
   */
  const jurisdiction = await owner.query<{ id: string }>(
    `SELECT id FROM jurisdictions WHERE country_code = 'IN' AND region_code IS NULL LIMIT 1`
  );
  jurisdictionId = jurisdiction.rows[0]?.id ?? '';
  if (!jurisdictionId) throw new Error('the seed is missing the IN jurisdiction');

  const created = await owner.query<{ id: string }>(
    `INSERT INTO products
       (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
        is_expiry_controlled, is_stock_item, updated_at)
     VALUES
       (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'ONL-MED', 'Onl Medicine', $2,
        'LOT_BATCH', true, true, now()),
       (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'ONL-OIN', 'Onl Ointment', $2,
        'LOT_BATCH', true, true, now())
     RETURNING id`,
    [org.organizationId, baseUnit]
  );
  medicine = created.rows[0]?.id ?? '';
  ointment = created.rows[1]?.id ?? '';

  counter = (
    await createLocation(ctx, {
      branchId: org.branchId,
      kind: 'MAIN_PHARMACY',
      code: 'ONL_COUNTER',
      name: 'Onl Counter',
      isDispensingPoint: true,
      requiresControlledAccess: false,
    })
  ).id;

  lot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: medicine,
      lotNumber: 'ONL-LOT-1',
      expiresOn: dateIn(400),
    })
  ).id;

  ointmentLot = (
    await createBatch(ctx, {
      branchId: org.branchId,
      productId: ointment,
      lotNumber: 'ONL-LOT-2',
      expiresOn: dateIn(400),
    })
  ).id;

  for (const [batchId, productId] of [
    [lot, medicine],
    [ointmentLot, ointment],
  ] as const) {
    await recordMovement(ctx, {
      branchId: org.branchId,
      productId,
      batchId,
      movementType: 'RETURN',
      quantity: '100',
      locationId: counter,
      referenceType: 'MANUAL',
    });
  }

  const patient = await owner.query<{ id: string }>(
    `INSERT INTO patients (id, organization_id, uhid, first_name, last_name, date_of_birth, updated_at)
     VALUES (gen_random_uuid(), $1, 'ONL00001', 'Onl', 'Patient', DATE '1990-05-05', now())
     RETURNING id`,
    [org.organizationId]
  );
  patientId = patient.rows[0]?.id ?? '';

  /*
   * ⚠️ ONLY THE MEDICINE IS CLEARED, AND THE OINTMENT DELIBERATELY IS NOT. The
   *   gate is then proved in both directions against one clinic on one day,
   *   rather than by a case that has to undo the other's fixture.
   */
  await recordOnlinePosition(medicine, 'PERMITTED');
}, 60_000);

afterAll(async () => {
  const ids = [org?.organizationId].filter(Boolean);
  const users = [org?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
}, 60_000);

// ---------------------------------------------------------------------------
// Taking the order
// ---------------------------------------------------------------------------

describe('a draft promises nothing', () => {
  it('holds no stock and burns no number', async () => {
    const before = await orderCounter();
    const available = await balanceOf(lot, 'AVAILABLE');

    const orderId = await takeOrder();
    const order = await getOnlineOrder(ctx, orderId);

    expect(order.status).toBe('DRAFT');
    expect(order.orderNumber).toBeNull();
    expect(order.lines[0]?.acceptanceDecision).toBeNull();
    expect(order.lines[0]?.heldQuantityBase).toBe('0');

    expect(await orderCounter()).toBe(before);
    expect(await balanceOf(lot, 'AVAILABLE')).toBe(available);
    expect(await balanceOf(lot, 'RESERVED')).toBe(0);
  });

  it('refuses the same product on two lines', async () => {
    await expect(
      createOnlineOrder(ctx, {
        branchId: org.branchId,
        locationId: counter,
        channel: 'WEB',
        patientId,
        address: ADDRESS,
        lines: [
          { productId: medicine, quantity: '2', unitId: baseUnit },
          { productId: medicine, quantity: '3', unitId: baseUnit },
        ],
      })
    ).rejects.toThrow(/twice/i);
  });

  it('can be amended, and the lines are replaced rather than merged', async () => {
    const orderId = await takeOrder();
    const updated = await updateOnlineOrder(ctx, orderId, {
      lines: [{ productId: ointment, quantity: '2', unitId: baseUnit }],
    });

    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]?.productId).toBe(ointment);
  });
});

// ---------------------------------------------------------------------------
// The gate — the reason this phase exists
// ---------------------------------------------------------------------------

describe('no product is onlineable by default', () => {
  it('refuses to accept an order for a product nobody has cleared for remote supply', async () => {
    const orderId = await takeOrder(ointment, '2');
    const before = await orderCounter();

    await expect(confirmOnlineOrder(ctx, orderId, { holdForDays: 7 })).rejects.toThrow(
      /remote(ly)?/i
    );

    /* A refusal leaves nothing: no hold, no number, no state change. */
    const order = await getOnlineOrder(ctx, orderId);
    expect(order.status).toBe('DRAFT');
    expect(order.orderNumber).toBeNull();
    expect(await orderCounter()).toBe(before);
    expect(await balanceOf(ointmentLot, 'RESERVED')).toBe(0);
  });

  it('names the product and says what to do about it', async () => {
    const orderId = await takeOrder(ointment, '2');
    await expect(confirmOnlineOrder(ctx, orderId, { holdForDays: 7 })).rejects.toThrow(
      /Onl Ointment/
    );
  });

  it('refuses one recorded as prohibited, and says so differently', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO products
         (id, organization_id, type, status, code, name, base_unit_id, tracking_mode,
          is_expiry_controlled, is_stock_item, updated_at)
       VALUES (gen_random_uuid(), $1, 'MEDICINE', 'ACTIVE', 'ONL-PRO', 'Onl Prohibited', $2,
               'LOT_BATCH', true, true, now())
       RETURNING id`,
      [org.organizationId, baseUnit]
    );
    const prohibited = rows[0]?.id ?? '';
    await recordOnlinePosition(prohibited, 'PROHIBITED');

    const orderId = await takeOrder(prohibited, '1');
    await expect(confirmOnlineOrder(ctx, orderId, { holdForDays: 7 })).rejects.toThrow(
      /may not be sent out/i
    );
  });
});

/**
 * ⚠️ THE SECOND DOOR, WHICH THIS PHASE OPENED AND THE SECURITY REVIEW FOUND.
 *
 *   `DispenseKind` had to gain `ONLINE` for the COLUMN's sake, and widening the
 *   shared enum silently widened `createDispenseRequest` with it. A caller
 *   holding `pharmacy.dispense.create` could then post `kind: 'ONLINE'` straight
 *   to the counter endpoint: `createDispenseWithin` evaluated it under
 *   `ONLINE_DISPENSE` with no `RemoteSupply`, so `assertRemoteSupplyIsOpen`
 *   never ran, no destination was supplied, and the supply left no
 *   `online_orders` row saying where the parcel went. The engine's own gate
 *   refused and refusing changed nothing, because no pack is
 *   `PRODUCTION_ENABLED` — which is the entire reason the service gate exists.
 *
 *   Refused now in two places: the contract refinement, and this service guard.
 */
describe('a parcel cannot be dispensed from the counter endpoint', () => {
  it('refuses kind ONLINE and points at the pack route', async () => {
    await expect(
      createDispense(ctx, {
        branchId: org.branchId,
        locationId: counter,
        kind: 'ONLINE',
        patientId,
        lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
      })
    ).rejects.toThrow(/packing its order/i);
  });

  it('refuses it at the contract too, so the guard is not the only thing', () => {
    const parsed = createDispenseRequest.safeParse({
      branchId: org.branchId,
      locationId: counter,
      kind: 'ONLINE',
      patientId,
      lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
    });

    expect(parsed.success).toBe(false);
  });

  /** And the ordinary counter paths are untouched by the refusal. */
  it('still supplies a counter sale', async () => {
    const sale = await createDispense(ctx, {
      branchId: org.branchId,
      locationId: counter,
      kind: 'COUNTER_SALE',
      lines: [{ productId: medicine, quantity: '1', unitId: baseUnit }],
    });

    expect(sale.kind).toBe('COUNTER_SALE');
  });
});

// ---------------------------------------------------------------------------
// Accepting, holding, and giving it back
// ---------------------------------------------------------------------------

describe('accepting an order holds the stock', () => {
  it('moves AVAILABLE to RESERVED, issues a number, and cites the ORDER LINE', async () => {
    const available = await balanceOf(lot, 'AVAILABLE');
    const reserved = await balanceOf(lot, 'RESERVED');

    const orderId = await takeOrder(medicine, '5');
    const order = await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });

    expect(order.status).toBe('CONFIRMED');
    expect(order.orderNumber).toMatch(/^ORD-/);
    expect(order.lines[0]?.acceptanceDecision).not.toBeNull();
    expect(order.lines[0]?.heldQuantityBase).toBe('5');

    expect(await balanceOf(lot, 'AVAILABLE')).toBe(available - 5);
    expect(await balanceOf(lot, 'RESERVED')).toBe(reserved + 5);

    /*
     * ⚠️ THE HOLD NAMES THE LINE. Naming the ORDER would leave packing unable to
     *   say which line each lot belonged to on an order with two products.
     */
    const lineId = order.lines[0]?.id ?? '';
    const held = await reservationsFor(lineId);
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe('ACTIVE');
    expect(held[0]?.reference_id).toBe(lineId);

    await expect(verifyBalances(ctx, { branchId: org.branchId })).resolves.toMatchObject({
      discrepancies: [],
    });
  });

  it('refuses to accept more than the shelf holds, and leaves no hold behind', async () => {
    const orderId = await takeOrder(medicine, '999999');
    const reserved = await balanceOf(lot, 'RESERVED');

    await expect(confirmOnlineOrder(ctx, orderId, { holdForDays: 7 })).rejects.toThrow(
      /not enough/i
    );

    expect(await balanceOf(lot, 'RESERVED')).toBe(reserved);
    expect((await getOnlineOrder(ctx, orderId)).status).toBe('DRAFT');
  });

  it('cannot be accepted twice', async () => {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await expect(confirmOnlineOrder(ctx, orderId, { holdForDays: 7 })).rejects.toThrow(
      /already been accepted/i
    );
  });

  it('cannot be amended once accepted', async () => {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await expect(
      updateOnlineOrder(ctx, orderId, {
        lines: [{ productId: medicine, quantity: '2', unitId: baseUnit }],
      })
    ).rejects.toThrow(/already been accepted/i);
  });
});

describe('standing an order down gives the stock back', () => {
  it('releases every hold', async () => {
    const orderId = await takeOrder(medicine, '4');
    const order = await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    const reserved = await balanceOf(lot, 'RESERVED');
    const available = await balanceOf(lot, 'AVAILABLE');

    const cancelled = await cancelOnlineOrder(ctx, orderId, {
      reason: 'The patient collected it at the counter instead.',
    });

    expect(cancelled.status).toBe('CANCELLED');
    expect(await balanceOf(lot, 'RESERVED')).toBe(reserved - 4);
    expect(await balanceOf(lot, 'AVAILABLE')).toBe(available + 4);

    const held = await reservationsFor(order.lines[0]?.id ?? '');
    expect(held[0]?.status).toBe('RELEASED');

    await expect(verifyBalances(ctx, { branchId: org.branchId })).resolves.toMatchObject({
      discrepancies: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Packing — the irreversible act
// ---------------------------------------------------------------------------

describe('packing is a dispense', () => {
  it('takes the held lots off the shelf and writes one ONLINE dispense', async () => {
    const orderId = await takeOrder(medicine, '6');
    const accepted = await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    const lineId = accepted.lines[0]?.id ?? '';

    const reserved = await balanceOf(lot, 'RESERVED');
    const available = await balanceOf(lot, 'AVAILABLE');

    const packed = await packOnlineOrder(ctx, orderId, {});

    expect(packed.status).toBe('PACKED');
    expect(packed.dispenseId).not.toBeNull();
    expect(packed.lines[0]?.heldQuantityBase).toBe('0');

    /* Out of RESERVED, and AVAILABLE is untouched — the double-count case. */
    expect(await balanceOf(lot, 'RESERVED')).toBe(reserved - 6);
    expect(await balanceOf(lot, 'AVAILABLE')).toBe(available);

    const held = await reservationsFor(lineId);
    expect(held[0]?.status).toBe('CONSUMED');

    const dispense = await getDispense(ctx, packed.dispenseId ?? '');
    expect(dispense.kind).toBe('ONLINE');
    expect(dispense.patientId).toBe(patientId);
    expect(dispense.lines).toHaveLength(1);
    /* NOT NULL by column, so this asserts the engine was asked at PACK time. */
    expect(dispense.lines[0]?.decision.outcome).toBeTruthy();
    expect(dispense.lines[0]?.allocations[0]?.lotNumber).toBe('ONL-LOT-1');

    await expect(verifyBalances(ctx, { branchId: org.branchId })).resolves.toMatchObject({
      discrepancies: [],
    });
  });

  it('raises the money side, and pharmacy still owns no rate', async () => {
    const orderId = await takeOrder(medicine, '2');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    const packed = await packOnlineOrder(ctx, orderId, {});

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM charge_requests cr
         JOIN dispense_lines dl ON dl.id = cr.dispense_line_id
        WHERE dl.dispense_id = $1`,
      [packed.dispenseId]
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });

  it('cannot be packed twice', async () => {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await packOnlineOrder(ctx, orderId, {});
    await expect(packOnlineOrder(ctx, orderId, {})).rejects.toThrow(/already been packed/i);
  });

  it('cannot be packed before it is accepted', async () => {
    const orderId = await takeOrder(medicine, '1');
    await expect(packOnlineOrder(ctx, orderId, {})).rejects.toThrow(/not been accepted/i);
  });

  it('cannot be stood down once it is packed', async () => {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await packOnlineOrder(ctx, orderId, {});
    await expect(
      cancelOnlineOrder(ctx, orderId, { reason: 'Changed their mind after it was made up.' })
    ).rejects.toThrow(/return/i);
  });

  it('refuses to pack against a hold that has gone away', async () => {
    const orderId = await takeOrder(medicine, '3');
    const accepted = await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });

    /*
     * The sweep, as it would leave things: the row terminal and the quantity back
     * in AVAILABLE. Packing must refuse rather than take stock out of a RESERVED
     * bucket that no longer holds it.
     */
    await owner.query(
      `UPDATE stock_reservations SET status = 'EXPIRED', released_at = now()
        WHERE reference_type = 'ONLINE_ORDER' AND reference_id = $1`,
      [accepted.lines[0]?.id]
    );

    await expect(packOnlineOrder(ctx, orderId, {})).rejects.toThrow(/hold/i);

    /* Put it back so the balance replay stays honest for the rest of the file. */
    await owner.query(
      `UPDATE stock_reservations SET status = 'ACTIVE', released_at = NULL
        WHERE reference_type = 'ONLINE_ORDER' AND reference_id = $1`,
      [accepted.lines[0]?.id]
    );
  });
});

// ---------------------------------------------------------------------------
// The parcel
// ---------------------------------------------------------------------------

describe('the parcel', () => {
  async function packedOrder(): Promise<string> {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await packOnlineOrder(ctx, orderId, {});
    return orderId;
  }

  it('is handed to a carrier once, and delivered', async () => {
    const orderId = await packedOrder();

    const shipped = await shipOnlineOrder(ctx, orderId, {
      carrierName: 'Onl Courier',
      trackingReference: `ONL${SUFFIX}`,
      packageCount: 1,
    });
    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.shipment?.trackingReference).toBe(`ONL${SUFFIX}`);

    const delivered = await deliverOnlineOrder(ctx, orderId, { receivedByName: 'A neighbour' });
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.shipment?.deliveredAt).not.toBeNull();
  });

  it('cannot be handed over twice', async () => {
    const orderId = await packedOrder();
    await shipOnlineOrder(ctx, orderId, { carrierName: 'Onl Courier', packageCount: 1 });
    await expect(
      shipOnlineOrder(ctx, orderId, { carrierName: 'Onl Courier', packageCount: 1 })
    ).rejects.toThrow(/already been handed over/i);
  });

  it('cannot be handed over before it is packed', async () => {
    const orderId = await takeOrder(medicine, '1');
    await confirmOnlineOrder(ctx, orderId, { holdForDays: 7 });
    await expect(
      shipOnlineOrder(ctx, orderId, { carrierName: 'Onl Courier', packageCount: 1 })
    ).rejects.toThrow(/not been packed/i);
  });

  /**
   * ⚠️ THE CASE THAT MATTERS MOST HERE. A courier's status update must not put
   *   quantity back on a shelf the clinic cannot find it on.
   */
  it('a failed delivery moves no stock, and a later delivery keeps the failure', async () => {
    const orderId = await packedOrder();
    await shipOnlineOrder(ctx, orderId, { carrierName: 'Onl Courier', packageCount: 1 });

    const available = await balanceOf(lot, 'AVAILABLE');
    const reserved = await balanceOf(lot, 'RESERVED');

    const failed = await failOnlineOrderDelivery(ctx, orderId, {
      reason: 'Nobody at the address; card left.',
    });
    expect(failed.status).toBe('DELIVERY_FAILED');
    expect(await balanceOf(lot, 'AVAILABLE')).toBe(available);
    expect(await balanceOf(lot, 'RESERVED')).toBe(reserved);

    const delivered = await deliverOnlineOrder(ctx, orderId, {});
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.shipment?.failedAt).not.toBeNull();
    expect(delivered.shipment?.failureReason).toBe('Nobody at the address; card left.');
  });
});

// ---------------------------------------------------------------------------
// PHI
// ---------------------------------------------------------------------------

describe('reading an order is a disclosure, and it is logged as one', () => {
  async function onlineOrderReads(): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'ONLINE_ORDER'`,
      [org.organizationId]
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('logs a first read of an order, and a list read of its own', async () => {
    /* ⚠️ `takeOrder` READS THE ORDER BACK, so the first disclosure is already
     *   logged by the time this line returns — which is why the baseline is taken
     *   after it and not before. */
    const orderId = await takeOrder(medicine, '1');
    const before = await onlineOrderReads();

    /*
     * ⚠️ THE SAME ACTOR RE-READING THE SAME RECORD IS DEDUPLICATED FOR FIVE
     *   MINUTES, and that is `recordDataAccess`'s deliberate behaviour rather
     *   than a gap: a pharmacist tabbing between panels of one order is one
     *   clinical act. So this read writes NOTHING, and asserting it does would
     *   pin the opposite of what the table is designed to do.
     */
    await getOnlineOrder(ctx, orderId, { route: 'GET /v1/online-orders/:orderId' });
    expect(await onlineOrderReads()).toBe(before);

    /*
     * A LIST names no single record, so it is never deduplicated — repeatedly
     * pulling the delivery book is itself the signal a disclosure review looks
     * for.
     */
    await listOnlineOrders(ctx, { page: 1, limit: 20 }, { route: 'GET /v1/online-orders' });
    await listOnlineOrders(ctx, { page: 1, limit: 20 }, { route: 'GET /v1/online-orders' });
    expect(await onlineOrderReads()).toBe(before + 2);

    /*
     * ⚠️ THE ROUTE PATTERN, NEVER THE URL, and never a name. `data_access_logs`
     *   is read by compliance people who have no business reading records.
     */
    const { rows } = await owner.query<{ route: string | null; patient_id: string | null }>(
      `SELECT route, patient_id FROM data_access_logs
        WHERE organization_id = $1 AND resource = 'ONLINE_ORDER'
        ORDER BY occurred_at DESC LIMIT 2`,
      [org.organizationId]
    );
    for (const row of rows) {
      expect(row.route).toMatch(/^GET \/v1\/online-orders/);
      expect(row.route).not.toContain('?');
    }
  });
});
