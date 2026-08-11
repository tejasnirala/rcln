'use client';

import { useActionState, useRef } from 'react';
import type { DoctorCompensationDetail } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { saveCompensation, type FeeFormState } from '@/app/(tenant)/t/[slug]/(app)/fees/actions';

/**
 * What the clinic has agreed to pay this doctor.
 *
 * ⚠️ IT IS A RECORD OF AN AGREEMENT AND IT PAYS NOBODY, AND THE COPY HAS TO SAY
 *   SO. There is no payroll run behind this — no periods, no payslips, no
 *   reconciliation against what the practitioner billed. A box labelled "salary"
 *   with a Save button next to it looks exactly like a payroll system to whoever
 *   is filling it in, and a clinic that believes rcln is paying its doctors is
 *   a clinic whose doctors do not get paid.
 *
 * ⚠️ AND IT IS UNRELATED TO WHAT PATIENTS ARE CHARGED, which is the grid above
 *   it on the same screen. Two amounts, adjacent, opposite directions: one is
 *   money coming in, one is money going out. `PER_SESSION` makes the confusion
 *   easy, so the section says which is which rather than relying on the heading.
 *
 * Read-only for everyone who does not hold `doctor.compensation.manage` —
 * including the doctor themselves, who may see their own figure and not set it.
 */

const INTERVALS: SelectOption[] = [
  { value: 'MONTHLY', label: 'A month' },
  { value: 'FORTNIGHTLY', label: 'A fortnight' },
  { value: 'WEEKLY', label: 'A week' },
  { value: 'DAILY', label: 'A day' },
  { value: 'HOURLY', label: 'An hour' },
  { value: 'PER_SESSION', label: 'A session' },
];

const IDLE: FeeFormState = { status: 'idle' };

export function DoctorPayPanel({
  slug,
  doctorId,
  compensation,
  canEdit,
}: {
  slug: string;
  doctorId: string;
  compensation: DoctorCompensationDetail;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    saveCompensation.bind(null, slug, doctorId),
    IDLE
  );
  const region = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, region);

  const agreed = compensation.amountMinor !== null;

  if (!canEdit) {
    return (
      <p className="text-ink mt-3 text-[0.9375rem]">
        {agreed ? (
          <>
            <span className="font-mono">
              {formatMoney(money(compensation.amountMinor ?? 0, compensation.currency))}
            </span>{' '}
            for{' '}
            {INTERVALS.find((i) => i.value === compensation.interval)?.label.toLowerCase() ??
              'a month'}
            .
          </>
        ) : (
          'Nothing agreed yet.'
        )}
      </p>
    );
  }

  return (
    <form ref={region} action={action} className="mt-3">
      <div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
        <Input
          name="amount"
          type="text"
          inputMode="decimal"
          label={`Amount · ${compensation.currency}`}
          hint="Leave blank if nothing has been agreed."
          defaultValue={
            compensation.amountMinor === null ? '' : (compensation.amountMinor / 100).toFixed(2)
          }
          className="font-mono"
          {...(state.fieldErrors?.['amount'] ? { errors: state.fieldErrors['amount'] } : {})}
        />
        <Select
          name="interval"
          label="For every"
          options={INTERVALS}
          defaultValue={compensation.interval ?? 'MONTHLY'}
        />
      </div>

      {state.message !== undefined ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-4">
          {state.message}
        </Alert>
      ) : null}

      <Button type="submit" className="mt-4" disabled={pending}>
        {pending ? 'Saving…' : 'Save what we pay'}
      </Button>
    </form>
  );
}
