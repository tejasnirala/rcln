'use server';

import { revalidatePath } from 'next/cache';
import {
  createDesignationRequest,
  inviteMemberRequest,
  type DesignationSummary,
  type InvitationSummary,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Issuing and cancelling invitations.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s — see the header of ../../../actions.ts.
 *
 * These actions are bound to the slug on the server before they reach the
 * browser, so a client cannot re-point one at another clinic.
 *
 * The invitation token never passes through here. It goes from the API straight
 * to the invitee's mailbox; the screen only ever sees ids and a status.
 */

export type InviteFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/*
 * NOTE: a 'use server' module may export async functions and nothing else — not
 * a constant, not an object. Types are erased at compile time so `export type`
 * is fine; the shared `idle` state lives with the component that renders it.
 */

export async function inviteMember(
  slug: string,
  _previous: InviteFormState,
  formData: FormData
): Promise<InviteFormState> {
  // Unchecked boxes are simply absent, so an org-wide invitation and a
  // branch-scoped one differ only in how many values came back.
  const branchIds = formData.getAll('branchIds').map(String).filter(Boolean);

  const parsed = inviteMemberRequest.safeParse({
    email: String(formData.get('email') ?? '')
      .trim()
      .toLowerCase(),
    roleId: String(formData.get('roleId') ?? ''),
    // Optional: an empty select means no title, not an empty-string uuid.
    ...(String(formData.get('designationId') ?? '') !== ''
      ? { designationId: String(formData.get('designationId')) }
      : {}),
    branchIds,
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<InvitationSummary>('/api/v1/invitations', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      // The API refuses a duplicate, an out-of-scope branch and an org-wide
      // grant beyond the caller's own reach, and its message says which.
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/invitations`);
  return { status: 'saved', message: `Invitation sent to ${parsed.data.email}.` };
}

export async function revokeInvitation(
  slug: string,
  invitationId: string,
  _previous: InviteFormState,
  formData: FormData
): Promise<InviteFormState> {
  const reason = String(formData.get('reason') ?? '').trim();

  const result = await api(`/api/v1/invitations/${invitationId}`, {
    method: 'DELETE',
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

  revalidatePath(`/t/${slug}/invitations`);
  return { status: 'saved', message: 'Invitation cancelled.' };
}

/**
 * Send it again — with a new link.
 *
 * Worth saying in the UI, because it is not what "resend" usually means: the
 * previous link stops working. See resendInvitation in the API service.
 */
export async function resendInvitation(
  slug: string,
  invitationId: string,
  _previous: InviteFormState
): Promise<InviteFormState> {
  const result = await api<InvitationSummary>(`/api/v1/invitations/${invitationId}/resend`, {
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

  revalidatePath(`/t/${slug}/invitations`);
  return {
    status: 'saved',
    message: 'A new link is on its way. The previous one no longer works.',
  };
}

/**
 * Add a job title without leaving the invite form.
 *
 * The alternative — sending someone to a separate settings screen and back —
 * loses whatever they had already typed into the invitation. This returns the
 * new title so the form can select it immediately.
 *
 * `revalidatePath` refreshes the menu for the next render; the immediate
 * selection comes from the returned row, because the current form state must
 * survive the round trip.
 */
export async function addDesignation(
  slug: string,
  name: string,
  roleId: string
): Promise<{ ok: true; designation: DesignationSummary } | { ok: false; message: string }> {
  const parsed = createDesignationRequest.safeParse({
    name,
    ...(roleId !== '' ? { roleId } : {}),
  });
  if (!parsed.success) {
    return { ok: false, message: 'Give the title at least two characters.' };
  }

  const result = await api<DesignationSummary>('/api/v1/designations', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message ?? 'That title could not be added.' };
  }

  revalidatePath(`/t/${slug}/invitations`);
  return { ok: true, designation: result.data };
}
