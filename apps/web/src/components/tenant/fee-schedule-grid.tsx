'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import type { BranchSummary, FeeScheduleView, FeeScopeLevel } from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import {
  loadFeeSchedule,
  saveFees,
  type FeeFormState,
} from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

/**
 * What a visit costs — the one grid, used at both ends of the inheritance.
 *
 * On the Clinic screen it edits the defaults every doctor inherits. On a
 * doctor's profile it edits that doctor's overrides. Same component, same
 * action, same shape of answer, because the two sheets ARE the same sheet at
 * different scopes, and building them separately is how they drift apart.
 *
 * ⚠️ EVERY ROW STATES WHERE ITS NUMBER CAME FROM, which is the settings screen's
 *   `Provenance` idea applied to the one place it matters even more. A price on
 *   this grid can come from four scopes, and an administrator who cannot tell an
 *   override from an inherited default sets an override on every doctor to be
 *   sure — after which the clinic's default means nothing and a price change has
 *   to be made forty times.
 *
 * ⚠️ AN EMPTY BOX MEANS INHERIT AND A TYPED `0` MEANS FREE, AND EVERY ROW SAYS
 *   SO IN WORDS. They look almost identical and they are opposite instructions:
 *   one falls through to the clinic's price, the other bills nothing. Making
 *   that legible is the most consequential thing this screen does.
 */

/** The words a clinic uses. `NEW` means nothing to a receptionist. */
const FEE_WORDS: Record<string, string> = {
  NEW: 'First visit',
  FOLLOW_UP: 'Review',
  WALK_IN: 'Walk-in',
  TELECONSULT: 'Teleconsultation',
  PROCEDURE: 'Procedure',
  RESCHEDULE: 'Moving an appointment',
};

/** What a row is for, where its name does not carry it. */
const FEE_NOTES: Record<string, string> = {
  FOLLOW_UP: 'Falls back to the first-visit price when this is blank everywhere.',
  RESCHEDULE:
    'Charged once per move, and only when the patient asked. A move the clinic makes is free.',
};

const LEVEL_WORDS: Record<FeeScopeLevel, string> = {
  DOCTOR_BRANCH: 'this doctor, at this branch',
  DOCTOR_ORGANIZATION: 'this doctor, everywhere',
  CLINIC_BRANCH: 'the clinic’s price at this branch',
  CLINIC_ORGANIZATION: 'the clinic’s price',
};

const IDLE: FeeFormState = { status: 'idle' };

/** Minor units to the major-unit string a person types back. */
function toBox(amountMinor: number | null): string {
  return amountMinor === null ? '' : (amountMinor / 100).toFixed(2);
}

export function FeeScheduleGrid({
  slug,
  doctorProfileId,
  branches,
  initial,
  canEdit,
}: {
  slug: string;
  /** Absent on the Clinic screen — that sheet is the clinic's own. */
  doctorProfileId?: string;
  /** The branches this caller may work in. An empty list is legitimate. */
  branches: BranchSummary[];
  /** The org-wide sheet, read on the server so the first paint has prices. */
  initial: FeeScheduleView | null;
  canEdit: boolean;
}) {
  const [branchId, setBranchId] = useState('');
  const [view, setView] = useState<FeeScheduleView | null>(initial);
  const [loading, startLoading] = useTransition();

  const [state, action, pending] = useActionState(
    saveFees.bind(null, slug, doctorProfileId ?? null),
    IDLE
  );
  const region = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, region);

  /*
   * ⚠️ THE SHEET IS RE-READ AFTER EVERY SAVE, NEVER PATCHED FROM THE FORM. What
   *   a box now inherits is a server answer: clearing a doctor's review price
   *   makes the clinic's number appear in it, and working that out in the
   *   browser would mean a second copy of the precedence rule.
   */
  useEffect(() => {
    let live = true;
    startLoading(() => {
      void loadFeeSchedule(slug, {
        ...(doctorProfileId !== undefined ? { doctorProfileId } : {}),
        ...(branchId !== '' ? { branchId } : {}),
      }).then((next) => {
        if (live) setView(next);
      });
    });
    return () => {
      live = false;
    };
  }, [slug, doctorProfileId, branchId, state.status, state.message]);

  const scopes: SelectOption[] = [
    { value: '', label: 'Every branch' },
    ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
  ];

  if (view === null) {
    return loading ? (
      <p className="text-muted mt-4 text-[0.8125rem]">Reading the fees…</p>
    ) : (
      <Alert tone="error" className="mt-4">
        Fees could not be read. Ask an administrator here whether you have access to them.
      </Alert>
    );
  }

  return (
    <form ref={region} action={action} className="mt-4">
      <input type="hidden" name="branchId" value={branchId} />

      {branches.length > 1 ? (
        <div className="max-w-xs">
          <Select
            name="scope"
            label="Which branch"
            hint="Set one price for everywhere, then override only the branches that differ."
            options={scopes}
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
          />
        </div>
      ) : null}

      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {view.rows.map((row) => {
          const inherited = row.ownAmountMinor === null && row.amountMinor !== null;
          const field = `amount.${row.feeType}`;
          const errors = state.fieldErrors?.[field];

          /*
           * Three states, three different consequences, and none of them is
           * visible from the number alone.
           */
          const provenance =
            row.amountMinor === null
              ? 'No price set. A bill for this kind of visit needs the amount typed in.'
              : inherited
                ? `Inherited from ${LEVEL_WORDS[row.level ?? 'CLINIC_ORGANIZATION']}. Type a number to override it.`
                : 'Set here. Clear the box to go back to inheriting.';

          return (
            <li key={row.feeType}>
              <input type="hidden" name="feeType" value={row.feeType} />
              <Input
                name={field}
                type="text"
                inputMode="decimal"
                label={`${FEE_WORDS[row.feeType] ?? row.feeType} · ${view.currency}`}
                hint={
                  FEE_NOTES[row.feeType] ? `${provenance} ${FEE_NOTES[row.feeType]}` : provenance
                }
                defaultValue={toBox(row.ownAmountMinor)}
                /*
                 * The inherited number is the PLACEHOLDER, not the value: it
                 * shows what applies today without the form claiming it as this
                 * scope's own, so saving an untouched row cannot silently pin
                 * the clinic's price onto one doctor.
                 */
                placeholder={inherited ? toBox(row.amountMinor) : 'Not set'}
                disabled={!canEdit}
                className="font-mono"
                {...(errors ? { errors } : {})}
              />
            </li>
          );
        })}
      </ul>

      {state.message !== undefined ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-4">
          {state.message}
        </Alert>
      ) : null}

      {canEdit ? (
        <Button type="submit" className="mt-4" disabled={pending || loading}>
          {pending ? 'Saving…' : 'Save fees'}
        </Button>
      ) : (
        <p className="text-muted mt-4 text-[0.8125rem]">
          Prices are set by an administrator at this clinic.
        </p>
      )}
    </form>
  );
}
