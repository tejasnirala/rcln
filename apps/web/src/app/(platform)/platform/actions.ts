'use server';

import {
  loginRequest,
  registerOrganizationRequest,
  type AuthSession,
  type RegisterOrganizationResponse,
} from '@rcln/contracts';
import { ADMIN_HOST, api, fieldErrorsFrom } from '@/lib/api';
import { clearSessionCookies, getAccessToken, setSessionCookies } from '@/lib/session';

/**
 * The super-admin console.
 *
 * Everything here addresses `admin.<root-domain>`, which `resolveTenant` skips
 * by name — so these calls carry no tenant, which is exactly right: a platform
 * admin belongs to no clinic. The API gates the routes on
 * `users.is_platform_admin` and answers a caller without it with 404, so the
 * console never confirms it exists to someone who cannot use it.
 */

export type PlatformLoginState = {
  /**
   * `signed-in` rather than a redirect: `/` on the admin host is the console
   * only after proxy.ts rewrites it, and a Server Action redirect resolves
   * against the route tree instead. See lib/hard-navigate.ts.
   */
  status: 'idle' | 'error' | 'signed-in';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function platformSignIn(
  _previous: PlatformLoginState,
  formData: FormData
): Promise<PlatformLoginState> {
  const parsed = loginRequest.safeParse({
    identifier: String(formData.get('identifier') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<AuthSession>('/api/v1/auth/login', {
    method: 'POST',
    host: ADMIN_HOST,
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : (result.message ?? 'Those credentials are not valid.'),
    };
  }

  /**
   * A valid clinic account is not an admin account.
   *
   * Refuse with the same message as bad credentials, and store nothing — this
   * page must not become a way to discover that a login works somewhere else.
   */
  if (!result.data.user.isPlatformAdmin) {
    return { status: 'error', message: 'Those credentials are not valid.' };
  }

  await setSessionCookies(result.data);
  /*
   * The console lives at `/` on the admin host, NOT at `/platform`: proxy.ts
   * rewrites this subdomain by PREPENDING /platform to the path, so
   * admin.<root>/platform resolves to /platform/platform and 404s on any real
   * page load. It only ever appeared to work as a client-side navigation.
   */
  return { status: 'signed-in' };
}

export async function platformSignOut(): Promise<void> {
  const accessToken = await getAccessToken();

  if (accessToken) {
    await api('/api/v1/auth/logout', { method: 'POST', host: ADMIN_HOST, accessToken });
  }

  await clearSessionCookies();
}

export type ProvisionState = {
  status: 'idle' | 'error' | 'provisioned';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  slug?: string;
};

/**
 * Provision a clinic on its behalf, typically from a demo request.
 *
 * Same service, same transaction and same invariants as self-serve signup — only
 * the actor differs, and that difference is what the audit row records.
 */
export async function provisionClinic(
  _previous: ProvisionState,
  formData: FormData
): Promise<ProvisionState> {
  const accessToken = await getAccessToken();
  if (!accessToken) return { status: 'error', message: 'Your session has expired. Sign in again.' };

  const value = (key: string): string => String(formData.get(key) ?? '').trim();
  const optional = (key: string): string | undefined => value(key) || undefined;

  const candidate = {
    organization: {
      legalName: value('legalName'),
      displayName: value('displayName'),
      slug: value('slug').toLowerCase(),
      orgType: value('orgType') || 'CLINIC',
    },
    branch: {
      name: value('branchName'),
      code: 'MAIN',
      ...(optional('city') ? { city: value('city') } : {}),
    },
    owner: {
      fullName: value('fullName'),
      email: value('email'),
      phone: value('phone'),
      password: value('password'),
    },
    planCode: value('planCode') || 'STARTER',
    acceptedTerms: true as const,
  };

  const parsed = registerOrganizationRequest.safeParse(candidate);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const demoRequestId = optional('demoRequestId');

  const result = await api<RegisterOrganizationResponse>('/api/v1/platform/organizations', {
    method: 'POST',
    host: ADMIN_HOST,
    accessToken,
    body: { ...parsed.data, ...(demoRequestId ? { demoRequestId } : {}) },
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message: result.message ?? 'We could not provision that clinic.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  return { status: 'provisioned', slug: result.data.slug };
}
