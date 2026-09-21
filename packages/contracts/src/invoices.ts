/**
 * Patient invoices — the wire shapes for the engine Phases 1–6 built.
 *
 * ⚠️ THESE ARE NOT `billing.ts`'s INVOICES. `InvoiceSummary` in that file is
 *   rcln billing the CLINIC for its subscription; everything here is the clinic
 *   billing a PATIENT. Two documents, two tables, two lifecycles — see §0.1 of
 *   `.kb/Architecture/invoice-engine-implementation.md` for why they can never
 *   share one. The names in this file all carry a `Patient…`-free prefix only
 *   because the module is mounted at `/v1/invoices`; when both appear in one
 *   screen, import them explicitly rather than by wildcard.
 *
 * ⚠️ MONEY CROSSES THE WIRE IN MINOR UNITS, AS AN INTEGER, ALWAYS. `…Minor`
 *   suffixes the field so a reader can never mistake 1250 for twelve rupees
 *   fifty. `numeric(14,2)` is the storage shape and `Money` is the arithmetic
 *   shape; JSON gets the second one, because a JSON number is a double and
 *   `4999.995` is a total nobody can be charged.
 *
 * ⚠️ NOTHING HERE IS A PATIENT'S RECORD, BUT `customerName` IS A PATIENT'S NAME.
 *   That is what makes an invoice list a PHI surface and why the read routes
 *   write `data_access_logs` rows. Filters are ids, dates and enums — never a
 *   name — so the query string stays safe to land in a proxy log.
 */
import { z } from 'zod';

import { calendarDate, uuid } from './common.js';

/**
 * What an invoice bills for.
 *
 * The full enum, including the three whose modules do not exist yet, because
 * the column and the source-code registry already carry them — a caller can
 * filter for `LAB` today and correctly get nothing.
 */
export const invoiceSourceType = z.enum([
  'APPOINTMENT',
  'PROCEDURE',
  'SERVICE',
  'LAB',
  'PHARMACY',
  'INVENTORY',
  'OTHER',
]);
export type InvoiceSourceTypeValue = z.infer<typeof invoiceSourceType>;

/**
 * A charge, or a reversal of one (PI-8).
 *
 * ⚠️ A CREDIT NOTE IS THE SAME SHAPE AS AN INVOICE ON THE WIRE, AND THE CLIENT
 *   MUST READ THIS FIELD BEFORE IT ADDS ANYTHING UP. Every money field on a
 *   credit note is POSITIVE — the kind carries the sign — so a total that sums
 *   `grandTotalMinor` across a list without splitting on this is a balance that
 *   grows when a patient is refunded. What is owed is Σ INVOICE − Σ CREDIT_NOTE.
 */
export const invoiceKind = z.enum(['INVOICE', 'CREDIT_NOTE']);
export type InvoiceKindValue = z.infer<typeof invoiceKind>;

export const invoiceStatus = z.enum([
  'DRAFT',
  'FINALIZING',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
  'VOID',
]);
export type InvoiceStatusValue = z.infer<typeof invoiceStatus>;

/**
 * How a line — or the whole document — is treated for tax.
 *
 * ⚠️ THE LAST TWO ARE WHAT MAKES AN INVOICE UNISSUABLE, AND THEY ARE NOT
 *   ERRORS. `UNRATED` is a category the clinic never gave a rate for and
 *   `PROVIDER_REQUIRED` is one where the law needs a value the clinic has not
 *   supplied; in both the engine charged nothing rather than guessing, which is
 *   right for a draft and cannot be handed to a patient. `isIssuable()` in
 *   `@rcln/tax` is the one definition — `InvoiceDetail.issuable` is that
 *   function's answer, not a second copy of this list.
 */
export type InvoiceTaxTreatmentValue =
  | 'STANDARD'
  | 'EXEMPT'
  | 'ZERO_RATED'
  | 'REVERSE_CHARGE'
  | 'NOT_REGISTERED'
  | 'UNRATED'
  | 'PROVIDER_REQUIRED';

/**
 * A discount, as the cashier entered it.
 *
 * ⚠️ A DISCRIMINATED UNION AND NOT THREE OPTIONAL FIELDS, MATCHING
 *   `DiscountInput` IN `@rcln/invoicing` AND THE CHECK CONSTRAINT ON THE ROW.
 *   `{ type: 'PERCENTAGE', amountMinor: 500 }` is a state the database refuses
 *   and a partial update is the ordinary way to reach it; a union makes it
 *   unrepresentable instead of merely refused.
 */
export const discountInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PERCENTAGE'),
    /** Basis points. 10% is 1000, and 100% is the ceiling. */
    bps: z.int().min(0).max(10_000),
  }),
  z.object({
    type: z.literal('FIXED'),
    amountMinor: z.int().min(0),
  }),
]);
export type DiscountInputRequest = z.infer<typeof discountInput>;

/**
 * One line of a draft.
 *
 * ⚠️ `taxCategory` AND `itemCode` ARE NOT THE SAME STRING, AND FUSING THEM IS
 *   THE BUG THIS SHAPE PREVENTS. The first is matched exactly against
 *   `tax_rules.tax_category` and decides what is charged; the second is the
 *   HSN/SAC printed on the line and decides nothing. A clinic that prints a code
 *   must not thereby change a rate.
 */
export const invoiceLineRequest = z.object({
  description: z.string().min(1).max(255),
  taxCategory: z.string().min(1).max(64),
  itemCode: z.string().max(32).nullish(),
  /**
   * A decimal string — `"1"`, `"0.5"`, `"1.250"`. A string rather than a number
   * because three decimal places of a double is where 0.1 + 0.2 lives, and the
   * server parses it to integer thousandths. A fourth decimal is refused there
   * rather than truncated here.
   */
  quantity: z
    .string()
    .regex(/^\d{1,11}(\.\d{1,3})?$/, 'up to three decimal places, and not negative'),
  unitPriceMinor: z.int().min(0),
  discount: discountInput.optional(),
});
export type InvoiceLineRequest = z.infer<typeof invoiceLineRequest>;

/**
 * The customer block.
 *
 * ⚠️ A SNAPSHOT, NOT A JOIN, AND THE CLIENT SENDS IT EVEN WHEN `patientId` IS
 *   SET. A patient marries and changes their surname; the invoice must keep
 *   printing what it printed. `patientId` is the link for querying, these fields
 *   are the document.
 */
export const invoiceCustomerRequest = z.object({
  name: z.string().min(1).max(255),
  phone: z.string().max(20).nullish(),
  email: z.email().max(255).nullish(),
  address: z.string().max(1000).nullish(),
  /** The customer's own GSTIN, on the rare invoice raised to a business. */
  taxId: z.string().max(32).nullish(),
});

const invoiceBody = z.object({
  branchId: uuid,
  sourceType: invoiceSourceType,
  /** Required iff `sourceType` is APPOINTMENT — the database says so too. */
  appointmentId: uuid.nullish(),
  patientId: uuid.nullish(),
  customer: invoiceCustomerRequest,
  /**
   * ⚠️ THE DATE OF SUPPLY, NOT THE DATE OF ISSUE. It selects the effective-dated
   *   tax rule and the registration, so a bill raised in April for a March
   *   consultation is taxed as March was. A calendar date rather than an
   *   instant: what the clinic means is a day, and the server reads it in the
   *   branch's zone.
   */
  suppliedOn: calendarDate,
  dueDate: calendarDate.nullish(),
  /** ISO 4217. Defaults to the organization's own currency. */
  currency: z.string().length(3).toUpperCase().optional(),
  lines: z.array(invoiceLineRequest).min(1).max(200),
  /** The whole-bill discount, apportioned onto the lines BEFORE tax. */
  discount: discountInput.optional(),
  /**
   * ⚠️ CASH ROUNDING IS NOT HERE, AND IT USED TO BE. `cashRoundingMinor` was a
   *   request parameter that was never stored, so `finalizeInvoice` — which
   *   re-prices from the stored inputs — re-priced without it: a clinic rounding
   *   to the rupee saw a rounded total on the draft and handed the patient an
   *   unrounded document. It is now `billing.cash_rounding_minor`, a setting at
   *   the organization or the branch, read again at every re-price. A value that
   *   cannot survive a re-price has no business on a request body.
   */
  notes: z.string().max(2000).nullish(),
});

export const createInvoiceRequest = invoiceBody.superRefine((v, ctx) => {
  const isAppointment = v.sourceType === 'APPOINTMENT';
  if (isAppointment !== Boolean(v.appointmentId)) {
    ctx.addIssue({
      code: 'custom',
      path: ['appointmentId'],
      message: isAppointment
        ? 'an APPOINTMENT invoice must cite the appointment it bills'
        : 'only an APPOINTMENT invoice cites an appointment',
    });
  }
});
export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequest>;

/**
 * Replace a draft.
 *
 * ⚠️ A WHOLE-DOCUMENT PUT AND NOT A PATCH, AND NOT A LINE-LEVEL CRUD. Pricing
 *   is a property of the invoice, not of a line — an invoice-level discount is
 *   apportioned across every line, so adding one line re-prices all of them.
 *   Endpoints that edited a single line would each have to re-price the whole
 *   document anyway, and would additionally have to answer what happens when two
 *   cashiers hold the same bill open. Sending the document back is the same
 *   arithmetic with none of that.
 *
 * The branch and the source cannot move: both are in the number series the
 * invoice will draw from, and neither is a correction anybody makes to a bill
 * that is already open. Cancel it and raise another.
 */
export const updateInvoiceRequest = invoiceBody
  .omit({ branchId: true, sourceType: true, appointmentId: true })
  .extend({ patientId: uuid.nullish() });
export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequest>;

/**
 * Issue it.
 *
 * `issuedOn` is accepted so a clinic entering yesterday's till can date the
 * document correctly, and defaults to today in the branch's zone. It decides
 * which series and which return period the number belongs to, which is why it
 * is not simply `now()` taken inside the service.
 */
export const issueInvoiceRequest = z.object({
  issuedOn: calendarDate.optional(),
});
export type IssueInvoiceRequest = z.infer<typeof issueInvoiceRequest>;

export const cancelInvoiceRequest = z.object({
  reason: z.string().max(500).nullish(),
});
export type CancelInvoiceRequest = z.infer<typeof cancelInvoiceRequest>;

/**
 * Void an issued invoice.
 *
 * The reason is REQUIRED here and optional on a cancel, and that is the whole
 * difference between the two: a cancelled draft explains itself, because nobody
 * ever saw it. A void reverses a document the patient is holding a copy of.
 */
export const voidInvoiceRequest = z.object({
  reason: z.string().min(1).max(500),
});
export type VoidInvoiceRequest = z.infer<typeof voidInvoiceRequest>;

/**
 * Raise a credit note against an issued invoice (PI-8).
 *
 * ⚠️ THE LINES ARE THE INVOICE'S OWN, CITED BY ID, AND NOT FREE-TYPED. A credit
 *   note whose lines the caller composes could credit a description and a price
 *   that never appeared on the document it reverses — which is how a correction
 *   becomes an unexplainable second document rather than a reversal of the
 *   first. Each entry names an `invoice_items` row and how much of it comes off.
 *
 * ⚠️ AND IT IS RE-PRICED, NOT COPIED. The tax on a credited line is computed by
 *   the same engine against the ORIGINAL invoice's `suppliedAt`, so a note
 *   raised in June for a March supply reverses March's rate — which is the whole
 *   reason the credit exists as a document rather than as an edit. Copying the
 *   stored tax figures would look identical until a rate changed, and would then
 *   be wrong in the direction of the clinic keeping the difference.
 */
export const creditNoteLineRequest = z.object({
  /** A line on the invoice being credited. */
  invoiceItemId: uuid,
  /**
   * How much of that line to reverse, in the SAME unit the line is priced in.
   * Omitted credits the whole line, which is the common case.
   *
   * ⚠️ A DECIMAL STRING, NEVER A NUMBER, for the reason every quantity in this
   *   repository is one: `0.1 + 0.2` is not `0.3` and a quantity that arrives
   *   as a double has already lost the argument.
   */
  quantity: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/, 'expected a positive quantity with at most 3 decimal places')
    .optional(),
});
export type CreditNoteLineRequest = z.infer<typeof creditNoteLineRequest>;

export const createCreditNoteRequest = z.object({
  /**
   * ⚠️ REQUIRED, AND NOT FOR TIDINESS. A credit note reduces a tax liability the
   *   clinic has already reported; "why" is the only part of it that is not
   *   derivable from the rows, and it is what an auditor asks first. Same
   *   argument `voidInvoiceRequest.reason` makes.
   */
  reason: z.string().min(1).max(500),
  /**
   * Empty credits the whole invoice — every line, in full.
   *
   * ⚠️ EACH LINE ONCE, AND THIS REFINEMENT IS LOAD-BEARING RATHER THAN TIDY. The
   *   per-line ceiling in `resolveLines` measures every entry against
   *   `alreadyCreditedByItem`, a snapshot taken ONCE before the loop runs. Name
   *   the same `invoiceItemId` twice and both entries read the same untouched
   *   remainder and both pass, so a line can be credited past what was supplied
   *   as long as the grand total stays under `assertWithinRemaining`'s ceiling —
   *   which it does whenever the invoice has more than one line. The document
   *   then reverses a quantity of one HSN that was never billed under it, which
   *   is a GST misstatement per line rather than a rounding argument, and stock
   *   reconciliation reads those lines.
   *
   *   `createInvoiceFromChargesRequest` already refines exactly this way, for
   *   exactly this reason. The cross-request half of the cap was closed; this is
   *   the within-request half.
   */
  lines: z
    .array(creditNoteLineRequest)
    .max(200)
    .refine(
      (lines) => new Set(lines.map((l) => l.invoiceItemId)).size === lines.length,
      'credit each invoice line once — combine the quantities instead'
    )
    .default([]),
});
export type CreateCreditNoteRequest = z.infer<typeof createCreditNoteRequest>;

/**
 * The list.
 *
 * ⚠️ THERE IS NO FREE-TEXT SEARCH PARAMETER, AND ITS ABSENCE IS DELIBERATE. The
 *   obvious one is `?q=<name>`, and a customer name in a query string is a
 *   patient name in `data_access_logs.route`, in the proxy's access log and in
 *   the browser's history — the exact disclosure `patients.routes.ts` moved its
 *   duplicate probe to a POST to avoid. An invoice is found by its number, its
 *   patient or its date, all of which are here.
 *
 *   ⚠️ `invoiceNumber` BEING A PARTIAL MATCH DOES NOT WEAKEN THAT. A document
 *     number is not a person. Searching a NAME still means resolving it to a
 *     `patientId` first — `POST /patients/search` exists for that — and putting
 *     the uuid in the URL, which is what `patientId` above is for.
 */
export const listInvoicesQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    branchId: uuid.optional(),
    patientId: uuid.optional(),
    appointmentId: uuid.optional(),
    status: invoiceStatus.optional(),
    sourceType: invoiceSourceType.optional(),
    /**
     * Charges, reversals, or both.
     *
     * ⚠️ OMITTED RETURNS BOTH, WHICH IS THE ONLY SAFE DEFAULT. Defaulting to
     *   `INVOICE` would hide every credit note from every existing caller and
     *   from the ledger the accountant reconciles — a reversal that does not
     *   appear anywhere is worse than one that appears in an unexpected list.
     *   The screens that mean one or the other say so.
     */
    kind: invoiceKind.optional(),
    /** Every credit note raised against one invoice. */
    creditedInvoiceId: uuid.optional(),
    /**
     * A fragment of the invoice number, matched anywhere in it and without
     * regard to case: `787` finds `INV-2026-APP-MAIN-000787`.
     *
     * ⚠️ THIS USED TO BE AN EXACT MATCH, AND PARTIAL IS SAFE HERE FOR A REASON
     *   THAT DOES NOT EXTEND TO THE CUSTOMER'S NAME. An invoice number is the
     *   clinic's own sequence — it identifies a document, not a person — so a
     *   fragment of one in the URL and in `data_access_logs.route` discloses
     *   nothing about who was treated. See the header for why the same relaxation
     *   is refused for a name.
     *
     * Trimmed rather than rejected when padded: a number pasted out of a
     * spreadsheet arrives with whitespace, and an exact-match filter used to
     * answer "no invoices" to it.
     */
    invoiceNumber: z.string().trim().max(64).optional(),
    /** Inclusive, on the issue date for an issued invoice and creation for a draft. */
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from !== undefined && v.to !== undefined && v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the first day' });
    }
  });
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuery>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** One row of the list. Enough to render a line; never enough to be the bill. */
export interface InvoiceListItem {
  id: string;
  /** Null while DRAFT — a draft has no number, by construction. */
  invoiceNumber: string | null;
  /** ⚠️ Read this before summing anything. See `invoiceKind`. */
  kind: InvoiceKindValue;
  /** The invoice this one reverses. Non-null iff `kind` is `CREDIT_NOTE`. */
  creditedInvoiceId: string | null;
  status: InvoiceStatusValue;
  sourceType: InvoiceSourceTypeValue;
  branchId: string;
  patientId: string | null;
  customerName: string;
  currency: string;
  grandTotalMinor: number;
  amountPaidMinor: number;
  /** `grandTotal − amountPaid`, computed and never stored. */
  balanceDueMinor: number;
  suppliedAt: string;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
}

export interface InvoiceTaxLine {
  /** `CGST`, `VAT` — what the component is called where it is levied. */
  name: string;
  /**
   * `IN-KA`, `AE`. Null where a rule names no jurisdiction.
   *
   * ⚠️ PART OF THE GROUPING KEY, NOT DECORATION. CGST 6% and SGST 6% are the
   *   same rate on the same base owed to two different governments; merging
   *   them into one 12% row states a tax nobody levies, on the table a return is
   *   filed from.
   */
  jurisdiction: string | null;
  rateBps: number;
  taxableMinor: number;
  amountMinor: number;
}

export interface InvoiceItemDetail {
  id: string;
  lineNumber: number;
  description: string;
  taxCategory: string;
  itemCode: string | null;
  /** A decimal string, as entered: `"1"`, `"0.5"`. */
  quantity: string;
  unitPriceMinor: number;
  grossMinor: number;
  /** This line's own discount. */
  discountMinor: number;
  /** Its share of the whole-bill discount. */
  apportionedDiscountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
  taxTreatment: InvoiceTaxTreatmentValue;
  /** Why it is treated that way — the exemption cited, or why it is UNRATED. */
  taxReason: string | null;
  taxes: InvoiceTaxLine[];
}

/**
 * The PDF's state, as far as a screen needs to know.
 *
 * ⚠️ `READY` IS THE ONLY VALUE FOR WHICH DOWNLOAD WORKS, AND `PENDING` IS NOT AN
 *   ERROR. The render is queued after the invoice commits and runs in the
 *   worker, so there is a window — usually a second — in which an issued invoice
 *   has no bytes. The screen renders the document from data throughout; only the
 *   Download button waits.
 */
export interface InvoiceDocumentState {
  status: 'NONE' | 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';
  documentId: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  generatedAt: string | null;
}

export interface InvoiceDetail extends InvoiceListItem {
  appointmentId: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  customerTaxId: string | null;
  /** The registration it was issued under, as printed. Null below the threshold. */
  issuerTaxId: string | null;
  issuerLegalName: string | null;
  placeOfSupply: string | null;
  taxTreatment: InvoiceTaxTreatmentValue;
  subtotalMinor: number;
  lineDiscountTotalMinor: number;
  invoiceDiscountTotalMinor: number;
  taxableAmountMinor: number;
  taxTotalMinor: number;
  roundingAdjustmentMinor: number;
  /** The whole-bill discount as entered, so the screen can re-open the draft. */
  discount: DiscountInputRequest | null;
  notes: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  voidedAt: string | null;
  items: InvoiceItemDetail[];
  /** The tax summary, grouped by component and jurisdiction and rate. */
  taxes: InvoiceTaxLine[];
  document: InvoiceDocumentState;
  /**
   * Whether this invoice can still be issued — every line has a rate.
   *
   * Reported rather than left for the screen to derive, because the definition
   * lives in `@rcln/tax` and a second one in the client would drift.
   */
  issuable: boolean;
  /** Why not, when it is not. Empty otherwise. */
  unissuableReasons: string[];
  /**
   * The credit notes raised against this invoice (PI-8). Empty on a credit note
   * itself — a note is never credited, it is the credit.
   *
   * ⚠️ `creditedTotalMinor` IS WHAT THE ENGINE CHECKS A NEW NOTE AGAINST, and it
   *   counts only notes that still stand. A cancelled draft note and a voided
   *   one both reverse nothing, so both are excluded — the same `LIVE_STATUSES`
   *   definition `appointment-billing.service.ts` uses for "already billed?",
   *   and for the same reason.
   */
  creditNotes: AppointmentInvoiceLink[];
  creditedTotalMinor: number;
}

// ---------------------------------------------------------------------------
// Appointment billing
// ---------------------------------------------------------------------------

/**
 * An invoice, as a VISIT sees it.
 *
 * Deliberately smaller than `InvoiceListItem` and deliberately carrying no
 * `customerName`: this shape hangs off the day board, which already knows whose
 * visit it is, and repeating the name there would put it in a second response
 * for no reader who did not already have it.
 */
export const appointmentInvoiceLink = z.object({
  invoiceId: uuid,
  /** Null while DRAFT — a draft has no number, by construction. */
  invoiceNumber: z.string().nullable(),
  status: invoiceStatus,
  currency: z.string().length(3),
  grandTotalMinor: z.int(),
  amountPaidMinor: z.int(),
  balanceDueMinor: z.int(),
  issuedAt: z.iso.datetime().nullable(),
});
export type AppointmentInvoiceLink = z.infer<typeof appointmentInvoiceLink>;

/**
 * Which fee the schedule charged for this visit.
 *
 * ⚠️ THE NUMBER IS THE ONE FROZEN AT BOOKING, where the appointment carries one.
 *   `appointments.booked_fee` is written when the visit is booked and re-written
 *   only when the booking moves to a DIFFERENT doctor, so a price rise reaches
 *   visits booked afterwards and no others (§0.2 decisions 9 and 10). A visit
 *   booked before this feature existed has no frozen fee and is resolved live,
 *   which is the old behaviour and the only case where it still applies.
 *
 * ⚠️ `FOLLOW_UP_FREE` IS A CHARGE OF ZERO, NOT THE ABSENCE OF ONE.
 *   `doctor_branch_settings.follow_up_free_days` says a review inside the window
 *   costs nothing; that is a priced answer the clinic gave, and it is not the
 *   same fact as a doctor whose rate card was never filled in — which is
 *   `unpricedReason`, and leaves `charge` null.
 */
export const consultationChargeBasis = z.enum(['CONSULTATION', 'FOLLOW_UP', 'FOLLOW_UP_FREE']);
export type ConsultationChargeBasis = z.infer<typeof consultationChargeBasis>;

/**
 * Why the fee schedule could not price this visit.
 *
 * Both are the clinic's own configuration gap and neither is an error: the
 * cashier can still bill the visit by sending `unitPriceMinor`, which is why
 * this is reported rather than thrown.
 *
 * ⚠️ THE TWO ARE DIFFERENT PROMPTS AND THE DISTINCTION IS WORTH THE EXTRA QUERY.
 *   `NO_RATE_CARD` means NOTHING resolved at any of the four scopes — the clinic
 *   has never filled the grid in, and the screen should say "set your prices".
 *   `NO_FEE_SET` means the grid exists and THIS kind of visit is blank, which is
 *   "teleconsults have no price yet". One message for both tells a clinic that
 *   priced five of six visit types to go and set up billing.
 */
export const consultationUnpricedReason = z.enum(['NO_RATE_CARD', 'NO_FEE_SET']);
export type ConsultationUnpricedReason = z.infer<typeof consultationUnpricedReason>;

/**
 * Why this visit cannot be billed from this door right now.
 *
 * ⚠️ `ALREADY_BILLED` IS ABOUT THE LIVE INVOICE, NOT ABOUT `appointment_id`,
 *   which is deliberately not unique. A visit billed, voided and billed again
 *   has two invoices citing it and the void keeps its reference — so the
 *   question "is this visit already billed?" is answered by whether any invoice
 *   for it is still standing, and a cancelled or voided one is not.
 */
export const appointmentBillingBlockedReason = z.enum([
  'ALREADY_BILLED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_NO_SHOW',
]);
export type AppointmentBillingBlockedReason = z.infer<typeof appointmentBillingBlockedReason>;

/** What the rate card proposes to charge for one visit. */
export const consultationCharge = z.object({
  basis: consultationChargeBasis,
  /** The line as it would be printed. */
  description: z.string(),
  /** Matched exactly against `tax_rules.tax_category`. */
  taxCategory: z.string(),
  unitPriceMinor: z.int(),
  /**
   * The free-review window this doctor offers at this branch, in days. Non-null
   * only when the visit is a follow-up and the window is configured — the number
   * the screen needs to explain a `FOLLOW_UP_FREE`.
   */
  freeFollowUpDays: z.number().int().nullable(),
});
export type ConsultationCharge = z.infer<typeof consultationCharge>;

/**
 * What billing this visit would look like — the preview behind the Raise
 * invoice button.
 *
 * ⚠️ `suppliedOn` IS THE DAY OF THE VISIT, NOT TODAY, and it is here because it
 *   is the single most consequential thing this endpoint decides. It selects the
 *   effective-dated tax rule and the registration, so a bill raised in April for
 *   a March consultation is taxed as March was. Read in the BRANCH's zone.
 */
export const appointmentBilling = z.object({
  appointmentId: uuid,
  branchId: uuid,
  patientId: uuid,
  suppliedOn: calendarDate,
  /** The organization's currency — what `unitPriceMinor` is denominated in. */
  currency: z.string().length(3),
  /** Null when the rate card could not price the visit; see `unpricedReason`. */
  charge: consultationCharge.nullable(),
  unpricedReason: consultationUnpricedReason.nullable(),
  /** The invoice this visit is currently billed on, if any. */
  liveInvoice: appointmentInvoiceLink.nullable(),
  /**
   * Every invoice ever raised for this visit, newest first — cancelled and
   * voided ones included. That history is the explanation of a re-bill, and the
   * screen that hides it is the screen where a voided invoice looks like it
   * never happened.
   */
  history: z.array(appointmentInvoiceLink),
  /**
   * What moving this booking has cost so far, and how many moves that was.
   *
   * ⚠️ ONCE PER MOVE, AND SEPARATE FROM `charge` BECAUSE IT IS A SEPARATE LINE.
   *   Three patient-requested moves are three charges and three lines on the
   *   bill — a patient who is charged 600 must be able to see it was 200 three
   *   times. Clinic-initiated moves are recorded and cost nothing, so they never
   *   appear here.
   *
   * ⚠️ AND IT IS CHARGED ON TOP OF A FREE FOLLOW-UP. The charge is for moving
   *   the slot, not for the consultation (§0.2 decision 11).
   */
  rescheduleChargeMinor: z.int(),
  rescheduleCount: z.int(),
  /** True when a draft can be raised. `blockedReason` says why not. */
  billable: z.boolean(),
  blockedReason: appointmentBillingBlockedReason.nullable(),
});
export type AppointmentBilling = z.infer<typeof appointmentBilling>;

/**
 * Bill a visit.
 *
 * ⚠️ THERE ARE NO LINES IN THIS REQUEST, AND THAT IS THE POINT OF THE ENDPOINT.
 *   The whole phase is "a consultation becomes an invoice without anybody
 *   retyping the fee": the line comes from the doctor's rate card at the visit's
 *   branch, the customer block from the patient, and the date of supply from the
 *   day the visit was scheduled for. Anything more elaborate — a second line, a
 *   procedure, a different patient — is `POST /v1/invoices`, which this endpoint
 *   is a shortcut through and not a replacement for.
 */
export const createAppointmentInvoiceRequest = z.object({
  /**
   * Override the rate card for this one visit.
   *
   * ⚠️ THE ESCAPE HATCH, NOT THE PATH. It exists so a clinic that has not filled
   *   in a doctor's fees can still bill from this door, and so a cashier can
   *   charge what was actually agreed. It confers no power `billing.invoice.create`
   *   did not already carry through `POST /v1/invoices`.
   */
  unitPriceMinor: z.int().min(0).optional(),
  /** The whole-bill discount, apportioned onto the line BEFORE tax. */
  discount: discountInput.optional(),
  /** Cash rounding is a setting, not a parameter — see `createInvoiceRequest`. */
  notes: z.string().max(2000).nullish(),
});
export type CreateAppointmentInvoiceRequest = z.infer<typeof createAppointmentInvoiceRequest>;
