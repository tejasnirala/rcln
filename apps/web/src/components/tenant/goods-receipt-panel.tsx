'use client';

import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';
import type { GoodsReceiptDetail } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';
import {
  decideQualityAction,
  goodsReceiptTransitionAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * One delivery: what it says, and whether it has reached a shelf yet.
 *
 * ⚠️ POSTING IS THE IRREVERSIBLE ACT AND THE COPY SAYS SO BEFORE THE BUTTON. It
 *   writes the ledger, creates the lot and serial rows and rolls the cost. There is
 *   no reversal by design: a posted delivery is corrected with a return or an
 *   adjustment, because the stock is genuinely on the shelf and the ledger genuinely
 *   records it arriving.
 *
 * ⚠️ INSPECTION IS A DECISION PER LINE WITH NO DEFAULT. There is no "pass all"
 *   control anywhere on this screen: checking a delivery is the moment somebody looks
 *   at it, and a screen where the default is "fine" is a screen where nobody looks.
 *   Only lines somebody actually marked are sent.
 */
interface Props {
  slug: string;
  receipt: GoodsReceiptDetail;
  canManage: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  POSTED: 'On the shelf',
  CANCELLED: 'Cancelled',
};

const QUALITY_LABEL: Record<string, string> = {
  NOT_REQUIRED: 'No check needed',
  PENDING: 'Waiting to be checked',
  ACCEPTED: 'Accepted',
  REJECTED: 'Refused',
};

export function GoodsReceiptPanel({ slug, receipt, canManage }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProcurementFormState | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  const [qualityState, qualityAction, qualityPending] = useActionState<
    ProcurementFormState,
    FormData
  >(decideQualityAction.bind(null, slug, receipt.id), IDLE_FORM);

  const post = () => {
    startTransition(async () => {
      setResult(await goodsReceiptTransitionAction(slug, receipt.id, 'post'));
    });
  };

  const cancel = (form: FormData) => {
    startTransition(async () => {
      const outcome = await goodsReceiptTransitionAction(slug, receipt.id, 'cancel', form);
      setResult(outcome);
      if (outcome.status === 'saved') setShowCancel(false);
    });
  };

  const pendingLines = receipt.lines.filter((line) => line.qualityStatus === 'PENDING');

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {receipt.receiptNumber ?? 'Draft delivery'}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {receipt.supplierName} · {receipt.branchName} ·{' '}
            {STATUS_LABEL[receipt.status] ?? receipt.status}
          </p>
        </div>
        {receipt.status === 'POSTED' && canManage ? (
          <Link
            href={`/procurement/returns/new?goodsReceiptId=${receipt.id}`}
            className="border-rule text-ink hover:bg-drape-tint/50 inline-flex items-center justify-center rounded-md border px-5 py-3 text-[0.9375rem] font-medium transition-colors"
          >
            Send something back
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      {result?.status === 'error' && result.message ? (
        <Alert tone="error">{result.message}</Alert>
      ) : null}
      {result?.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}
      {qualityState.status === 'error' && qualityState.message ? (
        <Alert tone="error">{qualityState.message}</Alert>
      ) : null}
      {qualityState.status === 'saved' ? <Alert tone="success">Inspection recorded.</Alert> : null}

      {receipt.status === 'DRAFT' ? (
        <Alert tone="info">
          Nothing here is on a shelf yet. Posting writes the movements, creates the lots and records
          what it cost — and cannot be undone afterwards, only corrected with a return or an
          adjustment.
        </Alert>
      ) : null}
      {receipt.status === 'CANCELLED' && receipt.cancellationReason ? (
        <Alert tone="warning">Cancelled: {receipt.cancellationReason}</Alert>
      ) : null}
      {receipt.status === 'POSTED' && receipt.qualityHoldRequired ? (
        <Alert tone="info">
          This branch inspects deliveries, so the stock landed on hold. It cannot be dispensed until
          each line is accepted below.
        </Alert>
      ) : null}

      <section className="border-rule bg-card grid gap-x-8 gap-y-3 rounded-md border p-4 sm:grid-cols-2">
        <Detail label="Onto" value={receipt.locationName} />
        <Detail label="Arrived" value={receipt.receivedAt.slice(0, 10)} />
        <Detail label="Against order" value={receipt.purchaseOrderNumber} />
        <Detail
          label="Their invoice"
          value={
            receipt.supplierInvoiceNumber === null
              ? null
              : `${receipt.supplierInvoiceNumber}${receipt.supplierInvoiceDate ? ` of ${receipt.supplierInvoiceDate}` : ''}`
          }
        />
        <Detail label="Recorded by" value={receipt.createdByName} />
        <Detail label="Posted by" value={receipt.postedByName} />
        <Detail
          label="Goods"
          value={`${receipt.currency} ${(receipt.goodsValueMinor / 100).toFixed(2)}`}
        />
        <Detail
          label="Charges"
          value={`${receipt.currency} ${((receipt.freightMinor + receipt.dutyMinor + receipt.handlingMinor) / 100).toFixed(2)} freight, duty and handling`}
        />
        <Detail
          label="Total"
          value={`${receipt.currency} ${(receipt.totalMinor / 100).toFixed(2)} including ${receipt.currency} ${(receipt.taxAmountMinor / 100).toFixed(2)} tax`}
        />
        {receipt.notes ? (
          <div className="sm:col-span-2">
            <Detail label="Notes" value={receipt.notes} />
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What was in the boxes
        </h2>
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {receipt.lines.map((line) => (
            <li key={line.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-ink text-[0.9375rem]">{line.productName}</span>
                {/* The line's own snapshot, never a join to `batches` — a draft has
                    no lot row at all, and the person keying it in is exactly who
                    needs to read back what they typed. */}
                {line.lotNumber ? (
                  <span className="text-muted font-mono text-[0.75rem]">{line.lotNumber}</span>
                ) : null}
                {line.serialNumber ? (
                  <span className="text-muted font-mono text-[0.75rem]">{line.serialNumber}</span>
                ) : null}
                {line.qualityStatus !== 'NOT_REQUIRED' ? (
                  <span
                    className={
                      line.qualityStatus === 'REJECTED'
                        ? 'text-signal border-signal/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                        : 'text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                    }
                  >
                    {QUALITY_LABEL[line.qualityStatus] ?? line.qualityStatus}
                  </span>
                ) : null}
                <span className="text-ink ml-auto font-mono text-[0.875rem]">
                  {receipt.currency} {(line.lineTotalMinor / 100).toFixed(2)}
                </span>
              </div>
              <p className="text-muted mt-1 text-[0.8125rem]">
                {line.receivedQuantityBase} {line.baseUnitSymbol}
                {line.expiresOn ? ` · expires ${line.expiresOn}` : ''}
                {' · '}
                {receipt.currency} {(line.unitCostBase / 100).toFixed(2)} per {line.baseUnitSymbol}
                {line.landedCostMinor > 0
                  ? ` · ${receipt.currency} ${(line.landedCostMinor / 100).toFixed(2)} of charges`
                  : ''}
                {Number(line.rejectedQuantityBase) > 0
                  ? ` · ${line.rejectedQuantityBase} refused`
                  : ''}
              </p>
              {line.qualityNotes ? (
                <p className="text-muted mt-1 text-[0.8125rem]">Inspection: {line.qualityNotes}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap gap-3">
        {canManage && receipt.status === 'DRAFT' ? (
          <>
            <Button type="button" disabled={pending} onClick={post}>
              {pending ? 'Posting…' : 'Post to the shelf'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowCancel(true)}>
              Cancel delivery
            </Button>
          </>
        ) : null}
      </section>

      {showCancel ? (
        <form
          action={cancel}
          className="border-rule bg-card max-w-xl space-y-3 rounded-md border p-4"
        >
          <Textarea
            label="Why is it being cancelled?"
            name="reason"
            required
            rows={3}
            errors={result?.fieldErrors?.['reason']}
            hint="Nothing has reached a shelf, so this moves no stock."
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Cancel delivery'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowCancel(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : null}

      {canManage && pendingLines.length > 0 ? (
        <form action={qualityAction} className="space-y-4">
          <div className="border-rule flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
            <h2 className="text-ink text-[0.9375rem] font-medium">Check what arrived</h2>
            <span className="text-muted text-[0.75rem]">
              Accepting a line makes it dispensable. Refusing leaves it on hold.
            </span>
          </div>

          <ul className="space-y-4">
            {pendingLines.map((line, index) => (
              <li key={line.id} className="border-rule bg-card space-y-3 rounded-md border p-4">
                <input type="hidden" name={`lines.${index}.lineId`} value={line.id} />
                <p className="text-ink text-[0.9375rem]">
                  {line.productName}
                  {line.lotNumber ? (
                    <span className="text-muted font-mono text-[0.75rem]"> {line.lotNumber}</span>
                  ) : null}
                  <span className="text-muted text-[0.8125rem]">
                    {' '}
                    · {line.receivedQuantityBase} {line.baseUnitSymbol} arrived
                  </span>
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    name={`lines.${index}.outcome`}
                    label="Decision"
                    options={[
                      { value: '', label: 'Not checked yet' },
                      { value: 'ACCEPTED', label: 'Accept' },
                      { value: 'REJECTED', label: 'Refuse' },
                    ]}
                    hint="Leave blank to decide later."
                  />
                  <Input
                    name={`lines.${index}.rejectedQuantityBase`}
                    label="How much is bad"
                    inputMode="decimal"
                    hint="Needed on a refusal. Leave blank if all of it is fine."
                  />
                  <Input
                    name={`lines.${index}.notes`}
                    label="What is wrong"
                    hint="Needed on a refusal — the supplier is asked for a credit on it."
                  />
                </div>
              </li>
            ))}
          </ul>

          <Button type="submit" disabled={qualityPending}>
            {qualityPending ? 'Saving…' : 'Record inspection'}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-muted text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.875rem]">{value ?? '—'}</dd>
    </div>
  );
}
