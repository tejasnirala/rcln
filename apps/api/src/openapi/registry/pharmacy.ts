/**
 * Pharmacy — the queue, the counter, returns and the dashboard over them.
 *
 * ⚠️ THE MOST PHI-DENSE SURFACE IN THE PRODUCT. Every read here is a disclosure
 *   and writes a `data_access_logs` row carrying the matched route PATTERN, never
 *   the URL. The dashboard is the deliberate exception: it returns counts and
 *   singles out nobody.
 *
 * ⚠️ NOTHING ON THIS ROUTER WRITES THE CLINICAL RECORD (invariant 7). There is no
 *   route here that touches `encounter_prescriptions`, and the one that looks
 *   like it might — verify — writes `prescription_fulfilments`, pharmacy's own
 *   row beside the consultation. Withdrawing a prescription is the prescriber's
 *   act, and pharmacy has no route to it here or anywhere else.
 *
 * ⚠️ A REGULATORY REFUSAL IS A `422`, NEVER A `403`. A `403` says "you may not do
 *   this", which sends a pharmacist to an administrator to fix a permission that
 *   was never wrong. A `422` says "this supply is not lawful here today" and
 *   carries the rule's own sentence, written to be read aloud to the patient.
 */
import {
  dispenseDetail,
  dispenseListResponse,
  dispenseReturnDetail,
  pharmacyDashboardResponse,
  pharmacyPrescriptionDetail,
  prescriptionQueueResponse,
  substitutionResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH_ID,
  DISPENSE_ALLOCATION_ID,
  DISPENSE_ID,
  DISPENSE_LINE_ID,
  DISPENSE_LINE_PAISE,
  DISPENSE_NUMBER,
  DISPENSE_RETURN_ID,
  DISPENSED_AT,
  ENCOUNTER_ID,
  FULFILMENT_ID,
  LOCATION_ID,
  PATIENT,
  PATIENT_ID,
  PRESCRIPTION_ROW_ID,
  PRODUCT,
  PRODUCT_ID,
  SUBSTITUTE_PRODUCT_ID,
  UNIT_CAPSULE_ID,
} from './fixtures.js';

const ENCOUNTER_NOTE = 'The consultation the prescription was written on, as the queue lists it.';

const DISPENSE_SUMMARY = {
  id: DISPENSE_ID,
  dispenseNumber: DISPENSE_NUMBER,
  kind: 'PRESCRIPTION',
  status: 'DISPENSED',
  branchId: BRANCH_ID,
  locationId: LOCATION_ID,
  patientId: PATIENT_ID,
  patientName: PATIENT.fullName,
  encounterId: ENCOUNTER_ID,
  dispensedAt: DISPENSED_AT,
  lineCount: 1,
  totalMinor: DISPENSE_LINE_PAISE,
  currency: 'INR',
};

export const pharmacyDocs: DocRegistry = {
  'GET /api/v1/pharmacy/queue': {
    summary: 'List the dispensing queue',
    description: `
Prescriptions waiting at the counter — written, not yet supplied.

**PHI: every row names a patient and what they were prescribed.** Reading this
writes a \`data_access_logs\` row.

The queue is fed by signed consultations. A prescription appears here once the
consultation is finalized, and leaves when it is fully supplied or stood down.
\`status\` distinguishes the ones awaiting verification from the ones verified
and ready to hand over.
`.trim(),
    response: prescriptionQueueResponse,
    phi: true,
    paginated: true,
    params: {
      branchId: 'Which counter. Required when the caller works across branches.',
      status: 'Filter by fulfilment status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One prescription waiting',
        value: {
          success: true,
          message: 'Success',
          data: {
            items: [
              {
                encounterId: ENCOUNTER_ID,
                patientId: PATIENT_ID,
                patientName: PATIENT.fullName,
                uhid: PATIENT.uhid,
                branchId: BRANCH_ID,
                status: 'PENDING',
                prescribedAt: '2026-03-17T04:22:00.000Z',
                lineCount: 1,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },

  'GET /api/v1/pharmacy/prescriptions/{encounterId}': {
    summary: 'Read a prescription at the counter',
    description: `
One consultation's prescription as the dispensary needs it: every line, what has
already been supplied against it, and what the rules say about each.

**PHI.** Audited on every read.

⚠️ **This is pharmacy's VIEW of the clinical record, not the record itself.**
Nothing here can change what the prescriber wrote. What pharmacy records against
it — verification, supply, standing down — lives in its own tables.

\`isRepeatable\` carries the prescriber's three-state endorsement: \`null\` means
they did not address repeats, which the engine reads as no endorsement, and
\`false\` is a positive instruction that this may not be repeated.
`.trim(),
    response: pharmacyPrescriptionDetail,
    phi: true,
    params: { encounterId: ENCOUNTER_NOTE },
    responseExamples: [
      {
        summary: 'A five-day course of amoxicillin',
        value: {
          success: true,
          message: 'Success',
          data: {
            encounterId: ENCOUNTER_ID,
            patientId: PATIENT_ID,
            patientName: PATIENT.fullName,
            uhid: PATIENT.uhid,
            status: 'PENDING',
            prescribedAt: '2026-03-17T04:22:00.000Z',
            items: [
              {
                encounterPrescriptionId: PRESCRIPTION_ROW_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                strength: '500mg',
                dose: '1',
                doseUnit: 'capsule',
                route: 'ORAL',
                frequency: 3,
                frequencyUnit: 'PER_DAY',
                durationValue: 5,
                durationUnit: 'DAY',
                quantity: '15',
                isPrn: false,
                isRepeatable: null,
                quantityDispensed: '0',
                scheduleClass: 'H',
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/pharmacy/prescriptions/{encounterId}/verify': {
    summary: 'Verify a prescription',
    description: `
Record that a pharmacist has checked this prescription and it may be supplied.

⚠️ **A clinical-safety control, NOT a segregation-of-duty one.** The service
deliberately does **not** refuse self-verification — a pharmacist checking a
prescription and then dispensing it is the normal, lawful workflow, and a
dispensary with one pharmacist has nobody else. What the split buys is that a
clinic which *wants* to separate the two acts can, and that the record says which
person did which.

\`PHARMACIST\` holds \`.verify\` alongside \`.create\`.

Writes \`prescription_fulfilments\` — pharmacy's own row. It does not touch the
consultation.
`.trim(),
    phi: true,
    errors: [409, 422],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      { summary: 'Verified', value: { branchId: BRANCH_ID } },
      {
        summary: 'With a note',
        value: { branchId: BRANCH_ID, notes: 'Confirmed no penicillin allergy with patient' },
      },
    ],
    responseExamples: [
      {
        summary: 'Verified',
        value: {
          success: true,
          message: 'Success',
          data: { id: FULFILMENT_ID, encounterId: ENCOUNTER_ID, status: 'VERIFIED' },
        },
      },
    ],
  },

  'POST /api/v1/pharmacy/prescriptions/{encounterId}/cancel': {
    summary: 'Stand a prescription down',
    description: `
Take a prescription off the dispensing queue.

⚠️ **THIS STANDS THE DISPENSARY DOWN AND DOES NOT WITHDRAW THE PRESCRIPTION.**
What the prescriber wrote remains written. Withdrawing a prescription is the
prescriber's act, in the clinical record, and pharmacy has no route to it here or
anywhere else — a dispensary that could delete a doctor's instruction would be a
dispensary nobody could audit.

Use it when the patient never collected, or collected elsewhere. \`reason\` is
required.
`.trim(),
    phi: true,
    errors: [409],
    params: { encounterId: ENCOUNTER_NOTE },
    requestExamples: [
      {
        summary: 'Never collected',
        value: { branchId: BRANCH_ID, reason: 'Patient collected at an outside pharmacy' },
      },
    ],
    responseExamples: [
      {
        summary: 'Stood down',
        value: {
          success: true,
          message: 'Success',
          data: { id: FULFILMENT_ID, encounterId: ENCOUNTER_ID, status: 'CANCELLED' },
        },
      },
    ],
  },

  'GET /api/v1/pharmacy/substitutions/{productId}': {
    summary: 'Find an equivalent product',
    description: `
What could be supplied instead — same composition, different brand — and what the
rules would say about each.

⚠️ **Gated on the READ code, because it authorises nothing.** It answers "what is
equivalent and what would the rules say". The supply asks the engine **again**,
at the moment of supplying, and never trusts a decision a client sends back. A
client that cached this answer and dispensed on it would be dispensing on stale
law.

Candidates carry their own stock position, so the counter can see what is
actually on the shelf rather than what merely exists in the catalogue.
`.trim(),
    response: substitutionResponse,
    phi: false,
    params: {
      productId: 'The prescribed product to find equivalents for.',
      branchId: "Which branch's stock to report against.",
    },
    responseExamples: [
      {
        summary: 'One equivalent in stock',
        value: {
          success: true,
          message: 'Success',
          data: {
            productId: PRODUCT_ID,
            candidates: [
              {
                productId: SUBSTITUTE_PRODUCT_ID,
                productName: 'Amoxil 500mg Capsule',
                compositionMatch: 'EXACT',
                quantityOnHand: 120,
                allowed: true,
                ruleCodes: [],
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/pharmacy/dispenses': {
    summary: 'List dispenses',
    description:
      'What has been supplied, filterable by patient, product, consultation, kind and date. **PHI** — every row names who received what. Audited.',
    response: dispenseListResponse,
    phi: true,
    paginated: true,
    params: {
      branchId: 'Which counter.',
      kind: '`PRESCRIPTION` or `COUNTER_SALE`.',
      status: '`DISPENSED`, `PARTIALLY_RETURNED` or `RETURNED`.',
      patientId: 'Narrow to one patient.',
      encounterId: 'Narrow to one consultation.',
      productId: 'Narrow to supplies containing one product.',
      from: 'Earliest dispensing date, `YYYY-MM-DD`.',
      to: 'Latest dispensing date, inclusive.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: "One day's supply",
        value: {
          success: true,
          message: 'Success',
          data: { dispenses: [DISPENSE_SUMMARY], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/pharmacy/dispenses/{dispenseId}': {
    summary: 'Get a dispense',
    description:
      "One supply in full — every line, and for each the batches and serials it actually came out of. That allocation detail is what makes a recall answerable: it is the link from a manufacturer's lot number to the named people who received it. **PHI**, audited.",
    response: dispenseDetail,
    phi: true,
    params: { dispenseId: 'The supply, as `GET /api/v1/pharmacy/dispenses` lists it.' },
    responseExamples: [
      {
        summary: 'A supply from one batch',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...DISPENSE_SUMMARY,
            notes: null,
            lines: [
              {
                id: DISPENSE_LINE_ID,
                encounterPrescriptionId: PRESCRIPTION_ROW_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                quantity: '15',
                unitId: UNIT_CAPSULE_ID,
                substitutedForProductId: null,
                substitutionReason: null,
                labelInstructions: 'One capsule three times a day after food, for five days.',
                lineTotalMinor: DISPENSE_LINE_PAISE,
                allocations: [
                  {
                    id: DISPENSE_ALLOCATION_ID,
                    locationId: LOCATION_ID,
                    batchId: BATCH_ID,
                    batchNumber: BATCH.batchNumber,
                    serialId: null,
                    quantityBase: 15,
                    isOverride: false,
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/pharmacy/dispenses': {
    summary: 'Supply',
    description: `
Hand stock over the counter. **One transaction, no draft** — the stock moves, the
ledger moves and the law is consulted together, or none of it happens.

⚠️ **A COUNTER SALE COMES THROUGH THIS SAME ENDPOINT with \`kind: COUNTER_SALE\`,
rather than a \`/sales\` route of its own.** They are the same act — stock leaves
a counter, the law is consulted, the ledger moves — differing only in whether a
prescription was presented, which is a *fact about the supply* and is exactly
what \`kind\` records. Two endpoints would be two code paths to keep in step, and
the one that got less traffic would be the one that quietly stopped asking the
engine.

A \`PRESCRIPTION\` dispense must name its \`encounterId\`; a \`COUNTER_SALE\`
must not.

⚠️ **A refusal is a \`422\` carrying the rule's own sentence**, not a \`403\`.
"A Schedule H medicine requires a valid prescription" is written to be read to
the person at the counter.

\`allocations\` omitted lets the engine pick batches — normally FEFO. Naming them
takes that decision manually, and \`isOverride\` with a reason is how a
pharmacist records supplying against the engine's preference.

Losing the race for the last strip is a \`409\`, which is a normal outcome in a
busy pharmacy rather than an error.
`.trim(),
    response: dispenseDetail,
    status: 201,
    phi: true,
    errors: [409, 422],
    requestExamples: [
      {
        summary: 'Against a prescription, engine picks the batch',
        value: {
          branchId: BRANCH_ID,
          locationId: LOCATION_ID,
          kind: 'PRESCRIPTION',
          encounterId: ENCOUNTER_ID,
          patientId: PATIENT_ID,
          lines: [
            {
              encounterPrescriptionId: PRESCRIPTION_ROW_ID,
              productId: PRODUCT_ID,
              quantity: '15',
              unitId: UNIT_CAPSULE_ID,
              labelInstructions: 'One capsule three times a day after food, for five days.',
            },
          ],
        },
      },
      {
        summary: 'A counter sale',
        description: 'No consultation behind it, so `encounterId` must be absent.',
        value: {
          branchId: BRANCH_ID,
          locationId: LOCATION_ID,
          kind: 'COUNTER_SALE',
          lines: [{ productId: PRODUCT_ID, quantity: '10', unitId: UNIT_CAPSULE_ID }],
        },
      },
      {
        summary: 'A named batch, overriding the engine',
        description: 'A substitution must say why — a database CHECK refuses one that does not.',
        value: {
          branchId: BRANCH_ID,
          locationId: LOCATION_ID,
          kind: 'PRESCRIPTION',
          encounterId: ENCOUNTER_ID,
          patientId: PATIENT_ID,
          lines: [
            {
              encounterPrescriptionId: PRESCRIPTION_ROW_ID,
              productId: SUBSTITUTE_PRODUCT_ID,
              substitutedForProductId: PRODUCT_ID,
              substitutionReason: 'Prescribed brand out of stock; same composition supplied.',
              quantity: '15',
              unitId: UNIT_CAPSULE_ID,
              allocations: [
                {
                  locationId: LOCATION_ID,
                  batchId: BATCH_ID,
                  quantityBase: 15,
                  isOverride: true,
                  overrideReason: 'Nearer expiry cleared with the pharmacist',
                },
              ],
            },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Supplied',
        value: { success: true, message: 'Success', data: DISPENSE_SUMMARY },
      },
    ],
  },

  'POST /api/v1/pharmacy/dispenses/{dispenseId}/return': {
    summary: 'Take a supply back',
    description: `
Record stock coming back over the counter.

⚠️ **\`requestRestock\` is a REQUEST, not an instruction.** Whether returned
medicine may go back on the shelf is a regulatory question, not the counter's
decision — the engine answers it, and the disposition comes back as
\`RESTOCKED\` or \`QUARANTINED\`. A clinic that could restock anything by asking
would be a clinic that dispensed returned Schedule H stock to the next patient.

Returns are per **line**, and optionally per **allocation**, so a partial return
comes off the batch it actually came from — which is what keeps the recall trail
intact.

The dispense moves to \`PARTIALLY_RETURNED\` or \`RETURNED\`. \`reason\` is
required.
`.trim(),
    response: dispenseReturnDetail,
    status: 201,
    phi: true,
    errors: [409, 422],
    params: { dispenseId: 'The supply being returned against.' },
    requestExamples: [
      {
        summary: 'Full return, asking to restock',
        value: {
          locationId: LOCATION_ID,
          reason: 'Patient developed a rash; course stopped on advice.',
          requestRestock: true,
          lines: [
            {
              dispenseLineId: DISPENSE_LINE_ID,
              dispenseAllocationId: DISPENSE_ALLOCATION_ID,
              quantityBase: 15,
            },
          ],
        },
      },
      {
        summary: 'Partial return',
        value: {
          reason: 'Patient returned the unused half of the course.',
          lines: [{ dispenseLineId: DISPENSE_LINE_ID, quantityBase: 6 }],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Returned and quarantined',
        description: 'The engine refused the restock request; the stock is not back on the shelf.',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: DISPENSE_RETURN_ID,
            dispenseId: DISPENSE_ID,
            disposition: 'QUARANTINED',
            reason: 'Patient developed a rash; course stopped on advice.',
            returnedAt: '2026-03-18T05:10:00.000Z',
          },
        },
      },
    ],
  },

  'GET /api/v1/pharmacy/dashboard': {
    summary: 'Get the pharmacy dashboard',
    description: `
Counts over the counter's day — waiting, supplied, returned, and what is running
short.

⚠️ **The one read on this router that is NOT audited, and deliberately.** It
returns counts and singles out nobody: there is no patient here to disclose.
Auditing it would bury the reads that *do* name somebody under a row per screen
refresh, which is exactly the failure that makes a disclosure log useless.
`.trim(),
    response: pharmacyDashboardResponse,
    phi: false,
    params: { branchId: 'Which counter. Omitted, every branch the caller may see.' },
    responseExamples: [
      {
        summary: "A counter's day",
        value: {
          success: true,
          message: 'Success',
          data: {
            branchId: BRANCH_ID,
            pendingPrescriptions: 4,
            dispensedToday: 37,
            returnedToday: 1,
            expiringSoon: 6,
            outOfStock: 2,
          },
        },
      },
    ],
  },
};
