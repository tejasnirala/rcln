/**
 * Online pharmacy — the order, the hold, the parcel, and where it got to.
 *
 * ⚠️ EVERY READ HERE DISCLOSES A NAMED PERSON'S HOME ADDRESS BESIDE THE MEDICINE
 *   GOING TO IT, which is a broader disclosure than the dispensing surface makes
 *   and is why these reads write a `data_access_logs` row under their own
 *   `ONLINE_ORDER` resource rather than under `PRESCRIPTION`.
 *
 * ⚠️ NO PRODUCT IS ONLINEABLE BY DEFAULT. Accepting an order refuses any line
 *   whose product has no recorded position on remote supply for the fulfilling
 *   branch's jurisdiction — a `422` naming the product and the remedy. That is
 *   the CLINIC's own configuration (`product_regulatory_profiles
 *   .online_sale_position`), refused directly rather than through the rule
 *   engine, because a regulatory refusal enforces nothing until a named human
 *   signs the jurisdiction's pack off.
 *
 * ⚠️ PACKING IS A DISPENSE. It writes the `dispenses` row, moves the ledger out
 *   of the `RESERVED` bucket and raises the charge requests — through the same
 *   function the counter uses — which is why it is gated on
 *   `pharmacy.dispense.create` and not on an online-specific code.
 */
import {
  onlineOrderDetail,
  onlineOrderListResponse,
  patientConsultationsResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BRANCH_ID,
  DELIVERY_ADDRESS,
  DISPENSE_ID,
  DISPENSE_NUMBER,
  BRANCH,
  DOCTOR,
  ENCOUNTER_ID,
  LOCATION_ID,
  ONLINE_ORDER_ID,
  ONLINE_ORDER_LINE_ID,
  ONLINE_ORDER_NUMBER,
  ONLINE_SHIPMENT_ID,
  PATIENT,
  PATIENT_ID,
  PRESCRIPTION_ROW_ID,
  PRODUCT,
  PRODUCT_ID,
  TRACKING_REFERENCE,
  UNIT_CAPSULE_ID,
} from './fixtures.js';

const ORDER_SUMMARY = {
  id: ONLINE_ORDER_ID,
  orderNumber: ONLINE_ORDER_NUMBER,
  branchId: BRANCH_ID,
  branchName: 'Indiranagar',
  channel: 'PHONE',
  status: 'CONFIRMED',
  patientId: PATIENT_ID,
  patientName: PATIENT.fullName,
  patientUhid: PATIENT.uhid,
  encounterId: ENCOUNTER_ID,
  locationId: LOCATION_ID,
  locationName: 'Main dispensary',
  destination: 'IN-KA',
  city: DELIVERY_ADDRESS.city,
  placedAt: '2026-03-17T05:10:00.000Z',
  placedByName: 'Anitha Rao',
  confirmedAt: '2026-03-17T05:14:00.000Z',
  packedAt: null,
  lineCount: 1,
  dispenseId: null,
  dispenseNumber: null,
  hasConditions: false,
};

const ORDER_LINE = {
  id: ONLINE_ORDER_LINE_ID,
  lineNumber: 1,
  encounterPrescriptionId: PRESCRIPTION_ROW_ID,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  quantityEntered: '20',
  unitId: UNIT_CAPSULE_ID,
  unitSymbol: 'cap',
  quantityBase: '20',
  baseUnitSymbol: 'cap',
  acceptanceDecision: {
    outcome: 'PERMITTED_WITH_CONDITIONS',
    messages: [],
    conditions: [
      {
        kind: 'LABEL_FIELDS',
        detail: 'The label must carry the patient name, the drug, the strength and the directions.',
      },
    ],
    lowestPackMaturity: 'AUTOMATED_TESTED',
    wasEnforced: false,
  },
  heldQuantityBase: '20',
};

const ORDER_DETAIL = {
  ...ORDER_SUMMARY,
  address: DELIVERY_ADDRESS,
  notes: null,
  confirmedByName: 'Anitha Rao',
  packedByName: null,
  cancelledAt: null,
  cancelledByName: null,
  cancellationReason: null,
  lines: [ORDER_LINE],
  shipment: null,
  createdAt: '2026-03-17T05:10:00.000Z',
};

export const onlinePharmacyDocs: DocRegistry = {
  'GET /api/v1/online-orders': {
    summary: 'List online orders',
    description: `
Orders to be delivered, newest first — the dispensary's own work queue for
anything that is going out in a parcel rather than over the counter.

**PHI: every row names a patient and the town their medicine is going to.**
Reading this writes a \`data_access_logs\` row under the \`ONLINE_ORDER\`
resource, one per request rather than per result.

\`trackingReference\` is the filter to use when a patient rings up holding a
consignment note. \`status\` is the one a dispensary works down: \`DRAFT\` is
being keyed, \`CONFIRMED\` has stock held against it and is waiting to be made
up, \`PACKED\` has left the shelf, and the last three are the courier's business.
`.trim(),
    response: onlineOrderListResponse,
    phi: true,
    paginated: true,
    params: {
      branchId: 'Which dispensary is fulfilling. Required when the caller works across branches.',
      status: 'Filter by where the order has got to.',
      channel: 'How the order arrived.',
      patientId: 'Everything sent to one person.',
      encounterId: 'Everything ordered against one consultation.',
      productId: 'Every order containing one product.',
      trackingReference: 'The consignment note, matched exactly.',
      from: 'Placed on or after this day (YYYY-MM-DD).',
      to: 'Placed on or before this day (YYYY-MM-DD).',
      page: 'Page number, from 1.',
      limit: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'One order waiting to be made up',
        value: {
          success: true,
          message: 'Success',
          data: {
            orders: [ORDER_SUMMARY],
            meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
          },
        },
      },
    ],
  },

  'GET /api/v1/online-orders/patients/{patientId}/consultations': {
    summary: "List a patient's recent consultations",
    description: `
The consultations an order can be raised against, in the only shape a picker
needs: when it happened, who saw them, and how many items were prescribed.

⚠️ **This is not the clinical record, deliberately.**
\`GET /patients/{patientId}/visit-history\` answers the same question and returns
DIAGNOSES, gated on \`clinical.encounter.read\`. That is right for a doctor and
wrong for somebody taking a delivery order over the phone — so this endpoint
exists, gated on \`pharmacy.online_order.manage\`, and carries no finding, no
complaint and no note.

Finalized consultations only unless \`includeOpen\` says otherwise: an order is
dispensed against a prescription a doctor has signed, and an open consultation's
prescription may still change.

Writes a \`data_access_logs\` row — naming somebody's consultations is a
disclosure about a named patient even without the findings.
`.trim(),
    response: patientConsultationsResponse,
    errors: [404],
    responseExamples: [
      {
        summary: 'Two recent consultations',
        value: {
          consultations: [
            {
              id: ENCOUNTER_ID,
              occurredAt: '2026-09-01T09:20:00.000Z',
              status: 'FINALIZED',
              doctorName: DOCTOR.fullName,
              branchName: BRANCH.name,
              prescribedItemCount: 3,
            },
          ],
        },
      },
    ],
  },

  'GET /api/v1/online-orders/{orderId}': {
    summary: 'Read one online order',
    description: `
The whole order: the delivery address, the lines, what the rules said when it was
accepted, how much stock is still held against each line, and the consignment
once there is one.

**PHI, and the densest on this surface** — a home address, a telephone number and
a medicine on one response.

\`lines[].heldQuantityBase\` is **derived from \`stock_reservations\`, not stored**.
A hold that the reservation sweep has released reads as \`0\` here, which is what
tells a dispensary that an order it accepted last month can no longer be packed
from the stock it was promised.

\`lines[].acceptanceDecision\` is the snapshot taken when the order was ACCEPTED
and is \`null\` on a draft. It is **not** what permitted the supply — that
decision is taken again at packing, under transaction \`ONLINE_DISPENSE\`, and
lives on the dispense line.
`.trim(),
    response: onlineOrderDetail,
    phi: true,
    params: { orderId: 'The order.' },
    responseExamples: [
      {
        summary: 'Accepted, stock held, not yet packed',
        value: { success: true, message: 'Success', data: ORDER_DETAIL },
      },
    ],
  },

  'POST /api/v1/online-orders': {
    summary: 'Take an online order',
    description: `
Records what somebody asked for. **Writes a draft and nothing else** — no number
is issued, no stock is held, no law is consulted, and abandoning the draft costs
the clinic nothing.

\`patientId\` is required, which is the opposite of a counter sale: a parcel has
to go to somebody, and a supply nobody can attribute cannot be traced when the
lot behind it is recalled.

The address is **copied onto the order**, not referenced. A later correction to
\`patient_addresses\` must not rewrite where something was sent, and the
destination jurisdiction the rules are asked about comes from these columns.

One line per product. The stock is held per line, so two lines naming one
medicine would be two holds for one thing and two answers to how much is coming.
`.trim(),
    response: onlineOrderDetail,
    status: 201,
    message: 'Order taken',
    phi: true,
    errors: [409],
    requestExamples: [
      {
        summary: 'Twenty capsules, to the address on file',
        value: {
          branchId: BRANCH_ID,
          locationId: LOCATION_ID,
          channel: 'PHONE',
          patientId: PATIENT_ID,
          encounterId: ENCOUNTER_ID,
          address: DELIVERY_ADDRESS,
          lines: [
            {
              encounterPrescriptionId: PRESCRIPTION_ROW_ID,
              productId: PRODUCT_ID,
              quantity: '20',
              unitId: UNIT_CAPSULE_ID,
            },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'A draft, with no number and nothing held',
        value: {
          success: true,
          message: 'Order taken',
          data: {
            ...ORDER_DETAIL,
            orderNumber: null,
            status: 'DRAFT',
            confirmedAt: null,
            confirmedByName: null,
            lines: [{ ...ORDER_LINE, acceptanceDecision: null, heldQuantityBase: '0' }],
          },
        },
      },
    ],
  },

  'PATCH /api/v1/online-orders/{orderId}': {
    summary: 'Amend a draft order',
    description: `
Corrects an order that has not been accepted yet. **A draft only** — once the
order is \`CONFIRMED\` the law has been asked about these exact lines and stock is
held against them, so amending would leave a frozen decision describing something
else. A \`409\` says so.

The branch, the patient and the channel are deliberately absent from this body.
Each of them changes what the order fundamentally is — which jurisdiction the
rules are asked in, who the supply is attributed to, how the request arrived —
and an order entered against the wrong one is a new order rather than an edit.

Sending \`lines\` **replaces** them. A partial merge would leave a line nobody
mentioned still on the order, and the holds are taken from this list.
`.trim(),
    response: onlineOrderDetail,
    message: 'Order updated',
    phi: true,
    errors: [409],
    params: { orderId: 'The draft order.' },
    requestExamples: [
      {
        summary: 'The patient asked for thirty instead',
        value: {
          lines: [
            {
              encounterPrescriptionId: PRESCRIPTION_ROW_ID,
              productId: PRODUCT_ID,
              quantity: '30',
              unitId: UNIT_CAPSULE_ID,
            },
          ],
        },
      },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/confirm': {
    summary: 'Accept an online order and hold the stock',
    description: `
The expensive act, and the one that promises somebody their medicine. In one
transaction, per line:

1. **the clinic's gate** — the product must have a regulatory profile for the
   fulfilling branch's jurisdiction whose remote-supply position is \`PERMITTED\`
   or \`RESTRICTED\`. Anything else is a \`422\` naming the product. **No product
   is onlineable by default**, and an unstated position is not a permission.
2. **the law** — evaluated as an \`ONLINE_DISPENSE\`, with the **destination**,
   and snapshotted onto the order line.
3. **the shelf** — FEFO plans which lots would go, refusing on a shortfall.
4. **the hold** — one \`RESERVATION\` movement per lot, \`AVAILABLE\` →
   \`RESERVED\`, cited to the order line.

The order number is issued **last**, so a refusal burns none.

\`holdForDays\` decides when the reservation sweep gives the stock back. A parcel
nobody has made up within a week is an order somebody has forgotten, and the
medicine is more use on the shelf than held for it.

A \`409\` here is the shelf losing a race for the last strip — an ordinary
outcome in a busy dispensary, not a fault.
`.trim(),
    response: onlineOrderDetail,
    message: 'Order accepted',
    phi: true,
    errors: [409, 422],
    params: { orderId: 'The draft order.' },
    requestExamples: [
      { summary: 'Hold it for a week', value: { holdForDays: 7 } },
      { summary: 'Collect tomorrow, hold it for two days', value: { holdForDays: 2 } },
    ],
    responseExamples: [
      {
        summary: 'Accepted, twenty capsules held',
        value: { success: true, message: 'Order accepted', data: ORDER_DETAIL },
      },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/cancel': {
    summary: 'Stand an online order down',
    description: `
Releases every hold and closes the order, with a reason.

**Before packing only.** Once the parcel has been made up the medicine has
physically left the shelf, and undoing that is a return against the dispense —
which asks the law where the stock may be put and quarantines it by default. A
\`409\` says so.

A hold the reservation sweep has already released is not an error: the release
path claims the row before it moves anything, and a cancellation that threw on a
lost race would be unable to cancel exactly the orders most in need of it.
`.trim(),
    response: onlineOrderDetail,
    message: 'Order stood down',
    phi: true,
    errors: [409],
    params: { orderId: 'The order.' },
    requestExamples: [
      {
        summary: 'The patient collected it in person instead',
        value: { reason: 'Collected at the counter — patient was passing.' },
      },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/pack': {
    summary: 'Make the parcel up',
    description: `
**This is the supply.** It consumes the holds, writes the \`dispenses\` row and
its lines and allocations, moves the ledger \`RESERVED\` → out, and raises the
charge requests — all through the same function the counter dispenses with, in
one transaction.

Gated on \`pharmacy.dispense.create\` rather than on an online code, because it
is the same act: medicine leaves a shelf into somebody's possession. The only
difference from the counter is that the person receiving it is not in the room.

**The body names no lot and no quantity.** The lots were chosen by FEFO and
reserved at confirmation; the quantities are on the order. Accepting either here
would be a second allocation decision over stock already spoken for.

\`packedAt\` becomes \`dispenses.dispensed_at\` and every ledger leg's
\`occurred_at\`, and it is the **packing** instant rather than the delivery one: a
parcel in transit is stock the clinic no longer holds.

A \`409\` means part of the hold went away while the parcel was being made up —
the sweep released it, or somebody cancelled. Nothing is dispensed short.
`.trim(),
    response: onlineOrderDetail,
    message: 'Packed',
    phi: true,
    errors: [409, 422],
    params: { orderId: 'The accepted order.' },
    requestExamples: [
      { summary: 'Now', value: {} },
      {
        summary: 'Made up before the shift ended, keyed the next morning',
        value: { packedAt: '2026-03-17T13:40:00.000Z' },
      },
    ],
    responseExamples: [
      {
        summary: 'Packed, and the dispense it became',
        value: {
          success: true,
          message: 'Packed',
          data: {
            ...ORDER_DETAIL,
            status: 'PACKED',
            packedAt: '2026-03-17T13:40:00.000Z',
            packedByName: 'Anitha Rao',
            dispenseId: DISPENSE_ID,
            dispenseNumber: DISPENSE_NUMBER,
            lines: [{ ...ORDER_LINE, heldQuantityBase: '0' }],
          },
        },
      },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/ship': {
    summary: 'Hand the parcel to a carrier',
    description: `
Records the consignment: who is carrying it, under what service, against what
tracking number.

**One consignment per order.** Partial shipment is deliberately not built — a
second row would be a second answer to "where is the parcel", and splitting a
consignment would mean splitting the dispense, the charge requests and the
reservations three ways. A clinic that must split places two orders.

This moves no stock. The medicine left the clinic's books when the parcel was
made up.
`.trim(),
    response: onlineOrderDetail,
    message: 'Handed to the carrier',
    phi: true,
    errors: [409],
    params: { orderId: 'The packed order.' },
    requestExamples: [
      {
        summary: 'One box, next-day, with a consignment note',
        value: {
          carrierName: 'Bluedart',
          serviceLevel: 'Next day',
          trackingReference: TRACKING_REFERENCE,
          packageCount: 1,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'With the courier',
        value: {
          success: true,
          message: 'Handed to the carrier',
          data: {
            ...ORDER_DETAIL,
            status: 'SHIPPED',
            packedAt: '2026-03-17T13:40:00.000Z',
            packedByName: 'Anitha Rao',
            dispenseId: DISPENSE_ID,
            dispenseNumber: DISPENSE_NUMBER,
            lines: [{ ...ORDER_LINE, heldQuantityBase: '0' }],
            shipment: {
              id: ONLINE_SHIPMENT_ID,
              carrierName: 'Bluedart',
              serviceLevel: 'Next day',
              trackingReference: TRACKING_REFERENCE,
              packageCount: 1,
              shippedAt: '2026-03-17T14:05:00.000Z',
              shippedByName: 'Anitha Rao',
              deliveredAt: null,
              deliveredByName: null,
              receivedByName: null,
              failedAt: null,
              failedByName: null,
              failureReason: null,
              notes: null,
            },
          },
        },
      },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/deliver': {
    summary: 'Record that the parcel arrived',
    description: `
Closes the delivery out. Reachable from \`SHIPPED\` **and** from
\`DELIVERY_FAILED\`: a courier failing on Tuesday and delivering on Wednesday is
the ordinary case, and the failed attempt is **not erased** — clearing it would
hide an attempt somebody may have to answer for.

\`receivedByName\` is who actually took it, where that differs from the recipient
the order named. **PHI**, and deliberately absent from the audit row.

A delivery dated before the failed attempt it follows is a \`400\`: a parcel
cannot arrive before it failed to.
`.trim(),
    response: onlineOrderDetail,
    message: 'Delivered',
    phi: true,
    errors: [409],
    params: { orderId: 'The shipped order.' },
    requestExamples: [
      { summary: 'The patient signed for it', value: {} },
      { summary: 'A neighbour took it in', value: { receivedByName: 'Meera Subramanian' } },
    ],
  },

  'POST /api/v1/online-orders/{orderId}/delivery-failed': {
    summary: 'Record a failed delivery attempt',
    description: `
The courier could not deliver it.

**This moves no stock, and that is deliberate rather than incomplete.** The
parcel is somewhere — a depot, a van, a neighbour — and the clinic does not have
it back. Putting the quantity on the shelf on the strength of a courier's status
update would make the balance say the clinic holds medicine it cannot find.

When the parcel physically returns, record a **return against the dispense**
(\`POST /api/v1/pharmacy/dispenses/{dispenseId}/return\`), which asks the law
where it may be put and quarantines it by default — a sharper question for a
parcel than for a counter return, because nobody can attest to how it was stored
in a van.

The attempt can still be followed by a successful delivery; both stand.
`.trim(),
    response: onlineOrderDetail,
    message: 'Failed attempt recorded',
    phi: true,
    errors: [409],
    params: { orderId: 'The shipped order.' },
    requestExamples: [
      {
        summary: 'Nobody at home',
        value: { reason: 'Nobody at the address; card left, re-attempt tomorrow.' },
      },
    ],
  },
};
