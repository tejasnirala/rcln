'use server';

import { impersonateRequest, type ImpersonationGrant } from '@rcln/contracts';
import { ADMIN_HOST, api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Entering a clinic, from the console's side.
 *
 * WHY THIS RETURNS A TICKET INSTEAD OF SIGNING ANYONE IN
 *   Session cookies are host-only (lib/session.ts) — that is the boundary that
 *   makes a session at alpha.rcln.com useless at beta.rcln.com. So this action,
 *   running on `admin.<root>`, CANNOT write the cookie the clinic's subdomain
 *   needs, and there is no arrangement of redirects that changes that.
 *
 *   What it can do is hand the browser a one-time ticket and let the browser
 *   carry it across. The client posts it to `/impersonate` on the clinic's own
 *   host, which is a Route Handler and therefore the request that receives the
 *   cookie. A POST because the ticket is a credential: a URL is written to every
 *   access log between the browser and here.
 */

export type ImpersonateState = {
  /** `ready` carries a ticket the client must post to the clinic's host. */
  status: 'idle' | 'error' | 'ready';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  grant?: ImpersonationGrant;
  /** Which row asked, so only that row reacts. */
  organizationId?: string;
};

export async function startImpersonation(
  organizationId: string,
  _previous: ImpersonateState,
  formData: FormData
): Promise<ImpersonateState> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { status: 'error', organizationId, message: 'Your session has expired. Sign in again.' };
  }

  const parsed = impersonateRequest.safeParse({ reason: String(formData.get('reason') ?? '') });

  if (!parsed.success) {
    return {
      status: 'error',
      organizationId,
      message: 'Check the highlighted field.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<ImpersonationGrant>(
    `/api/v1/platform/organizations/${organizationId}/impersonate`,
    { method: 'POST', host: ADMIN_HOST, accessToken, body: parsed.data }
  );

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      organizationId,
      message: result.message ?? 'We could not open that clinic.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  return { status: 'ready', organizationId, grant: result.data };
}
