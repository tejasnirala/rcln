'use server';

import { loginRequest, otpRequest, otpVerifyRequest, type AuthSession } from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { clearSessionCookies, getAccessToken, setSessionCookies } from '@/lib/session';

/*
 * Tenant sign-in.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID
 *   `resolveTenant` in apps/api derives the organization from the Host header.
 *   A Server Action's fetch is server-to-server to http://api:5000, so Host is
 *   `api:5000` and the tenant resolves to null — every login would 404, and a
 *   404 from an unknown tenant is indistinguishable from a missing route.
 *
 *   `slug` is passed into these actions for exactly that reason, and `api()`
 *   turns it into the Host header. Never drop it.
 *
 * A Server Action is a public POST endpoint, not just a form handler. The API
 * revalidates everything and owns the outcome; validating here only saves a
 * round trip on an obvious mistake.
 */

/**
 * `signed-in` rather than a redirect from the server.
 *
 * The action cannot navigate correctly on its own: `/` on this host means the
 * tenant home only after proxy.ts rewrites it, and a Server Action redirect is
 * resolved against the route tree instead — landing on the marketing page. The
 * form does a real browser navigation on this status. See lib/hard-navigate.ts.
 */
export type LoginFormState = {
  status: 'idle' | 'error' | 'otp-sent' | 'signed-in';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/** One message for every credential failure — see login.service.ts for why. */
const GENERIC_FAILURE = 'Those credentials are not valid.';

export async function signIn(
  slug: string,
  _previous: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const parsed = loginRequest.safeParse({
    identifier: String(formData.get('identifier') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    ...(formData.get('totpCode') ? { totpCode: formData.get('totpCode') } : {}),
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
    slug,
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : (result.message ?? GENERIC_FAILURE),
    };
  }

  await setSessionCookies(result.data);
  return { status: 'signed-in' };
}

/**
 * Phone sign-in, both steps.
 *
 * One action rather than two, so the step the user is on is DERIVED from the
 * answer this returns rather than held in client state that could disagree with
 * it. Which step is running is decided by whether a code was submitted.
 */
export async function otpSignIn(
  slug: string,
  _previous: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const phone = String(formData.get('phone') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();

  // -- step 2: a code is present, so verify it ---------------------------
  if (code) {
    const parsed = otpVerifyRequest.safeParse({ phone, code });

    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Check the highlighted fields.',
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      };
    }

    const result = await api<AuthSession>('/api/v1/auth/otp/verify', {
      method: 'POST',
      slug,
      body: parsed.data,
    });

    if (!result.ok || !result.data) {
      // Stay on the code step — the number is right, the code was not.
      return {
        status: 'otp-sent',
        message: result.message ?? 'That code is not valid or has expired.',
        fieldErrors: { code: ['Check the code and try again.'] },
      };
    }

    await setSessionCookies(result.data);
    return { status: 'signed-in' };
  }

  // -- step 1: send a code -----------------------------------------------
  const parsed = otpRequest.safeParse({ phone });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api('/api/v1/auth/otp/request', {
    method: 'POST',
    slug,
    body: parsed.data,
  });

  if (!result.ok && result.status === 429) {
    return { status: 'error', message: 'Too many codes requested. Wait a few minutes.' };
  }

  // The API answers identically for a known and an unknown number, and so does
  // this — anything else would reveal who has an account here.
  return {
    status: 'otp-sent',
    message: 'If that number has an account, a code is on its way.',
  };
}

/**
 * Sign out, and say where to go rather than going there.
 *
 * `/login` collides too: the apex serves a clinic finder at that path, so a
 * router navigation after signing out can render that instead of this clinic's
 * sign-in page. The caller navigates for real.
 */
export async function signOut(slug: string): Promise<void> {
  const accessToken = await getAccessToken();

  if (accessToken) {
    // Revoke server-side too. Clearing the cookie alone would leave a live
    // session anyone holding the token could keep using.
    await api('/api/v1/auth/logout', { method: 'POST', slug, accessToken });
  }

  await clearSessionCookies();
}

/**
 * Leave a clinic a super admin walked into.
 *
 * Revoking server-side matters more here than it does for an ordinary sign-out:
 * clearing the cookie only stops this browser, and the token this session issued
 * is the one credential in the product that can write into a clinic nobody at
 * that clinic authorised. The caller navigates back to the console itself —
 * that is another host, so no redirect from here could reach it.
 */
export async function stopImpersonation(slug: string): Promise<void> {
  const accessToken = await getAccessToken();

  if (accessToken) {
    await api('/api/v1/auth/impersonation/stop', { method: 'POST', slug, accessToken });
  }

  await clearSessionCookies();
}

export async function switchBranch(slug: string, branchId: string): Promise<void> {
  const accessToken = await getAccessToken();
  if (!accessToken) return;

  const result = await api<AuthSession>('/api/v1/auth/switch-branch', {
    method: 'POST',
    slug,
    accessToken,
    body: { branchId },
  });

  // A re-issued access token carries the new branch; the refresh token is
  // unchanged by design, so the session survives the switch.
  if (result.ok && result.data) {
    await setSessionCookies(result.data);
  }
  // No redirect: the caller reloads the page itself, which is also what makes
  // every server component re-read the session under the new branch.
}
