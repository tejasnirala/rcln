'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { InvoiceDetail, InvoiceTaxLine } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { StatusPill } from '@/components/tenant/invoice-list';
import { InvoiceDraftEditor } from '@/components/tenant/invoice-draft-editor';
import { RecordHistory } from '@/components/tenant/record-history';
import { formatClinicDate } from '@/lib/format';
import { INVOICE_SOURCE_LABELS } from '@/lib/invoice-filters';
import {
  cancelInvoice,
  issueInvoice,
  creditInvoice,
  voidInvoice,
  type InvoiceFormState,
} from '@/app/(tenant)/t/[slug]/(app)/invoices/actions';

/**
 * One invoice: what it says, what it totals, and what may still be done to it.
 *
 * ⚠️ THE DOCUMENT ON THIS SCREEN IS THE DOCUMENT THE PATIENT RECEIVES, NOT A
 *   RENDERING OF THE SAME DATA. The frame loads `renderInvoiceHtml` over
 *   `loadInvoiceDocumentData()` — the same function the worker's Chromium prints
 *   the stored PDF from. Everything else here is chrome around it: the totals
 *   panel exists because a cashier wants the arithmetic broken out, not because
 *   the document is missing anything.
 *
 * ⚠️ AND EVERY CONTROL IS THE API'S PERMISSION, NOT A GUESS AT ONE. Issuing is
 *   `billing.invoice.create` — raising the bill and handing it over are one act
 *   at a counter — while cancel and void share `billing.invoice.cancel`. A
 *   control the caller cannot use is not rendered, because following it would
 *   only produce a 403.
 */
export function InvoiceDetailScreen({
  slug,
  invoice,
  branchName,
  timezone,
  document,
  canEdit,
  canIssue,
  canCancel,
  canReadHistory,
  canCredit,
}: {
  slug: string;
  invoice: InvoiceDetail;
  branchName: string | null;
  timezone: string;
  /**
   * The preview frame. Built by the page, because it is a Server Component and
   * this screen is a Client one — see `invoice-document-frame.tsx`. It loads its
   * own content and reports its own failure inside the frame, so there is no
   * null case for this screen to render around.
   */
  document: React.ReactNode;
  canEdit: boolean;
  canIssue: boolean;
  canCancel: boolean;
  /**
   * `audit.record.read`, which is a manager's code and not a cashier's.
   *
   * ⚠️ DELIBERATELY NOT IMPLIED BY `billing.invoice.read`. The obvious widening
   *   — whoever may read the bill may read its trail — collides with §0.7: the
   *   audit endpoint keys on `(entityType, entityId)` and knows nothing about
   *   an invoice's SOURCE, so it would hand a receptionist the history of a lab
   *   invoice the ledger correctly hides from them. See `audit.routes.ts`.
   */
  canReadHistory: boolean;
  /**
   * `billing.credit_note.issue` (PI-8).
   *
   * ⚠️ DELIBERATELY NOT IMPLIED BY `canCancel`, EVEN THOUGH BOTH REVERSE A BILL.
   *   Voiding reverses a document in FULL and keeps its number; a credit note
   *   reverses PART of one, several times over as stock comes back, and issues a
   *   new document with its own statutory serial. A clinic that separates who may
   *   do which is a control the seeded permission already anticipated.
   */
  canCredit: boolean;
}) {
  const [state, setState] = useState<InvoiceFormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  /** Which confirmation is open. One at a time — they are all irreversible. */
  const [asking, setAsking] = useState<'none' | 'issue' | 'cancel' | 'void' | 'credit'>('none');
  const [reason, setReason] = useState('');
  /**
   * How much of each line is coming back (PI-8).
   *
   * ⚠️ SEEDED WITH THE WHOLE INVOICE, BECAUSE THAT IS THE COMMON CASE. A patient
   *   brought everything back, or the bill was raised in error. Untick a line or
   *   lower its quantity for a partial return — the API takes the same shape
   *   either way, and an EMPTY list is its own "credit all of it", which is what
   *   is sent when every line is still ticked at its full quantity.
   */
  const [creditLines, setCreditLines] = useState<Record<string, string>>({});

  const outcome = useRef<HTMLDivElement>(null);
  useOutcomeFocus(state.status, outcome);

  const isDraft = invoice.status === 'DRAFT';
  /*
   * ⚠️ THE THREE STATUSES A VOID IS REACHABLE FROM, MATCHING `voidInvoice()`
   *   EXACTLY. Not "anything that is not a draft": FINALIZING is the
   *   millisecond-wide window while the number is being taken, and CANCELLED and
   *   VOID are already finished. Offering the control in any of those produces a
   *   409 from a button that looked available.
   */
  const isVoidable =
    invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID' || invoice.status === 'PAID';
  /*
   * ⚠️ THE SAME THREE STATUSES A VOID IS REACHABLE FROM, AND ONE MORE CONDITION:
   *   a credit note is not itself creditable. `CREDITABLE_STATUSES` in
   *   `credit-note.service.ts` is the definition this mirrors, and the extra
   *   `kind` test is what stops the screen offering a control that produces a
   *   422 telling somebody a note cannot credit a note.
   *
   * ⚠️ AND IT CHECKS WHAT IS LEFT. An invoice already credited in full has
   *   nothing to reverse, and the engine refuses; hiding the button is the
   *   honest map rather than a 409 from a control that looked available.
   */
  const isCreditable =
    isVoidable &&
    invoice.kind === 'INVOICE' &&
    invoice.creditedTotalMinor < invoice.grandTotalMinor;
  const amount = (minor: number): string => formatMoney(money(minor, invoice.currency));

  function run(action: () => Promise<InvoiceFormState>): void {
    startTransition(async () => {
      const result = await action();
      setState(result);
      if (result.status === 'done') {
        setAsking('none');
        setReason('');
        setCreditLines({});
      }
    });
  }

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb">
        <Link
          href="/invoices"
          className="text-muted hover:text-drape text-sm focus-visible:underline"
        >
          ← All invoices
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display font-mono text-ink text-[1.75rem] leading-tight tracking-tight">
              {/*
               * A draft has no number by construction — the series is drawn from
               * at issue, so that a cancelled draft consumes nothing. "Draft
               * invoice" is what it is called until then, and it is not a
               * placeholder for a number that exists.
               */}
              {invoice.invoiceNumber ?? 'Draft invoice'}
            </h1>
            <StatusPill status={invoice.status} />
          </div>
          <p className="text-muted mt-2 text-sm">
            {INVOICE_SOURCE_LABELS[invoice.sourceType]}
            {branchName === null ? null : <> · {branchName}</>} · supplied{' '}
            {/* formatClinicDate in the BRANCH's zone — never toLocaleDateString. */}
            {formatClinicDate(invoice.suppliedAt, timezone)}
            {invoice.issuedAt === null ? null : (
              <> · issued {formatClinicDate(invoice.issuedAt, timezone)}</>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* A reference rather than an action — the same quiet link it is on
              every other screen, beside the buttons rather than among them. */}
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="invoice"
              entityId={invoice.id}
              /* ⚠️ THE NUMBER, NEVER THE CUSTOMER. The drawer's heading is the
                 one string this component chooses for it, and `customerName` is
                 the patient — the same reason `metadata.title` on the page above
                 is the word "Invoice". A draft has no number and is called what
                 it is. */
              label={invoice.invoiceNumber ?? 'Draft invoice'}
            />
          ) : null}
          {isDraft && canEdit && !editing ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit the draft
            </Button>
          ) : null}
          {isDraft && canIssue && !editing ? (
            <Button
              size="sm"
              disabled={pending || !invoice.issuable}
              onClick={() => setAsking('issue')}
            >
              Issue the invoice
            </Button>
          ) : null}
          {isDraft && canCancel && !editing ? (
            <Button variant="danger" size="sm" onClick={() => setAsking('cancel')}>
              Cancel the draft
            </Button>
          ) : null}
          {isCreditable && canCredit && !editing ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                /* Every line, at its full quantity — the common case. */
                setCreditLines(
                  Object.fromEntries(invoice.items.map((item) => [item.id, item.quantity]))
                );
                setAsking('credit');
              }}
            >
              Raise a credit note
            </Button>
          ) : null}
          {isVoidable && canCancel && !editing ? (
            <Button variant="danger" size="sm" onClick={() => setAsking('void')}>
              Void the invoice
            </Button>
          ) : null}
          <DownloadButton invoiceId={invoice.id} state={invoice.document.status} />
        </div>
      </header>

      <div ref={outcome} tabIndex={-1}>
        {state.status === 'error' && state.message ? (
          <Alert tone="error">{state.message}</Alert>
        ) : null}
        {state.status === 'done' && state.invoiceNumber ? (
          <Alert tone="info">
            {/* The action keeps its name through the flow: Issue → Issued. */}
            Issued as <span className="font-mono">{state.invoiceNumber}</span>. The PDF is being
            prepared and Download works in a moment.
          </Alert>
        ) : null}
      </div>

      {/*
       * ⚠️ AN UNISSUABLE DRAFT IS A CONFIGURATION GAP, NOT AN ERROR, AND IT IS
       *   SAID BEFORE THE BUTTON IS PRESSED RATHER THAN AFTER. A line whose tax
       *   category the clinic never gave a rate for was charged nothing — right
       *   for a draft, and impossible to hand to a patient. `issuable` and its
       *   reasons come from `isIssuable()` in @rcln/tax, so this is the engine's
       *   answer and not a second copy of the rule.
       */}
      {isDraft && !invoice.issuable ? (
        <Alert tone="error">
          <p className="font-medium">This draft cannot be issued yet.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {invoice.unissuableReasons.map((why) => (
              <li key={why}>{why}</li>
            ))}
          </ul>
          <p className="mt-2">
            Set a rate for the tax categories on these lines, or change the lines to categories the
            clinic has rated.
          </p>
        </Alert>
      ) : null}

      {asking === 'issue' ? (
        <Confirm
          heading="Issue this invoice?"
          body="It takes the next number in this branch's series, its totals stop being editable, and the patient's copy is generated. A mistake after this is corrected by voiding it, which leaves both documents on the record."
          confirmLabel="Issue the invoice"
          pending={pending}
          onCancel={() => setAsking('none')}
          onConfirm={() => run(() => issueInvoice(slug, invoice.id))}
        />
      ) : null}

      {asking === 'cancel' ? (
        <Confirm
          heading="Cancel this draft?"
          body="Nothing outside the clinic has seen it, so it consumes no invoice number and leaves no document. The visit it bills becomes billable again."
          confirmLabel="Cancel the draft"
          pending={pending}
          reason={{
            value: reason,
            onChange: setReason,
            label: 'Why (optional)',
            hint: 'A cancelled draft mostly explains itself.',
          }}
          onCancel={() => setAsking('none')}
          onConfirm={() => run(() => cancelInvoice(slug, invoice.id, reason))}
        />
      ) : null}

      {asking === 'void' ? (
        <Confirm
          heading="Void this invoice?"
          body="The number and the document both stand — the patient may be holding a copy — and the reason is the only account of why this bill was reversed. To reverse only part of it, raise a credit note instead."
          confirmLabel="Void the invoice"
          pending={pending}
          reason={{
            value: reason,
            onChange: setReason,
            label: 'Why',
            hint: 'Required. It goes on the record beside the invoice.',
            errors: state.fieldErrors?.['reason'],
          }}
          onCancel={() => setAsking('none')}
          onConfirm={() => run(() => voidInvoice(slug, invoice.id, reason))}
        />
      ) : null}

      {asking === 'credit' ? (
        <Confirm
          heading="Raise a credit note?"
          body="A credit note is a new document with its own number, reversing what you choose below at the rate that was in force when it was supplied. This invoice is not edited — it stands exactly as the patient received it."
          confirmLabel="Raise the credit note"
          pending={pending}
          extra={
            <div className="mt-4 max-w-prose">
              <table className="w-full text-left text-sm">
                <thead className="text-muted border-rule border-b text-xs">
                  <tr>
                    <th className="py-2 font-normal">
                      <span className="sr-only">Include</span>
                    </th>
                    <th className="py-2 font-normal">Line</th>
                    <th className="py-2 font-normal">Billed</th>
                    <th className="py-2 font-normal">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => {
                    const included = creditLines[item.id] !== undefined;
                    return (
                      <tr key={item.id} className="border-rule border-b last:border-0">
                        <td className="py-2">
                          <input
                            type="checkbox"
                            checked={included}
                            aria-label={`Credit ${item.description}`}
                            onChange={() =>
                              setCreditLines((current) => {
                                const next = { ...current };
                                if (included) delete next[item.id];
                                else next[item.id] = item.quantity;
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="py-2">{item.description}</td>
                        <td className="py-2 tabular-nums">{item.quantity}</td>
                        <td className="py-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            disabled={!included}
                            value={creditLines[item.id] ?? ''}
                            aria-label={`Quantity of ${item.description} to credit`}
                            onChange={(event) =>
                              setCreditLines((current) => ({
                                ...current,
                                [item.id]: event.target.value,
                              }))
                            }
                            className="border-rule w-24 rounded-sm border px-2 py-1 tabular-nums disabled:opacity-40"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {Object.keys(creditLines).length === 0 ? (
                <p className="text-danger mt-2 text-[0.8125rem]">
                  Choose at least one line to credit.
                </p>
              ) : null}
            </div>
          }
          reason={{
            value: reason,
            onChange: setReason,
            label: 'Why',
            hint: 'Required. It prints on the credit note and is what an auditor asks first.',
            errors: state.fieldErrors?.['reason'],
          }}
          onCancel={() => setAsking('none')}
          onConfirm={() =>
            run(() =>
              creditInvoice(
                slug,
                invoice.id,
                reason,
                Object.entries(creditLines).map(([invoiceItemId, quantity]) => ({
                  invoiceItemId,
                  quantity,
                }))
              )
            )
          }
        />
      ) : null}

      {/*
        ⚠️ THE NOTES RAISED AGAINST THIS BILL, AND WHAT IS LEFT. Shown on the
          invoice rather than only in the ledger, because "has this been
          refunded?" is asked while looking at the bill. The totals are
          POSITIVE on a credit note — the kind carries the sign — so the
          subtraction is stated in words rather than left to the reader.
      */}
      {invoice.creditNotes.length > 0 ? (
        <section
          aria-labelledby="credit-notes"
          className="border-rule bg-card rounded-md border p-4"
        >
          <h2 id="credit-notes" className="text-ink text-[1rem]">
            Credited
          </h2>
          <p className="text-muted mt-1 text-[0.875rem]">
            {amount(invoice.creditedTotalMinor)} of {amount(invoice.grandTotalMinor)} has been
            reversed.
          </p>
          <ul className="mt-3 space-y-2">
            {invoice.creditNotes.map((note) => (
              <li key={note.invoiceId} className="flex items-center justify-between gap-4">
                <Link
                  href={`/invoices/${note.invoiceId}`}
                  className="text-drape text-[0.875rem] hover:underline"
                >
                  {note.invoiceNumber ?? 'Credit note'}
                </Link>
                <span className="text-ink text-[0.875rem] tabular-nums">
                  {amount(note.grandTotalMinor)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {invoice.cancellationReason === null ? null : (
        <Alert tone="info">
          <span className="font-medium">{invoice.status === 'VOID' ? 'Voided' : 'Cancelled'}:</span>{' '}
          {invoice.cancellationReason}
        </Alert>
      )}

      {editing ? (
        <InvoiceDraftEditor
          slug={slug}
          invoice={invoice}
          timezone={timezone}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/*
            No heading and no caption: the document IS the invoice, printed at
            the size it prints, and a label over it explaining that it is a
            document is a sentence nobody needs twice. The section keeps an
            accessible name so the landmark is still announced.
          */}
          <section aria-label="Invoice document">{document}</section>

          <div className="space-y-8">
            <Totals invoice={invoice} amount={amount} />
            <Taxes taxes={invoice.taxes} amount={amount} />
            <Provenance invoice={invoice} timezone={timezone} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The arithmetic, broken out.
 *
 * ⚠️ EVERY FIGURE COMES OFF THE ROW AND NONE IS ADDED UP HERE. The engine's
 *   apportionment and its largest-remainder rounding are what make the lines sum
 *   to the total; re-deriving a subtotal in the browser would produce a number
 *   that is right almost always, and the times it disagreed with the document
 *   beside it would be unexplainable.
 */
function Totals({
  invoice,
  amount,
}: {
  invoice: InvoiceDetail;
  amount: (minor: number) => string;
}) {
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Lines', value: amount(invoice.subtotalMinor) },
    ...(invoice.lineDiscountTotalMinor > 0
      ? [{ label: 'Discount on lines', value: `−${amount(invoice.lineDiscountTotalMinor)}` }]
      : []),
    ...(invoice.invoiceDiscountTotalMinor > 0
      ? [{ label: 'Discount on the bill', value: `−${amount(invoice.invoiceDiscountTotalMinor)}` }]
      : []),
    { label: 'Taxable', value: amount(invoice.taxableAmountMinor) },
    { label: 'Tax', value: amount(invoice.taxTotalMinor) },
    ...(invoice.roundingAdjustmentMinor !== 0
      ? [
          {
            label: 'Rounding',
            value:
              invoice.roundingAdjustmentMinor > 0
                ? amount(invoice.roundingAdjustmentMinor)
                : `−${amount(Math.abs(invoice.roundingAdjustmentMinor))}`,
          },
        ]
      : []),
  ];

  return (
    <section aria-labelledby="totals-heading" className="border-rule bg-card rounded-lg border p-5">
      <h2 id="totals-heading" className="text-ink font-display text-lg">
        Totals
      </h2>
      <dl className="mt-4 space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted">{row.label}</dt>
            <dd className="text-ink font-mono">{row.value}</dd>
          </div>
        ))}
        <div className="border-rule flex items-baseline justify-between gap-4 border-t pt-3">
          <dt className="text-ink font-medium">Total</dt>
          <dd className="text-ink font-mono font-medium">{amount(invoice.grandTotalMinor)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted">Outstanding</dt>
          <dd className="text-ink font-mono">
            {/*
             * ⚠️ ALWAYS THE WHOLE TOTAL TODAY, BECAUSE THERE ARE NO PAYMENTS
             *   YET. `amount_paid` cannot be anything but zero through any
             *   route, so `PARTIALLY_PAID` and `PAID` are unreachable and this
             *   line is the grand total. It is shown rather than hidden so the
             *   screen does not have to change shape on the day the payments
             *   table lands.
             */}
            {amount(invoice.balanceDueMinor)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The tax summary, as a return is filed from.
 *
 * ⚠️ ONE ROW PER COMPONENT PER JURISDICTION PER RATE, AND MERGING ANY TWO OF
 *   THEM WOULD STATE A TAX NOBODY LEVIES. CGST 6% and SGST 6% are the same rate
 *   on the same base owed to two different governments; a single 12% row is not
 *   a tidier way of saying that, it is a different claim. The grouping is the
 *   API's and this table renders it as given.
 */
function Taxes({ taxes, amount }: { taxes: InvoiceTaxLine[]; amount: (minor: number) => string }) {
  return (
    <section aria-labelledby="taxes-heading" className="border-rule bg-card rounded-lg border p-5">
      <h2 id="taxes-heading" className="text-ink font-display text-lg">
        Tax
      </h2>
      {taxes.length === 0 ? (
        <p className="text-muted mt-3 text-sm">
          {/*
           * No tax is a legitimate answer — a clinic below the registration
           * threshold, or an exempt supply — and it is not the same as an
           * unrated line, which the alert above reports separately.
           */}
          No tax is charged on this invoice.
        </p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-muted text-left text-xs tracking-wide uppercase">
              <th scope="col" className="pb-2 font-medium">
                Component
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                Rate
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                On
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                Tax
              </th>
            </tr>
          </thead>
          <tbody>
            {taxes.map((tax) => (
              <tr
                key={`${tax.name}|${tax.jurisdiction ?? ''}|${tax.rateBps}`}
                className="border-rule border-t"
              >
                <td className="py-2">
                  {tax.name}
                  {tax.jurisdiction === null ? null : (
                    <span className="text-muted font-mono"> {tax.jurisdiction}</span>
                  )}
                </td>
                {/* Basis points into a percentage: 900 is 9%. */}
                <td className="py-2 text-right font-mono">{tax.rateBps / 100}%</td>
                <td className="py-2 text-right font-mono">{amount(tax.taxableMinor)}</td>
                <td className="py-2 text-right font-mono">{amount(tax.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Who issued it, under what registration, and where the supply happened.
 *
 * These are the fields a tax authority asks about and a clinic never thinks
 * about until it is asked. They are printed on the document; they are repeated
 * here because the document is an iframe somebody has to scroll.
 */
function Provenance({ invoice, timezone }: { invoice: InvoiceDetail; timezone: string }) {
  return (
    <section
      aria-labelledby="provenance-heading"
      className="border-rule bg-card rounded-lg border p-5"
    >
      <h2 id="provenance-heading" className="text-ink font-display text-lg">
        On the record
      </h2>
      <dl className="mt-4 space-y-3 text-sm">
        <Fact label="Billed to" value={invoice.customerName} />
        {invoice.customerTaxId === null ? null : (
          <Fact label="Customer tax number" value={invoice.customerTaxId} mono />
        )}
        {invoice.issuerLegalName === null ? null : (
          <Fact label="Issued by" value={invoice.issuerLegalName} />
        )}
        {invoice.issuerTaxId === null ? (
          <Fact
            label="Registration"
            /*
             * ⚠️ NOT AN ERROR AND NOT A MISSING FIELD. A clinic below the
             *   registration threshold issues invoices without one, and the
             *   engine charged no tax for exactly that reason.
             */
            value="None — this clinic is not registered for tax"
          />
        ) : (
          <Fact label="Registration" value={invoice.issuerTaxId} mono />
        )}
        {invoice.placeOfSupply === null ? null : (
          <Fact label="Place of supply" value={invoice.placeOfSupply} mono />
        )}
        {invoice.dueDate === null ? null : (
          <Fact
            label="Payment due"
            /*
             * ⚠️ SLICED, NOT FORMATTED IN A ZONE. `due_date` is a `DATE` and has
             *   no zone; `formatClinicDate` would read UTC midnight in the
             *   branch's zone and print the previous day west of Greenwich. The
             *   supplied date above IS an instant and is formatted properly.
             */
            value={invoice.dueDate.slice(0, 10)}
            mono
          />
        )}
        {invoice.voidedAt === null ? null : (
          <Fact label="Voided" value={formatClinicDate(invoice.voidedAt, timezone)} />
        )}
        {invoice.notes === null ? null : <Fact label="Notes" value={invoice.notes} />}
      </dl>
    </section>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted text-xs tracking-wide uppercase">{label}</dt>
      <dd className={mono ? 'text-ink font-mono' : 'text-ink'}>{value}</dd>
    </div>
  );
}

/**
 * Download, and the four states that are not "yes".
 *
 * ⚠️ `PENDING` IS NOT AN ERROR. The render is queued after the invoice commits
 *   and runs in the worker, so there is a window — usually about a second — in
 *   which an issued invoice has no bytes. The document on screen is rendered
 *   from data throughout, so only this button waits, and it says what it is
 *   waiting for rather than failing when pressed.
 *
 * A plain `<a>` and not a button: it is a URL, so it opens in a tab, and the
 * browser's own PDF viewer is what a cashier wants. `target="_blank"` carries
 * `rel="noopener"` because a document is not a place to hand out `window.opener`.
 */
function DownloadButton({
  invoiceId,
  state,
}: {
  invoiceId: string;
  state: InvoiceDetail['document']['status'];
}) {
  if (state === 'READY') {
    return (
      <a
        href={`/invoices/${invoiceId}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="border-rule bg-card text-ink hover:bg-drape-tint/40 inline-flex items-center justify-center rounded-md border px-3 py-2 text-[0.8125rem] font-medium transition-colors"
      >
        Download the PDF
      </a>
    );
  }

  if (state === 'PENDING' || state === 'GENERATING') {
    return (
      <p className="text-muted text-sm" aria-live="polite">
        Preparing the PDF…
      </p>
    );
  }

  if (state === 'FAILED') {
    return (
      <p className="text-signal text-sm">
        {/*
         * ⚠️ AND THERE IS NO RETRY BUTTON, WHICH IS AN API GAP AND NOT AN
         *   OVERSIGHT HERE. `requestInvoicePdf(ctx, job, attempt)` exists and
         *   nothing calls it a second time. Until a route does, re-issuing is
         *   not the answer — the invoice is valid and its number is spent — so
         *   the honest thing is to say the document failed and who can fix it.
         */}
        The PDF could not be generated. The invoice itself is valid; tell an administrator.
      </p>
    );
  }

  // NONE — a draft, which has no document by construction.
  return null;
}

/**
 * A confirmation, for the three actions that cannot be taken back.
 *
 * ⚠️ NOT A MODAL. A dialog that traps focus over a document somebody is reading
 *   is the wrong shape for "check this before you press it": the invoice is the
 *   context for the decision and hiding it behind an overlay removes exactly the
 *   thing being confirmed. This is a panel in the flow, it says what will happen
 *   in plain terms, and the safe choice is the one that dismisses it.
 */
function Confirm({
  heading,
  body,
  confirmLabel,
  pending,
  reason,
  extra,
  onCancel,
  onConfirm,
}: {
  heading: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  reason?: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    hint: string;
    errors?: string[] | undefined;
  };
  /**
   * An optional block between the body and the reason — the credit dialog's line
   * picker (PI-8).
   *
   * ⚠️ A SLOT RATHER THAN A SECOND CONFIRM COMPONENT. All four of these dialogs
   *   are the same irreversible-action shape and share the heading, the reason
   *   field, the disabled-while-pending pair and the "Keep it as it is" wording.
   *   Forking one of them to add a table is how two dialogs that must behave
   *   identically start drifting.
   */
  extra?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <section
      aria-labelledby="confirm-heading"
      className="border-signal/30 bg-signal-tint rounded-lg border p-5"
    >
      <h2 id="confirm-heading" className="text-ink font-display text-lg">
        {heading}
      </h2>
      <p className="text-ink-soft mt-2 max-w-prose text-sm">{body}</p>
      {extra}
      {reason ? (
        <div className="mt-4 max-w-prose">
          <Textarea
            name="reason"
            label={reason.label}
            hint={reason.hint}
            rows={2}
            value={reason.value}
            onChange={(event) => reason.onChange(event.target.value)}
            {...(reason.errors ? { errors: reason.errors } : {})}
          />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="danger" size="sm" disabled={pending} onClick={onConfirm}>
          {pending ? 'Working…' : confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Keep it as it is
        </Button>
      </div>
    </section>
  );
}
