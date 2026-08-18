/**
 * Recall & traceability — a manufacturer's notice and the work it starts.
 *
 * Two questions: which lots are still on which shelf, and which named people
 * already received the product.
 *
 * ⚠️ THOSE TWO QUESTIONS HAVE DIFFERENT PERMISSIONS, AND THAT SEPARATION IS THE
 *   WHOLE DESIGN OF THIS ROUTER. `/traceability/forward` answers "37 supplies, 4
 *   procedures, 29 people" and names nobody. `/traceability/affected` answers
 *   "these 29 people, with their phone numbers", and needs
 *   `recall.trace.patients` **on top of** the read code. A storekeeper who can
 *   read a lot number is not thereby somebody who may pull a patient list.
 *
 * ⚠️ RESOLVING AND EXECUTING SHARE ONE CODE, DELIBERATELY. Releasing a held lot
 *   puts stock back on sale and disposing of it destroys stock; both are the same
 *   class of decision as pulling it, taken by the same person. A separate
 *   `recall.notice.resolve` would be a code nobody could explain the boundary of.
 *
 * ⚠️ EXACTLY ONE ROUTE HERE DISCLOSES ANYTHING, and the service files ONE row
 *   carrying the COUNT. Nothing else files a disclosure, correctly: a recall
 *   notice is a statement about a product.
 *
 * ⚠️ AND NOTHING HERE CARRIES A `clinical.*` CODE (invariant 7). A recall reads
 *   the dispensing and consumption registers and writes only stock movements
 *   beside them; a test asserts it.
 */
import {
  affectedPartyResponse,
  backwardTraceResponse,
  forwardTraceResponse,
  recallCandidatesResponse,
  recallDetail,
  recallListResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH_ID,
  GOODS_RECEIPT_ID,
  LOCATION_ID,
  PATIENT,
  PATIENT_ID,
  PRODUCT,
  PRODUCT_ID,
  RECALL_BATCH_ID,
  RECALL_ID,
  RECALL_NUMBER,
  SUPPLIER,
  SUPPLIER_ID,
} from './fixtures.js';

const RECALL_NOTE = 'The recall notice, as `GET /api/v1/recalls` lists it.';
const ONE_SUBJECT =
  'Name **exactly one** of `batchId` or `serialId`. Naming both or neither is a `400`.';

const RECALL_SUMMARY = {
  id: RECALL_ID,
  recallNumber: RECALL_NUMBER,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  title: 'Amoxicillin 500mg — dissolution failure',
  classification: 'CLASS_II',
  source: 'MANUFACTURER',
  status: 'DRAFT',
  noticeReference: 'CIPLA/REC/2026/018',
  noticeOn: '2026-03-16',
  reason: 'Manufacturer reports out-of-specification dissolution in affected lots.',
  batchCount: 1,
  executedAt: null,
  closedAt: null,
};

const RECALL_BATCH = {
  id: RECALL_BATCH_ID,
  batchId: BATCH_ID,
  lotNumber: BATCH.batchNumber,
  expiresOn: BATCH.expiresOn,
  status: 'PENDING',
  quantityHeldBase: null,
  resolvedAt: null,
  note: null,
};

export const recallDocs: DocRegistry = {
  'GET /api/v1/recalls': {
    summary: 'List recall notices',
    description:
      'Recall notices this clinic has recorded, and where each stands. `DRAFT` has not pulled any stock yet; `EXECUTED` has.',
    response: recallListResponse,
    paginated: true,
    params: {
      productId: 'Narrow to one product.',
      status: '`DRAFT`, `EXECUTED`, `CLOSED` or `CANCELLED`.',
      classification: 'Filter by recall class.',
      page: 'Page number, from 1.',
      limit: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft notice',
        value: {
          success: true,
          message: 'Success',
          data: { recalls: [RECALL_SUMMARY], total: 1, page: 1, limit: 25 },
        },
      },
    ],
  },

  'GET /api/v1/recalls/{id}': {
    summary: 'Get a recall notice',
    description:
      'One notice with every lot on it and what has happened to each — pending, held, released, disposed, or no stock found.',
    response: recallDetail,
    params: { id: RECALL_NOTE },
    responseExamples: [
      {
        summary: 'A draft with one lot',
        value: {
          success: true,
          message: 'Success',
          data: { ...RECALL_SUMMARY, notes: null, outcomeNote: null, batches: [RECALL_BATCH] },
        },
      },
    ],
  },

  'GET /api/v1/recalls/{id}/candidates': {
    summary: 'List candidate lots for a recall',
    description: `
Lots of this product that could be added to the notice, with where their stock
is.

⚠️ **Gated on READ rather than CREATE.** It is the picker behind the "add lots"
dialog, and somebody reviewing a recall has every reason to see what was **not**
included — which is one of the questions an audit of a recall asks.
`.trim(),
    response: recallCandidatesResponse,
    params: { id: RECALL_NOTE },
    responseExamples: [
      {
        summary: 'One lot, still on the shelf',
        value: {
          success: true,
          message: 'Success',
          data: {
            candidates: [
              {
                batchId: BATCH_ID,
                lotNumber: BATCH.batchNumber,
                expiresOn: BATCH.expiresOn,
                manufacturedOn: BATCH.manufacturedOn,
                supplierId: SUPPLIER_ID,
                supplierName: SUPPLIER.name,
                quantityOnHandBase: '480',
                isIncluded: false,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/recalls': {
    summary: 'Record a recall notice',
    description: `
Record that a manufacturer, regulator, supplier or the clinic itself has recalled
a product.

**Creating a notice pulls no stock.** It is a draft until executed, which is what
lets the affected lots be assembled and reviewed first.

\`batchIds\` may seed the notice with lots immediately, or they can be added
later.

\`classification\` records how serious the recall is — Class I being a
reasonable probability of serious harm. \`source\` records who called it, which
is what a regulator asks first.
`.trim(),
    response: recallDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: "A manufacturer's Class II notice",
        value: {
          productId: PRODUCT_ID,
          title: 'Amoxicillin 500mg — dissolution failure',
          classification: 'CLASS_II',
          source: 'MANUFACTURER',
          noticeReference: 'CIPLA/REC/2026/018',
          noticeOn: '2026-03-16',
          reason: 'Manufacturer reports out-of-specification dissolution in affected lots.',
          batchIds: [BATCH_ID],
        },
      },
    ],
    responseExamples: [
      { summary: 'Recorded', value: { success: true, message: 'Success', data: RECALL_SUMMARY } },
    ],
  },

  'PATCH /api/v1/recalls/{id}': {
    summary: 'Update a recall notice',
    description:
      "Correct the notice's descriptive fields. **`productId` is not editable** — a recall of a different product is a different notice. Lots are managed through their own endpoints.",
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE },
    requestExamples: [
      { summary: 'Escalate the class', value: { classification: 'CLASS_I' } },
      { summary: 'Add the reference', value: { noticeReference: 'CIPLA/REC/2026/018-A' } },
    ],
  },

  'POST /api/v1/recalls/{id}/batches': {
    summary: 'Add lots to a recall',
    description:
      'Put more lots on the notice. Lots added **after** execution are held immediately rather than waiting for a second execute — a lot that turns out to be affected must not sit on the shelf while paperwork catches up.',
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE },
    requestExamples: [{ summary: 'Add one lot', value: { batchIds: [BATCH_ID] } }],
  },

  'DELETE /api/v1/recalls/{id}/batches/{recallBatchId}': {
    summary: 'Remove a lot from a recall',
    description:
      '**Only while the lot is `PENDING`.** Once stock has been held against it, removing the lot would strand a ledger leg — release it instead, which is a recorded decision rather than an erasure.',
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE, recallBatchId: "The lot's row on the notice, from `batches[]`." },
  },

  'POST /api/v1/recalls/{id}/execute': {
    summary: 'Execute a recall',
    description: `
Pull the stock.

⚠️ **ONE TRANSACTION, AND IT REACHES EVERY BRANCH THE CALLER CAN SEE. This is the
single most consequential write in the system.** It makes the product
un-dispensable and un-consumable across the whole organization, and every hold it
writes is a stock-ledger leg that cannot be edited afterwards.

Each lot moves to \`HELD\` with the quantity actually found, or \`NO_STOCK\` when
there is none left — the second being a normal and important outcome, because it
says the stock has already gone out and the patient trace is the next step.

Executing an already executed notice is \`409\`. There is no un-execute: a lot
held in error is **released**, which is a recorded decision.
`.trim(),
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE },
    requestExamples: [
      {
        summary: 'With a note',
        value: { note: 'Pulled at both branches on receipt of the notice.' },
      },
      { summary: 'Without one', value: {} },
    ],
    responseExamples: [
      {
        summary: 'Executed — one lot held',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...RECALL_SUMMARY,
            status: 'EXECUTED',
            executedAt: '2026-03-17T06:00:00.000Z',
            notes: null,
            outcomeNote: null,
            batches: [{ ...RECALL_BATCH, status: 'HELD', quantityHeldBase: '480' }],
          },
        },
      },
    ],
  },

  'POST /api/v1/recalls/{id}/batches/{recallBatchId}/resolve': {
    summary: 'Release or dispose of a held lot',
    description: `
Decide what happens to stock held by a recall.

\`RELEASE\` puts it back on sale; \`DISPOSE\` destroys it. Both write stock
movements.

⚠️ **Shares \`recall.notice.execute\` with pulling the stock, deliberately.**
Releasing a held lot puts stock back on sale and disposing of it destroys stock —
both are the same class of decision as pulling it, taken by the same person.

\`note\` is **required** in both directions: "why was this released" is the
question an inspector asks, and it has to be answerable from the record.
`.trim(),
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE, recallBatchId: "The lot's row on the notice, from `batches[]`." },
    requestExamples: [
      {
        summary: 'Destroy it',
        value: { resolution: 'DISPOSE', note: 'Destroyed under supervision; certificate on file.' },
      },
      {
        summary: 'Put it back',
        value: { resolution: 'RELEASE', note: 'Manufacturer confirmed this lot is not affected.' },
      },
    ],
  },

  'POST /api/v1/recalls/{id}/close': {
    summary: 'Close a recall',
    description:
      'Finish a recall whose lots have all been resolved. `outcomeNote` is required — it is the summary an inspector reads, and a closed recall with no account of what happened is worse than an open one.',
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE },
    requestExamples: [
      {
        summary: 'Closed out',
        value: {
          outcomeNote:
            '480 capsules destroyed; 29 patients contacted, 3 returned unused stock. No adverse events reported.',
        },
      },
    ],
  },

  'POST /api/v1/recalls/{id}/cancel': {
    summary: 'Cancel a recall',
    description:
      'Withdraw a notice — usually because the manufacturer retracted it. **Any lots still held must be released first**; cancelling would otherwise leave stock quarantined with no notice explaining why. `outcomeNote` is required.',
    response: recallDetail,
    errors: [409],
    params: { id: RECALL_NOTE },
    requestExamples: [
      {
        summary: 'Manufacturer retracted',
        value: { outcomeNote: 'Manufacturer withdrew the notice on 18 March.' },
      },
    ],
  },

  'GET /api/v1/traceability/forward': {
    summary: 'Trace a lot forward',
    description: `
Where did this lot GO — how much is still on which shelf, and how much has left.

⚠️ **Names nobody.** It answers "37 supplies, 4 procedures, 29 people" in counts.
Turning those counts into names is \`GET /api/v1/traceability/affected\`, which
needs a permission this one does not.

That is the split working: somebody without the patient code still sees **how
many** people are affected, which is exactly what tells them to ask a colleague.

${ONE_SUBJECT}
`.trim(),
    response: forwardTraceResponse,
    phi: false,
    params: {
      batchId: 'The lot to trace. Exactly one of this or `serialId`.',
      serialId: 'The serial to trace. Exactly one of this or `batchId`.',
    },
    responseExamples: [
      {
        summary: 'Some on the shelf, some dispensed',
        value: {
          success: true,
          message: 'Success',
          data: {
            batchId: BATCH_ID,
            lotNumber: BATCH.batchNumber,
            productId: PRODUCT_ID,
            productName: PRODUCT.name,
            onHand: [
              {
                branchId: BRANCH_ID,
                branchName: 'Alpha Clinic — Indiranagar',
                locationId: LOCATION_ID,
                locationName: 'Indiranagar pharmacy — main store',
                quantityBase: '480',
              },
            ],
            dispenseCount: 37,
            consumptionCount: 4,
            patientCount: 29,
          },
        },
      },
    ],
  },

  'GET /api/v1/traceability/backward': {
    summary: 'Trace a lot backward',
    description: `
Where did this lot COME FROM — which supplier, on which goods receipt, at what
cost.

The other half of a recall investigation: forward answers "who has it", backward
answers "who sold it to us", which is what a claim against a supplier needs.

${ONE_SUBJECT}
`.trim(),
    response: backwardTraceResponse,
    phi: false,
    params: {
      batchId: 'The lot to trace. Exactly one of this or `serialId`.',
      serialId: 'The serial to trace. Exactly one of this or `batchId`.',
    },
    responseExamples: [
      {
        summary: 'One goods receipt',
        value: {
          success: true,
          message: 'Success',
          data: {
            batchId: BATCH_ID,
            lotNumber: BATCH.batchNumber,
            productId: PRODUCT_ID,
            productName: PRODUCT.name,
            receipts: [
              {
                goodsReceiptId: GOODS_RECEIPT_ID,
                goodsReceiptNumber: 'GRN-2026-000589',
                supplierId: SUPPLIER_ID,
                supplierName: SUPPLIER.name,
                receivedAt: '2026-03-20T05:00:00.000Z',
                quantityBase: '1000',
                unitCostBase: 1400,
                supplierInvoiceNumber: 'MS/26/4471',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/traceability/affected': {
    summary: 'List the people affected by a recall',
    description: `
Who actually received the product — names and phone numbers, so the clinic can
telephone them.

⚠️ **THE ONE PHI ROUTE IN THIS DOMAIN, AND IT REQUIRES BOTH CODES.**
\`authorize\` takes them as a list meaning **all** of them, so somebody who may
read a notice but was not given \`recall.trace.patients\` gets a \`403\` here and
a full answer on \`/forward\`. The link between a lot and a patient always exists
in the data; **who may see it is an access-control question**, and this endpoint
is where that becomes code.

Every read files a \`data_access_logs\` row carrying the **count** — this is a
disclosure about many named people at once, which is precisely what a recall is
for and precisely why it is logged.

Name exactly one of \`recallId\`, \`batchId\` or \`serialId\`.
`.trim(),
    response: affectedPartyResponse,
    phi: true,
    paginated: true,
    errors: [403],
    params: {
      recallId: 'Everybody affected by a whole notice. Exactly one of the three.',
      batchId: 'Everybody who received one lot. Exactly one of the three.',
      serialId: 'Whoever received one serialised item. Exactly one of the three.',
      page: 'Page number, from 1.',
      limit: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One affected patient',
        value: {
          success: true,
          message: 'Success',
          data: {
            parties: [
              {
                patientId: PATIENT_ID,
                patientName: PATIENT.fullName,
                uhid: PATIENT.uhid,
                phone: PATIENT.phone,
                branchId: BRANCH_ID,
                quantityBase: '15',
                lastSuppliedAt: '2026-03-17T04:37:00.000Z',
                source: 'DISPENSE',
              },
            ],
            total: 29,
            page: 1,
            limit: 25,
          },
        },
      },
    ],
  },
};
