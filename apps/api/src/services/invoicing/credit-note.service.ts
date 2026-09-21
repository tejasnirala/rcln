/**
 * Credit notes — reversing an issued document without editing it (PI-8).
 *
 * ⚠️ THIS CLOSES A GAP `voidInvoice`'s HEADER RECORDED AS DELIBERATE, AND THE
 *   REASON IT WAS DELIBERATE IS WORTH KEEPING. Phase 5 wrote: "Under GST a void
 *   that reduces a tax liability already reported is corrected with a credit
 *   note, and this repository has nowhere to put one: no table, no number
 *   series, no `CREDIT_NOTE` source type. It is also unreachable in a useful
 *   sense today — there is no patient-payments table, so `amount_paid` is always
 *   zero." Designing the document with nothing to design against was the mistake
 *   it refused to make.
 *
 *   PI-8 gives it something to design against: a dispensing return is money
 *   coming back off a bill that has already been handed over, and it happens at
 *   every pharmacy every day.
 *
 * ── WHY A CREDIT NOTE IS AN `invoices` ROW ──────────────────────────────────
 * The alternative is `credit_notes` / `credit_note_items` / `credit_note_taxes`,
 * which duplicates the line arithmetic, the apportionment, the per-line tax
 * snapshot, the document join and — the part that actually decides it —
 * `invoices_lifecycle_guard`. That trigger freezes every money column of an
 * issued document against an allow-list, and a credit note has EXACTLY the same
 * immutability requirement. Writing it twice means getting the hardest thing in
 * this engine right twice, and finding out about the second one from an
 * auditor.
 *
 * What the law actually requires is a separate consecutive SERIES, and that is a
 * period key: `CRN-2026-PHA-MAIN-000001`. One table, two series.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 *   · crediting anything that was never issued — there is nothing to reverse;
 *   · crediting more than the invoice charged, in total across every note;
 *   · crediting a line that is not on the invoice being credited;
 *   · crediting a credit note.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * ⚠️ IT MOVES NO MONEY, AND CANNOT, BECAUSE THERE IS NO PATIENT-PAYMENTS TABLE.
 *   A credit note is the DOCUMENT that says the clinic owes the patient; the
 *   refund is a payment, `billing.refund.process` is the code that will gate it,
 *   and `amount_paid` is still always zero. That is the same honest boundary
 *   `voidInvoice` drew, moved one step forward rather than papered over.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { CreateCreditNoteRequest, InvoiceDetail } from '@rcln/contracts';
import { money } from '@rcln/payments';

import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

import {
  createDraftInvoice,
  finalizeInvoice,
  type DraftLineInput,
} from './invoice-lifecycle.service.js';
import { canSeePractitioner, canSeeSource, type InvoiceVisibility } from './invoice-visibility.js';
import { auditOptions, readInvoiceDetail, type InvoiceActionOptions } from './invoice.service.js';
import { toMoney } from './money.js';

/**
 * An invoice that still stands, and can therefore still be credited.
 *
 * ⚠️ THE SAME DEFINITION `appointment-billing.service.ts` USES FOR "ALREADY
 *   BILLED?", MINUS THE TWO PRE-ISSUE STATES. A DRAFT has no number and nothing
 *   to reverse — cancel it. A CANCELLED one was seen by nobody. A VOID one has
 *   already been reversed in full, and crediting it would reverse it twice.
 */
const CREDITABLE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID'] as const;

/** Credit notes that count against the invoice's remaining creditable value. */
const LIVE_NOTE_STATUSES = ['DRAFT', 'FINALIZING', 'ISSUED', 'PARTIALLY_PAID', 'PAID'] as const;

const ORIGINAL_SELECT = {
  id: true,
  kind: true,
  status: true,
  branchId: true,
  sourceType: true,
  invoiceNumber: true,
  /* Not printed — `loadVisibleInvoice` compares it against the caller's scope. */
  practitionerProfileId: true,
  patientId: true,
  currency: true,
  grandTotal: true,
  suppliedAt: true,
  customerName: true,
  customerPhone: true,
  customerEmail: true,
  customerAddress: true,
  customerTaxId: true,
  items: {
    orderBy: { lineNumber: 'asc' },
    select: {
      id: true,
      lineNumber: true,
      description: true,
      itemCode: true,
      taxCategory: true,
      quantity: true,
      unitPrice: true,
      /*
       * ⚠️ THE DISCOUNTS, WITHOUT WHICH A CREDIT NOTE REFUNDS GROSS WHERE THE
       *   PATIENT PAID NET. Missing these was a real defect found in review: on
       *   an invoice with any discount the note priced at `unitPrice × quantity`
       *   and the clinic issued a statutory document owing MORE than it had
       *   charged. `discount_amount` is the line's own and `apportioned_discount`
       *   is its share of the whole-bill one — both come off the taxable value,
       *   so both have to come off the credit.
       */
      discountAmount: true,
      apportionedDiscount: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

type Original = Prisma.InvoiceGetPayload<{ select: typeof ORIGINAL_SELECT }>;

/**
 * Raise a credit note against an issued invoice.
 *
 * ⚠️ IT IS ISSUED IMMEDIATELY AND HAS NO DRAFT STATE THE CALLER CAN SEE, WHICH
 *   IS THE OPPOSITE OF AN INVOICE AND IS THE SAME CALL PI-7 MADE ABOUT A
 *   DISPENSE. A credit note reverses something that has already happened — the
 *   stock is back on the shelf, the patient is owed the money — so there is
 *   nothing to assemble and nothing to change one's mind about. A draft credit
 *   note is a reversal that has been decided and not recorded, and the window
 *   between the two is exactly where a clinic's books stop balancing.
 *
 *   It still goes DRAFT → FINALIZING → ISSUED inside ONE transaction, because
 *   that is the only path through the lifecycle guard and the only thing that
 *   prices the lines. Nobody observes the intermediate states.
 *
 * ⚠️ THE ORIGINAL IS LOCKED `FOR UPDATE` FIRST. The total-credited check is a
 *   read-then-write against a sum, and `withTenant` is plain READ COMMITTED: two
 *   people crediting the same invoice concurrently both read a sum that leaves
 *   room and both write. PI-3 found this exact shape three times in one phase —
 *   see its "every transfer state transition was a read-then-write race" note —
 *   and it is worse here, because the result is a clinic refunding more than it
 *   charged.
 */
export async function createCreditNote(
  ctx: TenantContext,
  invoiceId: string,
  input: CreateCreditNoteRequest,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  const { id } = await withTenant(ctx, async (tx) => {
    await lockInvoice(tx, invoiceId);

    /*
     * ⚠️ THROUGH `loadVisible`, NOT A BARE `findFirst` — AND THE FIRST VERSION OF
     *   THIS GOT IT WRONG. Every other invoice mutation checks visibility before
     *   it writes; `voidInvoice` says so in its own comment. Without it a caller
     *   holding `billing.credit_note.issue` could reverse ANY issued invoice in
     *   the organization, including sources and practitioners their read
     *   visibility excludes — the write committed, and only the read-back on the
     *   way out 404'd, so they got an error and the ledger got a credit note they
     *   were never allowed to see.
     *
     *   404 and not 403, for the reason `canSeeSource` gives: a 403 on an id
     *   confirms the invoice exists.
     */
    const original = await loadVisibleInvoice(tx, ctx, invoiceId, visibility);

    assertCreditable(original);

    const lines = resolveLines(original, input, await creditedPerLine(tx, ctx, original.id));

    const draft = await createDraftInvoice(
      tx,
      ctx,
      {
        branchId: original.branchId,
        /*
         * ⚠️ THE SOURCE IS THE ORIGINAL'S. It decides the `{SOURCE}` segment of
         *   the number and which callers may see the document at all
         *   (`invoice-visibility.ts`) — a credit note against a pharmacy invoice
         *   that filed itself under `OTHER` would be visible to people the
         *   invoice it reverses is hidden from.
         */
        sourceType: original.sourceType,
        kind: 'CREDIT_NOTE',
        creditedInvoiceId: original.id,
        patientId: original.patientId,
        /*
         * ⚠️ THE CUSTOMER BLOCK IS COPIED FROM THE ORIGINAL DOCUMENT, NOT
         *   RE-READ FROM THE PATIENT. The original is a snapshot taken when it
         *   was issued, and a credit note has to be addressed to whoever the
         *   invoice was addressed to — a patient who has married and changed
         *   their surname since must not be sent a reversal in a different name
         *   from the bill it reverses. The whole reason `invoices` snapshots
         *   these columns, applied one document further along.
         */
        customer: {
          name: original.customerName,
          phone: original.customerPhone,
          email: original.customerEmail,
          address: original.customerAddress,
          taxId: original.customerTaxId,
        },
        /*
         * ⚠️ THE ORIGINAL'S DATE OF SUPPLY, NOT TODAY'S. `loadTaxContext`'s own
         *   header names this case: "a credit note raised in April against a
         *   March invoice is taxed as March was, and re-reading today's rules
         *   would quietly price it at whatever the rate is now." A reversal at
         *   the wrong rate leaves the clinic having collected tax at 12% and
         *   refunded it at 5%, with the difference owed to nobody and kept by
         *   accident.
         */
        suppliedAt: original.suppliedAt,
        dueDate: null,
        currency: original.currency,
        lines: lines.map((line) => line.draft),
        notes: input.reason,
      },
      auditOptions(options)
    );

    /*
     * ⚠️ THE CEILING IS CHECKED AFTER THE DRAFT IS PRICED, AND BEFORE IT IS
     *   FINALISED. That ordering is the fix for a defect review found: the check
     *   used to run BEFORE pricing and compared a gross-before-discount,
     *   before-tax figure against the original's `grand_total`, which is net and
     *   after tax — three different bases in one subtraction. Where the discount
     *   exceeded the tax it refused a legitimate full credit outright; where it
     *   did not, it let a note through that over-credited by roughly the
     *   discount.
     *
     *   Reading the priced draft's own `grand_total` compares like with like. The
     *   draft costs nothing if the check then throws: everything here is one
     *   transaction, so the rollback takes the draft with it and no number has
     *   been issued yet.
     */
    await assertWithinRemaining(tx, ctx, original, draft.id);

    /*
     * ⚠️ FINALISED IN THE SAME TRANSACTION, SO NO CREDIT NOTE IS EVER OBSERVABLE
     *   AS A DRAFT. See the header. `finalizeInvoice` re-prices from the stored
     *   inputs, refuses an UNRATED line, takes the number from the CRN series and
     *   writes its own audit row.
     *
     * ⚠️ AN UNRATED LINE REFUSES THE WHOLE NOTE, AND THAT IS RIGHT EVEN THOUGH
     *   THE INVOICE IT CREDITS WAS ISSUED. An issued invoice had a rate for every
     *   line by construction; if the category has since been withdrawn from the
     *   rate card, the clinic cannot state what it is reversing, and a reversal
     *   at no rate silently keeps the tax.
     */
    await finalizeInvoice(
      tx,
      ctx,
      { invoiceId: draft.id, issuedAt: new Date() },
      auditOptions(options)
    );

    return draft;
  });

  return readInvoiceDetail(ctx, id, visibility, options, false);
}

function assertCreditable(original: Original): void {
  if (original.kind === 'CREDIT_NOTE') {
    throw new ValidationError(
      'A credit note cannot itself be credited. Raise a fresh invoice if the clinic is owed money again.'
    );
  }

  if (!(CREDITABLE_STATUSES as readonly string[]).includes(original.status)) {
    throw new ConflictError(
      original.status === 'DRAFT'
        ? 'This invoice has not been issued, so there is nothing to reverse. Cancel the draft instead.'
        : `Invoice is ${original.status} and cannot be credited. Only a document that was actually issued can be reversed.`
    );
  }
}

interface ResolvedCreditLine {
  draft: DraftLineInput;
}

/**
 * The lines to reverse, cited from the invoice itself.
 *
 * ⚠️ EVERY FIELD EXCEPT THE QUANTITY IS THE ORIGINAL LINE'S, VERBATIM. The
 *   description, the tax category, the printed code and the unit price all come
 *   off the document being reversed — a credit note that described the supply
 *   differently, or rated it differently, would not be a reversal of anything a
 *   reader could match to the invoice in their hand.
 *
 * ⚠️ AND THE DISCOUNT COMES WITH THEM, AS A FIXED AMOUNT SCALED TO THE CREDITED
 *   QUANTITY. This is the fix for a defect review found: without it the note
 *   priced at GROSS while the invoice had charged NET, so crediting a discounted
 *   bill in full refunded more than was ever taken. Passing it as `FIXED` rather
 *   than re-deriving two layers of percentage means the engine's own
 *   apportionment arithmetic does the work, and a FULL credit comes out at
 *   exactly the line's `taxable_amount` — which is the number tax was computed
 *   on, and therefore the number that has to be reversed.
 *
 * ⚠️ SCALED PRO-RATA ON A PARTIAL CREDIT, largest-remainder left to the engine.
 *   Crediting 1 of 3 discounted units reverses a third of the discount with it;
 *   reversing the whole discount for one unit would refund more than that unit
 *   ever cost.
 *
 * ⚠️ AN EMPTY REQUEST CREDITS EVERY LINE IN FULL, which is the common case: a
 *   patient brought the whole supply back, or the bill was raised in error.
 */
function resolveLines(
  original: Original,
  input: CreateCreditNoteRequest,
  /** How much of each original line every LIVE note has already reversed. */
  alreadyCreditedByItem: ReadonlyMap<string, Prisma.Decimal>
): ResolvedCreditLine[] {
  const requested =
    input.lines.length > 0
      ? input.lines
      : original.items.map((item) => ({ invoiceItemId: item.id, quantity: undefined }));

  return requested.map((entry) => {
    const item = original.items.find((row) => row.id === entry.invoiceItemId);
    if (!item) {
      throw new ValidationError(
        'One of the lines is not on the invoice being credited. A credit note reverses the document it cites and nothing else.'
      );
    }

    const quantity =
      entry.quantity === undefined ? item.quantity : new Prisma.Decimal(entry.quantity);

    if (quantity.lessThanOrEqualTo(0)) {
      throw new ValidationError('A credited quantity must be more than nothing.');
    }

    /*
     * ⚠️ PER LINE, AND CUMULATIVE ACROSS EVERY LIVE NOTE — the second half was
     *   missing and it was a real defect. Capping against `item.quantity` alone
     *   let a two-line bill be credited twice on line A and never on line B: the
     *   TOTAL stayed bounded by `assertWithinRemaining`, so no clinic could
     *   refund more than it charged, but the document said more of A came back
     *   than ever went out — and stock reconciliation reads the lines, not the
     *   total.
     *
     *   `credited_invoice_item_id` on the note's own lines is what makes this
     *   summable at all; before PI-8 there was no link back to sum over.
     */
    const alreadyCredited = alreadyCreditedByItem.get(item.id) ?? new Prisma.Decimal(0);
    const remainingOnLine = item.quantity.minus(alreadyCredited);

    if (quantity.greaterThan(remainingOnLine)) {
      throw new ValidationError(
        /*
         * ⚠️ LINE NUMBER, NOT THE MEDICINE'S NAME. `errorHandler` logs
         *   `err.message` verbatim and `message` is not in pino's redact paths,
         *   so interpolating a product name here puts "this person was supplied
         *   X" into the application log — the disclosure this codebase never
         *   makes. The line number identifies it unambiguously on the document
         *   the caller is already holding.
         */
        alreadyCredited.greaterThan(0)
          ? `Line ${String(item.lineNumber)} was billed at ${item.quantity.toString()} and ` +
              `${alreadyCredited.toString()} has already been credited, so at most ` +
              `${remainingOnLine.toString()} is left.`
          : `Line ${String(item.lineNumber)} was billed at ${item.quantity.toString()} and cannot be credited for more than that.`
      );
    }

    const currency = original.currency;

    /*
     * The line's whole discount — its own plus its share of the bill's —
     * scaled to the fraction being credited. `item.quantity` is non-zero: a
     * zero-quantity invoice line is refused when the invoice is priced.
     */
    const discount = item.discountAmount
      .plus(item.apportionedDiscount)
      .times(quantity)
      .dividedBy(item.quantity)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    return {
      draft: {
        description: item.description,
        /* The link that makes the cap above summable on the NEXT note. */
        creditedInvoiceItemId: item.id,
        taxCategory: item.taxCategory,
        itemCode: item.itemCode,
        quantity: quantity.toString(),
        unitPrice: money(toMoney(item.unitPrice, currency).amountMinor, currency),
        ...(discount.greaterThan(0)
          ? {
              discount: {
                type: 'FIXED' as const,
                amount: money(toMoney(discount, currency).amountMinor, currency),
              },
            }
          : {}),
      },
    };
  });
}

/**
 * How much of each of an invoice's lines has already been reversed.
 *
 * ⚠️ SUMMED OVER THE NOTES' OWN LINES, KEYED BY `credited_invoice_item_id`, AND
 *   RESTRICTED TO NOTES THAT STILL STAND. A cancelled draft note and a voided
 *   one reverse nothing, so counting them would permanently block a clinic that
 *   voided a mistaken note from raising the right one — the same `LIVE_STATUSES`
 *   argument `appointment-billing.service.ts` makes about "is this visit already
 *   billed?".
 *
 * ⚠️ `groupBy` ON THE CHILD WITH A FILTER ON THE PARENT, so this is one query
 *   rather than one per line. An invoice with forty lines credited five times is
 *   still one round trip.
 */
async function creditedPerLine(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await tx.invoiceItem.groupBy({
    by: ['creditedInvoiceItemId'],
    where: {
      organizationId: ctx.organizationId,
      creditedInvoiceItemId: { not: null },
      invoice: {
        creditedInvoiceId: invoiceId,
        kind: 'CREDIT_NOTE',
        deletedAt: null,
        status: { in: [...LIVE_NOTE_STATUSES] },
      },
    },
    _sum: { quantity: true },
  });

  const byItem = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    if (row.creditedInvoiceItemId === null) continue;
    byItem.set(row.creditedInvoiceItemId, row._sum.quantity ?? new Prisma.Decimal(0));
  }
  return byItem;
}

/**
 * A clinic may not credit more than it charged.
 *
 * ⚠️ SUMMED ACROSS EVERY LIVE NOTE ON THIS INVOICE, NOT JUST THE ONE BEING
 *   RAISED. Partial returns are the ordinary case — three tablets today, the
 *   rest next week — so a clinic legitimately raises several notes against one
 *   bill, and the ceiling is the invoice's own `grand_total` against their sum.
 *   A per-note check alone lets three notes of the full amount through.
 *
 * ⚠️ CANCELLED AND VOID NOTES ARE EXCLUDED, because both reverse nothing. That
 *   is the same `LIVE_STATUSES` argument `appointment-billing.service.ts` makes
 *   about "is this visit already billed?", and getting it backwards here would
 *   permanently block a clinic that voided a mistaken credit note from raising
 *   the right one.
 *
 * ⚠️ IT COMPARES `grand_total` TO `grand_total`, WHICH IT DID NOT USED TO. The
 *   candidate is read back from the draft AFTER pricing rather than estimated
 *   from the line inputs before it, so both sides of the subtraction are the
 *   same base — net of discount, inclusive of tax and rounding. See the call
 *   site for what the old shape got wrong.
 *
 * ⚠️ THE DRAFT ITSELF IS EXCLUDED FROM `alreadyCredited` BY ITS OWN ID, not by
 *   its status. It is a live DRAFT at this moment and would otherwise count
 *   itself, making every first credit note look like a second one.
 */
async function assertWithinRemaining(
  tx: TxClient,
  ctx: TenantContext,
  original: Original,
  draftId: string
): Promise<void> {
  const [priced, existing] = await Promise.all([
    tx.invoice.findFirst({
      where: { id: draftId, organizationId: ctx.organizationId },
      select: { grandTotal: true },
    }),
    tx.invoice.aggregate({
      where: {
        organizationId: ctx.organizationId,
        creditedInvoiceId: original.id,
        kind: 'CREDIT_NOTE',
        deletedAt: null,
        status: { in: [...LIVE_NOTE_STATUSES] },
        id: { not: draftId },
      },
      _sum: { grandTotal: true },
    }),
  ]);

  const creditTotal = priced?.grandTotal ?? new Prisma.Decimal(0);
  const alreadyCredited = existing._sum.grandTotal ?? new Prisma.Decimal(0);
  const remaining = original.grandTotal.minus(alreadyCredited);

  if (remaining.lessThanOrEqualTo(0)) {
    throw new ConflictError(
      `Invoice ${original.invoiceNumber ?? ''} has already been credited in full.`.trim()
    );
  }

  if (creditTotal.greaterThan(remaining)) {
    throw new ConflictError(
      `That is more than is left to credit on this invoice. ${remaining.toString()} ${original.currency} remains.`
    );
  }
}

/**
 * The invoice being credited, and only if this caller may see it.
 *
 * ⚠️ THE SAME TWO QUESTIONS `loadVisible` IN `invoice.service.ts` ASKS, against
 *   the wider `ORIGINAL_SELECT` this file needs. Duplicated rather than exported
 *   because that function's select carries the whole detail payload and this one
 *   needs the line discounts; what must NOT diverge is the pair of checks, so
 *   both call the same `canSeeSource` / `canSeePractitioner` from
 *   `invoice-visibility.ts`.
 */
async function loadVisibleInvoice(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string,
  visibility: InvoiceVisibility
): Promise<Original> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId, deletedAt: null },
    select: ORIGINAL_SELECT,
  });

  if (!invoice) throw new NotFoundError('Invoice');
  if (!canSeeSource(visibility, invoice.sourceType)) throw new NotFoundError('Invoice');
  if (!canSeePractitioner(visibility, invoice.practitionerProfileId)) {
    throw new NotFoundError('Invoice');
  }
  return invoice;
}

/**
 * Serialise two people crediting the same invoice.
 *
 * `FOR UPDATE` on the invoice rather than an advisory lock, for the reason every
 * other lock in this codebase gives: the row is real, the lock releases at
 * COMMIT without anybody remembering to, and RLS applies to it — a lock on
 * another tenant's id locks nothing and the read that follows 404s.
 */
async function lockInvoice(tx: TxClient, invoiceId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND deleted_at IS NULL FOR UPDATE
  `;
}
