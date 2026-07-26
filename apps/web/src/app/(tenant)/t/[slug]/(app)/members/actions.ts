'use server';

import { revalidatePath } from 'next/cache';
import {
  assignRoleRequest,
  permissionOverrideRequest,
  updateMemberRequest,
  type MemberDetail,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Who works here, and what each of them may do.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s.
 *
 * These actions are bound to the slug on the server before they reach the
 * browser, so a client cannot re-point one at another clinic. Everything acts on
 * a MEMBERSHIP id rather than a user id — a person may work at two clinics, and
 * only one of those memberships is this tenant's business.
 *
 * NOTE: a 'use server' module may export async functions and nothing else — not
 * a constant, not an object. Types are erased, so `export type` is fine.
 */

export type MemberFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/** The empty string is how a `<select>` says "every branch"; the API wants null. */
function branchIdFrom(formData: FormData): string | null {
  const value = String(formData.get('branchId') ?? '').trim();
  return value === '' ? null : value;
}

export async function giveRole(
  slug: string,
  membershipId: string,
  _previous: MemberFormState,
  formData: FormData
): Promise<MemberFormState> {
  const parsed = assignRoleRequest.safeParse({
    roleId: String(formData.get('roleId') ?? ''),
    branchId: branchIdFrom(formData),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Choose a role and where it applies.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<MemberDetail>(`/api/v1/members/${membershipId}/roles`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      // The API refuses a role granting more than the caller holds, a branch
      // outside their reach, and any change to their own access.
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Role given.' };
}

export async function takeRoleAway(
  slug: string,
  membershipId: string,
  assignmentId: string,
  _previous: MemberFormState
): Promise<MemberFormState> {
  const result = await api(`/api/v1/members/${membershipId}/roles/${assignmentId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Role removed.' };
}

export async function saveException(
  slug: string,
  membershipId: string,
  _previous: MemberFormState,
  formData: FormData
): Promise<MemberFormState> {
  const parsed = permissionOverrideRequest.safeParse({
    permissionCode: String(formData.get('permissionCode') ?? ''),
    branchId: branchIdFrom(formData),
    effect: String(formData.get('effect') ?? 'DENY'),
    reason: String(formData.get('reason') ?? '').trim() || undefined,
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Choose a permission and whether to allow or block it.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<MemberDetail>(`/api/v1/members/${membershipId}/overrides`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Exception saved.' };
}

export async function clearException(
  slug: string,
  membershipId: string,
  overrideId: string,
  _previous: MemberFormState
): Promise<MemberFormState> {
  const result = await api(`/api/v1/members/${membershipId}/overrides/${overrideId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Exception removed. Their roles decide again.' };
}

/**
 * The employment record.
 *
 * An empty box means the field is cleared, which is why every value is sent as
 * `null` rather than omitted — omitting means "leave it alone", and the two have
 * to stay distinguishable.
 */
export async function saveDetails(
  slug: string,
  membershipId: string,
  _previous: MemberFormState,
  formData: FormData
): Promise<MemberFormState> {
  const text = (name: string): string | null => String(formData.get(name) ?? '').trim() || null;

  const parsed = updateMemberRequest.safeParse({
    employeeCode: text('employeeCode'),
    department: text('department'),
    designation: text('designation'),
    joinedOn: text('joinedOn'),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<MemberDetail>(`/api/v1/members/${membershipId}`, {
    method: 'PATCH',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Details saved.' };
}

export async function suspendMember(
  slug: string,
  membershipId: string,
  _previous: MemberFormState,
  formData: FormData
): Promise<MemberFormState> {
  const reason = String(formData.get('reason') ?? '').trim();

  const result = await api<MemberDetail>(`/api/v1/members/${membershipId}/suspend`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: reason ? { reason } : {},
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Access suspended. They are signed out everywhere.' };
}

export async function restoreMember(
  slug: string,
  membershipId: string,
  _previous: MemberFormState
): Promise<MemberFormState> {
  const result = await api<MemberDetail>(`/api/v1/members/${membershipId}/reactivate`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: {},
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/members`);
  return { status: 'saved', message: 'Access restored, with everything they had before.' };
}
