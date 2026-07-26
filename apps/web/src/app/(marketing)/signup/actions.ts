'use server';

import {
  availableSlug,
  registerOrganizationRequest,
  type RegisterOrganizationResponse,
  type SlugAvailabilityResponse,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';

/**
 * Clinic registration.
 *
 * Pre-tenant, so it runs on the apex like the demo form and needs no `slug` on
 * the API call — the organization this creates IS the tenant.
 *
 * A Server Action is a public POST endpoint, not just a form handler. Validating
 * here is a convenience that saves a round trip on an obvious mistake; the API
 * revalidates everything against the same contract and owns the write.
 */

export type SignupFormState = {
  status: 'idle' | 'error' | 'registered';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Where to send the browser once the clinic exists. */
  loginUrl?: string;
  slug?: string;
};

/**
 * Live subdomain availability for the form.
 *
 * Deliberately reports only "taken", never who took it, and stays quiet on a
 * network failure: this check is an assist, and blocking signup because a
 * lookup blipped would be worse than letting the API settle it on submit.
 */
export async function checkSlug(slug: string): Promise<{ available: boolean; message?: string }> {
  const parsed = availableSlug.safeParse(slug);
  if (!parsed.success) {
    return { available: false, message: parsed.error.issues[0]?.message ?? 'Not a valid address.' };
  }

  const result = await api<SlugAvailabilityResponse>(
    `/api/v1/public/organizations/check-slug?slug=${encodeURIComponent(parsed.data)}`
  );

  if (!result.ok || !result.data) {
    if (result.status === 429) {
      return { available: true, message: 'Too many checks — we will confirm when you continue.' };
    }
    return { available: true };
  }

  return result.data.available
    ? { available: true }
    : { available: false, message: 'That address is taken. Try another.' };
}

export async function registerClinic(
  _previous: SignupFormState,
  formData: FormData
): Promise<SignupFormState> {
  const value = (key: string): string => String(formData.get(key) ?? '').trim();
  const optional = (key: string): string | undefined => value(key) || undefined;

  // The contract is nested, the form is flat. Rebuild the shape here rather
  // than teaching the form about the API's structure.
  const candidate = {
    organization: {
      legalName: value('legalName'),
      displayName: value('displayName'),
      slug: value('slug').toLowerCase(),
      orgType: value('orgType') || 'CLINIC',
      ...(optional('gstNumber') ? { gstNumber: value('gstNumber').toUpperCase() } : {}),
    },
    branch: {
      name: value('branchName'),
      code: value('branchCode') || 'MAIN',
      ...(optional('branchPhone') ? { phone: value('branchPhone') } : {}),
      ...(optional('addressLine1') ? { addressLine1: value('addressLine1') } : {}),
      ...(optional('city') ? { city: value('city') } : {}),
      ...(optional('state') ? { state: value('state') } : {}),
      ...(optional('pincode') ? { pincode: value('pincode') } : {}),
    },
    owner: {
      fullName: value('fullName'),
      email: value('email'),
      phone: value('phone'),
      password: value('password'),
    },
    planCode: value('planCode') || 'STARTER',
    acceptedTerms: formData.get('acceptedTerms') === 'on',
  };

  const parsed = registerOrganizationRequest.safeParse(candidate);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<RegisterOrganizationResponse>('/api/v1/public/organizations/register', {
    method: 'POST',
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    if (result.status === 429) {
      return {
        status: 'error',
        message: 'Too many registrations from this network. Try again in an hour, or book a demo.',
      };
    }

    return {
      status: 'error',
      // The API's 409s are written for a person to read — "that subdomain is
      // taken", "an account with that email already exists" — so pass them
      // through rather than replacing them with something vaguer.
      message: result.message ?? 'We could not create the clinic. Try again.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  /**
   * No redirect from here.
   *
   * The clinic lives on its own subdomain and the session cookie is host-only,
   * so this has to be a full cross-origin navigation the browser performs —
   * not a Next router push. The component does it with the url below.
   */
  return {
    status: 'registered',
    loginUrl: result.data.loginUrl,
    slug: result.data.slug,
  };
}
