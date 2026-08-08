'use server';

import { revalidatePath } from 'next/cache';
import {
  createDoctorRequest,
  doctorScheduleRequest,
  updateDoctorRequest,
  type DoctorDetail,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * Doctors and their working hours.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s.
 *
 * These actions are bound to the slug on the server before they reach the
 * browser, so a client cannot re-point one at another clinic.
 */

export type DoctorFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/** Empty strings from an untouched optional input mean "not provided". */
function text(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? '').trim();
  return value === '' ? undefined : value;
}

function number(formData: FormData, key: string): number | undefined {
  const value = text(formData, key);
  return value === undefined ? undefined : Number(value);
}

/**
 * What the picker submitted: one JSON array carrying each row's specialty,
 * primary flag, proficiency and effective dates.
 *
 * ⚠️ ABSENT AND EMPTY ARE DIFFERENT, AND CONFLATING THEM DELETES DATA. On the
 *   edit form the picker is always rendered, so an empty array genuinely means
 *   "this doctor now has none" and must clear the set. A form that does NOT
 *   include the picker must send nothing, so the API leaves the existing
 *   classifications alone — `updateDoctorRequest` distinguishes the two
 *   precisely because omitting a field used to wipe every specialty a doctor had.
 *   `classificationsPresent` is what tells them apart.
 *
 * ⚠️ THE JSON IS NOT TRUSTED. It arrives from the browser, so a malformed body
 *   must produce a validation error rather than a 500 — and the shape is
 *   re-checked by `createDoctorRequest`/`updateDoctorRequest` immediately after,
 *   which is the same Zod schema the API itself enforces. Parsing here only
 *   turns a string into something those schemas can look at.
 */
type PickedClassification = {
  specialtyId: string;
  isPrimary?: boolean;
  proficiency?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

function classificationsFrom(
  formData: FormData
): { entries: PickedClassification[]; primaryId: string | undefined } | undefined {
  if (!formData.has('classificationsPresent')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get('classifications') ?? '[]'));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return { entries: [], primaryId: undefined };

  const entries = parsed
    .filter((e): e is PickedClassification => {
      if (typeof e !== 'object' || e === null) return false;
      return typeof (e as { specialtyId?: unknown }).specialtyId === 'string';
    })
    .map((e) => ({
      specialtyId: e.specialtyId,
      isPrimary: e.isPrimary === true,
      // Empty strings from a cleared date input mean "not recorded", and the
      // contract's calendarDate regex would reject them.
      ...(e.proficiency ? { proficiency: e.proficiency } : {}),
      ...(e.effectiveFrom ? { effectiveFrom: e.effectiveFrom } : {}),
      ...(e.effectiveTo ? { effectiveTo: e.effectiveTo } : {}),
    }));

  return {
    entries,
    primaryId: entries.find((e) => e.isPrimary)?.specialtyId,
  };
}

export async function createDoctor(
  slug: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const picked = classificationsFrom(formData);

  const parsed = createDoctorRequest.safeParse({
    userId: String(formData.get('userId') ?? ''),
    /*
     * The full set, not just the main one.
     *
     * This used to be `[primarySpecialtyId]` — one specialty at creation, on the
     * reasoning that a multi-select front-loads the least urgent decision. The
     * picker makes choosing three no harder than choosing one, and a cardiologist
     * who is also an electrophysiologist should not have to save the profile and
     * come back to say so.
     *
     * `classifications`, not `specialtyIds`: the picker records proficiency and
     * effective dates too, and the contract refuses both forms at once.
     */
    ...(picked ? { classifications: picked.entries } : {}),
    ...(picked?.primaryId ? { primarySpecialtyId: picked.primaryId } : {}),
    ...(text(formData, 'registrationNumber')
      ? { registrationNumber: text(formData, 'registrationNumber') }
      : {}),
    ...(text(formData, 'registrationCouncil')
      ? { registrationCouncil: text(formData, 'registrationCouncil') }
      : {}),
    ...(number(formData, 'experienceYears') !== undefined
      ? { experienceYears: number(formData, 'experienceYears') }
      : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<DoctorDetail>('/api/v1/doctors', {
    method: 'POST',
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

  revalidatePath(`/t/${slug}/doctors`);
  return { status: 'saved', message: 'Doctor added.' };
}

export async function updateDoctor(
  slug: string,
  doctorId: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const picked = classificationsFrom(formData);

  const parsed = updateDoctorRequest.safeParse({
    // Omitted entirely when the form carried no picker, so the API leaves the
    // existing classifications alone rather than clearing them.
    ...(picked ? { classifications: picked.entries } : {}),
    ...(picked?.primaryId ? { primarySpecialtyId: picked.primaryId } : {}),
    ...(text(formData, 'registrationNumber')
      ? { registrationNumber: text(formData, 'registrationNumber') }
      : {}),
    ...(text(formData, 'registrationCouncil')
      ? { registrationCouncil: text(formData, 'registrationCouncil') }
      : {}),
    ...(number(formData, 'experienceYears') !== undefined
      ? { experienceYears: number(formData, 'experienceYears') }
      : {}),
    ...(text(formData, 'bio') ? { bio: text(formData, 'bio') } : {}),
    ...(text(formData, 'status') ? { status: text(formData, 'status') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<DoctorDetail>(`/api/v1/doctors/${doctorId}`, {
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

  revalidatePath(`/t/${slug}/doctors`);
  return { status: 'saved', message: 'Saved.' };
}

/**
 * Add one block of working hours.
 *
 * The API answers 409 when the block overlaps one this doctor already has at
 * that branch on that day. That message is passed through as-is: it names the
 * clash in the clinic's terms, and the database DETAIL behind it is never
 * exposed.
 */
export async function addSchedule(
  slug: string,
  doctorId: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const parsed = doctorScheduleRequest.safeParse({
    branchId: String(formData.get('branchId') ?? ''),
    dayOfWeek: Number(formData.get('dayOfWeek') ?? -1),
    startTime: String(formData.get('startTime') ?? ''),
    endTime: String(formData.get('endTime') ?? ''),
    validFrom: String(formData.get('validFrom') ?? ''),
    isActive: true,
    ...(number(formData, 'slotMinutes') !== undefined
      ? { slotMinutes: number(formData, 'slotMinutes') }
      : {}),
    ...(number(formData, 'maxPatients') !== undefined
      ? { maxPatients: number(formData, 'maxPatients') }
      : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/doctors/${doctorId}/schedules`, {
    method: 'POST',
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

  revalidatePath(`/t/${slug}/doctors`);
  return { status: 'saved', message: 'Working hours added.' };
}

export async function removeSchedule(
  slug: string,
  doctorId: string,
  scheduleId: string
): Promise<DoctorFormState> {
  const result = await api(`/api/v1/doctors/${doctorId}/schedules/${scheduleId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/doctors`);
  return { status: 'saved', message: 'Working hours removed.' };
}

export async function retireDoctor(slug: string, doctorId: string): Promise<DoctorFormState> {
  const result = await api(`/api/v1/doctors/${doctorId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      ...(result.message !== undefined ? { message: result.message } : {}),
    };
  }

  revalidatePath(`/t/${slug}/doctors`);
  return { status: 'saved', message: 'Doctor retired.' };
}
