/**
 * The life of a patient invoice: assembled, finalised, and then left alone.
 *
 *     DRAFT ──▶ FINALIZING ──▶ ISSUED ──▶ PARTIALLY_PAID ──▶ PAID
 *       │                        │              │             │
 *       ▼                        └──────────────┴─────────────┴──▶ VOID
 *   CANCELLED
 *
 * ⚠️ THE TRANSITIONS ARE ENFORCED IN POSTGRES, NOT HERE. The
 *   `20260811090000_invoice_lifecycle_immutability` migration carries the
 *   transition table, the frozen-column allow-list and the guard on lines and
 *   tax rows. This file is the *ordinary* way through them, and it is
 *   deliberately not the only thing standing between an issued document and an
 *   `update()`: a fix-up script, a future worker or the next endpoint written in
 *   a hurry are all paths this file is not on. Every check below has a
 *   counterpart in the database, and where the two could drift the database
 *   wins — a 23514 or a raised exception is an ugly error, and a silently
 *   rewritten invoice is not an error at all.
 *
 * ⚠️ FINALISATION IS ONE TRANSACTION AND TAKES THE NUMBER LAST, FOR THE LOCK
 *   WINDOW AND NOT FOR THE SERIAL. `issueNumber()` holds a row lock on the
 *   branch's counter until COMMIT, and that lock is what every other till at the
 *   branch queues behind. Pricing, the issuable check and the registration read
 *   all happen before it, so the window is the two updates that follow and
 *   nothing else.
 *
 *   ⚠️ IT IS **NOT** WHAT KEEPS A REFUSED BILL FROM BURNING A SERIAL, AND
 *     ASSUMING IT WAS WOULD HAVE BEEN WRONG. Measured: moving the number ahead
 *     of the issuable check fails no test, because the throw rolls the whole
 *     transaction back and takes the counter's increment with it. The serial is
 *     safe because finalisation is ONE transaction — the ordering buys the lock
 *     window, and only that.
 *
 * ⚠️ A DRAFT IS RE-PRICED, NEVER TRUSTED. The stored totals are what the last
 *   write computed; the stored *inputs* — description, category, quantity, unit
 *   price, the two discounts — are what the cashier typed. Finalisation prices
 *   from the inputs again, because the rate card can be corrected between the
 *   draft being opened and the patient being handed the bill, and the document
 *   must state the rate in force on the day of supply as it is known now.
 */
import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import {
  parseQuantity,
  formatQuantity,
  type DiscountInput,
  type InvoiceLineInput,
} from '@rcln/invoicing';
import type { Money } from '@rcln/payments';

import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit, type AuditSnapshot } from '../audit/audit.service.js';

import { issueInvoiceNumber, type InvoiceSourceType } from './invoice-number.service.js';
import { toDecimal, toMoney } from './money.js';
import { priceDraftInvoice, type PricedDraftInvoice } from './pricing.service.js';
import { loadTaxContext } from './tax.service.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface DraftLineInput {
  description: string;
  /**
   * The ORIGINAL invoice line this one reverses. Credit notes only (PI-8).
   *
   * ⚠️ IT IS CARRIED THROUGH `StagedLine` AND RE-WRITTEN ON EVERY REPRICE, which
   *   is the whole reason it appears on this interface rather than being set
   *   once by the credit-note service. `repriceLoadedDraft` DELETES and
   *   re-inserts every line, and finalisation always re-prices — a column set at
   *   creation and not carried here is a column that exists until the document
   *   becomes a document. That is exactly what made
   *   `charge_requests.invoice_item_id` unusable and got it removed.
   */
  creditedInvoiceItemId?: string | null;
  /** Matched exactly against `tax_rules.tax_category`. Not the printed HSN code. */
  taxCategory: string;
  /** The HSN/SAC string printed on the line. Presentation only. */
  itemCode?: string | null;
  /** A decimal string or number. A fourth decimal place throws rather than truncating. */
  quantity: string | number;
  unitPrice: Money;
  /** This line's own discount. The whole-bill one is apportioned separately. */
  discount?: DiscountInput;
}

export interface CreateDraftInvoiceInput {
  branchId: string;
  sourceType: InvoiceSourceType;
  /**
   * A charge, or a reversal of one (PI-8). Defaults to `INVOICE`.
   *
   * ⚠️ A `CREDIT_NOTE` MUST CARRY `creditedInvoiceId` AND AN `INVOICE` MUST NOT.
   *   `invoices_credit_note_cites_its_invoice` says the same thing as a 23514 at
   *   COMMIT; it is checked here as well so the caller is told which field is
   *   wrong, exactly as the source-reference check below is.
   */
  kind?: 'INVOICE' | 'CREDIT_NOTE';
  /** The issued invoice this note reverses. Required iff `kind` is CREDIT_NOTE. */
  creditedInvoiceId?: string | null;
  /** Required iff `sourceType` is APPOINTMENT — `invoices_source_reference_matches_type`. */
  appointmentId?: string | null;
  patientId?: string | null;
  /**
   * ⚠️ A SNAPSHOT, NOT A JOIN. A patient marries and changes their surname; the
   *   invoice must keep printing what it printed. `patientId` is the link for
   *   querying, these fields are the document.
   */
  customer: {
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    /** The customer's own GSTIN, on the rare invoice raised to a business. */
    taxId?: string | null;
  };
  /**
   * Who provided the care, where this invoice bills care at all.
   *
   * ⚠️ A SNAPSHOT THE CALLER RESOLVES, NOT A JOIN THIS SERVICE MAKES. The
   *   document must keep naming whoever it named — a clinician who leaves,
   *   marries or re-registers does not restate a bill already issued. Absent on
   *   a pharmacy or counter invoice, which bills no attendance.
   */
  practitioner?: {
    name: string;
    registrationNumber?: string | null;
    /**
     * ⚠️ THE LINK, WHERE THE NAME IS THE DOCUMENT — and the thing a clinician's
     *   own invoice list is filtered on. Without it a bill is unattributed and
     *   invisible to the doctor who earned it.
     */
    profileId?: string | null;
  };
  /** ⚠️ THE DATE OF SUPPLY, NOT `now()`. It selects the rule and the registration. */
  suppliedAt: Date;
  dueDate?: Date | null;
  /** ISO 4217. Defaults to the organization's own currency. */
  currency?: string;
  lines: readonly DraftLineInput[];
  discount?: DiscountInput;
  notes?: string | null;
}

export interface FinalizeInvoiceInput {
  invoiceId: string;
  /**
   * The instant the invoice is issued at. Passed rather than taken from the
   * clock so a test can pin it and so a caller replaying a day's work cannot
   * accidentally date every document today — the branch-local date derived from
   * it decides which series and which return the number belongs to.
   */
  issuedAt: Date;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Open a draft, priced.
 *
 * ⚠️ THE DRAFT IS PRICED THE MOMENT IT EXISTS, AND PHASE 3 SHIPPED WITH THE
 *   OPPOSITE. Every money column defaults to 0, which is honest for an empty
 *   invoice and wrong for one with lines on it — a draft carrying five lines and
 *   a `grand_total` of zero is what the cashier reads off the screen. There is
 *   no state in which an invoice's totals are not the totals of its lines.
 */
export async function createDraftInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: CreateDraftInvoiceInput,
  options: InvoiceAuditOptions = {}
): Promise<{ id: string }> {
  if (input.lines.length === 0) {
    throw new ValidationError('An invoice needs at least one line.');
  }

  /*
   * The database says the same thing in `invoices_source_reference_matches_type`
   * and would say it as a 23514 at COMMIT. Said here as well because the
   * cashier can still be told which field is wrong.
   */
  const isAppointment = input.sourceType === 'APPOINTMENT';
  if (isAppointment !== Boolean(input.appointmentId)) {
    throw new ValidationError(
      isAppointment
        ? 'An APPOINTMENT invoice must cite the appointment it bills.'
        : `A ${input.sourceType} invoice cites no appointment.`
    );
  }

  /*
   * The database says the same thing in `invoices_credit_note_cites_its_invoice`
   * and would say it as a 23514 at COMMIT. Said here too, for the same reason
   * the source check above is: the caller can still be told which field is
   * wrong.
   */
  const kind = input.kind ?? 'INVOICE';
  const isCreditNote = kind === 'CREDIT_NOTE';
  if (isCreditNote !== Boolean(input.creditedInvoiceId)) {
    throw new ValidationError(
      isCreditNote
        ? 'A credit note must cite the invoice it reverses.'
        : 'An invoice credits nothing. Raise a credit note if you mean to reverse one.'
    );
  }

  const currency = (input.currency ?? (await organizationCurrency(tx, ctx))).toUpperCase();

  const invoice = await tx.invoice.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: input.branchId,
      sourceType: input.sourceType,
      kind,
      creditedInvoiceId: input.creditedInvoiceId ?? null,
      appointmentId: input.appointmentId ?? null,
      patientId: input.patientId ?? null,
      customerName: input.customer.name,
      customerPhone: input.customer.phone ?? null,
      customerEmail: input.customer.email ?? null,
      customerAddress: input.customer.address ?? null,
      customerTaxId: input.customer.taxId ?? null,
      practitionerName: input.practitioner?.name ?? null,
      practitionerRegistrationNumber: input.practitioner?.registrationNumber ?? null,
      practitionerProfileId: input.practitioner?.profileId ?? null,
      suppliedAt: input.suppliedAt,
      dueDate: input.dueDate ?? null,
      currency,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
      /*
       * Discount INPUT on the header from the start: it is what the cashier
       * typed, so it survives a reprice without being re-supplied. The computed
       * `invoice_discount_total` is written by `priceAndPersist` below.
       */
      ...discountColumns(input.discount),
    },
    select: { id: true },
  });

  await priceAndPersist(tx, ctx, {
    invoiceId: invoice.id,
    branchId: input.branchId,
    currency,
    suppliedAt: input.suppliedAt,
    customerTaxId: input.customer.taxId ?? null,
    /*
     * ⚠️ THE WHOLE-BILL DISCOUNT IS PRICED HERE AND NOT ONLY STORED ABOVE, AND
     *   OMITTING IT WAS A BUG THIS PHASE'S FIRST CREATE REVEALED. The header
     *   columns written by `discountColumns` are the discount AS ENTERED;
     *   `invoice_discount_total` and every line's `apportioned_discount` are what
     *   it CAME TO, and only the engine computes those. Left out, a draft came
     *   back from creation with the discount recorded and none of it applied —
     *   correct again the moment anything re-priced it, which finalisation always
     *   does, so the issued document was right and only the figure the cashier
     *   was looking at while deciding was wrong.
     */
    ...(input.discount ? { discount: input.discount } : {}),
    lines: input.lines.map((line, index) => ({
      lineNumber: index + 1,
      itemCode: line.itemCode ?? null,
      creditedInvoiceItemId: line.creditedInvoiceItemId ?? null,
      input: {
        description: line.description,
        taxCategory: line.taxCategory,
        quantityMilli: parseQuantity(line.quantity),
        unitPrice: line.unitPrice,
        ...(line.discount ? { discount: line.discount } : {}),
      },
    })),
  });

  /*
   * ⚠️ AFTER THE PRICING, NOT AFTER THE INSERT. The row that exists between the
   *   two carries every money column at its `@default(0)`, so a snapshot taken
   *   there would record a five-line invoice with a grand total of zero — the
   *   same bug the header describes Phase 3 shipping to the screen, filed
   *   permanently into a table that cannot be corrected.
   */
  await recordAudit(tx, ctx, {
    action: 'CREATE',
    entityType: 'invoice',
    entityId: invoice.id,
    branchId: input.branchId,
    after: await invoiceAuditSnapshot(tx, ctx, invoice.id),
    ...options,
  });

  return { id: invoice.id };
}

/**
 * The editable half of a draft. Everything a cashier can still change.
 *
 * ⚠️ THE BRANCH, THE SOURCE AND THE APPOINTMENT ARE NOT HERE, AND THAT IS NOT AN
 *   OVERSIGHT. All three are inputs to the NUMBER this invoice will draw —
 *   `INV-{year}-{SOURCE}-{BRANCH}-…` — and the first two also decide which
 *   registration prices it. Moving a bill between branches after it was opened
 *   is not a correction anybody makes at a counter; it is a different document,
 *   and the way to get one is to cancel this draft and raise it.
 */
export interface UpdateDraftInvoiceInput extends Omit<
  CreateDraftInvoiceInput,
  'branchId' | 'sourceType' | 'appointmentId' | 'currency'
> {
  invoiceId: string;
}

/**
 * Replace a draft's contents.
 *
 * ⚠️ THE WHOLE DOCUMENT, NOT A LINE. Pricing is a property of the invoice: the
 *   whole-bill discount is apportioned across every line, so adding one line
 *   re-prices all of them, and a per-line endpoint would have to re-price the
 *   whole thing anyway. `priceAndPersist` already deletes and rewrites the item
 *   rows for exactly that reason — this is the same write with the inputs coming
 *   from the request instead of from the rows.
 *
 * ⚠️ THE CURRENCY IS NOT CHANGEABLE EITHER. It was fixed when the draft was
 *   opened and every `Money` on it is denominated in it; a change would have to
 *   re-denominate the prices the cashier typed, which nobody can do for them.
 *
 * Throws 404 for an invoice this tenant cannot see and 409 for one that is no
 * longer a DRAFT — both from `loadDraft`, which is the single place that decides
 * a draft is editable.
 */
export async function updateDraftInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: UpdateDraftInvoiceInput,
  options: InvoiceAuditOptions = {}
): Promise<void> {
  if (input.lines.length === 0) {
    throw new ValidationError('An invoice needs at least one line.');
  }

  const draft = await loadDraft(tx, ctx, input.invoiceId);
  const before = await invoiceAuditSnapshot(tx, ctx, draft.id);

  await tx.invoice.update({
    where: { id: draft.id },
    data: {
      patientId: input.patientId ?? null,
      customerName: input.customer.name,
      customerPhone: input.customer.phone ?? null,
      customerEmail: input.customer.email ?? null,
      customerAddress: input.customer.address ?? null,
      customerTaxId: input.customer.taxId ?? null,
      suppliedAt: input.suppliedAt,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      ...discountColumns(input.discount),
    },
  });

  await priceAndPersist(tx, ctx, {
    invoiceId: draft.id,
    branchId: draft.branchId,
    currency: draft.currency,
    suppliedAt: input.suppliedAt,
    customerTaxId: input.customer.taxId ?? null,
    ...(input.discount ? { discount: input.discount } : {}),
    lines: input.lines.map((line, index) => ({
      lineNumber: index + 1,
      itemCode: line.itemCode ?? null,
      creditedInvoiceItemId: line.creditedInvoiceItemId ?? null,
      input: {
        description: line.description,
        taxCategory: line.taxCategory,
        quantityMilli: parseQuantity(line.quantity),
        unitPrice: line.unitPrice,
        ...(line.discount ? { discount: line.discount } : {}),
      },
    })),
  });

  await recordAudit(tx, ctx, {
    action: 'UPDATE',
    entityType: 'invoice',
    entityId: draft.id,
    branchId: draft.branchId,
    before,
    after: await invoiceAuditSnapshot(tx, ctx, draft.id),
    ...options,
  });
}

/**
 * Re-price a draft from its own stored inputs and rewrite what is derived.
 *
 * The path a line edit takes in Phase 7, and the first thing finalisation does.
 * Reads the inputs back out of `invoice_items` rather than taking them as an
 * argument, because those columns ARE the input: whatever wrote them last is
 * what the cashier last said.
 */
export async function repriceDraftInvoice(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<PricedDraftInvoice> {
  return repriceLoadedDraft(tx, ctx, await loadDraft(tx, ctx, invoiceId));
}

/** The half of the above that a caller which has already loaded the draft uses. */
async function repriceLoadedDraft(
  tx: TxClient,
  ctx: TenantContext,
  invoice: LoadedDraft
): Promise<PricedDraftInvoice> {
  return priceAndPersist(tx, ctx, {
    invoiceId: invoice.id,
    branchId: invoice.branchId,
    currency: invoice.currency,
    suppliedAt: invoice.suppliedAt,
    customerTaxId: invoice.customerTaxId,
    lines: invoice.items.map((item) => ({
      lineNumber: item.lineNumber,
      itemCode: item.itemCode,
      creditedInvoiceItemId: item.creditedInvoiceItemId,
      input: {
        description: item.description,
        taxCategory: item.taxCategory,
        quantityMilli: parseQuantity(item.quantity.toString()),
        unitPrice: toMoney(item.unitPrice, invoice.currency),
        ...(item.discountType
          ? {
              discount:
                item.discountType === 'PERCENTAGE'
                  ? ({ type: 'PERCENTAGE', bps: item.discountBps ?? 0 } as const)
                  : ({
                      type: 'FIXED',
                      amount: toMoney(
                        item.discountFixed ?? new Prisma.Decimal(0),
                        invoice.currency
                      ),
                    } as const),
            }
          : {}),
      },
    })),
    ...(invoice.discountType
      ? {
          discount:
            invoice.discountType === 'PERCENTAGE'
              ? ({ type: 'PERCENTAGE', bps: invoice.discountBps ?? 0 } as const)
              : ({
                  type: 'FIXED',
                  amount: toMoney(invoice.discountFixed ?? new Prisma.Decimal(0), invoice.currency),
                } as const),
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

export interface FinalizedInvoice {
  id: string;
  /**
   * The issuing branch.
   *
   * Returned rather than left for the caller to re-read, because the caller that
   * needs it is `issueInvoice`, which by then has COMMITTED and no longer has a
   * transaction to read it in. A second read outside the transaction would also
   * be a second chance to get the wrong branch onto a render job — and the
   * branch decides which folder the PDF lands in and which RLS loop the
   * `invoice_documents` row belongs to.
   */
  branchId: string;
  invoiceNumber: string;
  issuedAt: Date;
  grandTotal: Money;
}

/**
 * Turn a draft into a document.
 *
 * ⚠️ THE ORDER OF THE STEPS IS THE DESIGN. Price, refuse what cannot be issued,
 *   refuse what would be issued under the wrong registration, and only then take
 *   the number — so the counter's row lock is held across two updates rather
 *   than across a tax-context read and three checks. See the file header for
 *   what this ordering does NOT buy.
 */
export async function finalizeInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: FinalizeInvoiceInput,
  options: InvoiceAuditOptions = {}
): Promise<FinalizedInvoice> {
  const draft = await loadDraft(tx, ctx, input.invoiceId);
  if (draft.items.length === 0) {
    throw new ConflictError('An invoice with no lines is not a document. Add a line first.');
  }

  /*
   * ⚠️ BEFORE THE REPRICE, WHICH IS THE HALF OF THIS TRANSITION MOST WORTH
   *   RECORDING. Finalisation prices from the stored inputs again, so a rate
   *   card corrected between the draft being opened and the patient being handed
   *   the bill moves the tax and the grand total on a request where nobody typed
   *   a number. A snapshot taken after the reprice would show only the status
   *   and the number changing, and the trail would be silent about the one
   *   change no human made.
   */
  const before = await invoiceAuditSnapshot(tx, ctx, draft.id);

  const priced = await repriceLoadedDraft(tx, ctx, draft);

  /*
   * ⚠️ THIS IS WHERE `isIssuable()` FINALLY REFUSES SOMETHING. Phases 2 and 4
   *   both end with "UNRATED is reported and not yet refused". An UNRATED line
   *   is a category the clinic never told us the rate for: the engine charged
   *   nothing rather than guessing, and issuing that is a bill that under-
   *   collects tax the clinic still owes. `priced.issuable` is `@rcln/tax`'s own
   *   definition asked, not restated, so this and the engine cannot drift.
   */
  if (!priced.issuable) {
    throw new ConflictError(
      `This invoice cannot be issued until every line has a rate. ${priced.unissuableReasons.join(' ')}`
    );
  }

  await assertRegistrationCoversBranch(tx, ctx, draft.branchId, draft.suppliedAt);

  /*
   * The number LAST, for the lock-window reason in the file header. It runs on
   * THIS transaction, which is separately what makes a serial un-burnable: any
   * throw below rolls the counter's increment back with everything else.
   */
  const issued = await issueInvoiceNumber(tx, ctx, {
    branchId: draft.branchId,
    sourceType: draft.sourceType,
    /* PI-8: a credit note draws from its own series. See `KIND_PREFIXES`. */
    kind: draft.kind,
    issuedAt: input.issuedAt,
  });

  /*
   * ⚠️ TWO UPDATES, NOT ONE, AND FINALIZING IS NOT DECORATION. The first write
   *   takes the number, the issue date and the frozen totals while the row is
   *   still open; the second closes it. The guard trigger reads OLD.status, so
   *   splitting them is what lets the financial columns be written by the same
   *   statement that leaves DRAFT and be immutable the instant the row is
   *   ISSUED. `invoices_number_matches_status` leaves FINALIZING unconstrained
   *   for exactly this half-written moment.
   *
   *   Both statements are inside the caller's transaction, so no other session
   *   ever observes FINALIZING; the state earns its keep as the shape of the
   *   write, not as a row anybody will find.
   */
  await tx.invoice.update({
    where: { id: draft.id },
    data: {
      status: 'FINALIZING',
      invoiceNumber: issued.formatted,
      issuedAt: input.issuedAt,
      issuedBy: ctx.userId,
      issuerTaxRegistrationId: priced.issuerTaxRegistrationId,
      issuerTaxId: priced.issuerTaxId,
      issuerLegalName: priced.issuerLegalName,
      placeOfSupply: priced.placeOfSupply,
      taxTreatment: priced.taxTreatment,
    },
  });

  await tx.invoice.update({ where: { id: draft.id }, data: { status: 'ISSUED' } });

  /*
   * One row for the whole transition, not one per update. FINALIZING is the
   * shape of the write rather than a state anybody observes — the file header
   * says so — and filing it as its own audit entry would put a state in the
   * trail that no reader can be shown the invoice in.
   */
  await recordAudit(tx, ctx, {
    action: 'UPDATE',
    entityType: 'invoice',
    entityId: draft.id,
    branchId: draft.branchId,
    before,
    after: await invoiceAuditSnapshot(tx, ctx, draft.id),
    ...options,
  });

  return {
    id: draft.id,
    branchId: draft.branchId,
    invoiceNumber: issued.formatted,
    issuedAt: input.issuedAt,
    grandTotal: priced.grandTotal,
  };
}

// ---------------------------------------------------------------------------
// Cancel and void
// ---------------------------------------------------------------------------

/**
 * Abandon a draft.
 *
 * ⚠️ CANCELLED IS NOT VOID, AND THE DIFFERENCE IS WHETHER ANYBODY EVER SAW IT.
 *   A cancelled invoice never held a number, so nothing was shown to a patient,
 *   nothing appears on a return, and there is nothing to reverse. That is why it
 *   is reachable from DRAFT only.
 */
export async function cancelDraftInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: { invoiceId: string; reason?: string | null },
  options: InvoiceAuditOptions = {}
): Promise<void> {
  const draft = await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: ctx.organizationId, deletedAt: null },
    select: { id: true, status: true, branchId: true },
  });
  if (!draft) throw new NotFoundError('Invoice');

  if (draft.status !== 'DRAFT') {
    throw new ConflictError(
      `Invoice is ${draft.status} and cannot be cancelled. An issued invoice is voided, which keeps its number.`
    );
  }

  const before = await invoiceAuditSnapshot(tx, ctx, draft.id);

  await tx.invoice.update({
    where: { id: draft.id },
    data: {
      status: 'CANCELLED',
      cancelledBy: ctx.userId,
      cancelledAt: new Date(),
      cancellationReason: input.reason ?? null,
    },
  });

  await recordAudit(tx, ctx, {
    action: 'UPDATE',
    entityType: 'invoice',
    entityId: draft.id,
    branchId: draft.branchId,
    before,
    after: await invoiceAuditSnapshot(tx, ctx, draft.id),
    ...options,
  });
}

/**
 * Reverse an issued invoice, keeping its number.
 *
 * ⚠️ THE NUMBER AND THE ROW STAY FOR EVER. Voiding is how a series stays
 *   contiguous when a document has to be undone: the alternative is a DELETE,
 *   and a deleted number is a permanent hole that no reprint can fill because
 *   `issueNumber()` will never hand it out again.
 *
 * ⚠️ THIS DOES NOT RAISE A CREDIT NOTE, AND THE GAP IS DELIBERATE. Under GST a
 *   void that reduces a tax liability already reported is corrected with a
 *   credit note, and this repository has nowhere to put one: no table, no
 *   number series, no `CREDIT_NOTE` source type. It is also unreachable in a
 *   useful sense today — there is no patient-payments table, so `amount_paid` is
 *   always zero and no void can yet involve money. Designing the document with
 *   nothing to design against is the mistake §0.3 records about the lab and
 *   pharmacy stubs. `reason` is what a clinic has until then.
 */
export async function voidInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: { invoiceId: string; reason: string },
  options: InvoiceAuditOptions = {}
): Promise<void> {
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: ctx.organizationId },
    select: { id: true, status: true, branchId: true },
  });
  if (!invoice) throw new NotFoundError('Invoice');

  if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(invoice.status)) {
    throw new ConflictError(
      `Invoice is ${invoice.status} and cannot be voided. Only a document that was actually issued can be reversed.`
    );
  }

  /*
   * A reason is required rather than optional, and it is the one difference from
   * `cancelDraftInvoice`'s signature. A cancelled draft explains itself — nobody
   * saw it. A void is a reversal of something a patient holds a copy of, and
   * "why" is the only part of it that is not already in the row.
   */
  if (input.reason.trim().length === 0) {
    throw new ValidationError('Voiding an issued invoice needs a reason.');
  }

  const before = await invoiceAuditSnapshot(tx, ctx, invoice.id);

  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'VOID',
      voidedAt: new Date(),
      cancelledBy: ctx.userId,
      cancellationReason: input.reason,
    },
  });

  /*
   * ⚠️ THE FROZEN FINANCIALS ARE ON BOTH SIDES OF THIS ROW AND ARE IDENTICAL,
   *   WHICH IS THE POINT. A void reverses a document without changing a figure
   *   on it, so `diffSnapshots` narrows this to the status, the void date and
   *   the reason having been recorded — and the fact that the totals did NOT
   *   move is then provable from the trail, because a row that changed them
   *   would have said so.
   */
  await recordAudit(tx, ctx, {
    action: 'UPDATE',
    entityType: 'invoice',
    entityId: invoice.id,
    branchId: invoice.branchId,
    before,
    after: await invoiceAuditSnapshot(tx, ctx, invoice.id),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/**
 * Who did it and from where, for the row `recordAudit` writes.
 *
 * ⚠️ NO `route`, UNLIKE `InvoiceActionOptions` IN `invoice.service.ts`, AND THE
 *   TWO ARE NOT THE SAME TYPE FOR THAT REASON. `audit_logs` has no `route`
 *   column: a mutation is identified by what it changed, and the endpoint it
 *   arrived on is a property of the request rather than of the change.
 *   `data_access_logs` has one because a read leaves no other trace of its
 *   shape. The route passes the wider object; this narrows it.
 */
export interface InvoiceAuditOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * ⚠️ THE ALLOW-LIST. EVERY COLUMN AN AUDIT ROW MAY CARRY, AND NO OTHER.
 *
 * This is the first of the two layers CONVENTIONS.md asks for, and it is the one
 * that actually works: the columns that must never reach `audit_logs` are not
 * selected here, so no snapshot can contain them by accident. The deny-list in
 * `audit.service.ts` is the backstop under it.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, AND WHY EACH ONE IS A TEMPTING ADDITION:
 *
 *   - `customerName`, `customerPhone`, `customerEmail`, `customerAddress` — the
 *     patient, in four columns, snapshotted onto the invoice on purpose so the
 *     document keeps printing them. Copying them onto an append-only table that
 *     compliance staff read is the exact disclosure Stage 3 forbids. `patientId`
 *     below is the link a reader follows, and it names nobody on its own.
 *   - `notes` and `cancellationReason` — free text a cashier types. Reported as
 *     `hasNotes` / `hasCancellationReason`: that a reason was recorded is the
 *     auditable fact, and the sentence itself stays on the invoice where anyone
 *     who may read the bill can read it.
 *   - The LINES. `invoice_items.description` is "Ultrasound, obstetric" — a
 *     diagnosis in a billing column. `lineCount` is what an audit row needs:
 *     "the bill went from three lines to five" is the question, and what the two
 *     extra lines were for is on the invoice.
 *
 * `customerTaxId` IS here and is not an exception to any of the above. It is a
 * business's GSTIN, put on a bill so a company can claim it, and who added one
 * to a patient's invoice is a question with an obvious wrong answer.
 */
const AUDIT_SELECT = {
  status: true,
  sourceType: true,
  branchId: true,
  appointmentId: true,
  patientId: true,
  invoiceNumber: true,
  currency: true,
  customerTaxId: true,
  suppliedAt: true,
  dueDate: true,
  issuedAt: true,
  voidedAt: true,
  subtotal: true,
  lineDiscountTotal: true,
  invoiceDiscountTotal: true,
  taxableAmount: true,
  taxTotal: true,
  roundingAdjustment: true,
  grandTotal: true,
  taxTreatment: true,
  placeOfSupply: true,
  issuerTaxRegistrationId: true,
  issuerTaxId: true,
  notes: true,
  cancellationReason: true,
  _count: { select: { items: true } },
} satisfies Prisma.InvoiceSelect;

/**
 * One invoice, as the trail may see it.
 *
 * Read fresh on both sides of a write rather than assembled from the caller's
 * input, because the interesting half of an invoice is DERIVED: the cashier
 * types a quantity and a price, and what moved is the tax, the apportioned
 * discount and the grand total. A snapshot built from the request would record
 * what was asked for and miss what the engine did with it.
 *
 * ⚠️ MONEY AS INTEGER MINOR UNITS, VIA `toMoney`, NEVER `Decimal.toNumber()`.
 *   `numeric(14,2)` serialised into JSONB through a float is the one place a
 *   ledger silently loses a paisa, and `money.ts` exists to be the only
 *   boundary. The keys are suffixed `Minor` so nobody reads 199900 as rupees.
 */
async function invoiceAuditSnapshot(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<AuditSnapshot> {
  const row = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId },
    select: AUDIT_SELECT,
  });

  if (!row) throw new NotFoundError('Invoice');

  const minor = (value: Prisma.Decimal): number => toMoney(value, row.currency).amountMinor;

  return {
    status: row.status,
    sourceType: row.sourceType,
    branchId: row.branchId,
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    invoiceNumber: row.invoiceNumber,
    currency: row.currency,
    customerTaxId: row.customerTaxId,
    suppliedAt: row.suppliedAt.toISOString(),
    /*
     * ⚠️ SLICED, NOT CONVERTED — the Phase 9 lesson, in the one other place it
     *   applies. `due_date` is a `DATE`, which Prisma hands back as UTC
     *   midnight and which has no zone at all; running it through a zone helper
     *   reports the previous day west of Greenwich. `suppliedAt` above is a
     *   `timestamptz` and is a genuine instant, so it goes out as one.
     */
    dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    lineCount: row._count.items,
    subtotalMinor: minor(row.subtotal),
    lineDiscountTotalMinor: minor(row.lineDiscountTotal),
    invoiceDiscountTotalMinor: minor(row.invoiceDiscountTotal),
    taxableAmountMinor: minor(row.taxableAmount),
    taxTotalMinor: minor(row.taxTotal),
    roundingAdjustmentMinor: minor(row.roundingAdjustment),
    grandTotalMinor: minor(row.grandTotal),
    taxTreatment: row.taxTreatment,
    placeOfSupply: row.placeOfSupply,
    issuerTaxRegistrationId: row.issuerTaxRegistrationId,
    issuerTaxId: row.issuerTaxId,
    hasNotes: row.notes !== null,
    hasCancellationReason: row.cancellationReason !== null,
  };
}

// ---------------------------------------------------------------------------
// The registration check Phase 2 deferred
// ---------------------------------------------------------------------------

/**
 * Refuse to issue from a branch this clinic holds no registration for.
 *
 * ⚠️ THE DISTINCTION THIS FUNCTION EXISTS TO DRAW, AND IT IS NOT "IS THERE A
 *   REGISTRATION?". Two clinics reach finalisation with `NOT_REGISTERED` and
 *   only one of them has a problem:
 *
 *     - holds NOTHING anywhere — below the registration threshold. A legal
 *       position, and the honest one to print. Refusing here would stop every
 *       unregistered clinic on the platform from billing anybody.
 *     - holds a registration SOMEWHERE IN THIS COUNTRY, but nothing that reaches
 *       this branch. Either the branch's jurisdiction is wrong, or the clinic
 *       needs a registration for it, or somebody assigned coverage that leaves
 *       this branch out — and only a human can say which.
 *
 * ⚠️ `context.registrations` IS ALREADY THE EFFECTIVE SET FOR THIS BRANCH, which
 *   is what changed. `loadTaxContext` now narrows to the branch's stated coverage,
 *   or failing that to the registrations whose jurisdiction actually matches — so
 *   an empty set here means "nothing reaches this branch" and the old
 *   region-comparison this function used to do is already done, in the one place
 *   pricing reads it. Re-deriving it here would give two answers to one question.
 *
 *   What the narrowed set can no longer tell us is whether the clinic holds
 *   anything AT ALL, so that is read separately below. Without it, the check
 *   collapses into "no registration, carry on" and the wrong-state invoice it was
 *   written to catch goes out again.
 *
 * `branches.state` cannot answer any of this: it is free text written for an
 * address label, and "Karnataka", "KARNATAKA" and "Karnatak" are three different
 * lookup keys.
 */
async function assertRegistrationCoversBranch(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  suppliedAt: Date
): Promise<void> {
  const context = await loadTaxContext(tx, ctx, branchId, suppliedAt);
  const { countryCode, regionCode } = context.placeOfSupply;

  const country = countryCode.toUpperCase();

  // Something applies here. Which one it is was decided by coverage, and by the
  // same code that priced the document.
  if (context.registrations.some((row) => row.countryCode.toUpperCase() === country)) return;

  /*
   * Nothing applies. The clinic-wide question, asked directly: is this a practice
   * below the threshold, or one that is registered elsewhere in this country and
   * billing from a branch its registrations do not reach?
   */
  const heldInCountry = await tx.issuerTaxRegistration.findMany({
    where: {
      deletedAt: null,
      countryCode: country,
      effectiveFrom: { lte: suppliedAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: suppliedAt } }],
    },
    select: { countryCode: true, regionCode: true },
  });

  if (heldInCountry.length === 0) return;

  const region = regionCode?.toUpperCase() ?? null;
  const held = heldInCountry
    .map((registration) => registration.regionCode ?? registration.countryCode)
    .join(', ');

  throw new ConflictError(
    `This branch is registered in ${region ?? country} but the clinic holds no tax registration there (it holds: ${held}). ` +
      `Correct the branch's region, or add the registration, before issuing. Issuing now would bill under another state's registration.`
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StagedLine {
  lineNumber: number;
  itemCode: string | null;
  /** Carried across a reprice — see `DraftLineInput`. */
  creditedInvoiceItemId: string | null;
  input: InvoiceLineInput;
}

interface PricingRequest {
  invoiceId: string;
  branchId: string;
  currency: string;
  suppliedAt: Date;
  customerTaxId: string | null;
  discount?: DiscountInput;
  lines: StagedLine[];
}

/**
 * Price, then write every derived column — the invoice's totals, its lines and
 * their tax rows — as one replacement.
 *
 * ⚠️ THE LINES ARE DELETED AND RE-INSERTED RATHER THAN UPDATED IN PLACE. A
 *   reprice can change how many lines there are and which position each holds,
 *   and a diff that got it wrong would leave a stale row that still satisfies
 *   every constraint. `invoice_items` has no `deleted_at` deliberately — a line
 *   is hard-deleted while DRAFT — and the tax rows cascade from the item, so one
 *   `deleteMany` clears both. The item ids change on every reprice, which is
 *   safe precisely because nothing may reference a draft's line: `invoice_taxes`
 *   is written in the same statement and `invoice_documents` hangs off the
 *   invoice, not the line.
 */
async function priceAndPersist(
  tx: TxClient,
  ctx: TenantContext,
  request: PricingRequest
): Promise<PricedDraftInvoice> {
  const priced = await priceDraftInvoice(tx, ctx, {
    branchId: request.branchId,
    suppliedAt: request.suppliedAt,
    currency: request.currency,
    customerTaxId: request.customerTaxId,
    lines: request.lines.map((line) => line.input),
    ...(request.discount ? { discount: request.discount } : {}),
  });

  await tx.invoiceItem.deleteMany({
    where: { organizationId: ctx.organizationId, invoiceId: request.invoiceId },
  });

  for (const line of priced.lines) {
    const staged = request.lines[line.lineNumber - 1];

    const item = await tx.invoiceItem.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: request.branchId,
        invoiceId: request.invoiceId,
        lineNumber: line.lineNumber,
        description: line.description,
        itemCode: staged?.itemCode ?? null,
        creditedInvoiceItemId: staged?.creditedInvoiceItemId ?? null,
        taxCategory: line.taxCategory,
        quantity: new Prisma.Decimal(formatQuantity(line.quantityMilli)),
        unitPrice: toDecimal(line.unitPrice),
        grossAmount: toDecimal(line.grossAmount),
        ...discountColumns(line.discount),
        discountAmount: toDecimal(line.discountAmount),
        apportionedDiscount: toDecimal(line.apportionedDiscount),
        taxableAmount: toDecimal(line.taxableAmount),
        taxAmount: toDecimal(line.taxAmount),
        lineTotal: toDecimal(line.lineTotal),
        taxTreatment: line.taxTreatment,
        taxReason: line.taxReason,
      },
      select: { id: true },
    });

    /*
     * A separate `createMany` rather than a nested create under the item,
     * because `invoice_taxes` reaches its parents through COMPOSITE foreign keys
     * (ADR-0004) and Prisma's nested writes hand the child its parent's key
     * themselves — there is no way to also state `organization_id` and
     * `branch_id`, which this table carries in its own right precisely so it is
     * an ordinary member of both RLS loops rather than inheriting the org half
     * and none of the branch half.
     */
    if (line.taxes.length > 0) {
      await tx.invoiceTax.createMany({
        data: line.taxes.map((tax) => ({
          organizationId: ctx.organizationId,
          branchId: request.branchId,
          /*
           * Denormalised from the item so the invoice's tax summary is one
           * indexed read rather than a join through every line.
           */
          invoiceId: request.invoiceId,
          invoiceItemId: item.id,
          name: tax.name,
          jurisdiction: tax.jurisdiction,
          rateBps: tax.rateBps,
          taxableAmount: toDecimal(tax.taxableAmount),
          taxAmount: toDecimal(tax.taxAmount),
          treatment: tax.treatment,
          taxRuleId: tax.taxRuleId,
          taxRuleDefaultId: tax.taxRuleDefaultId,
        })),
      });
    }
  }

  await tx.invoice.update({
    where: { id: request.invoiceId },
    data: {
      subtotal: toDecimal(priced.subtotal),
      lineDiscountTotal: toDecimal(priced.lineDiscountTotal),
      invoiceDiscountTotal: toDecimal(priced.invoiceDiscountTotal),
      taxableAmount: toDecimal(priced.taxableAmount),
      taxTotal: toDecimal(priced.taxTotal),
      roundingAdjustment: toDecimal(priced.roundingAdjustment),
      grandTotal: toDecimal(priced.grandTotal),
      /*
       * The draft's own position, recomputed so the screen can show a cashier
       * that a line is UNRATED before they try to issue it. Finalisation writes
       * it again alongside the registration, because by then it is a claim the
       * document makes rather than a warning on a form.
       */
      taxTreatment: priced.taxTreatment,
      placeOfSupply: priced.placeOfSupply,
    },
  });

  return priced;
}

/**
 * A draft with everything a reprice reads, or a typed refusal.
 *
 * Under RLS another tenant's invoice id is indistinguishable from one that does
 * not exist, and both answers are 404 — never 403, which would confirm the row
 * is somebody's.
 */
/**
 * The header's own inputs, plus every line's, and nothing derived.
 *
 * Named so the select and the type cannot drift: adding a column here gives it
 * to `LoadedDraft` in the same edit, and forgetting to would otherwise surface
 * as a reprice that silently dropped whatever the cashier typed into it.
 */
const DRAFT_SELECT = {
  id: true,
  branchId: true,
  status: true,
  sourceType: true,
  /* PI-8: it decides which SERIES the number comes out of. See the number service. */
  kind: true,
  currency: true,
  suppliedAt: true,
  customerTaxId: true,
  discountType: true,
  discountBps: true,
  discountFixed: true,
  items: {
    orderBy: { lineNumber: 'asc' },
    select: {
      lineNumber: true,
      description: true,
      itemCode: true,
      creditedInvoiceItemId: true,
      taxCategory: true,
      quantity: true,
      unitPrice: true,
      discountType: true,
      discountBps: true,
      discountFixed: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

type LoadedDraft = Prisma.InvoiceGetPayload<{ select: typeof DRAFT_SELECT }>;

async function loadDraft(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<LoadedDraft> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId, deletedAt: null },
    select: DRAFT_SELECT,
  });

  if (!invoice) throw new NotFoundError('Invoice');

  if (invoice.status !== 'DRAFT') {
    /*
     * The trigger would refuse the writes that follow anyway; said here so the
     * caller gets a 409 naming the state rather than a raised Postgres exception
     * out of the middle of a transaction.
     */
    throw new ConflictError(
      `Invoice is ${invoice.status}. Only a DRAFT can be edited — an issued invoice is a document.`
    );
  }

  return invoice;
}

/** The three columns that hold a discount AS ENTERED, on either table. */
function discountColumns(discount: DiscountInput | undefined): {
  discountType: 'PERCENTAGE' | 'FIXED' | null;
  discountBps: number | null;
  discountFixed: Prisma.Decimal | null;
} {
  if (!discount) return { discountType: null, discountBps: null, discountFixed: null };

  return discount.type === 'PERCENTAGE'
    ? { discountType: 'PERCENTAGE', discountBps: discount.bps, discountFixed: null }
    : { discountType: 'FIXED', discountBps: null, discountFixed: toDecimal(discount.amount) };
}

/**
 * The house currency — what a draft is denominated in when nobody says
 * otherwise.
 *
 * Exported so the appointment-billing path prices in the same currency this one
 * would default to. A second read of `organizations.currency` somewhere else is
 * how a draft gets opened in one currency and priced in another.
 */
export async function organizationCurrency(tx: TxClient, ctx: TenantContext): Promise<string> {
  const organization = await tx.organization.findFirst({
    where: { id: ctx.organizationId },
    select: { currency: true },
  });
  if (!organization) throw new NotFoundError('Organization');
  return organization.currency;
}
