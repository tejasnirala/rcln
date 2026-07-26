'use server';

import { acceptInviteRequest, type AuthSession } from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { setSessionCookies } from '@/lib/session';

/*
 * Accepting an invitation.
 *
 * Deliberately NOT under `(app)` and not sharing branches/actions.ts: the person
 * running this has no session and no membership, which is the whole point. It
 * sends no bearer token.
 *
 * `slug` is bound on the server so the browser cannot re-point the accept at
 * another clinic — and it would not help if it could, because the API resolves
 * the invitation against the organization the Host header names.
 */

/**
 * `joined` rather than a redirect from the server.
 *
 * A Server Action's redirect is resolved against the route tree rather than
 * through the proxy rewrite, so `/` lands on the marketing page and a refresh
 * "fixes" it — the signature of the trap in docs/PITFALLS.md. The form does a
 * real browser navigation on this status instead. See lib/hard-navigate.ts.
 */
export type JoinFormState = {
  status: 'idle' | 'error' | 'joined';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function acceptInvitation(
  slug: string,
  token: string,
  needsAccount: boolean,
  _previous: JoinFormState,
  formData: FormData
): Promise<JoinFormState> {
  const parsed = acceptInviteRequest.safeParse({
    token,
    password: String(formData.get('password') ?? ''),
    // Only sent when the account is being created. On the other path the API
    // ignores it, but there is no reason to put a name on the wire at all.
    ...(needsAccount ? { fullName: String(formData.get('fullName') ?? '').trim() } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<AuthSession>('/api/v1/auth/invitations/accept', {
    method: 'POST',
    slug,
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : (result.message ?? 'That invitation could not be accepted.'),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  // The API mints a session on success, so nobody has to sign in immediately
  // after proving who they are.
  await setSessionCookies(result.data);
  return { status: 'joined' };
}
