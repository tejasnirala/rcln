'use server';

import { revalidatePath } from 'next/cache';
import {
  verificationConfirmRequest,
  type VerificationRequestResult,
  type VerificationResult,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Confirming your own email address and phone number.
 *
 * The channel is bound server-side alongside the slug, like every other action
 * in this app — the browser posts a code and nothing else, so it cannot re-point
 * one of these at another clinic or another channel.
 *
 * NOTE: a 'use server' module may export async functions and nothing else. The
 * shared `idle` state lives with the component that renders it.
 */

export type VerifyFormState = {
  status: 'idle' | 'error' | 'sent' | 'verified';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export type VerifyChannel = 'email' | 'phone';

/**
 * The prompt naming the unverified channel lives in the `(app)` LAYOUT, not on
 * this page, so a page-level revalidate would leave it on screen after the
 * thing it is asking for has been done. `'layout'` re-renders the shell too.
 */
async function refresh(slug: string): Promise<void> {
  revalidatePath(`/t/${slug}`, 'layout');
}

export async function sendVerificationCode(
  channel: VerifyChannel,
  slug: string,
  _previous: VerifyFormState
): Promise<VerifyFormState> {
  const result = await api<VerificationRequestResult>(`/api/v1/auth/verify/${channel}/request`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      // The API says which field is empty and when the budget is spent. Both are
      // more useful than anything invented here.
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  // Already verified — most likely because signing in with a code proved the
  // handset. Nothing was sent, so do not open a field asking for one.
  if (result.data.alreadyVerified) {
    await refresh(slug);
    return {
      status: 'verified',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  const minutes = Math.max(1, Math.round(result.data.expiresInSeconds / 60));
  return {
    status: 'sent',
    message: `Code sent. It works once and lasts ${String(minutes)} minutes.`,
  };
}

export async function confirmVerificationCode(
  channel: VerifyChannel,
  slug: string,
  _previous: VerifyFormState,
  formData: FormData
): Promise<VerifyFormState> {
  const parsed = verificationConfirmRequest.safeParse({
    code: String(formData.get('code') ?? '').trim(),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Enter the code exactly as it was sent.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<VerificationResult>(`/api/v1/auth/verify/${channel}/confirm`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  await refresh(slug);
  return {
    status: 'verified',
    message: channel === 'email' ? 'Email address confirmed.' : 'Phone number confirmed.',
  };
}
