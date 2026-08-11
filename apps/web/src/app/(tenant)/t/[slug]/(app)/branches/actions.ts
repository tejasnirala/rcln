'use server';

import { revalidatePath } from 'next/cache';
import {
  branchOperatingHoursRequest,
  createBranchRequest,
  updateBranchRequest,
  type BranchDetail,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Branch management.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s — see the header of ../../actions.ts.
 *
 * These actions are bound to the slug on the server before they reach the
 * browser, so a client cannot re-point one at another clinic.
 */

export type BranchFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/*
 * NOTE: a 'use server' module may export async functions and nothing else — not
 * a constant, not an object. Types are erased at compile time so `export type`
 * is fine, but the shared `idle` state lives with the component that renders it.
 */

/** Empty strings from an untouched optional input mean "not provided". */
function text(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? '').trim();
  return value === '' ? undefined : value;
}

async function authed(): Promise<string | undefined> {
  return getAccessToken();
}

export async function createBranch(
  slug: string,
  _previous: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = createBranchRequest.safeParse({
    name: String(formData.get('name') ?? '').trim(),
    code: String(formData.get('code') ?? '')
      .trim()
      .toUpperCase(),
    branchType: formData.get('branchType') ?? 'CLINIC',
    /*
     * ⚠️ OMITTED RATHER THAN DEFAULTED, ALL THREE. Country, region and time zone
     *   now fall back to the ORGANIZATION's when the form does not send them —
     *   sending a literal `Asia/Kolkata` from here, as this action used to, is
     *   what made every branch of a non-Indian clinic Indian for tax and IST for
     *   appointment times.
     */
    ...(text(formData, 'timezone') ? { timezone: text(formData, 'timezone') } : {}),
    ...(text(formData, 'countryCode') ? { countryCode: text(formData, 'countryCode') } : {}),
    ...(text(formData, 'regionCode') ? { regionCode: text(formData, 'regionCode') } : {}),
    ...(text(formData, 'phone') ? { phone: text(formData, 'phone') } : {}),
    ...(text(formData, 'email') ? { email: text(formData, 'email') } : {}),
    ...(text(formData, 'addressLine1') ? { addressLine1: text(formData, 'addressLine1') } : {}),
    ...(text(formData, 'city') ? { city: text(formData, 'city') } : {}),
    ...(text(formData, 'state') ? { state: text(formData, 'state') } : {}),
    ...(text(formData, 'pincode') ? { pincode: text(formData, 'pincode') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<BranchDetail>('/api/v1/branches', {
    method: 'POST',
    slug,
    accessToken: await authed(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/branches`);
  return { status: 'saved', message: `${parsed.data.name} added.` };
}

export async function updateBranch(
  slug: string,
  branchId: string,
  _previous: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const parsed = updateBranchRequest.safeParse({
    name: String(formData.get('name') ?? '').trim(),
    ...(text(formData, 'phone') !== undefined ? { phone: text(formData, 'phone') } : {}),
    ...(text(formData, 'email') !== undefined ? { email: text(formData, 'email') } : {}),
    ...(text(formData, 'addressLine1') !== undefined
      ? { addressLine1: text(formData, 'addressLine1') }
      : {}),
    ...(text(formData, 'city') !== undefined ? { city: text(formData, 'city') } : {}),
    ...(text(formData, 'state') !== undefined ? { state: text(formData, 'state') } : {}),
    ...(text(formData, 'pincode') !== undefined ? { pincode: text(formData, 'pincode') } : {}),
    ...(text(formData, 'countryCode') !== undefined
      ? { countryCode: text(formData, 'countryCode') }
      : {}),
    /*
     * An empty region is meaningful and must survive: it clears the branch back
     * to the country-wide registration. Sent as '' so the contract's transform
     * turns it into null, which is why this one tests the raw field rather than
     * `text()`.
     */
    ...(formData.get('regionCode') !== null
      ? { regionCode: String(formData.get('regionCode')).trim() }
      : {}),
    ...(formData.get('status') ? { status: formData.get('status') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<BranchDetail>(`/api/v1/branches/${branchId}`, {
    method: 'PATCH',
    slug,
    accessToken: await authed(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/branches`);
  return { status: 'saved', message: 'Changes saved.' };
}

/**
 * The whole week at once.
 *
 * The form posts seven rows whatever the branch currently has; a day whose
 * "Open" box is unchecked is sent with isClosed true rather than omitted, so
 * the editor round-trips exactly what it displayed. Omission is reserved for
 * a day the branch genuinely does not have.
 */
export async function saveOperatingHours(
  slug: string,
  branchId: string,
  _previous: BranchFormState,
  formData: FormData
): Promise<BranchFormState> {
  const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    dayOfWeek: day,
    opensAt: String(formData.get(`opensAt-${String(day)}`) ?? '09:00'),
    closesAt: String(formData.get(`closesAt-${String(day)}`) ?? '17:00'),
    isClosed: formData.get(`open-${String(day)}`) === null,
    slotMinutes: Number(formData.get(`slotMinutes-${String(day)}`) ?? 15),
  }));

  const parsed = branchOperatingHoursRequest.safeParse({ hours });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted times.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<BranchDetail>(`/api/v1/branches/${branchId}/operating-hours`, {
    method: 'PUT',
    slug,
    accessToken: await authed(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/branches`);
  return { status: 'saved', message: 'Opening hours saved.' };
}

export async function removeBranch(
  slug: string,
  branchId: string,
  _previous: BranchFormState
): Promise<BranchFormState> {
  const result = await api(`/api/v1/branches/${branchId}`, {
    method: 'DELETE',
    slug,
    accessToken: await authed(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      // The API refuses the primary branch and the last remaining one, and its
      // message says which. Passing it through beats inventing a vaguer one.
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/branches`);
  return { status: 'saved', message: 'Branch retired.' };
}
