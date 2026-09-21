/**
 * Invoicing & tax — what the clinic bills a PATIENT, the registrations it bills
 * under, and what a visit costs.
 *
 * **Not the subscription rcln charges the clinic** — that is Billing.
 *
 * ⚠️ `billing.invoice.read` GETS YOU THE SURFACE; WHAT YOU SEE ON IT IS DERIVED.
 *   Every read resolves the caller's visible SOURCES first — a pharmacist sees
 *   pharmacy invoices, the accountant sees all of them — and applies that set in
 *   the QUERY, never as a default for a `?sourceType=` the caller passed. **A
 *   filter the client controls is not a boundary.** The rule is consulted by the
 *   list, the detail, the document and the PDF alike, because three copies of it
 *   is how a download link outlives the list it was hidden from.
 *
 * ⚠️ A PHI SURFACE. An invoice carries a customer name and, in every line
 *   description, what the patient was treated for. **The list contract
 *   deliberately has no free-text search parameter**, because a name in a query
 *   string is a name in the proxy log, the browser history and the referrer of
 *   the next request.
 *
 * ⚠️ MONEY IS MINOR UNITS AND NEVER A FLOAT. `unitPriceMinor` is an integer on
 *   the wire; the engine refuses a currency mismatch rather than silently
 *   re-denominating.
 */
import { feeQuote, feeScheduleView } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  APPOINTMENT_ID,
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  CHARGE_REQUEST_ID,
  CONSULTATION_FEE_PAISE,
  CREDIT_NOTE_ID,
  DOCTOR_ID,
  GST_RATE_PERCENT,
  INVOICE_ID,
  INVOICE_ITEM_ID,
  INVOICE_NUMBER,
  INVOICE_TOTAL_PAISE,
  PATIENT,
  PATIENT_ID,
  TAX_REGISTRATION_ID,
  TAX_RULE_ID,
  TODAY,
} from './fixtures.js';

const INVOICE_NOTE =
  "The invoice. One outside the caller's visible sources is answered `404` — the visibility rule applies to the detail, the document and the PDF exactly as it does to the list.";

const INVOICE_SUMMARY = {
  id: INVOICE_ID,
  invoiceNumber: null,
  kind: 'INVOICE',
  status: 'DRAFT',
  sourceType: 'APPOINTMENT',
  branchId: BRANCH_ID,
  appointmentId: APPOINTMENT_ID,
  patientId: PATIENT_ID,
  customerName: PATIENT.fullName,
  suppliedOn: TODAY,
  dueDate: null,
  currency: 'INR',
  subtotalMinor: 75000,
  taxMinor: 9000,
  totalMinor: INVOICE_TOTAL_PAISE,
  issuedOn: null,
};

const INVOICE_DETAIL_EXAMPLE = {
  ...INVOICE_SUMMARY,
  notes: null,
  customer: {
    name: PATIENT.fullName,
    phone: PATIENT.phone,
    email: PATIENT.email,
    address: null,
  },
  lines: [
    {
      id: INVOICE_ITEM_ID,
      description: 'Consultation — General Medicine',
      itemCode: 'CONSULT',
      taxCategory: 'GST_12',
      quantity: '1',
      unitPriceMinor: CONSULTATION_FEE_PAISE,
      discount: null,
      lineSubtotalMinor: CONSULTATION_FEE_PAISE,
      taxLines: [
        { name: 'CGST', rateBps: 600, amountMinor: 3600 },
        { name: 'SGST', rateBps: 600, amountMinor: 3600 },
      ],
      lineTotalMinor: 67200,
    },
  ],
};

const TAX_REGISTRATION = {
  id: TAX_REGISTRATION_ID,
  countryCode: 'IN',
  regionCode: 'KA',
  scheme: 'GST',
  registrationNumber: '29AAACA1234C1ZP',
  legalName: 'Alpha Clinic Healthcare Pvt Ltd',
  status: 'ACTIVE',
  coverageMode: 'EXPLICIT',
  effectiveFrom: '2024-11-01',
  effectiveTo: null,
  branchIds: [BRANCH_ID],
};

const TAX_RULE = {
  id: TAX_RULE_ID,
  countryCode: 'IN',
  regionCode: 'KA',
  scheme: 'GST',
  taxCategory: 'GST_12',
  description: 'Medicines and consultations',
  rateBps: GST_RATE_PERCENT * 100,
  treatment: 'STANDARD',
  lineName: 'IGST',
  regionalLineName: 'CGST/SGST',
  split: 'INTRA_STATE_HALVES',
  stacks: false,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

export const invoiceDocs: DocRegistry = {
  'GET /api/v1/invoices': {
    summary: 'List invoices',
    description: `
Patient invoices, filtered to the sources the caller may see.

⚠️ **There is deliberately NO free-text search parameter.** A patient name in a
query string is a name in the proxy log, the browser history and the referrer of
the next request. Filter by patient id, appointment or date instead.

⚠️ **\`sourceType\` narrows within what you may already see; it cannot widen
it.** The visible set is resolved from the caller's permissions and applied in
the query — a pharmacist filtering for \`APPOINTMENT\` gets nothing rather than
somebody else's invoices.

A clinician without \`billing.invoice.read_all\` sees only invoices for their own
patients; every administrative role holds that code and skips the narrowing
entirely.
`.trim(),
    phi: true,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      status: 'Filter by invoice status.',
      sourceType: 'Narrow within the sources you may already see. Cannot widen them.',
      patientId: 'Narrow to one patient.',
      appointmentId: 'Narrow to one visit.',
      from: 'Earliest supply date.',
      to: 'Latest supply date, inclusive.',
      page: 'Page number, from 1.',
      limit: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft',
        value: {
          success: true,
          message: 'Success',
          data: { invoices: [INVOICE_SUMMARY], total: 1, page: 1, limit: 25 },
        },
      },
    ],
  },

  'GET /api/v1/invoices/{invoiceId}': {
    summary: 'Get an invoice',
    description:
      'One invoice as a **SCREEN** needs it — ids, states, what is editable. What the *document* says is `GET /{invoiceId}/document`, and the duplication is deliberate. **PHI**, audited.',
    phi: true,
    params: { invoiceId: INVOICE_NOTE },
    responseExamples: [
      {
        summary: 'A draft with one line',
        value: { success: true, message: 'Success', data: INVOICE_DETAIL_EXAMPLE },
      },
    ],
  },

  'GET /api/v1/invoices/{invoiceId}/document': {
    summary: 'Get the invoice document data',
    description: `
What the **document** says, as data.

⚠️ **Not a second shape of the detail response — the duplication is the
feature.** \`GET /{invoiceId}\` is what a screen needs. This is what the document
says, from the same loader the worker calls to render the PDF. That shared loader
is the entire reason the invoice on screen and the invoice a patient downloads
cannot drift.

Use this when you want to do something else with the document — render it
yourself, export it, feed it to an accounting system.
`.trim(),
    phi: true,
    params: { invoiceId: INVOICE_NOTE },
  },

  'GET /api/v1/invoices/{invoiceId}/preview': {
    summary: 'Render the invoice as HTML',
    description: `
The invoice as a browser can display it.

⚠️ **The same function the worker prints the PDF with.** What the clinic sees and
what the patient receives are the same document because both are one renderer
over one loader. A screen kept alike by hand would be two templates and one
reconciliation meeting.

Answers \`text/html\` with a **Content-Security-Policy that forbids everything
the document does not use** — the template has no scripts, the frame should be
sandboxed without \`allow-scripts\`, and the CSP is the third layer.

The render lives in the API rather than the web app because the service that owns
the data should serve both representations of it.
`.trim(),
    phi: true,
    params: { invoiceId: INVOICE_NOTE },
  },

  'GET /api/v1/invoices/{invoiceId}/pdf': {
    summary: 'Download the invoice PDF',
    description: `
The stored PDF.

⚠️ **Always the stored bytes, never a re-render.** The patient's copy and the
clinic's copy are one file, whose checksum is verified on the way out — a
document whose bytes no longer match what was recorded is either corrupt or
substituted, and neither may be handed over as a tax invoice. That mismatch is a
\`500\`, deliberately: it is our problem, not the caller's.

⚠️ **\`409\` is a NORMAL ANSWER here, not an error.** The render is queued after
the invoice commits and runs in the worker, so there is a window — usually about a
second — in which an issued invoice has no bytes yet. A \`404\` would say *stop*;
this says the render is still in flight and **the same request will work
shortly**. The screen renders from data throughout; only Download waits.
`.trim(),
    phi: true,
    errors: [409, 500],
    params: { invoiceId: INVOICE_NOTE },
  },

  'POST /api/v1/invoices': {
    summary: 'Create a draft invoice',
    description: `
Open a draft bill.

**An \`APPOINTMENT\` invoice must cite its \`appointmentId\`, and only an
\`APPOINTMENT\` invoice may** — the contract refuses both mismatches, because a
bill that claims a source it does not have is a bill nothing reconciles.

\`currency\` defaults to the organization's and is **fixed once the draft is
open** — it cannot be changed by an edit.

Prices are minor-unit integers. \`discount\` is either a percentage in basis
points or a fixed minor amount, per line and again for the whole invoice.

Tax is computed by the engine from each line's \`taxCategory\` against the
clinic's rate card — never sent by the client.
`.trim(),
    status: 201,
    phi: true,
    errors: [409, 422],
    requestExamples: [
      {
        summary: 'A consultation invoice',
        value: {
          branchId: BRANCH_ID,
          sourceType: 'APPOINTMENT',
          appointmentId: APPOINTMENT_ID,
          patientId: PATIENT_ID,
          customer: { name: PATIENT.fullName, phone: PATIENT.phone, email: PATIENT.email },
          suppliedOn: TODAY,
          currency: 'INR',
          lines: [
            {
              description: 'Consultation — General Medicine',
              itemCode: 'CONSULT',
              taxCategory: 'GST_12',
              quantity: '1',
              unitPriceMinor: CONSULTATION_FEE_PAISE,
            },
          ],
        },
      },
      {
        summary: 'A counter sale with a 10% discount',
        value: {
          branchId: BRANCH_ID,
          sourceType: 'PHARMACY',
          customer: { name: 'Walk-in customer' },
          suppliedOn: TODAY,
          lines: [
            {
              description: 'Amoxicillin 500mg capsule × 15',
              taxCategory: 'GST_12',
              quantity: '15',
              unitPriceMinor: 1600,
              discount: { type: 'PERCENTAGE', bps: 1000 },
            },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Drafted',
        value: { success: true, message: 'Success', data: INVOICE_DETAIL_EXAMPLE },
      },
    ],
  },

  'PUT /api/v1/invoices/{invoiceId}': {
    summary: 'Replace a draft invoice',
    description: `
Rewrite a draft, whole.

**Only while \`DRAFT\`.** An issued invoice is a statutory document and is never
edited — it is voided, or partly reversed with a credit note.

**\`branchId\`, \`sourceType\` and \`appointmentId\` are not editable**: an
invoice that changed what it bills is a different invoice.

⚠️ **Prices are built in the INVOICE'S own currency, not the organization's.** A
draft's currency is fixed when it is opened, and a \`PUT\` against a draft opened
in something else is perfectly valid.

Behind \`billing.invoice.update\`, the separate power to change a bill somebody
else opened.
`.trim(),
    phi: true,
    errors: [409, 422],
    params: { invoiceId: INVOICE_NOTE },
    requestExamples: [
      {
        summary: 'Add a second line',
        value: {
          patientId: PATIENT_ID,
          customer: { name: PATIENT.fullName, phone: PATIENT.phone },
          suppliedOn: TODAY,
          lines: [
            {
              description: 'Consultation — General Medicine',
              taxCategory: 'GST_12',
              quantity: '1',
              unitPriceMinor: CONSULTATION_FEE_PAISE,
            },
            {
              description: 'Dressing',
              taxCategory: 'GST_12',
              quantity: '1',
              unitPriceMinor: 15000,
            },
          ],
        },
      },
    ],
  },

  'POST /api/v1/invoices/{invoiceId}/issue': {
    summary: 'Issue an invoice',
    description: `
Turn a draft into a statutory document. It is assigned its number from the
series, becomes immutable, and a PDF render is queued.

⚠️ **\`billing.invoice.create\`, NOT \`.update\`.** Raising the bill and handing
it over are one act at a counter — a receptionist who could open a draft and never
issue it would have half a job.

\`issuedOn\` defaults to today. Note the PDF is not ready the instant this
returns; see the \`409\` on the PDF route.

**After this there is no edit**: void the whole document, or credit part of it.
`.trim(),
    phi: true,
    errors: [409, 422],
    params: { invoiceId: INVOICE_NOTE },
    requestExamples: [
      { summary: 'Issue today', value: {} },
      { summary: 'Backdate the issue', value: { issuedOn: '2026-03-16' } },
    ],
    responseExamples: [
      {
        summary: 'Issued',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...INVOICE_DETAIL_EXAMPLE,
            status: 'ISSUED',
            invoiceNumber: INVOICE_NUMBER,
            issuedOn: TODAY,
          },
        },
      },
    ],
  },

  'POST /api/v1/invoices/{invoiceId}/cancel': {
    summary: 'Cancel a draft invoice',
    description:
      'Abandon a draft nobody has seen. **No number was issued**, so nothing is burnt in the series. `reason` is optional here — and required on `void` — because the two acts are not comparable.',
    phi: true,
    errors: [409],
    params: { invoiceId: INVOICE_NOTE },
    requestExamples: [
      { summary: 'With a reason', value: { reason: 'Opened against the wrong visit' } },
      { summary: 'Without one', value: {} },
    ],
  },

  'POST /api/v1/invoices/{invoiceId}/void': {
    summary: 'Void an issued invoice',
    description: `
Reverse a document the patient is holding a copy of.

⚠️ **A separate route from cancel, not a status parameter, because they are
different acts on different documents.** A cancelled draft was seen by nobody; a
void reverses something already handed over. That is why \`reason\` is required
here and optional there.

⚠️ **The number and the row stay for ever.** A deleted number is a permanent hole
in a statutory series that no reprint can fill.

To reverse only *part* of an invoice — stock coming back a bit at a time — issue a
credit note instead.
`.trim(),
    phi: true,
    errors: [409],
    params: { invoiceId: INVOICE_NOTE },
    requestExamples: [
      {
        summary: 'Billed the wrong patient',
        value: { reason: 'Raised against the wrong patient; reissued as INV-2026-0004418.' },
      },
    ],
    responseExamples: [
      {
        summary: 'Voided',
        description: 'Note the number is kept.',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...INVOICE_DETAIL_EXAMPLE,
            status: 'VOID',
            invoiceNumber: INVOICE_NUMBER,
            issuedOn: TODAY,
          },
        },
      },
    ],
  },

  'POST /api/v1/invoices/from-charges': {
    summary: 'Raise an invoice from approved charges',
    description: `
Assemble a bill from charge requests somebody has already approved.

⚠️ **\`billing.invoice.create\` and not a new code, because this confers nothing
the generic create does not.** Deciding whether a supply is billed at all is a
different act behind \`billing.charge_request.manage\` on the charging router.

⚠️ **Mounted here rather than under \`/charging\`, because what it returns is an
invoice and what it enforces is the invoice engine's rules** — the branch, the
patient, the currency and the source must all agree. A create endpoint returning
an invoice from a router the invoice permissions do not gate is how a second door
into billing gets written.

Charges must be \`PENDING\` and already decided \`BILL\`. They move to
\`INVOICED\`.
`.trim(),
    status: 201,
    phi: true,
    errors: [409, 422],
    requestExamples: [
      {
        summary: "Bill a visit's approved charges",
        value: {
          branchId: BRANCH_ID,
          patientId: PATIENT_ID,
          sourceType: 'PHARMACY',
          suppliedOn: TODAY,
          customer: { name: PATIENT.fullName, phone: PATIENT.phone },
          chargeRequestIds: [CHARGE_REQUEST_ID],
        },
      },
    ],
  },

  'POST /api/v1/invoices/{invoiceId}/credit-notes': {
    summary: 'Issue a credit note',
    description: `
Reverse part of an issued invoice, and issue a **new document with its own
statutory serial**.

⚠️ **\`billing.credit_note.issue\`, NOT \`billing.invoice.cancel\`, and the split
is real.** Voiding reverses a document in full and keeps its number; a credit note
reverses part of one, several times over as stock comes back. A clinic separating
who may reverse a bill from who may void one is a control this code anticipates.

⚠️ **IT MOVES NO MONEY.** A credit note is the *document* saying the clinic owes
the patient. The refund is a payment, and that is a separate act.

Omit \`quantity\` on a line to credit it in full; give one to credit part of it.
Crediting more than remains on a line is \`409\`.
`.trim(),
    status: 201,
    phi: true,
    errors: [409, 422],
    params: { invoiceId: INVOICE_NOTE },
    requestExamples: [
      {
        summary: 'Credit one line in full',
        value: {
          reason: 'Medicine returned unopened',
          lines: [{ invoiceItemId: INVOICE_ITEM_ID }],
        },
      },
      {
        summary: 'Credit part of a line',
        value: {
          reason: 'Six of fifteen capsules returned',
          lines: [{ invoiceItemId: INVOICE_ITEM_ID, quantity: '6' }],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Credit note issued',
        description: 'A new document with its own number — the original invoice is untouched.',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...INVOICE_DETAIL_EXAMPLE,
            id: CREDIT_NOTE_ID,
            kind: 'CREDIT_NOTE',
            status: 'ISSUED',
            invoiceNumber: 'CRN-2026-0000112',
            issuedOn: TODAY,
          },
        },
      },
    ],
  },

  'GET /api/v1/tax/rate-card': {
    summary: 'Get the resolved rate card',
    description:
      'Which tax rules are in force for a branch today — what the engine will actually apply. The one place to answer "why did this invoice carry 12%" without reading the rule table and doing the effective-date arithmetic by hand.',
    params: {
      branchId: "Which branch's jurisdiction to resolve for.",
      on: 'Resolve as at this date rather than today, `YYYY-MM-DD`.',
    },
    responseExamples: [
      {
        summary: 'Intra-state GST at 12%',
        value: {
          success: true,
          message: 'Success',
          data: {
            branchId: BRANCH_ID,
            countryCode: 'IN',
            regionCode: 'KA',
            scheme: 'GST',
            rules: [TAX_RULE],
          },
        },
      },
    ],
  },

  'GET /api/v1/tax/registrations': {
    summary: 'List tax registrations',
    description: `
The registrations **this clinic** bills under.

⚠️ **This is not \`/api/v1/platform/tax-registrations\`, and the two must never
learn about each other.** That one is platform reference data about tax schemes;
this one is the clinic's own GSTIN and which of its branches trade under it.

Not a PHI surface — nothing here names a patient.
`.trim(),
    params: {
      countryCode: 'Narrow to one country.',
      status: 'Filter by `SCHEDULED`, `ACTIVE` or `LAPSED`.',
    },
    responseExamples: [
      {
        summary: 'One Karnataka registration',
        value: { success: true, message: 'Success', data: { registrations: [TAX_REGISTRATION] } },
      },
    ],
  },

  'POST /api/v1/tax/registrations': {
    summary: 'Create a tax registration',
    description: `
Record a registration number the clinic trades under, for one jurisdiction.

Effective-dated. \`SCHEDULED\` before its window, \`ACTIVE\` inside it,
\`LAPSED\` after — derived, not set.

⚠️ **There is no DELETE on this resource.** An invoice issued last March has to
keep saying which registration it was issued under; deleting the row would make
the document unexplainable. Close it with \`effectiveTo\` instead.

Branch coverage is set separately, through \`PUT /{id}/branches\`.
`.trim(),
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A Karnataka GSTIN',
        value: {
          countryCode: 'IN',
          regionCode: 'KA',
          scheme: 'GST',
          registrationNumber: '29AAACA1234C1ZP',
          legalName: 'Alpha Clinic Healthcare Pvt Ltd',
          effectiveFrom: '2024-11-01',
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: TAX_REGISTRATION } },
    ],
  },

  'PATCH /api/v1/tax/registrations/{id}': {
    summary: 'Update a tax registration',
    description:
      'Correct a registration or close it off with `effectiveTo`. **No delete exists** — invoices already issued cite this row.',
    errors: [409],
    params: { id: 'The registration, as `GET /api/v1/tax/registrations` lists it.' },
    requestExamples: [
      { summary: 'Close it off', value: { effectiveTo: '2026-03-31' } },
      {
        summary: 'Correct the legal name',
        value: { legalName: 'Alpha Clinic Healthcare Private Limited' },
      },
    ],
  },

  'PUT /api/v1/tax/registrations/{id}/branches': {
    summary: 'Set which branches a registration covers',
    description: `
Say which branches trade under this registration.

\`PUT\`, so the list replaces. An empty array means the registration covers no
branch explicitly — which is meaningful when coverage is by jurisdiction instead.

⚠️ **A branch with no covering registration raises invoices with no tax**, so a
group opening in a new state needs a registration for it before it bills there.
`.trim(),
    errors: [409],
    params: { id: 'The registration.' },
    requestExamples: [
      { summary: 'Cover the Bengaluru branch', value: { branchIds: [BRANCH_ID] } },
      { summary: 'Cover both', value: { branchIds: [BRANCH_ID, BRANCH_KOCHI_ID] } },
    ],
  },

  'GET /api/v1/tax/rules': {
    summary: 'List tax rules',
    description:
      "The clinic's rate card — which category attracts which rate, in which jurisdiction, over which period. `split: INTRA_STATE_HALVES` is what turns one 12% rule into CGST 6 + SGST 6 on an intra-state supply.",
    params: {
      countryCode: 'Narrow to one country.',
      regionCode: 'Narrow to one region.',
      taxCategory: 'Narrow to one category.',
      activeOn: 'Only rules in force on this date.',
    },
    responseExamples: [
      {
        summary: 'One GST rule',
        value: { success: true, message: 'Success', data: { rules: [TAX_RULE] } },
      },
    ],
  },

  'POST /api/v1/tax/rules': {
    summary: 'Create a tax rule',
    description: `
Add a rate to the clinic's rate card.

⚠️ **From the moment it takes effect, every invoice it covers carries this tax.**
There is no dry run and no staging — \`effectiveFrom\` is the switch.

\`rateBps\` is basis points: 12% is \`1200\`. \`split: INTRA_STATE_HALVES\` makes
the engine emit two half-rate lines named by \`regionalLineName\` when supply is
intra-state, and one line named by \`lineName\` when it is not.

\`stacks\` marks a rule that applies **on top of** another rather than instead of
it — a cess.

There is no DELETE. Ending a rule is \`POST /{id}/end\`.
`.trim(),
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: '12% GST, split intra-state',
        value: {
          countryCode: 'IN',
          regionCode: 'KA',
          scheme: 'GST',
          taxCategory: 'GST_12',
          description: 'Medicines and consultations',
          rateBps: 1200,
          lineName: 'IGST',
          regionalLineName: 'CGST/SGST',
          split: 'INTRA_STATE_HALVES',
          effectiveFrom: '2026-01-01',
        },
      },
      {
        summary: 'A zero-rated category',
        value: {
          countryCode: 'IN',
          regionCode: 'KA',
          scheme: 'GST',
          taxCategory: 'GST_0',
          rateBps: 0,
          treatment: 'ZERO_RATED',
          lineName: 'GST',
          effectiveFrom: '2026-01-01',
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: TAX_RULE } },
    ],
  },

  'PATCH /api/v1/tax/rules/{id}': {
    summary: 'Update a tax rule',
    description: `
Correct a rule's descriptive fields.

⚠️ **NOT THE PATH FOR A RATE CHANGE, AND IT REFUSES TO BE ONE.** Moving the rate
on a live rule would silently restate every invoice's basis. A new rate is a new
rule with its own \`effectiveFrom\`, and the old one ended — which is what keeps
last March's invoice explainable.
`.trim(),
    errors: [409],
    params: { id: 'The rule, as `GET /api/v1/tax/rules` lists it.' },
    requestExamples: [
      {
        summary: 'Correct the description',
        value: { description: 'Medicines, consultations and procedures' },
      },
    ],
  },

  'POST /api/v1/tax/rules/{id}/end': {
    summary: 'End a tax rule',
    description: `
Close a rule off at a date.

⚠️ **A \`POST\` and not a \`DELETE\`, because it is not one.** The row stays and
the rate stops applying from the date given. Invoices raised while it was in force
keep pointing at it, which is the whole reason there is no delete on this
resource.
`.trim(),
    errors: [409],
    params: { id: 'The rule.' },
    requestExamples: [{ summary: 'End it at the year end', value: { effectiveTo: '2026-03-31' } }],
  },

  'GET /api/v1/fee-schedule/quote': {
    summary: 'Quote a fee',
    description: `
What one doctor charges for one fee type at one branch, resolved down the scope
chain.

⚠️ **The one endpoint that answers "what do we charge for a consultation?"** —
and it is held widely, because the front desk is quoted the fee as they book. The
code that SETS fees is not.

\`amountMinor: null\` means no price is configured anywhere in the chain, which
is different from a price of zero.
`.trim(),
    response: feeQuote,
    params: {
      doctorProfileId: 'The doctor. Required.',
      branchId: 'The branch. Required.',
      feeType: 'Which fee — `CONSULTATION`, `FOLLOW_UP`, and so on. Required.',
    },
    responseExamples: [
      {
        summary: '₹600 for a consultation',
        value: {
          success: true,
          message: 'Success',
          data: {
            currency: 'INR',
            doctorProfileId: DOCTOR_ID,
            branchId: BRANCH_ID,
            feeType: 'CONSULTATION',
            amountMinor: CONSULTATION_FEE_PAISE,
            resolvedFrom: 'DOCTOR',
          },
        },
      },
    ],
  },

  'GET /api/v1/fee-schedule/entries': {
    summary: 'List fee schedule entries',
    description:
      'Every configured fee across every scope, flat — what an audit of the rate card reads, as distinct from the resolved view a screen shows.',
    responseExamples: [
      {
        summary: 'One clinic-wide entry',
        value: {
          success: true,
          message: 'Success',
          data: {
            entries: [
              {
                scopeLevel: 'ORGANIZATION',
                branchId: null,
                doctorProfileId: null,
                feeType: 'CONSULTATION',
                amountMinor: 50000,
                currency: 'INR',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/fee-schedule': {
    summary: 'Get the fee schedule',
    description:
      "The clinic-wide or branch-level rate card, resolved. **A doctor's own overrides are not here** — those are `GET /api/v1/doctors/{doctorId}/fees`. Not PHI; a fee names a service, never a person.",
    response: feeScheduleView,
    params: { branchId: 'Resolve at this branch. Omitted, the clinic-wide card.' },
    responseExamples: [
      {
        summary: 'The clinic-wide card',
        value: {
          success: true,
          message: 'Success',
          data: {
            scopeLevel: 'ORGANIZATION',
            branchId: null,
            doctorProfileId: null,
            currency: 'INR',
            rows: [
              {
                feeType: 'CONSULTATION',
                amountMinor: 50000,
                inheritedFrom: 'ORGANIZATION',
                isOverridden: true,
              },
            ],
          },
        },
      },
    ],
  },

  'PUT /api/v1/fee-schedule': {
    summary: 'Set the fee schedule',
    description: `
Set clinic-wide or branch-level prices.

\`branchId: null\` sets the clinic-wide card; a branch id overrides it there.
Doctor-level overrides are set on the doctor.

**\`PUT\` replaces the set at that scope.** A fee type omitted stops being
overridden here and falls back up the chain; \`amountMinor: null\` explicitly
clears one.

Behind \`billing.fee_schedule.manage\`, which is deliberately narrower than the
code that reads a quote.
`.trim(),
    response: feeScheduleView,
    errors: [403],
    requestExamples: [
      {
        summary: 'Clinic-wide consultation fee',
        value: { branchId: null, fees: [{ feeType: 'CONSULTATION', amountMinor: 50000 }] },
      },
      {
        summary: 'A higher fee at one branch',
        value: {
          branchId: BRANCH_KOCHI_ID,
          fees: [{ feeType: 'CONSULTATION', amountMinor: 55000 }],
        },
      },
    ],
  },
};
