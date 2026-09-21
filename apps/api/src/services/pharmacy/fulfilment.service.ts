/**
 * Packing, shipping and delivering an online order (PI-12).
 *
 * `online-order.service.ts` is the other half — taking the order, accepting it,
 * standing it down. The split is where the risk changes, and the whole of the
 * irreversible risk is in this file's first function.
 *
 * ── PACKING IS A DISPENSE, AND IT GOES THROUGH THE DISPENSE ─────────────────
 * ⚠️ THERE IS NO SECOND POSTING FUNCTION HERE. `packOnlineOrder` consumes the
 *   holds and then calls `createDispenseWithin` — the same function the counter
 *   calls — inside the transaction it already owns. What that buys is that every
 *   supply in this product, however it was asked for, is subject to one
 *   re-assertion of the world, one consultation of the law, one snapshot, one
 *   set of ledger legs and one charge-request pass. A parallel copy would be a
 *   second door into the highest-risk write in the programme, and the PI-11
 *   review has already written down what that costs.
 *
 * ── THE ORDER OF THE THREE THINGS PACKING DOES ──────────────────────────────
 *
 *   1. CLAIM the holds       `updateMany` with `status: 'ACTIVE'` in the
 *                            predicate, so a count of zero means the sweep or
 *                            somebody else got there first. This is the same
 *                            claim-before-you-move discipline
 *                            `releaseReservationIn` documents at length, and it
 *                            is FIRST for the same reason: the row is what
 *                            decides whether the movement happens at all.
 *   2. DISPENSE              which writes the `DISPENSING` legs out of the
 *                            `RESERVED` bucket the claim just accounted for.
 *   3. MOVE THE ORDER ON     status, `packed_at`, and the dispense id, which the
 *                            unique index makes a one-shot.
 *
 *   ⚠️ CLAIMING AFTER DISPENSING WOULD LOSE THE RACE THE OTHER WAY. The sweep
 *     could release a hold between the ledger leg and the claim, moving quantity
 *     back into AVAILABLE that had already left the building — a shelf showing
 *     stock that is in a parcel.
 *
 * ── SHIPPING AND DELIVERING MOVE NO STOCK, AND THAT IS WHY THEY ARE CHEAP ───
 * A parcel handed to a courier has already left the clinic's books. Everything
 * after packing is a record of where it got to, which is why those three
 * functions are gated on `pharmacy.online_order.dispatch` rather than on the
 * supply code, and why none of them touches the ledger, an invoice or a
 * regulatory decision.
 *
 * ⚠️ A PARCEL THAT COMES BACK IS A RETURN, NOT A CANCELLATION. There is no path
 *   in this file that un-dispenses anything. A failed delivery whose stock
 *   physically returns to the pharmacy goes through
 *   `POST /v1/pharmacy/dispenses/:id/return`, which asks the law where it may be
 *   put and quarantines it by default — the same treatment a medicine handed
 *   back over the counter gets, and for a sharper reason: nobody can attest to
 *   how a parcel was stored in a van.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * Reads log through `getOnlineOrder`. Audit rows carry ids, counts and a carrier
 * name — never an address, a medicine or a patient.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import { NOTIFICATION_JOB } from '@rcln/queue';
import type {
  CreateDispenseRequest,
  DeliverOnlineOrderRequest,
  FailOnlineOrderDeliveryRequest,
  OnlineOrderDetail,
  PackOnlineOrderRequest,
  ShipOnlineOrderRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  createDispenseWithin,
  type RemoteSupply,
  type ResolvedAllocation,
} from './dispense.service.js';
import { getOnlineOrder } from './online-order.service.js';
import { auditMeta, q } from './shared.js';
import type { PharmacyActionOptions } from './queue.service.js';
import { notifyAboutOrder } from './notify.js';

/** The order, in the shape every act below needs it. */
async function loadOrder(
  tx: TxClient,
  organizationId: string,
  id: string
): Promise<{
  id: string;
  branchId: string;
  locationId: string;
  status: string;
  patientId: string;
  encounterId: string | null;
  notes: string | null;
  destinationCountryCode: string;
  destinationRegionCode: string | null;
  lines: {
    id: string;
    lineNumber: number;
    encounterPrescriptionId: string | null;
    productId: string;
    quantityEntered: Prisma.Decimal;
    unitId: string;
    quantityBase: Prisma.Decimal;
  }[];
}> {
  const order = await tx.onlineOrder.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      branchId: true,
      locationId: true,
      status: true,
      patientId: true,
      encounterId: true,
      notes: true,
      destinationCountryCode: true,
      destinationRegionCode: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        select: {
          id: true,
          lineNumber: true,
          encounterPrescriptionId: true,
          productId: true,
          quantityEntered: true,
          unitId: true,
          quantityBase: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('Online order');
  return order;
}

// ---------------------------------------------------------------------------
// Packing — the irreversible act
// ---------------------------------------------------------------------------

/**
 * Make the parcel up: consume the holds, write the dispense, move the order on.
 *
 * @throws RegulatoryRefusalError 422 when the rules refuse a line AND the pack
 *         is one a human has signed off (`enforcement.ts`).
 */
export async function packOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: PackOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  const packedAt = body.packedAt ? new Date(body.packedAt) : new Date();

  await withTenant(ctx, async (tx) => {
    const order = await loadOrder(tx, ctx.organizationId, id);
    if (order.status !== 'CONFIRMED') {
      throw new ConflictError(
        order.status === 'DRAFT'
          ? 'This order has not been accepted yet, so no stock is held for it.'
          : order.status === 'CANCELLED'
            ? 'This order was stood down.'
            : order.status === 'EXPIRED'
              ? /* ⚠️ NAMED SEPARATELY, BECAUSE "already packed" WOULD BE A LIE
                 *   AND AN EXPENSIVE ONE. The hold ran out and the stock went
                 *   back to the shelf; the order is still real and its number is
                 *   still the patient's. What has to happen next is a new
                 *   order, not a hunt for a parcel nobody made up. */
                'The stock held for this order was released when the hold ran out, so there is nothing reserved to pack. Take the order again.'
              : 'This order has already been packed.'
      );
    }
    if (order.lines.length === 0) {
      throw new ValidationError('There is nothing on this order to pack.');
    }

    const lineIds = order.lines.map((line) => line.id);

    /*
     * The holds, read with the lot and the expiry the engine is shown as
     * traceability evidence. ⚠️ `ACTIVE` ONLY — an EXPIRED or RELEASED hold is
     * quantity that has already gone back to the shelf, and packing against one
     * would take it out of a `RESERVED` bucket that no longer holds it.
     */
    const held = await tx.stockReservation.findMany({
      where: {
        organizationId: ctx.organizationId,
        referenceType: 'ONLINE_ORDER',
        referenceId: { in: lineIds },
        status: 'ACTIVE',
      },
      select: {
        id: true,
        referenceId: true,
        locationId: true,
        batchId: true,
        serialId: true,
        quantityBase: true,
        batch: { select: { lotNumber: true, expiresOn: true, status: true } },
        serial: { select: { serialNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (held.length === 0) {
      throw new ConflictError(
        'None of the stock held for this order is still held — the hold has expired or been released. Cancel the order and place it again.'
      );
    }

    /*
     * ⚠️ A LOT RECALLED SINCE THE ORDER WAS ACCEPTED MAY NOT BE PACKED
     *   (KNOWN_ISSUES #24 — "the most consequential gap PI-12 leaves").
     *
     *   `executeRecall` moves the quantity out of every bucket holding physical
     *   stock, `RESERVED` included, so the BALANCE is already gone by the time
     *   anybody gets here. What survives is the reservation ROW: it is still
     *   ACTIVE, it still names the batch, and the claim below would take it. The
     *   dispense would then fail somewhere deeper on a balance that is no longer
     *   there — or, worse, would not, and a recalled lot would go into a parcel
     *   addressed to a patient.
     *
     *   Refused here rather than repaired, deliberately: which lot should
     *   replace it is an allocation decision somebody has to make with the
     *   recall in front of them, and silently re-picking would hide a recall
     *   from the person best placed to act on it. The order stands, the holds
     *   stay claimed by nobody, and the message names the lot.
     */
    const recalledHold = held.find((hold) => hold.batch?.status === 'RECALLED');
    if (recalledHold) {
      throw new ConflictError(
        `Lot ${recalledHold.batch?.lotNumber ?? ''} was recalled after this order was accepted, ` +
          `so this parcel cannot be made up from the stock held for it. Cancel the order, or ` +
          `release the hold and pack it from stock that is not under recall.`
      );
    }

    /*
     * ⚠️ STEP 1: CLAIM THE HOLDS BEFORE ANY LEDGER LEG IS WRITTEN. See the file
     *   header. `updateMany` with `status: 'ACTIVE'` in the predicate is the
     *   claim; a count that does not match what we read means the sweep took
     *   some of them between the read and here, and packing a short parcel is
     *   worse than refusing to pack one.
     *
     * ⚠️ `released_at` IS SET ON A CONSUMED ROW TOO, AND THE CHECK CONSTRAINT
     *   REQUIRES IT — `stock_reservations_terminal_dated` pairs the timestamp
     *   with any status that is not ACTIVE. What it records is when the hold
     *   ENDED, which for a consumed one is when the parcel was made up.
     */
    const claimed = await tx.stockReservation.updateMany({
      /* ⚠️ `organizationId` EXPLICIT, NOT LEFT TO RLS (ADR-0005, and the rule
       * `createOnlineOrder` states about its own writes). The ids come from a
       * tenant-scoped read four lines up, so this is defence in depth — which is
       * the standard for a tenant column, not an optimisation to skip. */
      where: {
        id: { in: held.map((reservation) => reservation.id) },
        organizationId: ctx.organizationId,
        status: 'ACTIVE',
      },
      data: { status: 'CONSUMED', releasedAt: packedAt, releasedById: ctx.userId },
    });
    if (claimed.count !== held.length) {
      throw new ConflictError(
        'Part of the stock held for this order was released while the parcel was being made up. Reload the order and check the shelf.'
      );
    }

    const allocationsByLine = new Map<string, ResolvedAllocation[]>();
    for (const reservation of held) {
      if (reservation.referenceId === null) continue;
      const bucket = allocationsByLine.get(reservation.referenceId) ?? [];
      bucket.push({
        locationId: reservation.locationId,
        batchId: reservation.batchId,
        serialId: reservation.serialId,
        quantityBase: reservation.quantityBase,
        /*
         * ⚠️ NEVER AN OVERRIDE. FEFO chose these lots at confirmation and nobody
         *   has been offered the chance to depart from it since — an override
         *   with no human behind it would be a reason nobody can be asked about.
         */
        isOverride: false,
        overrideReason: null,
        lotNumber: reservation.batch?.lotNumber ?? null,
        expiresOn: reservation.batch?.expiresOn ?? null,
        serialNumber: reservation.serial?.serialNumber ?? null,
      });
      allocationsByLine.set(reservation.referenceId, bucket);
    }

    /*
     * The request the dispensing machinery takes, built from the ORDER rather
     * than from anything a client sent to this endpoint. ⚠️ Every field is
     * server-derived; see `RemoteSupply` for the three that a caller must never
     * be able to state.
     */
    const requestLines: CreateDispenseRequest['lines'] = order.lines.map((line) => ({
      encounterPrescriptionId: line.encounterPrescriptionId,
      productId: line.productId,
      quantity: q(line.quantityEntered),
      unitId: line.unitId,
    }));

    const heldByRequestLine = new Map<
      CreateDispenseRequest['lines'][number],
      ResolvedAllocation[]
    >();
    order.lines.forEach((line, index) => {
      const requestLine = requestLines[index];
      const allocations = allocationsByLine.get(line.id);
      if (requestLine === undefined || allocations === undefined) return;
      heldByRequestLine.set(requestLine, allocations);
    });

    const remote: RemoteSupply = {
      onlineOrderId: order.id,
      destination: {
        countryCode: order.destinationCountryCode,
        regionCode: order.destinationRegionCode,
      },
      held: heldByRequestLine,
    };

    const dispenseId = await createDispenseWithin(
      tx,
      ctx,
      order.branchId,
      {
        branchId: order.branchId,
        locationId: order.locationId,
        kind: 'ONLINE',
        encounterId: order.encounterId,
        patientId: order.patientId,
        dispensedAt: packedAt.toISOString(),
        notes: body.notes ?? order.notes,
        lines: requestLines,
      },
      options,
      remote
    );

    await tx.onlineOrder.update({
      where: { id: order.id },
      data: {
        status: 'PACKED',
        packedAt,
        packedById: ctx.userId,
        dispenseId,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: 'CONFIRMED' },
      after: {
        status: 'PACKED',
        dispenseId,
        lineCount: order.lines.length,
        reservationsConsumed: claimed.count,
      },
      ...auditMeta(options),
    });
  });

  return getOnlineOrder(ctx, id, options);
}

// ---------------------------------------------------------------------------
// Shipping, delivering, failing — a record of where the parcel got to
// ---------------------------------------------------------------------------

export async function shipOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: ShipOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  const shippedAt = body.shippedAt ? new Date(body.shippedAt) : new Date();

  await withTenant(ctx, async (tx) => {
    const order = await loadOrder(tx, ctx.organizationId, id);
    if (order.status !== 'PACKED') {
      throw new ConflictError(
        order.status === 'CONFIRMED'
          ? 'This order has not been packed yet — nothing has left the shelf to give a courier.'
          : 'This order has already been handed over.'
      );
    }

    /*
     * ⚠️ ONE CONSIGNMENT PER ORDER, AND THE UNIQUE INDEX IS WHAT ENFORCES IT.
     *   Creating rather than upserting means a second dispatch collides at the
     *   database rather than quietly overwriting the tracking number somebody
     *   has already read out to a patient. The status check above is the same
     *   guarantee one layer up.
     */
    const shipment = await tx.onlineOrderShipment.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: order.branchId,
        onlineOrderId: order.id,
        carrierName: body.carrierName,
        serviceLevel: body.serviceLevel ?? null,
        trackingReference: body.trackingReference ?? null,
        packageCount: body.packageCount,
        shippedAt,
        shippedById: ctx.userId,
        notes: body.notes ?? null,
      },
      select: { id: true },
    });

    await tx.onlineOrder.update({ where: { id: order.id }, data: { status: 'SHIPPED' } });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: 'PACKED' },
      after: {
        status: 'SHIPPED',
        shipmentId: shipment.id,
        /* A courier's name is not PHI, and it is the one thing an operator asks. */
        carrierName: body.carrierName,
        packageCount: body.packageCount,
      },
      ...auditMeta(options),
    });
  });

  /* It has left the building — after the commit, never inside it. */
  const shipped = await getOnlineOrder(ctx, id, options);
  await notifyAboutOrder(ctx, NOTIFICATION_JOB.ONLINE_ORDER_SHIPPED, shipped);
  return shipped;
}

/**
 * It arrived.
 *
 * ⚠️ REACHABLE FROM `DELIVERY_FAILED` AS WELL AS FROM `SHIPPED`, AND THE FAILURE
 *   IS NOT ERASED. A courier failing on Tuesday and delivering on Wednesday is
 *   the ordinary case; clearing `failed_at` would hide an attempt somebody may
 *   have to answer for, and refusing the delivery would leave the record
 *   disagreeing with the parcel. So both timestamps stand, the CHECK constraint
 *   only insists the delivery is not dated BEFORE the failure, and `delivered_at`
 *   is what the status reads from.
 */
export async function deliverOnlineOrder(
  ctx: TenantContext,
  id: string,
  body: DeliverOnlineOrderRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  const deliveredAt = body.deliveredAt ? new Date(body.deliveredAt) : new Date();

  await withTenant(ctx, async (tx) => {
    const order = await loadOrder(tx, ctx.organizationId, id);
    if (order.status !== 'SHIPPED' && order.status !== 'DELIVERY_FAILED') {
      throw new ConflictError(
        order.status === 'DELIVERED'
          ? 'This order has already been delivered.'
          : 'This order is not with a courier yet.'
      );
    }

    const shipment = await tx.onlineOrderShipment.findFirst({
      where: { organizationId: ctx.organizationId, onlineOrderId: order.id },
      select: { id: true, failedAt: true },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    if (shipment.failedAt !== null && deliveredAt.getTime() < shipment.failedAt.getTime()) {
      throw new ValidationError(
        'This delivery is dated before the failed attempt it follows. Check the date — a parcel cannot arrive before it failed to.'
      );
    }

    await tx.onlineOrderShipment.update({
      where: { id: shipment.id },
      data: {
        deliveredAt,
        deliveredById: ctx.userId,
        receivedByName: body.receivedByName ?? null,
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      },
    });

    await tx.onlineOrder.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: order.status },
      /* ⚠️ NO `receivedByName` — that is the name of a person at an address. */
      after: { status: 'DELIVERED', shipmentId: shipment.id },
      ...auditMeta(options),
    });
  });

  return getOnlineOrder(ctx, id, options);
}

/**
 * It did not arrive.
 *
 * ⚠️ IT MOVES NO STOCK, AND THAT IS DELIBERATE RATHER THAN INCOMPLETE. The
 *   parcel is somewhere — a depot, a van, a neighbour — and the clinic does not
 *   have it back. Putting the quantity back on the shelf on the strength of a
 *   courier's status update would make the balance say the clinic holds medicine
 *   it cannot find. When the parcel physically returns, that is a
 *   `dispense_returns` row against the dispense, which asks the law where it may
 *   be put and quarantines it by default.
 */
export async function failOnlineOrderDelivery(
  ctx: TenantContext,
  id: string,
  body: FailOnlineOrderDeliveryRequest,
  options: PharmacyActionOptions = {}
): Promise<OnlineOrderDetail> {
  const failedAt = body.failedAt ? new Date(body.failedAt) : new Date();

  await withTenant(ctx, async (tx) => {
    const order = await loadOrder(tx, ctx.organizationId, id);
    if (order.status !== 'SHIPPED') {
      throw new ConflictError(
        order.status === 'DELIVERED'
          ? 'This order has already been delivered. If it came back, record a return against the dispense.'
          : order.status === 'DELIVERY_FAILED'
            ? 'A failed attempt is already recorded against this order.'
            : 'This order is not with a courier yet.'
      );
    }

    const shipment = await tx.onlineOrderShipment.findFirst({
      where: { organizationId: ctx.organizationId, onlineOrderId: order.id },
      select: { id: true, shippedAt: true },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    if (failedAt.getTime() < shipment.shippedAt.getTime()) {
      throw new ValidationError(
        'This attempt is dated before the parcel was handed over. Check the date.'
      );
    }

    await tx.onlineOrderShipment.update({
      where: { id: shipment.id },
      data: { failedAt, failedById: ctx.userId, failureReason: body.reason },
    });

    await tx.onlineOrder.update({ where: { id: order.id }, data: { status: 'DELIVERY_FAILED' } });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'online_order',
      entityId: order.id,
      branchId: order.branchId,
      before: { status: 'SHIPPED' },
      after: { status: 'DELIVERY_FAILED', shipmentId: shipment.id },
      ...auditMeta(options),
    });
  });

  /* The parcel came back. Say so, and keep the reason behind the sign-in — it is
   * free text somebody wrote about a named person's address. */
  const failed = await getOnlineOrder(ctx, id, options);
  await notifyAboutOrder(ctx, NOTIFICATION_JOB.ONLINE_ORDER_DELIVERY_FAILED, failed);
  return failed;
}
