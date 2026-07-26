'use server';

import { revalidatePath } from 'next/cache';
import {
  updateOrganizationRequest,
  type OrganizationProfile,
  type SettingItem,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The clinic's own details, and the defaults it runs on.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(); it is bound on the server before these reach the browser, so a client
 * cannot re-point one at another clinic. Which organization is being edited is
 * never in a payload — the API takes it from that header.
 *
 * NOTE: a 'use server' module may export async functions and nothing else. Types
 * are erased at compile time so `export type` is fine; a constant is not.
 */

export type SettingsFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function saveOrganization(
  slug: string,
  _previous: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const gstNumber = String(formData.get('gstNumber') ?? '')
    .trim()
    .toUpperCase();

  const parsed = updateOrganizationRequest.safeParse({
    legalName: String(formData.get('legalName') ?? '').trim(),
    displayName: String(formData.get('displayName') ?? '').trim(),
    timezone: String(formData.get('timezone') ?? '').trim(),
    currency: String(formData.get('currency') ?? '').trim(),
    // An empty box is an instruction to clear it. The contract makes this field
    // nullable for exactly that, and null survives the PATCH's absent-key filter.
    gstNumber: gstNumber === '' ? null : gstNumber,
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<OrganizationProfile>('/api/v1/organization', {
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

  revalidatePath(`/t/${slug}/settings`);
  return { status: 'saved', message: 'Clinic details saved.' };
}

/**
 * Set one default for the whole clinic.
 *
 * The submitted value is a string — every form field is — and the shape it has
 * to become is decided by a row in `setting_definitions`, so the data type
 * travels with the form and the parsing happens here. The API checks the result
 * against the same definition and refuses a mismatch, so this is a nicer error
 * rather than the only one.
 */
export async function saveSetting(
  slug: string,
  key: string,
  dataType: SettingItem['dataType'],
  _previous: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const raw = String(formData.get('value') ?? '').trim();
  let value: unknown;

  switch (dataType) {
    case 'BOOL':
      value = raw === 'true';
      break;
    case 'INT':
    case 'DECIMAL': {
      const parsed = Number(raw);
      if (raw === '' || !Number.isFinite(parsed)) {
        return {
          status: 'error',
          message: 'Enter a number.',
          fieldErrors: { value: ['Enter a number.'] },
        };
      }
      value = parsed;
      break;
    }
    case 'JSON':
      try {
        value = JSON.parse(raw);
      } catch {
        return {
          status: 'error',
          // Names what is wrong and what to do, not "invalid input".
          message: 'This needs to be valid JSON — a list looks like [90, 30].',
          fieldErrors: { value: ['This is not valid JSON.'] },
        };
      }
      break;
    case 'STRING':
      value = raw;
      break;
  }

  const result = await api<SettingItem>(
    `/api/v1/organization/settings/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      slug,
      accessToken: await getAccessToken(),
      body: { value },
    }
  );

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/settings`);
  return { status: 'saved', message: 'Saved.' };
}

/** Drop this clinic's value and go back to whatever it was overruling. */
export async function resetSetting(
  slug: string,
  key: string,
  _previous: SettingsFormState
): Promise<SettingsFormState> {
  const result = await api<SettingItem>(
    `/api/v1/organization/settings/${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
      slug,
      accessToken: await getAccessToken(),
    }
  );

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/settings`);
  return { status: 'saved', message: 'Back to the default.' };
}
