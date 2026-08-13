/**
 * Everything a patient invoice prints, and nothing else.
 *
 * ⚠️ THIS TYPE IS THE WHOLE POINT OF THE PHASE. The screen and the PDF are the
 *   same document because they are the same function of the same value: the API
 *   builds one of these, the web renders it, the worker renders it, and there is
 *   no third path by which a number could reach one output and not the other. A
 *   field the template needs and this type does not carry is a field the preview
 *   would have to fetch separately — and the moment the two renderings read from
 *   two sources they are two documents that merely look alike.
 *
 * ⚠️ IT IS PLAIN JSON, DELIBERATELY. No `Date`, no `Decimal`, no `Money`, no
 *   Prisma row. It crosses a process boundary as the body of an HTTP response
 *   (Phase 7's `GET /invoices/:id/document`) and it is rendered inside Next's
 *   server runtime, so anything that does not survive `JSON.parse(JSON.stringify(x))`
 *   is a value that would arrive intact in the worker and mangled in the browser.
 *   Amounts are integer minor units of the single `currency` below; timestamps
 *   are ISO-8601 with a `Z`.
 *
 * ⚠️ IT IS A SNAPSHOT, NOT A VIEW. Every string here was resolved when the
 *   invoice was issued — the clinic's legal name, its tax registration number,
 *   the patient's name and address. A clinic that re-registers under a new name
 *   must not silently restate its old invoices, so nothing in the template joins
 *   to a live row. That is the same reasoning `invoices.customer_name` and
 *   `.issuer_tax_id` already exist for; this type is where it becomes visible.
 *
 * ⚠️ AND IT IS FULL OF PHI. A patient's name, phone, address and what they were
 *   treated for, in one object. It is never logged, never cached in Redis and
 *   never put in a queue payload — the job carries an invoice id and the
 *   consumer builds this itself, under RLS. See the header of `@rcln/queue`.
 */

/** Mirrors `InvoiceStatus` in schema.prisma. */
export type InvoiceDocumentStatus =
  'DRAFT' | 'FINALIZING' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED' | 'VOID';

/** Mirrors `InvoiceSourceType` in schema.prisma. */
export type InvoiceDocumentSourceType =
  'APPOINTMENT' | 'PROCEDURE' | 'SERVICE' | 'LAB' | 'PHARMACY' | 'INVENTORY' | 'OTHER';

/** Mirrors `TaxTreatment` in `@rcln/tax`. */
export type InvoiceTaxTreatment =
  | 'STANDARD'
  | 'ZERO_RATED'
  | 'EXEMPT'
  | 'REVERSE_CHARGE'
  | 'NOT_REGISTERED'
  | 'UNRATED'
  | 'PROVIDER_REQUIRED';

/**
 * The clinic, as it was when the invoice was issued.
 *
 * `taxIdLabel` travels with the number rather than being derived in the
 * template, because what the registration is called is a fact about the
 * jurisdiction that issued it — `GSTIN` in India, `VAT No.` in Ireland, `ABN`
 * in Australia. Phase 2b's lesson: a document that prints the right number
 * under the wrong name is arithmetically perfect and not compliant anywhere,
 * and every total-based assertion passes.
 */
export interface InvoiceDocumentIssuer {
  /** The registered legal name — what the tax authority knows the clinic as. */
  legalName: string;
  /** The name over the door, when it differs. Printed above the legal name. */
  tradeName: string | null;
  branchName: string;
  branchCode: string;
  addressLines: readonly string[];
  phone: string | null;
  email: string | null;
  /** Null for a clinic below the registration threshold — a legal position. */
  taxId: string | null;
  /** What that number is called here. Only meaningful when `taxId` is set. */
  taxIdLabel: string;
}

/**
 * Who is being billed.
 *
 * A snapshot of the columns on `invoices`, never a join to `patients` — see the
 * header. `patientNumber` is the clinic's own MRN, printed so a receipt can be
 * matched back to a chart without printing anything clinical.
 */
export interface InvoiceDocumentCustomer {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** The customer's own registration, on the rare invoice raised to a business. */
  taxId: string | null;
  patientNumber: string | null;
}

/**
 * Who provided the care, when the document bills care at all.
 *
 * ⚠️ A SNAPSHOT OFF `invoices`, NOT A JOIN THROUGH THE APPOINTMENT. A doctor who
 *   leaves, marries or re-registers must not restate the invoices they were
 *   named on — the same rule as the customer block and the issuer's tax number.
 *
 * Null on any source that is not a consultation. A pharmacy bill has a
 * prescriber, which is a different fact and gets its own field when it exists.
 */
export interface InvoiceDocumentPractitioner {
  name: string;
  /** Their council registration, printed under the name where they hold one. */
  registrationNumber: string | null;
}

/** One printed tax line under one item. 12% in Karnataka is two of these. */
export interface InvoiceDocumentTaxLine {
  name: string;
  rateBps: number;
  taxAmountMinor: number;
}

export interface InvoiceDocumentLine {
  lineNumber: number;
  description: string;
  /**
   * How the item is packaged — "strip of 15", "100ml bottle", "box of 100".
   *
   * ⚠️ A SEPARATE FIELD RATHER THAN THE TAIL OF `description`, AND IT IS NOT
   *   PARSED OUT OF ONE. Splitting "Paracetamol 650mg tablets — strip of 15" on
   *   the dash would be a heuristic over free text somebody typed, and it would
   *   mangle every description that happens to contain a dash for another
   *   reason. Printed as its own muted line under the name so the description
   *   column can be narrower.
   *
   * ⚠️ NOTHING POPULATES THIS YET. `invoice_items` has no column for it, so the
   *   API sends null and every real invoice renders exactly as before. Wiring it
   *   is a schema change plus a snapshot at the point of sale — the pack size a
   *   medicine was SOLD in, never the one the product carries today.
   */
  packaging?: string | null;
  /** The printed HSN/SAC. Presentation only — never the tax-category key. */
  itemCode: string | null;
  /** A decimal string, already at the column's three places. `'1.000'`. */
  quantity: string;
  unitPriceMinor: number;
  grossAmountMinor: number;
  /** This line's own discount. */
  discountAmountMinor: number;
  /** Its share of the whole-bill discount, apportioned before tax (§0.5). */
  apportionedDiscountMinor: number;
  taxableAmountMinor: number;
  taxAmountMinor: number;
  lineTotalMinor: number;
  taxes: readonly InvoiceDocumentTaxLine[];
}

/**
 * The tax table at the foot of the invoice, grouped by rate and name.
 *
 * Grouped rather than listed per line because that is what a return is filed
 * from and what an auditor adds up. Both halves of an Indian split appear as
 * their own rows — CGST 6% and SGST 6% are owed to two different governments
 * and summing them into one 12% row would print a tax nobody levies.
 */
export interface InvoiceDocumentTaxSummaryRow {
  name: string;
  /**
   * Who the tax is owed to — `IN` for CGST, `IN-KA` for SGST.
   *
   * ⚠️ NULLABLE, AND THE NULL IS NOT AN OVERSIGHT. A line priced from an
   *   external provider's quote carries the provider's own component names with
   *   no jurisdiction attached; `invoice_taxes.jurisdiction` is nullable for
   *   that reason. Printing a blank cell is honest. Printing the country as a
   *   guess would state which government a tax is owed to, on a document a
   *   return is filed from.
   */
  jurisdiction: string | null;
  rateBps: number;
  taxableAmountMinor: number;
  taxAmountMinor: number;
}

export interface InvoiceDocumentTotals {
  subtotalMinor: number;
  lineDiscountTotalMinor: number;
  invoiceDiscountTotalMinor: number;
  taxableAmountMinor: number;
  taxTotalMinor: number;
  /** Cash rounding, applied to the total and never to a line (Phase 4). */
  roundingAdjustmentMinor: number;
  grandTotalMinor: number;
  amountPaidMinor: number;
  balanceDueMinor: number;
}

export interface InvoiceDocumentData {
  /** ISO 4217. Every `*Minor` field below is in this currency's minor units. */
  currency: string;
  /**
   * The issuing branch's IANA zone.
   *
   * ⚠️ NEVER THE BROWSER'S AND NEVER THE CONTAINER'S — invariant 6. The worker
   *   renders in a UTC container and the preview renders in whatever zone the
   *   receptionist's laptop is set to, and both must print the DAY the clinic
   *   keeps. 00:30 IST on 1 April is 19:00 UTC on 31 March: read as an instant
   *   it is the old financial year, read in the clinic's zone it starts the new
   *   one. Carrying the zone in the data is what makes that true by construction
   *   rather than by everyone remembering.
   *
   * ⚠️ THERE IS DELIBERATELY NO `timeFormat`, BECAUSE AN INVOICE IS DATED AND
   *   NOT TIMESTAMPED. GST — and every other regime this engine covers —
   *   requires the DATE of issue; none requires the minute, and a clock face on
   *   a tax document is noise on the one line an auditor reads. The 12/24 choice
   *   is `locale.time_format`, a per-branch setting that belongs to appointment
   *   cards and the day board. A document type that genuinely needs a time — a
   *   prescription, a lab report — adds the field when it has a consumer for it.
   */
  timezone: string;
  /** ISO country of the issuing branch. Decides what the document calls itself. */
  countryCode: string;

  /**
   * Null until the invoice is finalised.
   *
   * ⚠️ NOT AN EMPTY STRING AND NOT A PLACEHOLDER. A draft genuinely has no
   *   number — `issueNumber()` is called at finalisation so an abandoned draft
   *   cannot burn a serial, and `invoices_number_matches_status` refuses a DRAFT
   *   that holds one. The preview has to be able to say so; substituting
   *   `'DRAFT'` here would put a string that looks like a number into the
   *   document title and, through it, into a filename.
   */
  invoiceNumber: string | null;
  status: InvoiceDocumentStatus;
  /** ISO-8601 with a `Z`. Null on a draft being previewed before issue. */
  issuedAt: string | null;
  suppliedAt: string;
  dueDate: string | null;
  placeOfSupply: string | null;
  taxTreatment: InvoiceTaxTreatment;
  notes: string | null;

  /**
   * What this invoice bills, mirroring `InvoiceSourceType`.
   *
   * ⚠️ CARRIED SO THE TEMPLATE CAN NAME ITS OWN COLUMNS, and for no other
   *   reason. One document renders every source, and the money column is a
   *   consultation's FEE and a dispense's unit RATE — printing "Rate" over a
   *   doctor's fee reads as a price list, and printing "Fee" over ten tablets is
   *   simply wrong. The alternative is a second template, which is how the PDF
   *   and the preview drift apart.
   */
  sourceType: InvoiceDocumentSourceType;

  issuer: InvoiceDocumentIssuer;
  customer: InvoiceDocumentCustomer;
  /** Null unless this document bills care somebody provided. */
  practitioner: InvoiceDocumentPractitioner | null;
  lines: readonly InvoiceDocumentLine[];
  taxSummary: readonly InvoiceDocumentTaxSummaryRow[];
  totals: InvoiceDocumentTotals;
}
