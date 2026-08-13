'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { PurchaseRequisitionDetail } from '@rcln/contracts';
import { Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';
import {
  requisitionTransitionAction,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * One requisition, and whichever of the four transitions this caller may make.
 *
 * ⚠️ `canApprove` COMES FROM THE SERVER AND IS PRESENTATION ONLY. It is false for
 *   the requisition's own creator however many permissions they hold, because the
 *   `purchase_requisitions_approver_is_not_creator` CHECK would refuse the write —
 *   and a button that produces a 400 is worse than no button. The decision is made
 *   three times server-side; hiding the control is the fourth place and the only
 *   one that is allowed to be wrong.
 *
 * ⚠️ REJECTING NEEDS A REASON AND APPROVING DOES NOT. A refusal the requester cannot
 *   act on gets raised again unchanged.
 */
interface Props {
  slug: string;
  requisition: PurchaseRequisitionDetail;
  canCreate: boolean;
  canApprove: boolean;
  /** Whether this caller may raise an order from an approved requisition. */
  canOrder: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  ORDERED: 'Ordered',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
};

export function RequisitionPanel({ slug, requisition, canCreate, canApprove, canOrder }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProcurementFormState | null>(null);
  const [showReject, setShowReject] = useState(false);

  const run = (verb: 'submit' | 'approve' | 'cancel') => {
    startTransition(async () => {
      setResult(await requisitionTransitionAction(slug, requisition.id, verb));
    });
  };

  const reject = (form: FormData) => {
    startTransition(async () => {
      const outcome = await requisitionTransitionAction(slug, requisition.id, 'reject', form);
      setResult(outcome);
      if (outcome.status === 'saved') setShowReject(false);
    });
  };

  const isDraft = requisition.status === 'DRAFT';
  const isSubmitted = requisition.status === 'SUBMITTED';

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {requisition.requisitionNumber ?? 'Draft requisition'}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {requisition.branchName} · {STATUS_LABEL[requisition.status] ?? requisition.status}
          </p>
        </div>
        {requisition.status === 'APPROVED' && canOrder ? (
          <Link
            href={`/procurement/purchase-orders/new?requisitionId=${requisition.id}`}
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Raise an order
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      {result?.status === 'error' && result.message ? (
        <Alert tone="error">{result.message}</Alert>
      ) : null}
      {result?.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

      {isSubmitted && !requisition.canApprove && canApprove ? (
        <Alert tone="info">
          You raised this requisition, so somebody else has to approve it. That is the point of the
          two steps and no permission changes it.
        </Alert>
      ) : null}

      {requisition.status === 'REJECTED' && requisition.rejectionReason ? (
        <Alert tone="warning">
          Rejected by {requisition.rejectedByName ?? 'an approver'}: {requisition.rejectionReason}
        </Alert>
      ) : null}

      <section className="border-rule bg-card grid gap-x-8 gap-y-3 rounded-md border p-4 sm:grid-cols-2">
        <Detail label="Raised by" value={requisition.createdByName} />
        <Detail label="Needed by" value={requisition.requiredBy} />
        <Detail label="Approved by" value={requisition.approvedByName} />
        <Detail label="Notes" value={requisition.notes} />
      </section>

      <section className="space-y-3">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What was asked for
        </h2>
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {requisition.lines.map((line) => (
            <li key={line.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-ink text-[0.9375rem]">{line.productName}</span>
                <span className="text-muted font-mono text-[0.75rem]">{line.productCode}</span>
                <span className="text-ink ml-auto font-mono text-[0.875rem]">
                  {line.quantityBase} {line.baseUnitSymbol}
                </span>
              </div>
              {line.suggestedSupplierName ? (
                <p className="text-muted mt-1 text-[0.8125rem]">
                  Usually from {line.suggestedSupplierName}
                </p>
              ) : null}
              {line.notes ? <p className="text-muted mt-1 text-[0.8125rem]">{line.notes}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap gap-3">
        {isDraft && canCreate ? (
          <Button type="button" disabled={pending} onClick={() => run('submit')}>
            {pending ? 'Sending…' : 'Send for approval'}
          </Button>
        ) : null}

        {isSubmitted && requisition.canApprove ? (
          <>
            <Button type="button" disabled={pending} onClick={() => run('approve')}>
              {pending ? 'Saving…' : 'Approve'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowReject((v) => !v)}>
              Reject
            </Button>
          </>
        ) : null}

        {(isDraft || isSubmitted || requisition.status === 'APPROVED') && canCreate ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run('cancel')}
          >
            Withdraw
          </Button>
        ) : null}
      </section>

      {showReject ? (
        <form
          action={reject}
          className="border-rule bg-card max-w-xl space-y-3 rounded-md border p-4"
        >
          <Textarea
            label="Why is it being rejected?"
            name="reason"
            required
            rows={3}
            errors={result?.fieldErrors?.['reason']}
            hint="The person who raised it sees this. Without it they will simply ask again."
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Reject requisition'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowReject(false)}>
              Cancel
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
