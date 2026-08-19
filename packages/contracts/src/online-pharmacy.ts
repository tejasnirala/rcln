/**
 * Online pharmacy: order, hold, pack, ship, deliver (PI-12).
 *
 * `pharmacy.ts` is what happens when medicine leaves a shelf into somebody's
 * hand at a counter. This is what happens when it leaves in a parcel — and the
 * two end in the same `dispenses` row, written by the same function, because a
 * second way to move stock is a second way to get it wrong.
 *
 * ── WHAT THIS SURFACE DELIBERATELY CANNOT DO ────────────────────────────────
 * Everything `pharmacy.ts` lists, plus three of its own:
 *
 *   name the lots a parcel is made up from   the lots were chosen and HELD at
 *                                            confirmation; packing honours the
 *                                            reservations and takes no
 *                                            allocation from a client, because
 *                                            an allocation sent at packing time
 *                                            would be a second FEFO decision
 *                                            over stock already spoken for
 *   substitute one product for another       see the header on
 *                                            `online-pharmacy.prisma`: the
 *                                            conversation happens before the
 *                                            confirmation, so the remedy is to
 *                                            cancel and re-place
 *
 * ⚠️ AND ONE THING IT CAN DO THAT AN EARLIER DRAFT OF THIS HEADER CLAIMED IT
 *   COULD NOT: **the destination jurisdiction is DECLARED, not derived.** That
 *   claim was wrong and the security review caught it. There is no geocoder in
 *   this product, so nothing can read `IN-KL` out of a free-text address line —
 *   whoever types the address types the country and the region beside it.
 *
 *   What follows, stated rather than papered over: a regional rule can be missed
 *   by declaring a different region from the one the parcel is actually going
 *   to. It is a data-entry hole, not an escalation — the same person could type
 *   a different address — and what bounds it is evidence rather than validation:
 *   the declared pair is FROZEN on the order beside the address it is supposed
 *   to describe, the snapshotted regulatory decision cites it, and both halves
 *   are on the audit row, so a wrong declaration is reconstructable afterwards
 *   even though nothing catches it at the time.
 *
 *   ⚠️ AND IT CANNOT BE VALIDATED AGAINST `jurisdictions`, WHICH WAS TRIED. That
 *     table lists places rcln has written RULES for, not places that exist —
 *     India has a country-wide row and no state rows — so the check refused
 *     `IN-KA` on its first run. See the note where it used to live in
 *     `online-order.service.ts`. Closing this properly needs an address the
 *     platform can resolve to a place, which is a different piece of work.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ THIS IS THE ONLY CONTRACT IN THE PRODUCT CARRYING A PATIENT'S HOME ADDRESS
 *   BESIDE THE MEDICINES BEING SENT TO IT. Every read of an order writes a
 *   `data_access_logs` row under its own resource (`ONLINE_ORDER`), and none of
 *   these fields may reach a URL, a cookie or `localStorage`.
 */
import { z } from 'zod';
import { uuid } from './common.js';
import { countryCode, decimalString } from './products.js';
import { positiveQuantity } from './inventory.js';
import { dispenseRegulatorySummary } from './pharmacy.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in online-pharmacy.prisma
// ---------------------------------------------------------------------------

export const onlineOrderChannel = z.enum(['WEB', 'PHONE', 'WHATSAPP', 'EMAIL', 'COUNTER']);

export const onlineOrderStatus = z.enum([
  'DRAFT',
  'CONFIRMED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
]);

const listMeta = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const documentPage = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// ---------------------------------------------------------------------------
// Where it is going
// ---------------------------------------------------------------------------

/**
 * The delivery address, as the order freezes it.
 *
 * ⚠️ A SNAPSHOT AND NOT A REFERENCE, EVEN THOUGH `patientAddressId` IS HERE. The
 *   id records which stored address this was copied from so a screen can say
 *   "the home address"; the seven fields below are what the parcel is actually
 *   sent to, and a later correction to `patient_addresses` must not rewrite
 *   where something WAS sent. See the model comment.
 *
 * ⚠️ THE REGION IS ISO 3166-2 WITHOUT THE COUNTRY PREFIX — `KA`, never `IN-KA`.
 *   Every other jurisdiction column in this schema spells it that way, and
 *   getting it wrong makes every regional rule miss silently.
 */
export const onlineOrderAddress = z.object({
  /** ⚠️ PHI. Frequently not the patient — an elderly person's daughter signs. */
  recipientName: z.string().trim().min(1).max(255),
  /** ⚠️ PHI. What the carrier rings. */
  recipientPhone: z.string().trim().min(4).max(20),
  /** ⚠️ PHI, all five. */
  addressLine1: z.string().trim().min(1).max(255),
  addressLine2: z.string().trim().max(255).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(100).nullish(),
  pincode: z.string().trim().max(10).nullish(),
  destinationCountryCode: countryCode,
  destinationRegionCode: z.string().trim().max(16).nullish(),
  /** Advisory. Which stored address this was copied from, where it was. */
  patientAddressId: uuid.nullish(),
});

// ---------------------------------------------------------------------------
// Placing and amending a draft
// ---------------------------------------------------------------------------

export const onlineOrderLineRequest = z.object({
  /** The prescribed line this answers. Absent where no prescription backs it. */
  encounterPrescriptionId: uuid.nullish(),
  productId: uuid,
  /** What the person taking the order typed, in the unit they thought in. */
  quantity: positiveQuantity,
  unitId: uuid,
});

export const createOnlineOrderRequest = z.object({
  branchId: uuid,
  /** The dispensing point it will be packed out of. */
  locationId: uuid,
  channel: onlineOrderChannel,
  /**
   * ⚠️ REQUIRED, WHICH IS THE OPPOSITE OF A COUNTER SALE. A parcel has to go to
   *   somebody, and a supply nobody can attribute cannot be traced when the lot
   *   behind it is recalled.
   */
  patientId: uuid,
  /** The consultation whose prescription this fills, where one does. */
  encounterId: uuid.nullish(),
  address: onlineOrderAddress,
  /** ⚠️ PHI. */
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(onlineOrderLineRequest).min(1).max(100),
});

/**
 * Amending a draft.
 *
 * ⚠️ NEITHER THE BRANCH, THE PATIENT NOR THE CHANNEL IS HERE, AND EACH IS ABSENT
 *   FOR ITS OWN REASON. The branch decides which jurisdiction the law is asked
 *   in and whose shelf the stock leaves; the patient is who the supply is
 *   attributed to; the channel is a fact about how the request arrived and is
 *   not something a later edit discovers. An order entered against the wrong one
 *   of any of the three is a new order, not an edit — the same call PI-11 made
 *   about `subject_type`.
 *
 * ⚠️ AND IT APPLIES TO A DRAFT ONLY. Once the order is CONFIRMED the stock is
 *   held and the law has been asked about these exact lines; editing them would
 *   leave a frozen decision describing something else.
 */
export const updateOnlineOrderRequest = z.object({
  locationId: uuid.optional(),
  encounterId: uuid.nullish(),
  address: onlineOrderAddress.optional(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(onlineOrderLineRequest).min(1).max(100).optional(),
});

/**
 * Accepting it: the law is asked, the number is issued and the stock is HELD.
 *
 * ⚠️ THE BODY CARRIES NO LINE, NO LOT AND NO DECISION. Everything it acts on is
 *   already on the order, and everything it decides comes from the server —
 *   which is the property that stops a client choosing which lots to hold, or
 *   sending back a regulatory answer it liked the look of.
 */
export const confirmOnlineOrderRequest = z.object({
  /**
   * How long the hold runs before the reservation sweep gives the stock back.
   *
   * ⚠️ A DELIBERATE DEFAULT RATHER THAN NONE, WHICH IS THE OPPOSITE CALL FROM
   *   `stock_reservations` ON ITS OWN ENDPOINT. A manual hold is somebody
   *   deciding to keep stock back and has no natural length, so that contract
   *   makes them state one. An order has a natural length: a parcel that has not
   *   been made up within a week is an order somebody has forgotten, and the
   *   stock is more use on the shelf than held for it.
   */
  holdForDays: z.coerce.number().int().min(1).max(90).default(7),
});

export const cancelOnlineOrderRequest = z.object({
  /** ⚠️ REQUIRED BY THE CHECK CONSTRAINT TOO. "Cancelled" with no reason is what
   *   the patient rings up about. */
  reason: z.string().trim().min(4).max(2000),
});

// ---------------------------------------------------------------------------
// Packing, shipping, delivering
// ---------------------------------------------------------------------------

/**
 * Make the parcel up.
 *
 * ⚠️ THE EMPTIEST REQUEST BODY IN THE PROGRAMME, AND EVERY MISSING FIELD IS A
 *   DECISION. It names no lot (the reservations already do), no quantity (the
 *   order already does), no price (pharmacy owns none) and no regulatory answer
 *   (the server asks, at this moment, and snapshots what it is told). What is
 *   left is when it happened, because the instant a parcel was made up is not
 *   always the instant somebody got to a keyboard.
 */
export const packOnlineOrderRequest = z.object({
  /**
   * When the boxes actually left the shelf. Defaults to now.
   *
   * ⚠️ IT BECOMES `dispenses.dispensed_at` AND EVERY LEDGER LEG'S `occurred_at`,
   *   AND IT IS THE PACKING INSTANT RATHER THAN THE DELIVERY ONE. A parcel in
   *   transit is stock the clinic no longer holds, so the ledger has to move
   *   when the shelf empties; "handed over" for a remote supply is the moment
   *   the clinic parts with it.
   */
  packedAt: z.iso.datetime().optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export const shipOnlineOrderRequest = z.object({
  /** Free text, never an enum: a clinic's courier is a local firm as often as
   *  a national one, and a closed list would be a migration per market. */
  carrierName: z.string().trim().min(1).max(128),
  serviceLevel: z.string().trim().max(64).nullish(),
  trackingReference: z.string().trim().max(128).nullish(),
  packageCount: z.coerce.number().int().min(1).max(999).default(1),
  shippedAt: z.iso.datetime().optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export const deliverOnlineOrderRequest = z.object({
  deliveredAt: z.iso.datetime().optional(),
  /** ⚠️ PHI. Who actually took it, where that differs from the named recipient. */
  receivedByName: z.string().trim().max(255).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export const failOnlineOrderDeliveryRequest = z.object({
  failedAt: z.iso.datetime().optional(),
  /** ⚠️ REQUIRED BY THE CHECK CONSTRAINT. A failed delivery with no reason is a
   *  parcel nobody can go looking for. */
  reason: z.string().trim().min(4).max(2000),
});

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

export const onlineOrderLineDetail = z.object({
  id: uuid,
  lineNumber: z.number().int(),
  encounterPrescriptionId: uuid.nullable(),
  productId: uuid,
  productName: z.string(),
  quantityEntered: decimalString,
  unitId: uuid,
  unitSymbol: z.string(),
  quantityBase: decimalString,
  baseUnitSymbol: z.string(),
  /**
   * What the engine said when the order was ACCEPTED, as the counter reads it.
   *
   * ⚠️ NULL ON A DRAFT, AND IT IS NOT WHAT PERMITTED THE SUPPLY. The decision
   *   that did is on the dispense line, taken at packing under transaction
   *   `ONLINE_DISPENSE`. See the model comment for why there are two.
   */
  acceptanceDecision: dispenseRegulatorySummary.nullable(),
  /**
   * How much of this line is currently HELD, in base units.
   *
   * ⚠️ DERIVED FROM `stock_reservations` AND NEVER STORED, for the reason
   *   pharmacy stores no dispensed-so-far column: the reservations are where the
   *   quantity truth is, the sweep can release them without telling this table,
   *   and a stored copy would be a second answer free to disagree.
   */
  heldQuantityBase: decimalString,
});

export const onlineOrderShipmentDetail = z.object({
  id: uuid,
  carrierName: z.string(),
  serviceLevel: z.string().nullable(),
  trackingReference: z.string().nullable(),
  packageCount: z.number().int(),
  shippedAt: z.iso.datetime(),
  shippedByName: z.string(),
  deliveredAt: z.iso.datetime().nullable(),
  deliveredByName: z.string().nullable(),
  /** ⚠️ PHI. */
  receivedByName: z.string().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failedByName: z.string().nullable(),
  failureReason: z.string().nullable(),
  notes: z.string().nullable(),
});

export const onlineOrderSummary = z.object({
  id: uuid,
  /** Null until the order is confirmed — a draft burns no number. */
  orderNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  channel: onlineOrderChannel,
  status: onlineOrderStatus,
  /** ⚠️ PHI. */
  patientId: uuid,
  patientName: z.string(),
  patientUhid: z.string(),
  encounterId: uuid.nullable(),
  locationId: uuid,
  locationName: z.string(),
  /** Where it is going, as a jurisdiction — `IN-KA`, or `IN`. */
  destination: z.string(),
  /** ⚠️ PHI. What the parcel is addressed to; the list screen shows the town. */
  city: z.string().nullable(),
  placedAt: z.iso.datetime(),
  placedByName: z.string(),
  confirmedAt: z.iso.datetime().nullable(),
  packedAt: z.iso.datetime().nullable(),
  lineCount: z.number().int(),
  /** The supply this became, once it has been packed. */
  dispenseId: uuid.nullable(),
  dispenseNumber: z.string().nullable(),
  /** Did any line come back with something the law required of it? */
  hasConditions: z.boolean(),
});

export const onlineOrderDetail = onlineOrderSummary.extend({
  address: onlineOrderAddress,
  /** ⚠️ PHI. */
  notes: z.string().nullable(),
  confirmedByName: z.string().nullable(),
  packedByName: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledByName: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  lines: z.array(onlineOrderLineDetail),
  shipment: onlineOrderShipmentDetail.nullable(),
  createdAt: z.iso.datetime(),
});

export const onlineOrderQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  status: onlineOrderStatus.optional(),
  channel: onlineOrderChannel.optional(),
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  productId: uuid.optional(),
  /** The consignment note somebody is holding while they ring up. */
  trackingReference: z.string().trim().max(128).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const onlineOrderListResponse = z.object({
  orders: z.array(onlineOrderSummary),
  meta: listMeta,
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type OnlineOrderChannel = z.infer<typeof onlineOrderChannel>;
export type OnlineOrderStatus = z.infer<typeof onlineOrderStatus>;
export type OnlineOrderAddress = z.infer<typeof onlineOrderAddress>;

export type OnlineOrderLineRequest = z.infer<typeof onlineOrderLineRequest>;
export type CreateOnlineOrderRequest = z.infer<typeof createOnlineOrderRequest>;
export type UpdateOnlineOrderRequest = z.infer<typeof updateOnlineOrderRequest>;
export type ConfirmOnlineOrderRequest = z.infer<typeof confirmOnlineOrderRequest>;
export type CancelOnlineOrderRequest = z.infer<typeof cancelOnlineOrderRequest>;

export type PackOnlineOrderRequest = z.infer<typeof packOnlineOrderRequest>;
export type ShipOnlineOrderRequest = z.infer<typeof shipOnlineOrderRequest>;
export type DeliverOnlineOrderRequest = z.infer<typeof deliverOnlineOrderRequest>;
export type FailOnlineOrderDeliveryRequest = z.infer<typeof failOnlineOrderDeliveryRequest>;

export type OnlineOrderLineDetail = z.infer<typeof onlineOrderLineDetail>;
export type OnlineOrderShipmentDetail = z.infer<typeof onlineOrderShipmentDetail>;
export type OnlineOrderSummary = z.infer<typeof onlineOrderSummary>;
export type OnlineOrderDetail = z.infer<typeof onlineOrderDetail>;
export type OnlineOrderQuery = z.infer<typeof onlineOrderQuery>;
export type OnlineOrderListResponse = z.infer<typeof onlineOrderListResponse>;
