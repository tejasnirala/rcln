/**
 * Charging & consumption — the seam between what was supplied and what is
 * billed, and what a procedure actually consumed.
 *
 * **Two facts, deliberately not derived from each other.** What left the shelf is
 * a stock fact; what the patient pays is a commercial one. A clinic that gives
 * away sutures and one that itemises them both record the same consumption.
 *
 * ⚠️ THREE WRITE CODES ON THE CHARGING SIDE, AND THEY ARE THREE DIFFERENT BLAST
 *   RADII. Deciding one charge affects one patient. Editing the policy decides
 *   every future supply of a product at every branch, silently and with no row to
 *   review. Setting a price decides what every future bill says. A single
 *   `billing.charging.manage` would hand the front desk all three the day
 *   somebody grants it to answer one `OPTIONAL` charge.
 *
 * ⚠️ `consumption.override` IS ENFORCED IN THE SERVICE, NOT BY `authorize`, and
 *   it is the one code here that could not be. Whether a body contains a variance
 *   is not knowable until the expected quantities have been read and the units
 *   converted — which is most of the work of recording one.
 *
 * ⚠️ NOTHING ON THE CONSUMPTION ROUTER CARRIES A `clinical.*` CODE, and a test
 *   asserts it. Recording what a procedure consumed writes a stock movement
 *   anchored to a consultation and no clinical content: the arrow points one way,
 *   reading the encounter and writing only beside it. Invariant 7 holds.
 *
 * ⚠️ AND NOTHING HERE STATES A PRICE ON THE CONSUMPTION SIDE. The money is a
 *   charge request raised inside the recording transaction; there is no route
 *   through which a caller could say what something costs.
 */
import {
  consumptionDetail,
  consumptionPlanResponse,
  consumptionTemplateDetail,
  consumptionTemplateListResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH_ID,
  CHARGE_POLICY_RULE_ID,
  CHARGE_REQUEST_ID,
  CONSUMPTION_LINE_ID,
  CONSUMPTION_RECORD_ID,
  CONSUMPTION_TEMPLATE_ID,
  CONSUMPTION_TEMPLATE_LINE_ID,
  ENCOUNTER_ID,
  ENCOUNTER_PROCEDURE_ID,
  LOCATION_ID,
  PATIENT,
  PATIENT_ID,
  PRODUCT,
  PRODUCT_ID,
  PRODUCT_PRICE_ID,
  UNIT_CAPSULE_ID,
} from './fixtures.js';

const POLICY_MEANINGS = `
\`NEVER_BILL\` — never charged, no request raised.
\`INCLUDED_IN_SERVICE\` — covered by the consultation or procedure fee.
\`SEPARATELY_BILLABLE\` — always charged; a request is raised and pre-approved.
\`OPTIONAL\` — a human decides, one supply at a time. This is what fills the queue.
\`CONTRACT_DEFINED\` — the patient's scheme decides.
\`JURISDICTION_CONFIGURED\` — the law decides.
`.trim();

const CHARGE_REQUEST = {
  id: CHARGE_REQUEST_ID,
  branchId: BRANCH_ID,
  kind: 'SUPPLY',
  status: 'PENDING',
  patientId: PATIENT_ID,
  patientName: PATIENT.fullName,
  encounterId: ENCOUNTER_ID,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  quantityBase: '15',
  unitId: UNIT_CAPSULE_ID,
  policy: 'OPTIONAL',
  unitPriceMinor: 1600,
  amountMinor: 24000,
  currency: 'INR',
  raisedAt: '2026-03-17T04:37:00.000Z',
  decidedAt: null,
  suppressedReason: null,
};

const TEMPLATE = {
  id: CONSUMPTION_TEMPLATE_ID,
  itemId: ENCOUNTER_PROCEDURE_ID,
  itemName: 'Wound dressing',
  name: 'Wound dressing — standard tray',
  status: 'ACTIVE',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  notes: null,
  lineCount: 1,
};

const RECORD = {
  id: CONSUMPTION_RECORD_ID,
  branchId: BRANCH_ID,
  anchorKind: 'ENCOUNTER_PROCEDURE',
  encounterId: ENCOUNTER_ID,
  encounterProcedureId: ENCOUNTER_PROCEDURE_ID,
  patientId: PATIENT_ID,
  locationId: LOCATION_ID,
  kind: 'PROCEDURE',
  occurredAt: '2026-03-17T04:30:00.000Z',
  notes: null,
  lineCount: 1,
};

export const chargingDocs: DocRegistry = {
  'GET /api/v1/charging/requests': {
    summary: 'List charge requests',
    description: `
The queue of supplies waiting on a billing decision.

⚠️ **A disclosure — it names a patient beside a medicine** — so every read writes
a \`data_access_logs\` row.

Most rows here are \`OPTIONAL\` under the standing policy: everything the policy
already decided was either billed or suppressed without a human seeing it. This
queue is what is left over.
`.trim(),
    phi: true,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      status: '`PENDING`, `SUPPRESSED`, `INVOICED` or `CANCELLED`.',
      patientId: 'Narrow to one patient.',
      encounterId: 'Narrow to one consultation.',
      from: 'Earliest raised date.',
      to: 'Latest raised date, inclusive.',
      page: 'Page number, from 1.',
      limit: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'One supply awaiting a decision',
        value: {
          success: true,
          message: 'Success',
          data: { requests: [CHARGE_REQUEST], total: 1, page: 1, limit: 50 },
        },
      },
    ],
  },

  'GET /api/v1/charging/requests/summary': {
    summary: 'Summarise the charge queue',
    description: `
How many charges are waiting and what they come to.

⚠️ **The deliberate exception to the disclosure rule on this router.** It returns
counts and one sum, singles out nobody, and renders on every poll — auditing it
would bury the reads that *do* name a patient.
`.trim(),
    phi: false,
    params: { branchId: 'Narrow to one branch.' },
    responseExamples: [
      {
        summary: 'Twelve waiting',
        value: {
          success: true,
          message: 'Success',
          data: { pendingCount: 12, pendingAmountMinor: 187400, currency: 'INR' },
        },
      },
    ],
  },

  'POST /api/v1/charging/requests/{id}/decide': {
    summary: 'Decide a charge',
    description: `
Bill this supply, or suppress it.

**A discriminated union: \`BILL\` may carry a \`unitPriceMinor\`; \`SUPPRESS\`
must carry a \`reason\`.** A suppression with no reason is a write-off nobody can
account for later, which is why the contract will not accept one.

⚠️ **Overriding the price needs \`billing.fee_schedule.manage\` as well.** The
route gates the decision; supplying a \`unitPriceMinor\` is a *pricing* act, and
whoever may answer an optional charge does not thereby get to set what it costs.

Deciding an already decided or invoiced request is \`409\`. Billing does not
raise an invoice — that is \`POST /api/v1/invoices/from-charges\`.
`.trim(),
    phi: true,
    errors: [403, 409],
    params: { id: 'The charge request, as `GET /api/v1/charging/requests` lists it.' },
    requestExamples: [
      { summary: 'Bill it at the standing price', value: { decision: 'BILL' } },
      {
        summary: 'Bill it at an agreed price',
        description: 'Needs `billing.fee_schedule.manage` on top of the decision code.',
        value: { decision: 'BILL', unitPriceMinor: 1400 },
      },
      {
        summary: 'Suppress it',
        description: '`reason` is required — a write-off has to be accountable.',
        value: { decision: 'SUPPRESS', reason: 'Goodwill — replaced a dressing that failed' },
      },
    ],
    responseExamples: [
      {
        summary: 'Billed',
        value: {
          success: true,
          message: 'Success',
          data: { ...CHARGE_REQUEST, status: 'PENDING', decidedAt: '2026-03-17T05:00:00.000Z' },
        },
      },
    ],
  },

  'GET /api/v1/charging/policies': {
    summary: 'List charge policy rules',
    description: `
The standing rules that decide whether a supply is billed at all, without anybody
looking at it.

${POLICY_MEANINGS}

Rules are scoped \`PRODUCT\` → \`PRODUCT_CATEGORY\` → \`PRODUCT_TYPE\` →
\`DEFAULT\`, most specific winning.
`.trim(),
    paginated: true,
    params: {
      scope: 'Filter to one scope level.',
      productId: 'Narrow to rules touching one product.',
      page: 'Page number, from 1.',
      limit: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'A product-level rule',
        value: {
          success: true,
          message: 'Success',
          data: {
            rules: [
              {
                id: CHARGE_POLICY_RULE_ID,
                scope: 'PRODUCT',
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                productCategoryId: null,
                productCategoryName: null,
                productType: null,
                policy: 'SEPARATELY_BILLABLE',
                note: null,
                updatedAt: '2026-01-04T05:30:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            limit: 50,
          },
        },
      },
    ],
  },

  'GET /api/v1/charging/policies/resolve': {
    summary: 'Resolve the policy for a product',
    description:
      'Which rule actually applies to one product, and at which scope it was found. What a screen shows when somebody asks "why was this billed" — the answer is a rule, and this names it.',
    params: { productId: 'The product to resolve. Required.' },
    responseExamples: [
      {
        summary: 'Matched at product level',
        value: {
          success: true,
          message: 'Success',
          data: {
            productId: PRODUCT_ID,
            policy: 'SEPARATELY_BILLABLE',
            matchedScope: 'PRODUCT',
            ruleId: CHARGE_POLICY_RULE_ID,
          },
        },
      },
      {
        summary: 'Fell through to the default',
        value: {
          success: true,
          message: 'Success',
          data: {
            productId: PRODUCT_ID,
            policy: 'INCLUDED_IN_SERVICE',
            matchedScope: 'DEFAULT',
            ruleId: null,
          },
        },
      },
    ],
  },

  'POST /api/v1/charging/policies': {
    summary: 'Create a charge policy rule',
    description: `
Decide, standingly, whether a class of supply is billed.

⚠️ **This decides every future supply of the product at every branch, silently
and with no row to review.** That is why it sits behind
\`billing.charge_policy.manage\` and not the code that answers a single queued
charge — the blast radius is the whole clinic, not one patient.

${POLICY_MEANINGS}

A rule at a scope that already has one is \`409\`; update that one instead.
`.trim(),
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Always bill this product',
        value: {
          target: { scope: 'PRODUCT', productId: PRODUCT_ID },
          policy: 'SEPARATELY_BILLABLE',
        },
      },
      {
        summary: 'Consumables are included in the fee',
        value: {
          target: { scope: 'PRODUCT_TYPE', productType: 'CONSUMABLE' },
          policy: 'INCLUDED_IN_SERVICE',
          note: 'Covered by the procedure fee since April 2026.',
        },
      },
    ],
  },

  'PATCH /api/v1/charging/policies/{id}': {
    summary: 'Update a charge policy rule',
    description:
      'Change what a standing rule decides. **`target` is not editable** — a rule about a different product is a different rule. Existing charge requests are not retrospectively re-decided; the change applies to future supplies.',
    errors: [409],
    params: { id: 'The rule, as `GET /api/v1/charging/policies` lists it.' },
    requestExamples: [{ summary: 'Make it optional instead', value: { policy: 'OPTIONAL' } }],
  },

  'DELETE /api/v1/charging/policies/{id}': {
    summary: 'Delete a charge policy rule',
    description:
      'Remove a rule so supplies fall through to the next scope up. Charge requests already raised are unaffected.',
    errors: [409],
    params: { id: 'The rule, as `GET /api/v1/charging/policies` lists it.' },
  },

  'GET /api/v1/charging/prices': {
    summary: 'List product prices',
    description:
      'What the clinic charges for a product, per unit, optionally per branch. A `branchId` of `null` is the clinic-wide price a branch price overrides.',
    paginated: true,
    params: {
      productId: 'Narrow to one product.',
      branchId: 'Narrow to one branch.',
      page: 'Page number, from 1.',
      limit: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'A clinic-wide price',
        value: {
          success: true,
          message: 'Success',
          data: {
            prices: [
              {
                id: PRODUCT_PRICE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                branchId: null,
                branchName: null,
                unitId: UNIT_CAPSULE_ID,
                unitSymbol: 'cap',
                amountMinor: 1600,
                currency: 'INR',
                updatedAt: '2026-01-04T05:30:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            limit: 50,
          },
        },
      },
    ],
  },

  'PUT /api/v1/charging/prices': {
    summary: 'Set a product price',
    description: `
Set what a product costs, per unit.

**An upsert keyed on product + branch + unit**, which is why it is a \`PUT\` with
no id in the path — the caller states what should be true rather than hunting for
whether a row exists.

\`branchId: null\` sets the clinic-wide price; a branch id overrides it there.

⚠️ **Behind \`billing.fee_schedule.manage\`, reusing the code that already means
"may set what this clinic charges" rather than inventing a second pricing
permission.** Two pricing codes is how a screen quotes one number and the bill
states another.

\`amountMinor\` is in minor units.
`.trim(),
    errors: [409],
    requestExamples: [
      {
        summary: '₹16 a capsule, clinic-wide',
        value: {
          productId: PRODUCT_ID,
          branchId: null,
          unitId: UNIT_CAPSULE_ID,
          amountMinor: 1600,
        },
      },
      {
        summary: 'A different price at Kochi',
        value: {
          productId: PRODUCT_ID,
          branchId: BRANCH_ID,
          unitId: UNIT_CAPSULE_ID,
          amountMinor: 1750,
        },
      },
    ],
  },

  'DELETE /api/v1/charging/prices/{id}': {
    summary: 'Delete a product price',
    description:
      'Remove a price. A branch price deleted falls back to the clinic-wide one; the clinic-wide one deleted leaves the product with no standing price, so every charge needs one stated explicitly.',
    errors: [409],
    params: { id: 'The price row, as `GET /api/v1/charging/prices` lists it.' },
  },

  'GET /api/v1/consumption/templates': {
    summary: 'List consumption templates',
    description:
      'What a procedure is *expected* to use. The expectation a recording is compared against — a variance from it is what `consumption.override` gates.',
    response: consumptionTemplateListResponse,
    paginated: true,
    params: {
      itemId: 'Narrow to templates for one procedure.',
      status: '`DRAFT`, `ACTIVE` or `RETIRED`.',
      page: 'Page number, from 1.',
      limit: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One active template',
        value: {
          success: true,
          message: 'Success',
          data: { templates: [TEMPLATE], total: 1, page: 1, limit: 25 },
        },
      },
    ],
  },

  'GET /api/v1/consumption/templates/{id}': {
    summary: 'Get a consumption template',
    description:
      'One template with every expected line. `isOptional` marks lines whose absence is not a variance — a suture size that depends on the wound.',
    response: consumptionTemplateDetail,
    params: { id: 'The template, as `GET /api/v1/consumption/templates` lists it.' },
    responseExamples: [
      {
        summary: 'A dressing tray',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...TEMPLATE,
            lines: [
              {
                id: CONSUMPTION_TEMPLATE_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                quantity: '2',
                unitId: UNIT_CAPSULE_ID,
                isOptional: false,
                displayOrder: 0,
                note: null,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/consumption/templates': {
    summary: 'Create a consumption template',
    description: `
Declare what a procedure normally uses.

**A statement about a procedure, not about a patient** — no patient appears in
the request or the response, and these routes file no disclosure row.

Created \`DRAFT\` by default; only an \`ACTIVE\` template within its effective
window is used to pre-fill and to detect variance.

Effective-dated, so a change in practice is a new window rather than an edit that
retrospectively makes past recordings look like variances.
`.trim(),
    response: consumptionTemplateDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A dressing tray',
        value: {
          itemId: ENCOUNTER_PROCEDURE_ID,
          name: 'Wound dressing — standard tray',
          status: 'ACTIVE',
          effectiveFrom: '2026-01-01',
          lines: [
            { productId: PRODUCT_ID, quantity: '2', unitId: UNIT_CAPSULE_ID, isOptional: false },
          ],
        },
      },
    ],
  },

  'PATCH /api/v1/consumption/templates/{id}': {
    summary: 'Update a consumption template',
    description:
      'Rename a template, change its window or status, or replace its lines. Sending `lines` replaces the whole set. **`itemId` is not editable** — a template for a different procedure is a different template.',
    response: consumptionTemplateDetail,
    errors: [409],
    params: { id: 'The template.' },
    requestExamples: [
      { summary: 'Activate it', value: { status: 'ACTIVE' } },
      { summary: 'Retire it', value: { status: 'RETIRED', effectiveTo: '2026-03-31' } },
    ],
  },

  'DELETE /api/v1/consumption/templates/{id}': {
    summary: 'Delete a consumption template',
    description:
      '**A template already cited by a recording is `409`** — that recording is measured against it, and deleting it would make its variances unexplainable. Retire it instead.',
    errors: [409],
    params: { id: 'The template.' },
  },

  'GET /api/v1/consumption/plan': {
    summary: 'Plan a consumption',
    description: `
What this procedure is expected to use, with the lots that would satisfy it —
what the recording panel pre-fills from.

⚠️ **A plan, not a hold.** Nothing is reserved and nothing moves. Candidate lots
are offered first-expiry-first; between this call and the recording, somebody
else may take them.

Returns the template's expected quantities so the person recording sees what they
are departing from, which is the whole point of a variance being a deliberate
act.
`.trim(),
    response: consumptionPlanResponse,
    params: {
      encounterId: 'The consultation. Required.',
      encounterProcedureId: 'The procedure within it.',
      branchId: 'Which branch.',
      locationId: 'Which location to draw stock from.',
    },
    responseExamples: [
      {
        summary: 'Expected two, one lot available',
        value: {
          success: true,
          message: 'Success',
          data: {
            templateId: CONSUMPTION_TEMPLATE_ID,
            lines: [
              {
                templateLineId: CONSUMPTION_TEMPLATE_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                expectedQuantity: '2',
                unitId: UNIT_CAPSULE_ID,
                isOptional: false,
                candidateLots: [
                  {
                    locationId: LOCATION_ID,
                    batchId: BATCH_ID,
                    lotNumber: BATCH.batchNumber,
                    expiresOn: BATCH.expiresOn,
                    quantityAvailableBase: '480',
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/consumption/records': {
    summary: 'List consumption records',
    description:
      'What procedures actually used. **A disclosure** — a named person, a product, sometimes a serial number — so every read is audited.',
    phi: true,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      encounterId: 'Narrow to one consultation.',
      patientId: 'Narrow to one patient.',
      from: 'Earliest occurrence date.',
      to: 'Latest occurrence date, inclusive.',
      page: 'Page number, from 1.',
      limit: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One recording',
        value: {
          success: true,
          message: 'Success',
          data: { records: [RECORD], total: 1, page: 1, limit: 25 },
        },
      },
    ],
  },

  'GET /api/v1/consumption/records/{id}': {
    summary: 'Get a consumption record',
    description:
      'One recording with every line, the lots it came out of, and any variance from the template with the reason given. **PHI**, audited.',
    response: consumptionDetail,
    phi: true,
    params: { id: 'The recording, as `GET /api/v1/consumption/records` lists it.' },
    responseExamples: [
      {
        summary: 'Two used, as expected',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...RECORD,
            lines: [
              {
                id: CONSUMPTION_LINE_ID,
                templateLineId: CONSUMPTION_TEMPLATE_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                quantity: '2',
                unitId: UNIT_CAPSULE_ID,
                expectedQuantity: '2',
                isVariance: false,
                overrideReason: null,
                allocations: [
                  {
                    locationId: LOCATION_ID,
                    batchId: BATCH_ID,
                    quantityBase: 2,
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

  'POST /api/v1/consumption/records': {
    summary: 'Record what was consumed',
    description: `
Record what a procedure actually used. **Stock moves here.**

⚠️ **Departing from the template needs \`consumption.override\`, and that check
happens INSIDE the handler rather than at the route.** Whether a body contains a
variance is not knowable until the expected quantities have been read and the
units converted — which is most of the work of recording one. So the route gates
\`consumption.record\` and the narrower act is gated within it. A variance
without the code is a \`403\`; a variance without an \`overrideReason\` is a
\`400\`.

⚠️ **This states no price.** The money side is a charge request raised inside the
same transaction, decided later against the standing policy. There is no route
here through which a caller could say what something costs.

\`anchorKind: ENCOUNTER_PROCEDURE\` must name its \`encounterProcedureId\`;
\`ENCOUNTER\` must not.

\`allocations\` omitted lets the engine pick lots, first expiry first.
`.trim(),
    response: consumptionDetail,
    status: 201,
    phi: true,
    errors: [403, 409],
    requestExamples: [
      {
        summary: 'Exactly what the template expected',
        value: {
          branchId: BRANCH_ID,
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId: ENCOUNTER_ID,
          encounterProcedureId: ENCOUNTER_PROCEDURE_ID,
          locationId: LOCATION_ID,
          lines: [
            {
              templateLineId: CONSUMPTION_TEMPLATE_LINE_ID,
              productId: PRODUCT_ID,
              quantity: '2',
              unitId: UNIT_CAPSULE_ID,
            },
          ],
        },
      },
      {
        summary: 'A variance',
        description: 'Needs `consumption.override`, and `overrideReason` is required.',
        value: {
          branchId: BRANCH_ID,
          anchorKind: 'ENCOUNTER_PROCEDURE',
          encounterId: ENCOUNTER_ID,
          encounterProcedureId: ENCOUNTER_PROCEDURE_ID,
          locationId: LOCATION_ID,
          lines: [
            {
              templateLineId: CONSUMPTION_TEMPLATE_LINE_ID,
              productId: PRODUCT_ID,
              quantity: '4',
              unitId: UNIT_CAPSULE_ID,
              overrideReason: 'Wound larger than expected; second dressing required.',
            },
          ],
        },
      },
    ],
  },

  'PATCH /api/v1/consumption/records/{id}': {
    summary: 'Amend a consumption record',
    description: `
Correct a recording that was keyed wrong — the whole line set is replaced and the
stock difference is written as compensating movements.

\`reason\` is required and is kept on the record.

**For stock genuinely used or returned afterwards, use
\`POST /{id}/corrections\` instead.** An amendment says "this is what happened";
a correction says "and then this also happened". Collapsing them makes the
difference between a keying error and a second dressing unanswerable.
`.trim(),
    response: consumptionDetail,
    phi: true,
    errors: [403, 409],
    params: { id: 'The recording.' },
    requestExamples: [
      {
        summary: 'Keyed the wrong quantity',
        value: {
          reason: 'Keyed 4, actually used 2.',
          lines: [
            {
              templateLineId: CONSUMPTION_TEMPLATE_LINE_ID,
              productId: PRODUCT_ID,
              quantity: '2',
              unitId: UNIT_CAPSULE_ID,
            },
          ],
        },
      },
    ],
  },

  'POST /api/v1/consumption/records/{id}/corrections': {
    summary: 'Add a correction to a consumption record',
    description: `
Record additional consumption, or a reversal, against an existing recording.

\`ADDITIONAL_CONSUMPTION\` is more stock used after the fact;
\`CONSUMPTION_REVERSAL\` is stock put back.

**Distinct from an amendment, deliberately.** The original recording stays
exactly as it was and the correction sits beside it, so the record can answer
both "what was recorded at the time" and "what was eventually used" — which an
edit-in-place destroys.

Charge requests are raised or reversed to match, so the bill follows the
correction without anybody restating a price.
`.trim(),
    response: consumptionDetail,
    status: 201,
    phi: true,
    errors: [403, 409],
    params: { id: 'The recording being corrected.' },
    requestExamples: [
      {
        summary: 'More used afterwards',
        value: {
          kind: 'ADDITIONAL_CONSUMPTION',
          reason: 'Dressing changed again the same afternoon.',
          lines: [{ productId: PRODUCT_ID, quantity: '2', unitId: UNIT_CAPSULE_ID }],
        },
      },
      {
        summary: 'Put back unopened',
        value: {
          kind: 'CONSUMPTION_REVERSAL',
          reason: 'Second tray opened but not used; returned to the shelf.',
          lines: [{ productId: PRODUCT_ID, quantity: '2', unitId: UNIT_CAPSULE_ID }],
        },
      },
    ],
  },
};
