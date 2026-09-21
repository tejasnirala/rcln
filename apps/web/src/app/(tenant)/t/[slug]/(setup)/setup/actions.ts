'use server';

import { revalidatePath } from 'next/cache';
import {
  careContextStepRequest,
  identityStepRequest,
  localeStepRequest,
  moduleStepRequest,
  staffStepRequest,
  taxStepRequest,
  type ClinicModule,
  type OnboardingState,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The setup wizard's writes.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * `api()`; it is bound on the server before these reach the browser, so a client
 * cannot re-point one at another clinic. Which organization is being configured
 * is never in a payload — the API takes it from that header.
 *
 * ⚠️ A 'use server' MODULE MAY EXPORT ASYNC FUNCTIONS AND NOTHING ELSE, AND THE
 *   FAILURE IS AT MODULE EVALUATION RATHER THAN AT THE OFFENDING LINE — Next
 *   reports the last export in the file, which is never the one at fault. Types
 *   are erased at compile time so `export type` is fine; a CONSTANT is not, and
 *   the idle form state that used to live here is now `IDLE` in
 *   `onboarding-wizard.tsx`, which is the only thing that ever read it.
 */

export type SetupFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** The wizard state as it now stands, so the rail advances without a refetch. */
  state?: OnboardingState;
  /**
   * Set by `finishSetup` alone, and the wizard navigates to the clinic on it.
   *
   * ⚠️ A FLAG RATHER THAN A `redirect('/')` IN THIS FILE, AND THE REASON IS
   *   `proxy.ts`. A Server Action's redirect is resolved against the ROUTE TREE
   *   and never goes back through the Host rewrite, so `/` matches
   *   `(marketing)/page.tsx` — the owner would finish setting up their clinic
   *   and be handed the public landing page on their own subdomain. An absolute
   *   URL does not help; Next normalises it back to a path. See
   *   `lib/hard-navigate.ts`, which exists for exactly this.
   *
   * ⚠️ AND IT IS NOT `state.completedAt`, WHICH LOOKS LIKE THE SAME FACT AND IS
   *   NOT. That is already set for a clinic re-opening `/setup` to change an
   *   answer — navigating on it would bounce them straight back out of the
   *   screen they deliberately opened. This says "setup was finished JUST NOW,
   *   by this submission".
   */
  finished?: boolean;
};

/**
 * Every step goes through here.
 *
 * ⚠️ ONE HELPER RATHER THAN SEVEN NEAR-IDENTICAL FUNCTIONS, because the only
 *   thing that varies is the path and the parsed body — and seven copies of the
 *   error handling is seven places for one of them to stop reporting a field
 *   error. The steps differ in how they read a FormData, not in what they do
 *   with the result.
 */
async function putStep(
  slug: string,
  path: string,
  body: unknown,
  savedMessage: string
): Promise<SetupFormState> {
  const result = await api<OnboardingState>(`/api/v1/onboarding${path}`, {
    method: path === '/complete' ? 'POST' : 'PUT',
    slug,
    accessToken: await getAccessToken(),
    ...(body !== undefined ? { body } : {}),
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.fieldErrors !== undefined ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  /*
   * The shell reads `setupComplete` and the branch modules off the SESSION, and
   * the session is rebuilt per request — so the layout above has to re-render
   * for a finished wizard to stop redirecting and for the nav to gain its tabs.
   * Revalidating the tenant root is what makes that happen without a hard reload.
   */
  revalidatePath(`/t/${slug}`, 'layout');

  return {
    status: 'saved',
    message: savedMessage,
    ...(result.data !== undefined ? { state: result.data } : {}),
  };
}

function invalid(issues: Parameters<typeof fieldErrorsFrom>[0]): SetupFormState {
  return {
    status: 'error',
    message: 'Check the highlighted fields.',
    fieldErrors: fieldErrorsFrom(issues),
  };
}

export async function saveIdentity(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const parsed = identityStepRequest.safeParse({
    legalName: String(formData.get('legalName') ?? '').trim(),
    displayName: String(formData.get('displayName') ?? '').trim(),
    orgType: String(formData.get('orgType') ?? 'CLINIC'),
    facilityKind: String(formData.get('facilityKind') ?? 'CLINIC'),
    countryCode: String(formData.get('countryCode') ?? '').trim(),
    // Blank is meaningful: it clears the state back to "not set". The contract's
    // transform turns an empty string into null.
    regionCode: String(formData.get('regionCode') ?? '').trim(),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(slug, '/steps/identity', parsed.data, 'Saved.');
}

export async function saveCareContexts(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const branchId = String(formData.get('branchId') ?? '').trim();
  const parsed = careContextStepRequest.safeParse({
    ...(branchId ? { branchId } : {}),
    careContextIds: formData.getAll('careContextIds').map(String),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(slug, '/steps/care-contexts', parsed.data, 'Saved.');
}

export async function saveModules(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const branchId = String(formData.get('branchId') ?? '').trim();
  const parsed = moduleStepRequest.safeParse({
    ...(branchId ? { branchId } : {}),
    modules: formData.getAll('modules').map(String) as ClinicModule[],
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(slug, '/steps/modules', parsed.data, 'Saved.');
}

export async function saveLocale(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const slotMinutes = Number(formData.get('slotMinutes') ?? 15);

  /*
   * The week arrives as seven groups of fields named `open-<n>`, `close-<n>` and
   * `closed-<n>`. A day whose box is ticked is sent with `isClosed` and its
   * times are ignored by the API — but they still have to PARSE, so the closed
   * rows carry their existing values rather than empty strings.
   */
  const operatingHours = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => {
    const opensAt = String(formData.get(`open-${String(day)}`) ?? '');
    const closesAt = String(formData.get(`close-${String(day)}`) ?? '');
    if (!opensAt || !closesAt) return [];
    return [
      {
        dayOfWeek: day,
        opensAt,
        closesAt,
        isClosed: formData.get(`closed-${String(day)}`) === 'on',
        slotMinutes,
      },
    ];
  });

  const parsed = localeStepRequest.safeParse({
    branchId: String(formData.get('branchId') ?? '').trim(),
    timezone: String(formData.get('timezone') ?? '').trim(),
    timeFormat: String(formData.get('timeFormat') ?? '12H'),
    slotMinutes,
    operatingHours,
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(slug, '/steps/locale', parsed.data, 'Saved.');
}

export async function saveTax(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const registrationNumber = String(formData.get('registrationNumber') ?? '').trim();
  const number = (name: string): number | undefined => {
    const raw = String(formData.get(name) ?? '').trim();
    if (raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };

  const parsed = taxStepRequest.safeParse({
    invoicePrefix: String(formData.get('invoicePrefix') ?? '').trim() || undefined,
    defaultTaxPercent: number('defaultTaxPercent'),
    financialYearStartMonth: number('financialYearStartMonth'),
    cashRoundingMinor: number('cashRoundingMinor'),
    /*
     * ⚠️ THE REGISTRATION IS OMITTED ENTIRELY UNLESS A NUMBER WAS TYPED. Sending
     *   a half-filled object would create an `issuer_tax_registrations` row with
     *   a blank GSTIN — the number every invoice this clinic raises would then
     *   print. Not registered yet is a real answer and has to stay one.
     */
    ...(registrationNumber
      ? {
          taxRegistration: {
            countryCode: String(formData.get('countryCode') ?? '').trim(),
            regionCode: String(formData.get('regionCode') ?? '').trim() || null,
            scheme: String(formData.get('scheme') ?? 'GST'),
            registrationNumber,
            legalName: String(formData.get('registrationLegalName') ?? '').trim() || null,
            effectiveFrom: String(formData.get('effectiveFrom') ?? '').trim(),
          },
        }
      : {}),
  });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(slug, '/steps/tax', parsed.data, 'Saved.');
}

export async function saveStaff(
  slug: string,
  _previous: SetupFormState,
  formData: FormData
): Promise<SetupFormState> {
  const emails = formData.getAll('email').map(String);
  const roleIds = formData.getAll('roleId').map(String);
  const branchIds = formData.getAll('branchIds').map(String);

  const invitations = emails.flatMap((email, index) => {
    const trimmed = email.trim();
    if (trimmed === '') return [];
    return [{ email: trimmed, roleId: roleIds[index] ?? '', branchIds }];
  });

  const parsed = staffStepRequest.safeParse({ invitations });
  if (!parsed.success) return invalid(parsed.error.issues);

  return putStep(
    slug,
    '/steps/staff',
    parsed.data,
    invitations.length === 0 ? 'Saved.' : `${String(invitations.length)} invitation(s) sent.`
  );
}

export async function finishSetup(
  slug: string,
  _previous: SetupFormState
): Promise<SetupFormState> {
  const result = await putStep(slug, '/complete', undefined, 'Setup complete.');

  // Only on success: a failed finish must leave the wizard where it is, with
  // its error on screen, rather than navigating away from it.
  return result.status === 'saved' ? { ...result, finished: true } : result;
}
