'use client';

import { useActionState, useState } from 'react';
import type {
  AffectedPartyResponse,
  RecallCandidatesResponse,
  RecallDetail as RecallDetailShape,
} from '@rcln/contracts';
import { Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ProductRecallNav } from '@/components/tenant/product-recall-nav';
import { formatClinicDate, formatClinicDateTime } from '@/lib/format';
import {
  addRecallBatchesAction,
  cancelRecallAction,
  closeRecallAction,
  executeRecallAction,
  IDLE_RECALL_FORM,
  resolveRecallBatchAction,
  type RecallFormState,
} from '@/app/(tenant)/t/[slug]/(app)/product-recalls/actions';

/**
 * One notice: what it covers, what has been pulled, and who already has it.
 *
 * ⚠️ THE AFFECTED-PARTY TABLE IS RENDERED ONLY WHEN THE CALLER HOLDS
 *   `recall.trace.patients`, and this is the one screen in the workspace where
 *   hiding CONTENT rather than a control is right. Everywhere else the rule is
 *   "render it and let the API refuse" — but this table is a page of named
 *   people with phone numbers, and a screen that laid it out and let the 403
 *   arrive would already have told the reader how many patients are affected.
 *   Somebody without the code sees the COUNT, which is what tells them to ask.
 *
 * ⚠️ AND THE COUNT IS SHOWN TO EVERYBODY. A recall where nobody knows how many
 *   people are involved is a recall nobody escalates.
 */
const STATUS_LABEL: Record<RecallDetailShape['status'], string> = {
  DRAFT: 'Being assembled',
  EXECUTED: 'Stock pulled',
  CLOSED: 'Finished',
  CANCELLED: 'Withdrawn',
};

const LOT_LABEL: Record<RecallDetailShape['batches'][number]['status'], string> = {
  PENDING: 'Not yet pulled',
  HELD: 'Held',
  RELEASED: 'Released back',
  DISPOSED: 'Destroyed or returned',
  NO_STOCK: 'None left to pull',
};

interface Props {
  slug: string;
  recall: RecallDetailShape;
  candidates: RecallCandidatesResponse | null;
  affected: AffectedPartyResponse | null;
  /** How many people received it, whether or not their names may be shown. */
  patientCount: number;
  timeZone: string;
  timeFormat: '12H' | '24H';
  canCreate: boolean;
  canExecute: boolean;
  canSeePatients: boolean;
}

export function ProductRecallDetail({
  slug,
  recall,
  candidates,
  affected,
  patientCount,
  timeZone,
  timeFormat,
  canCreate,
  canExecute,
  canSeePatients,
}: Props) {
  const [addState, addBatches, adding] = useActionState<RecallFormState, FormData>(
    addRecallBatchesAction.bind(null, slug, recall.id),
    IDLE_RECALL_FORM
  );
  const [executeState, execute, executing] = useActionState<RecallFormState, FormData>(
    executeRecallAction.bind(null, slug, recall.id),
    IDLE_RECALL_FORM
  );
  const [endState, close, closing] = useActionState<RecallFormState, FormData>(
    closeRecallAction.bind(null, slug, recall.id),
    IDLE_RECALL_FORM
  );
  const [cancelState, cancel, cancelling] = useActionState<RecallFormState, FormData>(
    cancelRecallAction.bind(null, slug, recall.id),
    IDLE_RECALL_FORM
  );

  const [resolving, setResolving] = useState<string | null>(null);

  const pending = recall.batches.filter((lot) => lot.status === 'PENDING');
  const live = recall.status === 'DRAFT' || recall.status === 'EXECUTED';
  const error =
    addState.message ?? executeState.message ?? endState.message ?? cancelState.message ?? null;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-muted text-[0.75rem] tracking-wide uppercase">{recall.reference}</p>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {recall.title}
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          {recall.productName} · {STATUS_LABEL[recall.status]} · {recall.heldCount} of{' '}
          {recall.batchCount} lot{recall.batchCount === 1 ? '' : 's'} pulled
        </p>
      </header>

      <ProductRecallNav />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="border-rule bg-card space-y-2 rounded-md border p-4 text-[0.875rem]">
        <p>
          <span className="text-muted">Why: </span>
          {recall.reason}
        </p>
        {recall.noticeReference ? (
          <p>
            <span className="text-muted">Their reference: </span>
            {recall.noticeReference}
            {recall.noticeOn ? ` · dated ${formatClinicDate(recall.noticeOn, timeZone)}` : ''}
          </p>
        ) : null}
        <p className="text-muted">
          Raised by {recall.raisedByName}
          {recall.executedByName ? ` · pulled by ${recall.executedByName}` : ''}
          {recall.closedByName ? ` · ended by ${recall.closedByName}` : ''}
        </p>
        {recall.outcomeNote ? (
          <p>
            <span className="text-muted">How it ended: </span>
            {recall.outcomeNote}
          </p>
        ) : null}
      </section>

      {/* ---- the lots ---------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="font-display text-ink text-[1.125rem]">Lots this notice covers</h2>

        {recall.batches.length === 0 ? (
          <p className="text-muted text-[0.875rem]">
            No lots yet. A notice with an empty scope holds nothing — add the lots it names below.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[0.875rem]">
              <thead className="text-muted border-rule border-b">
                <tr>
                  <th className="py-2 pr-4 font-medium">Lot</th>
                  <th className="py-2 pr-4 font-medium">Branch</th>
                  <th className="py-2 pr-4 font-medium">Expires</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 pr-4 font-medium">Pulled</th>
                  <th className="py-2 pr-4 font-medium">Still available</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {recall.batches.map((lot) => (
                  <tr key={lot.id} className="border-rule border-b align-top last:border-0">
                    <td className="py-2 pr-4 font-medium">{lot.lotNumber}</td>
                    <td className="py-2 pr-4">{lot.branchName}</td>
                    <td className="py-2 pr-4">
                      {lot.expiresOn ? formatClinicDate(lot.expiresOn, timeZone) : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {LOT_LABEL[lot.status]}
                      {lot.outcomeNote ? (
                        <span className="text-muted block text-[0.75rem]">{lot.outcomeNote}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {lot.quantityHeldBase === null
                        ? '—'
                        : `${lot.quantityHeldBase} ${recall.baseUnitSymbol}`}
                    </td>
                    <td className="py-2 pr-4">
                      {lot.quantityAvailableBase} {recall.baseUnitSymbol}
                    </td>
                    <td className="py-2">
                      {canExecute && (lot.status === 'HELD' || lot.status === 'NO_STOCK') ? (
                        resolving === lot.id ? (
                          <LotResolution
                            slug={slug}
                            recallId={recall.id}
                            recallBatchId={lot.id}
                            onDone={() => setResolving(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setResolving(lot.id)}
                            className="text-drape text-[0.8125rem] hover:underline"
                          >
                            Resolve
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- adding lots -------------------------------------------------- */}
      {canCreate && live && candidates && candidates.items.length > 0 ? (
        <section className="border-rule bg-card space-y-3 rounded-md border p-4">
          <h2 className="font-display text-ink text-[1.125rem]">Add lots</h2>
          <p className="text-muted text-[0.8125rem]">
            Every lot of {candidates.productName} that this notice does not already name — including
            lots with nothing left on the shelf, which are the ones where contacting people is all
            of the work.
          </p>
          <form action={addBatches} className="space-y-3">
            <ul className="space-y-2">
              {candidates.items.map((candidate) => (
                <li key={candidate.batchId} className="flex items-start gap-2 text-[0.875rem]">
                  <input
                    type="checkbox"
                    name="batchIds"
                    value={candidate.batchId}
                    id={`lot-${candidate.batchId}`}
                    className="mt-1"
                  />
                  <label htmlFor={`lot-${candidate.batchId}`}>
                    <span className="font-medium">{candidate.lotNumber}</span> ·{' '}
                    {candidate.branchName} · {candidate.quantityAvailableBase}{' '}
                    {candidates.baseUnitSymbol} available
                    {candidate.expiresOn
                      ? ` · expires ${formatClinicDate(candidate.expiresOn, timeZone)}`
                      : ''}
                    {candidate.inOtherRecall ? (
                      <span className="text-muted block text-[0.75rem]">
                        Already named by another live notice.
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="submit"
              disabled={adding}
              className="border-rule text-ink hover:bg-paper rounded-md border px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
            >
              {adding ? 'Adding…' : 'Add the ticked lots'}
            </button>
          </form>
        </section>
      ) : null}

      {/* ---- executing ---------------------------------------------------- */}
      {canExecute && live && pending.length > 0 ? (
        <section className="border-rule bg-card space-y-3 rounded-md border p-4">
          <h2 className="font-display text-ink text-[1.125rem]">Pull the stock</h2>
          <p className="text-muted text-[0.8125rem]">
            This moves every one of the {pending.length} outstanding lot
            {pending.length === 1 ? '' : 's'} into the recalled bucket at the branches you work at.
            The product stops being dispensable and consumable immediately, and the movements cannot
            be edited afterwards — releasing a lot later is a separate, recorded act.
          </p>
          <form action={execute} className="space-y-3">
            <Textarea
              label="Note for the movements"
              name="note"
              hint="Leave blank to use the reason on the notice."
            />
            <button
              type="submit"
              disabled={executing}
              className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
            >
              {executing
                ? 'Pulling…'
                : `Pull ${pending.length} lot${pending.length === 1 ? '' : 's'}`}
            </button>
          </form>
        </section>
      ) : null}

      {/* ---- who has it --------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="font-display text-ink text-[1.125rem]">Who already has it</h2>
        <p className="text-muted text-[0.875rem]">
          {patientCount === 0
            ? 'Nobody received any of these lots.'
            : `${patientCount} ${patientCount === 1 ? 'person' : 'people'} received one of these lots.`}
        </p>

        {patientCount > 0 && !canSeePatients ? (
          <Alert tone="info">
            Seeing who they are needs the patient-trace permission. Ask somebody at this clinic who
            holds it — the count above is what this screen can tell you.
          </Alert>
        ) : null}

        {canSeePatients && affected && affected.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[0.875rem]">
              <thead className="text-muted border-rule border-b">
                <tr>
                  <th className="py-2 pr-4 font-medium">Person</th>
                  <th className="py-2 pr-4 font-medium">Phone</th>
                  <th className="py-2 pr-4 font-medium">How</th>
                  <th className="py-2 pr-4 font-medium">Lot</th>
                  <th className="py-2 pr-4 font-medium">Quantity</th>
                  <th className="py-2 pr-4 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {affected.items.map((party) => (
                  <tr
                    key={`${party.sourceId}-${party.patientId}`}
                    className="border-rule border-b last:border-0"
                  >
                    <td className="py-2 pr-4">
                      {party.patientName}
                      <span className="text-muted block text-[0.75rem]">{party.patientCode}</span>
                    </td>
                    <td className="py-2 pr-4">{party.patientPhone ?? '—'}</td>
                    <td className="py-2 pr-4">
                      {party.route === 'DISPENSE' ? 'Dispensed' : 'Used in a procedure'}
                    </td>
                    <td className="py-2 pr-4">{party.serialNumber ?? party.lotNumber ?? '—'}</td>
                    <td className="py-2 pr-4">
                      {party.quantityBase} {affected.baseUnitSymbol}
                    </td>
                    <td className="py-2 pr-4">
                      {formatClinicDateTime(party.occurredAt, timeZone, timeFormat)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* ---- ending it ---------------------------------------------------- */}
      {canExecute && live ? (
        <section className="border-rule space-y-4 rounded-md border p-4">
          <h2 className="font-display text-ink text-[1.125rem]">End this notice</h2>

          {recall.status === 'EXECUTED' ? (
            <form action={close} className="space-y-3">
              <Textarea
                label="How it ended"
                name="outcomeNote"
                hint='"Closed" is not an outcome. What was found, and who was contacted, is.'
                errors={endState.fieldErrors?.outcomeNote}
              />
              <button
                type="submit"
                disabled={closing || pending.length > 0}
                className="border-rule text-ink hover:bg-card rounded-md border px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
              >
                {closing ? 'Closing…' : 'Close it'}
              </button>
              {pending.length > 0 ? (
                <p className="text-muted text-[0.75rem]">
                  {pending.length} lot{pending.length === 1 ? '' : 's'} still to be pulled, at
                  branches you may not work at. Somebody there has to pull them first.
                </p>
              ) : null}
            </form>
          ) : null}

          <form action={cancel} className="space-y-3">
            <Textarea
              label="Or withdraw it"
              name="outcomeNote"
              hint="Cancelling puts no stock back. Release each held lot first."
              errors={cancelState.fieldErrors?.outcomeNote}
            />
            <button
              type="submit"
              disabled={cancelling}
              className="text-muted hover:text-ink text-[0.875rem] disabled:opacity-50"
            >
              {cancelling ? 'Withdrawing…' : 'Withdraw this notice'}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

/**
 * What happened to one lot.
 *
 * ⚠️ RELEASE AND DISPOSE ARE ONE FORM AND TWO VERY DIFFERENT ACTS, so the choice
 *   is an explicit control rather than two buttons that look alike. Releasing
 *   puts the quantity back on sale; disposing destroys it. Both demand a reason,
 *   and the database refuses a blank one.
 */
function LotResolution({
  slug,
  recallId,
  recallBatchId,
  onDone,
}: {
  slug: string;
  recallId: string;
  recallBatchId: string;
  onDone: () => void;
}) {
  const [state, resolve, saving] = useActionState<RecallFormState, FormData>(
    resolveRecallBatchAction.bind(null, slug, recallId, recallBatchId),
    IDLE_RECALL_FORM
  );

  const [lastStatus, setLastStatus] = useState(state.status);
  if (state.status !== lastStatus) {
    setLastStatus(state.status);
    if (state.status === 'saved') onDone();
  }

  return (
    <form action={resolve} className="space-y-2">
      <Select
        label="What happened"
        name="resolution"
        options={[
          { value: 'RELEASE', label: 'Put it back on sale' },
          { value: 'DISPOSE', label: 'Destroyed or sent back' },
        ]}
      />
      <Textarea label="Why" name="note" errors={state.fieldErrors?.note} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="border-rule text-ink hover:bg-card rounded-md border px-3 py-1 text-[0.8125rem] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-muted hover:text-ink px-2 text-[0.8125rem]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
