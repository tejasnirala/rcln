'use server';

import { revalidatePath } from 'next/cache';
import type {
  DoctorCompensationDetail,
  FeeQuote,
  FeeScheduleView,
  PayoutIntervalValue,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * What a visit costs, and what the doctor giving it is paid.
 *
 * ⚠️ NOT IN A ROUTE FOLDER OF ITS OWN BY ACCIDENT — there is no `page.tsx` here
 *   and there should not be. These actions are shared by two screens that are
 *   nowhere near each other in the tree: the Clinic screen sets the defaults,
 *   and a doctor's profile overrides them. Copying them into both folders is how
 *   the two ends of one grid start posting different bodies.
 *
 * ⚠️ THE FEE IS QUOTED BEFORE THE PATIENT AGREES TO ANYTHING. `loadFeeQuote`
 *   backs the line on the booking form, and it calls the same endpoint — and so
 *   the same resolver — that freezes the price onto the appointment a moment
 *   later. A number worked out here in the browser is how the desk says 500 and
 *   the bill says 600.
 */

export type FeeFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One scope's sheet, with inheritance folded in.
 *
 * `doctorProfileId` absent is the clinic's own grid; `branchId` absent is the
 * org-wide sheet that every branch falls back to.
 */
export async function loadFeeSchedule(
  slug: string,
  args: { doctorProfileId?: string; branchId?: string }
): Promise<FeeScheduleView | null> {
  const query = args.branchId ? `?branchId=${encodeURIComponent(args.branchId)}` : '';
  const path = args.doctorProfileId
    ? `/api/v1/doctors/${args.doctorProfileId}/fees${query}`
    : `/api/v1/fee-schedule${query}`;

  const result = await api<FeeScheduleView>(path, { slug, accessToken: await getAccessToken() });
  return result.ok && result.data ? result.data : null;
}

/** What this visit would cost, for the line on the booking form. */
export async function loadFeeQuote(
  slug: string,
  args: { doctorProfileId: string; branchId: string; feeType: string }
): Promise<FeeQuote | null> {
  const query = new URLSearchParams({
    doctorProfileId: args.doctorProfileId,
    branchId: args.branchId,
    feeType: args.feeType,
  });

  const result = await api<FeeQuote>(`/api/v1/fee-schedule/quote?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

/** The agreed figure. Null when the caller may not see it, or there is none. */
export async function loadCompensation(
  slug: string,
  doctorId: string
): Promise<DoctorCompensationDetail | null> {
  const result = await api<DoctorCompensationDetail>(`/api/v1/doctors/${doctorId}/compensation`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Save one scope's prices.
 *
 * ⚠️ A BLANK BOX MEANS "INHERIT", NOT "FREE", AND THAT IS WHY THE BODY CARRIES
 *   `null` RATHER THAN OMITTING THE KEY. Clearing a box is a real instruction —
 *   go back to whatever the broader sheet says — and the API deletes the row for
 *   it. A `0` typed deliberately is a price of nothing and is sent as `0`.
 *
 * Only the fee types the form posted are touched; anything else the clinic has
 * configured is left alone.
 */
export async function saveFees(
  slug: string,
  doctorProfileId: string | null,
  _previous: FeeFormState,
  formData: FormData
): Promise<FeeFormState> {
  const branchRaw = String(formData.get('branchId') ?? '');
  const branchId = branchRaw === '' ? null : branchRaw;

  const fees: { feeType: string; amountMinor: number | null }[] = [];
  for (const feeType of formData.getAll('feeType').map(String)) {
    const raw = String(formData.get(`amount.${feeType}`) ?? '').trim();

    if (raw === '') {
      fees.push({ feeType, amountMinor: null });
      continue;
    }

    /*
     * Major units in the box, minor units on the wire. A clinic types 400 or
     * 400.50; the API and the column speak integers, and rounding here rather
     * than at the boundary is how 400.005 becomes a price nobody agreed.
     */
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        status: 'error',
        message: 'Enter an amount like 400 or 400.50, or leave it blank to inherit.',
        fieldErrors: { [`amount.${feeType}`]: ['Enter an amount, or leave it blank.'] },
      };
    }
    fees.push({ feeType, amountMinor: Math.round(parsed * 100) });
  }

  if (fees.length === 0) return { status: 'error', message: 'There was nothing to save.' };

  const path = doctorProfileId ? `/api/v1/doctors/${doctorProfileId}/fees` : '/api/v1/fee-schedule';

  const result = await api<FeeScheduleView>(path, {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body: { branchId, fees },
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(doctorProfileId ? `/t/${slug}/doctors/${doctorProfileId}` : `/t/${slug}/settings`);
  return { status: 'saved', message: 'Saved.' };
}

/**
 * Record what the clinic has agreed to pay a doctor.
 *
 * ⚠️ THIS PAYS NOBODY. It is a record of an agreement — no run, no payslip, no
 *   reconciliation against what the doctor billed. The copy on the screen says
 *   so, because a field labelled "salary" with a Save button next to it looks
 *   exactly like a payroll system to the person filling it in.
 *
 * Clearing the amount clears the interval with it: an interval on its own is a
 * schedule for paying nothing.
 */
export async function saveCompensation(
  slug: string,
  doctorId: string,
  _previous: FeeFormState,
  formData: FormData
): Promise<FeeFormState> {
  const raw = String(formData.get('amount') ?? '').trim();
  const interval = String(formData.get('interval') ?? '');

  let amountMinor: number | null = null;
  if (raw !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        status: 'error',
        message: 'Enter an amount like 120000, or leave it blank.',
        fieldErrors: { amount: ['Enter an amount, or leave it blank.'] },
      };
    }
    amountMinor = Math.round(parsed * 100);
  }

  const result = await api<DoctorCompensationDetail>(`/api/v1/doctors/${doctorId}/compensation`, {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body: {
      amountMinor,
      interval: amountMinor === null ? null : ((interval || 'MONTHLY') as PayoutIntervalValue),
    },
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/doctors/${doctorId}`);
  return { status: 'saved', message: amountMinor === null ? 'Cleared.' : 'Saved.' };
}
