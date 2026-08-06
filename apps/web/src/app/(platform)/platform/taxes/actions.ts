'use server';

import { revalidatePath } from 'next/cache';
import type { TaxRegistrationSummary } from '@rcln/contracts';
import { ADMIN_HOST, api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Adding, changing and retiring the jurisdictions rcln collects tax in.
 *
 * ⚠️ EVERY ONE OF THESE CHANGES WHAT CLINICS ARE CHARGED, IMMEDIATELY.
 *   There is no draft and no publish. The tax engine reads the table on every
 *   invoice, so a save here shows up on the next checkout. `effectiveFrom` is
 *   how you schedule a change; it is not a workflow state.
 *
 * The rate crosses the wire in BASIS POINTS, matching how money crosses it in
 * minor units — the form takes a percentage from a human and converts once,
 * here, so a float never reaches the API or the column.
 */

export type TaxFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Echoed back so a rejected save does not empty the form. See the signup form. */
  values?: Record<string, string>;
};

const PRESERVED = [
  'countryCode',
  'regionCode',
  'scheme',
  'registrationNumber',
  'ratePercent',
  'effectiveFrom',
  'effectiveTo',
] as const;

/**
 * `18` or `17.5` -> basis points.
 *
 * Rounded rather than truncated, and validated by the caller: a percentage with
 * more than two decimals is not a rate any authority publishes, and silently
 * dropping the third digit would produce an invoice nobody can reproduce.
 */
function toBasisPoints(percent: string): number | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(percent.trim())) return null;
  return Math.round(Number(percent) * 100);
}

function read(formData: FormData) {
  const value = (key: string): string => String(formData.get(key) ?? '').trim();
  const values: Record<string, string> = {};
  for (const key of PRESERVED) {
    const typed = value(key);
    if (typed) values[key] = typed;
  }
  return { value, values };
}

export async function saveTaxRegistration(
  id: string | null,
  _previous: TaxFormState,
  formData: FormData
): Promise<TaxFormState> {
  const { value, values } = read(formData);

  const rate = toBasisPoints(value('ratePercent'));
  if (rate === null) {
    return {
      status: 'error',
      values,
      message: 'Check the highlighted fields.',
      fieldErrors: { ratePercent: ['A percentage, like 18 or 17.5.'] },
    };
  }

  const body = {
    countryCode: value('countryCode'),
    // Blank means the whole country. The API normalises it to null; sending the
    // empty string rather than omitting the key is what lets an EDIT widen a
    // region-specific registration back to country-wide.
    regionCode: value('regionCode'),
    scheme: value('scheme'),
    registrationNumber: value('registrationNumber'),
    standardRateBps: rate,
    effectiveFrom: value('effectiveFrom'),
    ...(value('effectiveTo') ? { effectiveTo: value('effectiveTo') } : {}),
  };

  const result = await api<TaxRegistrationSummary>(
    id ? `/api/v1/platform/tax-registrations/${id}` : '/api/v1/platform/tax-registrations',
    {
      method: id ? 'PATCH' : 'POST',
      host: ADMIN_HOST,
      accessToken: await getAccessToken(),
      body,
    }
  );

  if (!result.ok) {
    return {
      status: 'error',
      values,
      // The API's 409 explains that two registrations for one place would be
      // picked between arbitrarily. That is more useful than anything generic.
      message: result.message ?? 'That could not be saved.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath('/platform/taxes');
  return { status: 'saved', message: id ? 'Registration updated.' : 'Registration added.' };
}

export async function removeTaxRegistration(
  id: string,
  _previous: TaxFormState
): Promise<TaxFormState> {
  const result = await api(`/api/v1/platform/tax-registrations/${id}`, {
    method: 'DELETE',
    host: ADMIN_HOST,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'That could not be removed.' };
  }

  revalidatePath('/platform/taxes');
  return {
    status: 'saved',
    message: 'Registration removed. Nothing further will be charged there.',
  };
}
