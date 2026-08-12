'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { InventoryLocationSummary, StockTransferDetail } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { readable, TransferProgress } from '@/components/tenant/stock-status';
import { formatClinicDateTime } from '@/lib/format';
import {
  cancelTransferAction,
  dispatchTransferAction,
  IDLE_FORM,
  receiveTransferAction,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * One transfer, and whatever it is this person's turn to do with it.
 *
 * ⚠️ THE SCREEN SHOWS EXACTLY ONE ACTION AT A TIME, AND WHICH ONE DEPENDS ON THE
 *   BRANCH THE READER WORKS AT. The sender sends and can cancel; the receiver
 *   signs for what arrived. Showing both to both would offer a receiving
 *   storekeeper a "Send" button that 404s, because the movements it writes carry
 *   the SENDING branch and RLS will not let them write one. Better to not offer
 *   it than to explain the refusal afterwards.
 *
 * ⚠️ WHERE THE STOCK IS BETWEEN THE TWO IS THIS DOCUMENT, NOT A SHELF. Once it
 *   is sent, the sending branch's shelves are already lighter and nothing has
 *   arrived anywhere — the outstanding quantity below is the only record that it
 *   exists. That is why this screen names the sender, the date and the amount:
 *   "it vanished between branches" is answered here or nowhere.
 *
 * NO PHI.
 */
const STATUS_LABEL: Record<StockTransferDetail['status'], string> = {
  DRAFT: 'Draft',
  DISPATCHED: 'Sent',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

interface Props {
  slug: string;
  transfer: StockTransferDetail;
  locations: InventoryLocationSummary[];
  timezone: string;
  timeFormat: '12H' | '24H';
  /** Branch ids this user works at. Decides which action is theirs. */
  branchIds: string[];
  canTransfer: boolean;
}

export function TransferDetail({
  slug,
  transfer,
  locations,
  timezone,
  timeFormat,
  branchIds,
  canTransfer,
}: Props) {
  const isSender = branchIds.includes(transfer.fromBranchId);
  const isReceiver = branchIds.includes(transfer.toBranchId);

  const canSend = canTransfer && isSender && transfer.status === 'DRAFT';
  const canReceive =
    canTransfer &&
    isReceiver &&
    (transfer.status === 'DISPATCHED' || transfer.status === 'PARTIALLY_RECEIVED');
  const canCancel =
    canTransfer && isSender && transfer.status !== 'RECEIVED' && transfer.status !== 'CANCELLED';

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <Link href="/stock/transfers" className="text-muted text-[0.8125rem]">
          ← Transfers
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {transfer.fromLocationName} → {transfer.toLocationName ?? 'not yet decided'}
          </h1>
          <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
            {STATUS_LABEL[transfer.status]}
          </span>
        </div>
        <p className="text-muted text-[0.875rem]">
          {transfer.isIntraBranch
            ? `Within ${transfer.fromBranchName}`
            : `${transfer.fromBranchName} → ${transfer.toBranchName}`}
          {transfer.transferNumber ? ` · ${transfer.transferNumber}` : ''}
        </p>
      </header>

      {/* ---- the trail ---------------------------------------------------- */}
      <section aria-labelledby="trail-heading" className="space-y-2">
        <h2 id="trail-heading" className="sr-only">
          What has happened to this transfer
        </h2>
        <dl className="border-rule bg-card divide-rule divide-y rounded-md border text-[0.875rem]">
          <Row label="Drafted">
            {transfer.createdByName ?? 'Someone'} ·{' '}
            {formatClinicDateTime(transfer.createdAt, timezone, timeFormat)}
          </Row>
          {transfer.dispatchedAt ? (
            <Row label="Sent">
              {transfer.dispatchedByName ?? 'Someone'} ·{' '}
              {formatClinicDateTime(transfer.dispatchedAt, timezone, timeFormat)}
            </Row>
          ) : null}
          {transfer.receivedAt ? (
            <Row label="Signed for">
              {transfer.receivedByName ?? 'Someone'} ·{' '}
              {formatClinicDateTime(transfer.receivedAt, timezone, timeFormat)}
            </Row>
          ) : null}
          {transfer.cancelledAt ? (
            <Row label="Cancelled">
              {transfer.cancelledByName ?? 'Someone'} ·{' '}
              {formatClinicDateTime(transfer.cancelledAt, timezone, timeFormat)} ·{' '}
              {transfer.cancellationReason}
            </Row>
          ) : null}
          {transfer.notes ? <Row label="Notes">{transfer.notes}</Row> : null}
        </dl>
      </section>

      {/* ---- the lines ---------------------------------------------------- */}
      <section aria-labelledby="lines-heading" className="space-y-3">
        <h2 id="lines-heading" className="text-ink text-[1.0625rem] font-medium">
          What is on it
        </h2>

        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {transfer.lines.map((line) => (
            <li key={line.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-ink text-[0.9375rem] font-medium">{line.productName}</span>
                {line.lotNumber ? (
                  <span className="font-mono text-muted text-[0.75rem]">{line.lotNumber}</span>
                ) : null}
                {line.serialNumber ? (
                  <span className="font-mono text-muted text-[0.75rem]">{line.serialNumber}</span>
                ) : null}
                <span className="text-muted ml-auto font-mono text-[0.75rem]">
                  {line.expiresOn ?? 'no expiry'}
                </span>
              </div>

              <div className="mt-2 max-w-md">
                {transfer.status === 'DRAFT' || transfer.status === 'CANCELLED' ? (
                  <p className="text-muted text-[0.75rem]">
                    <span className="text-ink font-mono">{readable(line.sentQuantityBase)}</span>{' '}
                    {line.baseUnitSymbol} to send
                  </p>
                ) : (
                  <TransferProgress
                    sent={line.sentQuantityBase}
                    received={line.receivedQuantityBase}
                    unit={line.baseUnitSymbol}
                    label={`${line.productName}${line.lotNumber ? ` lot ${line.lotNumber}` : ''}`}
                  />
                )}
              </div>

              {line.notes ? (
                <p className="text-muted mt-1.5 text-[0.8125rem]">{line.notes}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* ---- whatever is this person's turn -------------------------------- */}
      {canSend ? <SendPanel slug={slug} transferId={transfer.id} transfer={transfer} /> : null}

      {canReceive ? (
        <ReceivePanel
          slug={slug}
          transfer={transfer}
          locations={locations.filter((l) => l.branchId === transfer.toBranchId && l.isActive)}
        />
      ) : null}

      {canCancel ? <CancelPanel slug={slug} transfer={transfer} /> : null}

      {/*
        ⚠️ SAID PLAINLY RATHER THAN LEAVING THE SCREEN BLANK. A storekeeper at the
           receiving branch looking at a transfer that has not been sent yet
           should be told that, not left wondering which button they are missing.
      */}
      {!canSend && !canReceive && !canCancel ? (
        <p className="text-muted text-[0.875rem]">
          {transfer.status === 'RECEIVED'
            ? 'This transfer is complete. Send stock back as a new transfer if it needs to go the other way.'
            : transfer.status === 'CANCELLED'
              ? 'This transfer was cancelled. Anything already sent went back to the sending branch.'
              : transfer.status === 'DRAFT'
                ? 'This is still a draft at the sending branch. It will appear here to sign for once they send it.'
                : 'There is nothing for you to do on this transfer.'}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5">
      <dt className="text-muted w-24 shrink-0 text-[0.8125rem]">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/**
 * ⚠️ THE COPY SAYS WHAT SENDING DOES BEFORE THE BUTTON DOES IT. Sending writes a
 *   movement for every line and the shelves are lighter the moment it returns —
 *   there is no undo, only a cancellation that writes compensating movements
 *   into a permanent ledger. A dialog asking "are you sure?" is a question
 *   nobody reads; a sentence saying what happens is one they might.
 */
function SendPanel({
  slug,
  transferId,
  transfer,
}: {
  slug: string;
  transferId: string;
  transfer: StockTransferDetail;
}) {
  const [state, action, pending] = useActionState<StockFormState>(
    dispatchTransferAction.bind(null, slug, transferId),
    IDLE_FORM
  );

  return (
    <form action={action} className="border-rule bg-card space-y-4 rounded-md border p-5">
      <h2 className="text-ink text-[1.0625rem] font-medium">Send it</h2>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <p className="text-muted text-[0.875rem]">
        {transfer.isIntraBranch
          ? 'This moves the stock between the two shelves straight away and records it as arrived. It cannot be undone — a mistake is corrected by moving it back.'
          : `This takes the stock off ${transfer.fromLocationName} now. It stays on this transfer until ${transfer.toBranchName} signs for it, and it will not show on either branch's shelves in the meantime.`}
      </p>

      <Button type="submit" disabled={pending}>
        {pending ? 'Sending…' : transfer.isIntraBranch ? 'Move the stock' : 'Send it'}
      </Button>
    </form>
  );
}

/**
 * ⚠️ ONE BOX PER LINE, PREFILLED WITH WHAT IS OUTSTANDING, AND NO "RECEIVE ALL"
 *   BUTTON. Receiving is the moment somebody counts. Prefilling the expected
 *   amount is a convenience for the common case where everything arrived;
 *   a single button that skips the boxes entirely is a screen where nobody ever
 *   counts, and the whole value of this document is that somebody did.
 *
 *   A box cleared to blank receives none of that line, which leaves the transfer
 *   outstanding and in this inbox — exactly what should happen when a box is
 *   missing.
 */
function ReceivePanel({
  slug,
  transfer,
  locations,
}: {
  slug: string;
  transfer: StockTransferDetail;
  locations: InventoryLocationSummary[];
}) {
  const [state, action, pending] = useActionState<StockFormState, FormData>(
    receiveTransferAction.bind(null, slug, transfer.id),
    IDLE_FORM
  );

  const outstanding = transfer.lines.filter((l) => Number(l.outstandingQuantityBase) > 0);

  return (
    <form action={action} className="border-rule bg-card space-y-4 rounded-md border p-5">
      <h2 className="text-ink text-[1.0625rem] font-medium">Sign for what arrived</h2>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <p className="text-muted text-[0.875rem]">
        Count what is in front of you and enter it. Anything you leave blank stays outstanding on
        this transfer. If more arrived than was sent, receive what was sent and record the
        difference as an adjustment.
      </p>

      {locations.length === 0 ? (
        <Alert tone="warning">
          This branch has no active shelf to receive into. Add one under Locations first.
        </Alert>
      ) : (
        <>
          <Select
            name="toLocationId"
            label="Onto which shelf"
            required
            defaultValue={transfer.toLocationId ?? ''}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
          />

          <ul className="space-y-3">
            {outstanding.map((line) => (
              <li key={line.id}>
                <Input
                  name={`receive.${line.id}`}
                  label={`${line.productName}${line.lotNumber ? ` · ${line.lotNumber}` : ''}`}
                  inputMode="decimal"
                  defaultValue={line.outstandingQuantityBase}
                  hint={`${readable(line.outstandingQuantityBase)} ${line.baseUnitSymbol} outstanding`}
                />
              </li>
            ))}
          </ul>

          <Textarea name="notes" label="Notes" rows={2} />

          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Sign for it'}
          </Button>
        </>
      )}
    </form>
  );
}

/**
 * ⚠️ THE REASON IS REQUIRED, AND FOR THE SAME REASON AN ADJUSTMENT'S IS.
 *   Cancelling a sent transfer writes a compensating movement back to the sender
 *   for everything still outstanding, and two ledger rows with nothing between
 *   them explaining why is two rows nobody can audit a year later.
 */
function CancelPanel({ slug, transfer }: { slug: string; transfer: StockTransferDetail }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<StockFormState, FormData>(
    cancelTransferAction.bind(null, slug, transfer.id),
    IDLE_FORM
  );

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Cancel this transfer
      </Button>
    );
  }

  return (
    <form action={action} className="border-rule bg-card space-y-4 rounded-md border p-5">
      <h2 className="text-ink text-[1.0625rem] font-medium">Cancel this transfer</h2>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <p className="text-muted text-[0.875rem]">
        {transfer.status === 'DRAFT'
          ? 'Nothing has moved, so this only closes the draft.'
          : `Anything still outstanding goes back onto ${transfer.fromLocationName} as a new movement. Nothing is deleted — the original send stays in the ledger with this cancellation beside it.`}
      </p>

      <Textarea
        name="reason"
        label="Why"
        required
        rows={2}
        errors={state.fieldErrors?.['reason']}
        hint="This is what somebody reading the ledger next year will see."
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Cancelling…' : 'Cancel the transfer'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
