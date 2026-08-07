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

export async function createDoctor(
  slug: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const specialtyId = text(formData, 'primarySpecialtyId');

  const parsed = createDoctorRequest.safeParse({
    userId: String(formData.get('userId') ?? ''),
    // The primary specialty is also the whole set at creation. Adding more is a
    // later edit — asking for a multi-select before the profile exists front-loads
    // the least urgent decision.
    specialtyIds: specialtyId ? [specialtyId] : [],
    ...(specialtyId ? { primarySpecialtyId: specialtyId } : {}),
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
  const parsed = updateDoctorRequest.safeParse({
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
