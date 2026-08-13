'use client';

import { useState, useTransition } from 'react';
import type { PurchaseReturnDetail } from '@rcln/contracts';
import { Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';
import {
  purchaseReturnTransitionAction,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * One return.
 *
 * ⚠️ SENDING IS IRREVERSIBLE AND THE COPY SAYS WHY. It writes the movements and the
 *   stock leaves; a supplier who posts it back is recorded as a new delivery, because
 *   that is what it physically is. So there is no "un-send" — only cancel, and only
 *   while it is still a draft.
 */
interface Props {
  slug: string;
  purchaseReturn: PurchaseReturnDetail;
  canManage: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Gone back',
  CANCELLED: 'Cancelled',
};

const BUCKET_LABEL: Record<string, string> = {
  AVAILABLE: 'sound stock',
  QUARANTINED: 'on hold',
  DAMAGED: 'damaged',
  EXPIRED: 'expired',
  RECALLED: 'recalled',
  BLOCKED: 'blocked',
};

export function PurchaseReturnPanel({ slug, purchaseReturn, canManage }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProcurementFormState | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  const send = () => {
    startTransition(async () => {
      setResult(await purchaseReturnTransitionAction(slug, purchaseReturn.id, 'send'));
    });
  };

  const cancel = (form: FormData) => {
    startTransition(async () => {
      const outcome = await purchaseReturnTransitionAction(slug, purchaseReturn.id, 'cancel', form);
      setResult(outcome);
      if (outcome.status === 'saved') setShowCancel(false);
    });
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {purchaseReturn.returnNumber ?? 'Draft return'}
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          {purchaseReturn.supplierName} · {purchaseReturn.branchName} ·{' '}
          {STATUS_LABEL[purchaseReturn.status] ?? purchaseReturn.status}
        </p>
      </header>

      <ProcurementNav />

      {result?.status === 'error' && result.message ? (
        <Alert tone="error">{result.message}</Alert>
      ) : null}
      {result?.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

      {purchaseReturn.status === 'DRAFT' ? (
        <Alert tone="info">
          Nothing has left a shelf yet. Sending it writes the movements — after that, stock the
          supplier posts back is recorded as a new delivery.
        </Alert>
      ) : null}
      {purchaseReturn.status === 'CANCELLED' && purchaseReturn.cancellationReason ? (
        <Alert tone="warning">Cancelled: {purchaseReturn.cancellationReason}</Alert>
      ) : null}

      <section className="border-rule bg-card grid gap-x-8 gap-y-3 rounded-md border p-4 sm:grid-cols-2">
        <Detail label="Leaving from" value={purchaseReturn.locationName} />
        <Detail label="From delivery" value={purchaseReturn.goodsReceiptNumber} />
        <Detail label="Raised by" value={purchaseReturn.createdByName} />
        <Detail label="Sent by" value={purchaseReturn.sentByName} />
        <Detail label="Their credit note" value={purchaseReturn.supplierCreditNoteNumber} />
        <Detail
          label="Value"
          value={`${purchaseReturn.currency} ${(purchaseReturn.totalMinor / 100).toFixed(2)}`}
        />
        <div className="sm:col-span-2">
          <Detail label="Why" value={purchaseReturn.reason} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What is going back
        </h2>
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {purchaseReturn.lines.map((line) => (
            <li key={line.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-ink text-[0.9375rem]">{line.productName}</span>
                {line.lotNumber ? (
                  <span className="text-muted font-mono text-[0.75rem]">{line.lotNumber}</span>
                ) : null}
                {line.serialNumber ? (
                  <span className="text-muted font-mono text-[0.75rem]">{line.serialNumber}</span>
                ) : null}
                <span className="text-ink ml-auto font-mono text-[0.875rem]">
                  {line.quantityBase} {line.baseUnitSymbol}
                </span>
              </div>
              <p className="text-muted mt-1 text-[0.8125rem]">
                Taken from {BUCKET_LABEL[line.statusFrom] ?? line.statusFrom.toLowerCase()}
                {line.expiresOn ? ` · expires ${line.expiresOn}` : ''}
                {line.unitCostBase !== null && line.currency
                  ? ` · ${line.currency} ${(line.unitCostBase / 100).toFixed(2)} per ${line.baseUnitSymbol}`
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {canManage && purchaseReturn.status === 'DRAFT' ? (
        <section className="flex flex-wrap gap-3">
          <Button type="button" disabled={pending} onClick={send}>
            {pending ? 'Sending…' : 'Send it back'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setShowCancel(true)}>
            Cancel return
          </Button>
        </section>
      ) : null}

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
            hint="Nothing has left a shelf, so this moves no stock."
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Cancel return'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowCancel(false)}>
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
