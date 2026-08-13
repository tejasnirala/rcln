'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { PurchaseOrderDetail } from '@rcln/contracts';
import { Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';
import {
  purchaseOrderTransitionAction,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * One order, and what is still outstanding on it.
 *
 * ⚠️ CLOSE AND CANCEL ARE DIFFERENT ACTS AND THE SCREEN OFFERS WHICHEVER APPLIES.
 *   Cancel is only available before anything has arrived — an order with deliveries
 *   against it has stock on a shelf, and marking it cancelled would say the clinic
 *   never ordered what it is holding. Close is the one for a short shipment: it
 *   records that nothing more is coming, which is a judgement, so it needs a reason.
 */
interface Props {
  slug: string;
  order: PurchaseOrderDetail;
  canManage: boolean;
  /** Whether this caller may record the delivery against it. */
  canReceive: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  PARTIALLY_RECEIVED: 'Part delivered',
  RECEIVED: 'Delivered in full',
  CLOSED: 'Closed short',
  CANCELLED: 'Cancelled',
};

export function PurchaseOrderPanel({ slug, order, canManage, canReceive }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProcurementFormState | null>(null);
  const [reasonFor, setReasonFor] = useState<'close' | 'cancel' | null>(null);

  const issue = () => {
    startTransition(async () => {
      setResult(await purchaseOrderTransitionAction(slug, order.id, 'issue'));
    });
  };

  const withReason = (verb: 'close' | 'cancel') => (form: FormData) => {
    startTransition(async () => {
      const outcome = await purchaseOrderTransitionAction(slug, order.id, verb, form);
      setResult(outcome);
      if (outcome.status === 'saved') setReasonFor(null);
    });
  };

  const anyReceived = order.lines.some((l) => Number(l.receivedQuantityBase) > 0);
  const canCancel =
    canManage && !anyReceived && order.status !== 'CANCELLED' && order.status !== 'CLOSED';
  const canClose =
    canManage && (order.status === 'ISSUED' || order.status === 'PARTIALLY_RECEIVED');

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {order.orderNumber ?? 'Draft order'}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {order.supplierName} · {order.branchName} · {STATUS_LABEL[order.status] ?? order.status}
          </p>
        </div>
        {canReceive && (order.status === 'ISSUED' || order.status === 'PARTIALLY_RECEIVED') ? (
          <Link
            href={`/procurement/goods-receipts/new?purchaseOrderId=${order.id}`}
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Record the delivery
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      {result?.status === 'error' && result.message ? (
        <Alert tone="error">{result.message}</Alert>
      ) : null}
      {result?.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

      {order.status === 'CLOSED' && order.closureReason ? (
        <Alert tone="warning">Closed short: {order.closureReason}</Alert>
      ) : null}
      {order.status === 'CANCELLED' && order.cancellationReason ? (
        <Alert tone="warning">Cancelled: {order.cancellationReason}</Alert>
      ) : null}

      <section className="border-rule bg-card grid gap-x-8 gap-y-3 rounded-md border p-4 sm:grid-cols-2">
        <Detail label="Their tax number" value={order.supplierTaxNumber} />
        <Detail label="Expected" value={order.expectedDate} />
        <Detail label="Deliver to" value={order.deliverToLocationName} />
        <Detail label="From requisition" value={order.requisitionNumber} />
        <Detail label="Raised by" value={order.createdByName} />
        <Detail label="Issued by" value={order.issuedByName} />
        <Detail
          label="Total"
          value={`${order.currency} ${(order.totalMinor / 100).toFixed(2)} (${order.currency} ${(order.subtotalMinor / 100).toFixed(2)} goods, ${order.currency} ${(order.taxAmountMinor / 100).toFixed(2)} tax)`}
        />
        <Detail label="Terms" value={order.terms} />
        {order.notes ? (
          <div className="sm:col-span-2">
            <Detail label="Notes" value={order.notes} />
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Lines</h2>
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {order.lines.map((line) => (
            <li key={line.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-ink text-[0.9375rem]">{line.productName}</span>
                <span className="text-muted font-mono text-[0.75rem]">
                  {line.supplierSku ?? line.productCode}
                </span>
                <span className="text-ink ml-auto font-mono text-[0.875rem]">
                  {order.currency} {(line.lineTotalMinor / 100).toFixed(2)}
                </span>
              </div>
              <p className="text-muted mt-1 text-[0.8125rem]">
                {line.orderedQuantityBase} {line.baseUnitSymbol} ordered ·{' '}
                {line.receivedQuantityBase} delivered
                {Number(line.outstandingQuantityBase) > 0 ? (
                  <span className="text-signal">
                    {' '}
                    · {line.outstandingQuantityBase} {line.baseUnitSymbol} still due
                  </span>
                ) : null}
                {' · '}
                {order.currency} {(line.unitCostBase / 100).toFixed(2)} per {line.baseUnitSymbol}
              </p>
              {line.notes ? <p className="text-muted mt-1 text-[0.8125rem]">{line.notes}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap gap-3">
        {canManage && order.status === 'DRAFT' ? (
          <Button type="button" disabled={pending} onClick={issue}>
            {pending ? 'Issuing…' : 'Issue to supplier'}
          </Button>
        ) : null}
        {canClose ? (
          <Button type="button" variant="secondary" onClick={() => setReasonFor('close')}>
            Nothing more coming
          </Button>
        ) : null}
        {canCancel ? (
          <Button type="button" variant="secondary" onClick={() => setReasonFor('cancel')}>
            Cancel order
          </Button>
        ) : null}
      </section>

      {reasonFor !== null ? (
        <form
          action={withReason(reasonFor)}
          className="border-rule bg-card max-w-xl space-y-3 rounded-md border p-4"
        >
          <Textarea
            label={
              reasonFor === 'close'
                ? 'Why is nothing more expected?'
                : 'Why is the order being cancelled?'
            }
            name="reason"
            required
            rows={3}
            errors={result?.fieldErrors?.['reason']}
            hint={
              reasonFor === 'close'
                ? 'The outstanding quantity stops appearing as due. What has arrived stays on the shelf.'
                : 'Nothing has been delivered against this order, so cancelling moves no stock.'
            }
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : reasonFor === 'close' ? 'Close order' : 'Cancel order'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setReasonFor(null)}>
              Back
            </Button>
          </div>
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
