'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import type { DispenseDetail as DispenseDetailShape } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, inputClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import {
  IDLE_FORM,
  returnDispenseAction,
  type PharmacyFormState,
} from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';
import { formatClinicDateTime } from '@/lib/format';

/**
 * One supply, as it was made — and the form for taking some of it back.
 *
 * ⚠️ WHAT IS SHOWN IS THE SNAPSHOT, NOT A FRESH ANSWER. The lot, the expiry and
 *   what the rules said are read off the record as it stood on the day. Rules may
 *   have been superseded twice since; re-running the engine over a historical
 *   supply must never change what that supply says (PI-ADR-008).
 *
 * ⚠️ RULE SENTENCES, NEVER RULE IDS. An obligation reads "record this in the
 *   Schedule X register", not "REG-IN-0042 v3 returned a condition". The
 *   internals live on the Rules screens.
 *
 * ⚠️ A RETURN NEVER EDITS THIS RECORD. It is a separate document that cites it,
 *   the way a credit note cites an invoice, and where the stock goes is decided
 *   by the clinic asking and the rules agreeing.
 */
interface Props {
  slug: string;
  dispense: DispenseDetailShape;
  timezone: string;
  timeFormat: '12H' | '24H';
  canTakeReturns: boolean;
}

export function DispenseDetail({ slug, dispense, timezone, timeFormat, canTakeReturns }: Props) {
  const [returning, setReturning] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const [state, submit, pending] = useActionState<PharmacyFormState, FormData>(
    (previous, form) => returnDispenseAction(slug, dispense.id, previous, form),
    IDLE_FORM
  );

  const returnLines = useMemo(
    () =>
      Object.entries(quantities)
        .filter(([, value]) => Number(value) > 0)
        .map(([key, value]) => {
          const [dispenseLineId, dispenseAllocationId] = key.split('|');
          return { dispenseLineId, dispenseAllocationId, quantityBase: value };
        }),
    [quantities]
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {dispense.dispenseNumber}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {dispense.patientName ?? 'Counter sale'}
            {dispense.patientUhid ? ` · ${dispense.patientUhid}` : ''} · handed over by{' '}
            {dispense.dispensedByName} at {dispense.locationName}
          </p>
          <p className="text-muted mt-1 text-[0.875rem]">
            {formatClinicDateTime(dispense.dispensedAt, timezone, timeFormat)}
          </p>
        </div>
        {dispense.encounterId ? (
          <Link
            href={`/pharmacy/prescriptions/${dispense.encounterId}`}
            className="text-muted hover:text-ink text-[0.875rem] underline underline-offset-4"
          >
            The prescription
          </Link>
        ) : null}
      </header>

      {dispense.notes ? <p className="text-muted text-[0.875rem]">{dispense.notes}</p> : null}

      <section className="space-y-2">
        <h2 className="text-ink text-[1.125rem] font-medium">What was handed over</h2>
        <ul className="space-y-2">
          {dispense.lines.map((line) => (
            <li key={line.id} className="border-rule bg-card rounded-md border">
              <div className="border-rule flex flex-wrap items-start justify-between gap-4 border-b p-4">
                <div>
                  <p className="text-ink text-[1rem] font-medium">{line.productName}</p>
                  {line.substitutedForProductName ? (
                    <p className="text-muted text-[0.875rem]">
                      Given instead of {line.substitutedForProductName} — {line.substitutionReason}
                    </p>
                  ) : null}
                  {line.labelInstructions ? (
                    <p className="text-muted mt-1 text-[0.875rem] italic">
                      “{line.labelInstructions}”
                    </p>
                  ) : null}
                </div>
                <p className="text-ink text-[0.9375rem] tabular-nums">
                  {line.quantityBase} {line.baseUnitSymbol}
                  {Number(line.returnedQuantityBase) > 0 ? (
                    <span className="text-muted"> · {line.returnedQuantityBase} back</span>
                  ) : null}
                </p>
              </div>

              <ul className="divide-rule divide-y">
                {line.allocations.map((allocation) => (
                  <li key={allocation.id} className="flex flex-wrap items-center gap-4 p-4">
                    <span className="text-ink w-28 shrink-0 text-[0.875rem] font-medium tabular-nums">
                      {allocation.expiresOn ?? 'no expiry'}
                    </span>
                    <span className="text-muted flex-1 text-[0.875rem]">
                      {allocation.lotNumber ? `Lot ${allocation.lotNumber}` : 'Untracked stock'}
                      {allocation.serialNumber ? ` · ${allocation.serialNumber}` : ''} ·{' '}
                      {allocation.locationName}
                    </span>
                    <span className="text-ink text-[0.875rem] tabular-nums">
                      {allocation.quantityBase} {line.baseUnitSymbol}
                    </span>
                    {allocation.isOverride ? (
                      <span className="text-warning text-[0.8125rem]">
                        Chosen over the plan — {allocation.overrideReason}
                      </span>
                    ) : null}
                    {returning ? (
                      <label className="flex items-center gap-2">
                        <span className="text-muted text-[0.8125rem]">Back</span>
                        {/* Bare, for the reason the workspace's quantity cell is:
                            the row is the label, and a stacked one per lot would
                            triple its height. The accessible name is on the box. */}
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`Quantity of ${line.productName} coming back from ${
                            allocation.lotNumber ? `lot ${allocation.lotNumber}` : 'untracked stock'
                          }`}
                          value={quantities[`${line.id}|${allocation.id}`] ?? ''}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [`${line.id}|${allocation.id}`]: event.target.value,
                            }))
                          }
                          className={cn(inputClass, 'w-24 text-right tabular-nums')}
                        />
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>

              {line.decision.messages.length > 0 || line.decision.conditions.length > 0 ? (
                <div className="border-rule bg-paper space-y-2 border-t p-4">
                  {line.decision.conditions.map((condition) => (
                    <p
                      key={`${condition.kind}-${condition.detail}`}
                      className="text-ink text-[0.875rem]"
                    >
                      <strong className="font-medium">Must be done:</strong> {condition.detail}
                    </p>
                  ))}
                  {line.decision.messages.map((message) => (
                    <p key={message} className="text-muted text-[0.875rem]">
                      {message}
                    </p>
                  ))}
                  {!line.decision.wasEnforced && line.decision.outcome !== 'PERMITTED' ? (
                    <p className="text-muted text-[0.8125rem]">
                      Recorded, not applied: nobody has signed off the rules for this place yet.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {dispense.returns.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-ink text-[1.125rem] font-medium">What came back</h2>
          <ul className="space-y-2">
            {dispense.returns.map((ret) => (
              <li key={ret.id} className="border-rule bg-card rounded-md border p-4">
                <p className="text-ink text-[0.9375rem]">
                  {formatClinicDateTime(ret.returnedAt, timezone, timeFormat)} · taken by{' '}
                  {ret.receivedByName} ·{' '}
                  {ret.disposition === 'RESTOCKED' ? 'back on the shelf' : 'quarantined'}
                </p>
                <p className="text-muted text-[0.875rem]">{ret.reason}</p>
                <ul className="text-muted mt-2 text-[0.875rem]">
                  {ret.lines.map((line) => (
                    <li key={line.id}>
                      {line.productName} · {line.quantityBase}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canTakeReturns && dispense.status !== 'RETURNED' ? (
        <section className="border-rule bg-card space-y-4 rounded-md border p-4">
          <h2 className="text-ink text-[1.125rem] font-medium">Take something back</h2>

          {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
          {state.status === 'saved' ? (
            <Alert tone="success">Recorded. The stock has gone where the rules allow.</Alert>
          ) : null}

          {returning ? (
            <form action={submit} className="space-y-3">
              <input type="hidden" name="lines" value={JSON.stringify(returnLines)} />
              <p className="text-muted text-[0.875rem]">
                Enter what is coming back against each lot above.
              </p>
              <Input
                label="Why it came back"
                name="reason"
                required
                minLength={4}
                placeholder="Wrong strength dispensed"
              />
              <label className="flex items-start gap-3">
                <input type="checkbox" name="requestRestock" className="mt-1" />
                <span className="text-muted text-[0.875rem]">
                  Put it back into sellable stock if the rules allow it. Left unticked — and
                  wherever the rules do not clearly allow it — the stock is quarantined.
                </span>
              </label>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={pending || returnLines.length === 0}>
                  {pending ? 'Recording…' : 'Record the return'}
                </Button>
                <button
                  type="button"
                  onClick={() => setReturning(false)}
                  className="text-muted hover:text-ink text-[0.875rem]"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setReturning(true)}>
              Start a return
            </Button>
          )}
        </section>
      ) : null}
    </div>
  );
}
