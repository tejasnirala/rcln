'use server';

import { demoRequestInput } from '@rcln/contracts';

/*
 * Server Actions are reachable by direct POST, not only through the form, so
 * this is a public endpoint in its own right. It does no trusting of its own:
 * the API revalidates everything, rate-limits per IP and owns the write.
 *
 * The call goes server-to-server, which is why it uses API_INTERNAL_URL and not
 * NEXT_PUBLIC_API_URL. The public one points at localhost because the *browser*
 * resolves it; inside the web container localhost is this container. Same
 * string, different machine — it typechecks and fails at runtime.
 */

const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://api:5000';

export type DemoFormState = {
  status: 'idle' | 'booked' | 'error';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function bookDemo(
  _previous: DemoFormState,
  formData: FormData
): Promise<DemoFormState> {
  const raw = Object.fromEntries(
    Array.from(formData.entries()).filter(([, value]) => typeof value === 'string' && value !== '')
  );

  // Validate here too so an obvious mistake is corrected without a round trip.
  // The API does not trust this having happened.
  const parsed = demoRequestInput.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { status: 'error', message: 'Check the highlighted fields.', fieldErrors };
  }

  try {
    const response = await fetch(`${API_URL}/api/v1/public/demo-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
      cache: 'no-store',
    });

    if (response.status === 429) {
      return {
        status: 'error',
        message: 'Too many submissions from this network. Try again in an hour, or email us.',
      };
    }

    if (!response.ok) {
      return {
        status: 'error',
        message: 'We could not record that. Try again, or email hello@rcln.com.',
      };
    }

    return { status: 'booked' };
  } catch {
    // Never surface the underlying network error — it names internal hosts.
    return {
      status: 'error',
      message: 'We could not reach the booking service. Try again, or email hello@rcln.com.',
    };
  }
}
