/**
 * Billing a set of charges — the second integrated source on the invoice engine.
 *
 * The sibling of `appointment-billing.service.ts` and deliberately its shape: a
 * domain that knows what happened hands a structured request to invoicing, and
 * invoicing does the rest. Nothing here is a second engine. The draft it opens
 * is an ordinary `sourceType: PHARMACY` invoice, priced, finalised, numbered and
 * rendered by exactly the code Phases 3–7 built.
 *
 * ⚠️ WHERE IT DIFFERS FROM THE APPOINTMENT DOOR, AND WHY. A consultation is ONE
 *   billable event with a rate card behind it, so that door reads the card and
 *   composes the lines. A pharmacy bill is N events that already happened, each
 *   with its policy and price resolved and FROZEN at the moment of supply. So
 *   this door composes nothing: it reads the charge requests, refuses the ones
 *   that are not billable, and turns each into a line verbatim.
 *
 *   That is not a stylistic choice. Re-resolving a price here would price a
 *   supply at today's grid rather than at the grid in force when the medicine
 *   left the shelf, and a clinic that raised its prices on Monday would restate
 *   Friday's supplies. `charge_requests` is the snapshot; this reads it.
 *
 * ⚠️ THE CALLER NAMES THE CHARGES AND THIS SERVICE DOES NOT GUESS. "Bill
 *   everything outstanding for this patient" is a query the SCREEN runs and a
 *   set the human confirms. Deriving the set here from a patient id would mean a
 *   charge raised one second before the click silently joining a bill nobody
 *   reviewed.
 *
 * ⚠️ NO NEW PERMISSION CODE FOR THE ACT OF BILLING. `billing.invoice.create`
 *   raises the draft, which is the same code the generic route uses, because
 *   this endpoint confers nothing it does not. `billing.charge_request.manage`
 *   is a different act — deciding whether a supply is billed AT ALL — and is
 *   gated separately.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type { CreateInvoiceFromChargesRequest, InvoiceDetail } from '@rcln/contracts';
import { money } from '@rcln/payments';

import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

import { needsDecision } from '../charging/policy.service.js';
import { createDraftInvoice, type DraftLineInput } from './invoice-lifecycle.service.js';
import { canSeeSource, type InvoiceVisibility } from './invoice-visibility.js';
import { auditOptions, readInvoiceDetail, type InvoiceActionOptions } from './invoice.service.js';
import { toMoney } from './money.js';

const CHARGE_SELECT = {
  id: true,
  branchId: true,
  sourceType: true,
  kind: true,
  status: true,
  patientId: true,
  occurredAt: true,
  quantity: true,
  description: true,
  unitPrice: true,
  currency: true,
  taxCategory: true,
  itemCode: true,
  policy: true,
  decidedAt: true,
  patient: {
    select: {
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      addresses: {
        where: { isPrimary: true },
        take: 1,
        select: { line1: true, line2: true, city: true, state: true, pincode: true },
      },
    },
  },
} satisfies Prisma.ChargeRequestSelect;

type ChargeRow = Prisma.ChargeRequestGetPayload<{ select: typeof CHARGE_SELECT }>;

/**
 * Raise one invoice from a set of pending charges.
 *
 * ⚠️ THE CHARGE ROWS ARE LOCKED `FOR UPDATE` FIRST, AND THAT LOCK IS THE ONLY
 *   THING STOPPING TWO TILLS BILLING ONE SUPPLY TWICE. The obvious alternative
 *   — a unique index tying a charge request to at most one invoice — is not
 *   available: `invoice_id` must stay non-unique so a voided invoice keeps its
 *   reference while the replacement cites the same charges. So it is an
 *   application invariant, and an application invariant asserted by a read is a
 *   race. PI-3 learned this three times in one phase; `appointment-billing`
 *   locks the appointment for exactly the same reason.
 *
 * ⚠️ AND THE LOCK IS ORDERED. Two callers billing overlapping sets in different
 *   orders deadlock; `ORDER BY id` inside the locking statement makes every
 *   caller take them in the same order, so the second waits instead.
 */
export async function createInvoiceFromCharges(
  ctx: TenantContext,
  input: CreateInvoiceFromChargesRequest,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  const { id } = await withTenant(ctx, async (tx) => {
    await lockCharges(tx, input.chargeRequestIds);

    const charges = await tx.chargeRequest.findMany({
      where: { id: { in: input.chargeRequestIds }, organizationId: ctx.organizationId },
      select: CHARGE_SELECT,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    /*
     * ⚠️ A MISSING CHARGE IS A REFUSAL, NOT A SILENTLY SHORTER BILL. Under RLS an
     *   id from another tenant is indistinguishable from one that does not
     *   exist, and both mean the human confirmed a set that is not the set being
     *   billed. Quietly dropping it would hand somebody an invoice they did not
     *   review.
     */
    if (charges.length !== input.chargeRequestIds.length) {
      throw new NotFoundError('Charge request');
    }

    const first = assertOneBill(charges);

    /*
     * ⚠️ THE SOURCE HAS TO BE ONE THIS CALLER MAY SEE, AND THIS WAS MISSING. The
     *   source is taken from the charges rather than from a parameter — which
     *   stops a caller CHOOSING a source — but nothing checked that they may see
     *   the one they got. Without it somebody holding `billing.invoice.create`
     *   and no `pharmacy.dispense.read` could raise a pharmacy invoice they are
     *   then 404'd from reading, leaving a document in the ledger they created
     *   and cannot see.
     *
     *   404 and not 403, for the reason `canSeeSource` gives.
     */
    if (!canSeeSource(visibility, first.sourceType)) throw new NotFoundError('Charge request');
    /*
     * ⚠️ THE CHARGE'S OWN CURRENCY, NOT THE ORGANIZATION'S AS IT IS TODAY. The
     *   first version read `organizationCurrency(tx, ctx)` here, and that
     *   silently un-froze the one thing this whole file is careful to freeze: the
     *   currency selects the minor-unit exponent, so if a clinic changed its
     *   currency between supply and billing, an INR price was re-scaled and
     *   relabelled — a hundredfold error against JPY. `assertOneBill` has already
     *   proved every charge agrees with this one.
     */
    const currency = first.currency;

    const lines: DraftLineInput[] = charges.map((charge) => toLine(charge, currency));

    const draft = await createDraftInvoice(
      tx,
      ctx,
      {
        branchId: first.branchId,
        /*
         * ⚠️ THE SOURCE COMES FROM THE CHARGES, NOT FROM A PARAMETER. It decides
         *   the `{SOURCE}` segment of the number and which callers may SEE the
         *   invoice at all (`invoice-visibility.ts`), so letting the client pick
         *   it would let a caller file a pharmacy bill under a source their own
         *   role can read.
         */
        sourceType: first.sourceType,
        patientId: first.patientId,
        customer: {
          name: customerName(first),
          phone: first.patient?.phone ?? null,
          email: first.patient?.email ?? null,
          address: addressOf(first),
          /* A patient is not a business. A GSTIN goes on by editing the draft. */
          taxId: null,
        },
        /*
         * ⚠️ NO PRACTITIONER, DELIBERATELY. `invoices.practitioner_name` prints
         *   "attended by" and a pharmacy bill is for a box of tablets nobody was
         *   attended for — the column's own comment says exactly this. A dispense
         *   has a PRESCRIBER, which is a different fact and deserves its own
         *   column if a clinic ever needs it printed.
         *
         * ⚠️ THE COST, STATED: `practitioner_profile_id` is what
         *   `invoice-visibility.ts` filters a clinician's own list on, so a
         *   doctor holding `billing.invoice.read` and not `.read_all` sees no
         *   pharmacy invoices at all. That is correct — a pharmacy supply is not
         *   their work — and it is the same answer they get for a counter sale
         *   today.
         */
        /*
         * ⚠️ THE INSTANT OF THE EARLIEST SUPPLY, NOT `now()`. It selects the
         *   effective-dated tax rule and the registration, so a bill raised in
         *   April for a March supply is taxed as March was. Where several
         *   supplies span a rate change the earliest wins, and the desk's answer
         *   to that is to bill them separately — which is what naming the set
         *   explicitly makes possible.
         */
        suppliedAt: first.occurredAt,
        dueDate: null,
        currency,
        lines,
        notes: input.notes ?? null,
      },
      /*
       * ⚠️ THE AUDIT ROW COMES FROM `createDraftInvoice` AND IS NOT WRITTEN
       *   AGAIN HERE. This door differs from the generic one in what it READS
       *   and not at all in what it writes. The charge updates below get their
       *   own rows, because attaching a supply to a bill is a separate fact.
       */
      auditOptions(options)
    );

    await attachToInvoice(tx, ctx, draft.id, charges);

    return draft;
  });

  return readInvoiceDetail(ctx, id, visibility, options, false);
}

/**
 * Every charge on one bill must agree about who, where and in what.
 *
 * ⚠️ THE PATIENT CHECK IS A DISCLOSURE BOUNDARY AND NOT A TIDINESS ONE. An
 *   invoice that billed two patients' supplies puts one person's medicines on a
 *   document handed to another. Refused with a sentence rather than by picking
 *   the first — the desk chose the set and can choose a better one.
 *
 * ⚠️ THE BRANCH CHECK IS THE NUMBER SERIES AND THE PLACE OF SUPPLY. Both are
 *   per branch, and a bill spanning two would be numbered in one state's series
 *   and taxed under the other's registration.
 */
function assertOneBill(charges: readonly ChargeRow[]): ChargeRow {
  const first = charges[0];
  if (!first) throw new ValidationError('Name at least one charge to bill.');

  for (const charge of charges) {
    if (charge.status !== 'PENDING') {
      throw new ConflictError(
        charge.status === 'INVOICED'
          ? 'One of these charges is already on an invoice.'
          : `One of these charges is ${charge.status.toLowerCase()} and cannot be billed.`
      );
    }

    /*
     * ⚠️ AN UNDECIDED `OPTIONAL` CHARGE MAY NOT BE BILLED, AND THIS IS THE CHECK
     *   THAT MAKES THE POLICY MEAN ANYTHING. Without it, "a human decides"
     *   collapses into "whoever raises the invoice decides, without recording
     *   that they did" — which is the state PI-8 exists to replace.
     */
    if (needsDecision(charge.policy) && charge.decidedAt === null) {
      throw new ConflictError(
        'One of these charges is waiting for somebody to decide whether it is billed. Answer it on the charge queue first.'
      );
    }

    if (charge.unitPrice === null) {
      throw new ConflictError(
        /*
         * ⚠️ NO MEDICINE NAME. `errorHandler` logs `err.message` verbatim and it
         *   is not in pino's redact paths, so a product name here becomes "this
         *   person was supplied X" in the application log. Worse on this
         *   particular throw: it sits behind `billing.invoice.create` alone, so a
         *   caller without `billing.charge_request.read` would get the medicine
         *   back in the response with no disclosure row filed. The charge id is
         *   enough to find it on the queue.
         */
        `A charge on this bill has no price (${charge.id}). Set one on the product, or override it on the charge queue.`
      );
    }

    if (charge.branchId !== first.branchId) {
      throw new ValidationError(
        'These charges are from different branches. An invoice is numbered and taxed at one branch, so bill them separately.'
      );
    }

    if (charge.patientId !== first.patientId) {
      throw new ValidationError('These charges are for different people. Bill them separately.');
    }

    if (charge.currency !== first.currency) {
      throw new ValidationError('These charges are in different currencies. Bill them separately.');
    }

    if (charge.sourceType !== first.sourceType) {
      throw new ValidationError(
        'These charges come from different modules. An invoice has one source, so bill them separately.'
      );
    }

    /*
     * ⚠️ A REVERSAL NEVER JOINS AN INVOICE. It reduces what is owed, which is a
     *   CREDIT NOTE against the document that charged it — and an invoice
     *   carrying a negative line would be a document whose total is not the sum
     *   of what it says was supplied. `credit-note.service.ts` is the path.
     */
    if (charge.kind === 'REVERSAL') {
      throw new ValidationError(
        'A return is credited, not invoiced. Raise a credit note against the invoice that charged it.'
      );
    }
  }

  return first;
}

/**
 * One charge, as one invoice line.
 *
 * ⚠️ EVERY FIELD IS COPIED AND NONE IS RE-RESOLVED. The description, the
 *   category, the printed code, the quantity and the price were all decided at
 *   the moment of supply and frozen on the charge request. See the file header
 *   for why re-resolving them would restate history.
 *
 * ⚠️ AN ABSENT `taxCategory` BECOMES THE EMPTY STRING AND NOT A GUESS, WHICH
 *   RESOLVES `UNRATED` AND MAKES THE INVOICE UNISSUABLE. That is the designed
 *   failure and not a bug to route around: a category with no rule means the
 *   clinic has not classified this product, and issuing it would under-collect
 *   tax the clinic still owes. The draft is raised so the gap is visible on a
 *   real document; `finalizeInvoice` is what refuses.
 */
function toLine(charge: ChargeRow, currency: string): DraftLineInput {
  return {
    description: charge.description,
    taxCategory: charge.taxCategory ?? '',
    itemCode: charge.itemCode,
    quantity: charge.quantity.toString(),
    unitPrice: money(toMoney(charge.unitPrice!, currency).amountMinor, currency),
  };
}

/**
 * Write the link back — the one direction of the seam that invoicing owns.
 *
 * ⚠️ THE INVOICE, AND DELIBERATELY NOT THE INVOICE ITEM. BILLING_INTEGRATION.md
 *   asks for `invoice_item_id`, and an item id cannot be the link:
 *   `finalizeInvoice` re-prices a draft from its stored inputs, and
 *   `repriceLoadedDraft` does that by DELETING every `invoice_items` row and
 *   writing them again. So the id a charge cited at creation is gone by the time
 *   the document is issued — which either blocks finalisation on the foreign key
 *   or silently detaches the link at the moment it starts to matter. Measured,
 *   not reasoned about: the first version had the FK and finalisation raised
 *   `charge_requests_organization_id_invoice_item_id_fkey`.
 *
 *   `invoice_id` is stable for the life of the document and is what every
 *   question is actually about. The LINE is recoverable by position where anybody
 *   needs it — `createDraftInvoice` numbers lines by array index, and this
 *   function is handed the charges in the same order the lines were built from.
 */
async function attachToInvoice(
  tx: TxClient,
  ctx: TenantContext,
  invoiceId: string,
  charges: readonly ChargeRow[]
): Promise<void> {
  await tx.chargeRequest.updateMany({
    where: { id: { in: charges.map((charge) => charge.id) }, organizationId: ctx.organizationId },
    data: { status: 'INVOICED', invoiceId },
  });
}

/**
 * Serialise two tills billing the same supply.
 *
 * `FOR UPDATE` on the rows rather than an advisory lock, for the reason
 * `appointment-billing.service.ts` gives: the rows are real, the lock is
 * released by COMMIT without anybody remembering to, and RLS applies to it — a
 * lock on another tenant's id locks nothing and the subsequent read 404s.
 */
async function lockCharges(tx: TxClient, ids: readonly string[]): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM charge_requests
     WHERE id = ANY (${[...ids]}::uuid[])
     ORDER BY id
       FOR UPDATE
  `;
}

function customerName(charge: ChargeRow): string {
  if (!charge.patient) {
    /*
     * ⚠️ A COUNTER SALE HAS NO PATIENT AND STILL NEEDS A NAME ON THE DOCUMENT.
     *   `customer_name` is NOT NULL because an invoice with no addressee is not
     *   a document. Inventing a patient record to hold a paracetamol sale is
     *   exactly what `dispenses.patient_id` is nullable to avoid, so the bill
     *   says what it is and the cashier types a name over it if the customer
     *   wants one.
     */
    return 'Counter sale';
  }
  return charge.patient.lastName
    ? `${charge.patient.firstName} ${charge.patient.lastName}`
    : charge.patient.firstName;
}

/** The patient's primary address as one printable block. */
function addressOf(charge: ChargeRow): string | null {
  const address = charge.patient?.addresses[0];
  if (!address) return null;

  const composed = [address.line1, address.line2, address.city, address.state, address.pincode]
    .filter((part): part is string => Boolean(part))
    .join(', ');
  return composed.length > 0 ? composed : null;
}
