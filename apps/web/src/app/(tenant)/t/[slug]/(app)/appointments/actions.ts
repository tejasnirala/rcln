'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelAppointmentRequest,
  createAppointmentRequest,
  type AppointmentDetail,
  type AppointmentListResponse,
  type AvailabilityResponse,
  type PatientListResponse,
  type PatientSummary,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The day board and the booking flow.
 *
 * ⚠️ THE DATE IS A URL PARAMETER AND THE PATIENT SEARCH IS NOT.
 *   A date is nobody's surname, so it navigates: the board is linkable,
 *   refreshable and back-buttonable, which is what a screen the front desk
 *   lives in all day needs. The patient lookup inside the booking panel is a
 *   server ACTION returning results into component state, for exactly the
 *   reason the patients screen states — a search term lands in browser history,
 *   the next referrer, and every proxy log in between.
 *
 * `slug` is bound on the server before these reach the browser, so a client
 * cannot re-point one at another clinic.
 */

export type BookingState = {
  status: 'idle' | 'error' | 'booked';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** The number to read back to the patient, once there is one. */
  appointmentNumber?: string;
};

export type LookupState = {
  status: 'idle' | 'error' | 'done';
  message?: string;
  patients: PatientSummary[];
};

/**
 * ⚠️ NOT EXPORTED, AND IT CANNOT BE. Every export from a `'use server'` module
 *   must be an async function — Next turns each one into a callable server
 *   reference, and a plain constant arrives as `undefined` at the first read
 *   rather than at the import. The client keeps its own copy, exactly as
 *   `patient-search.tsx` does.
 */
const EMPTY_LOOKUP: LookupState = { status: 'idle', patients: [] };

function text(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? '').trim();
  return value === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What is free for one doctor on one day. Never names who holds a taken slot. */
export async function loadAvailability(
  slug: string,
  branchId: string,
  doctorProfileId: string,
  date: string
): Promise<AvailabilityResponse | null> {
  const query = new URLSearchParams({ branchId, doctorProfileId, date });
  const result = await api<AvailabilityResponse>(
    `/api/v1/appointments/availability?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data : null;
}

export async function loadDay(
  slug: string,
  branchId: string,
  date: string
): Promise<AppointmentListResponse | null> {
  const query = new URLSearchParams({ branchId, date });
  const result = await api<AppointmentListResponse>(`/api/v1/appointments?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

/**
 * Find the patient to book.
 *
 * A server action rather than a navigation: the term is somebody's surname. It
 * still travels as a query parameter on the internal hop to the API, which
 * hashes it into `data_access_logs` rather than storing it — that hop has no
 * history, no referrer and no third party on it.
 */
export async function lookupPatients(
  slug: string,
  _previous: LookupState,
  formData: FormData
): Promise<LookupState> {
  const term = text(formData, 'q');
  if (term === undefined) return EMPTY_LOOKUP;

  const query = new URLSearchParams({ q: term, scope: 'BRANCH', limit: '10' });
  const result = await api<PatientListResponse>(`/api/v1/patients?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message: result.message ?? 'The search could not be run.',
      patients: [],
    };
  }

  return { status: 'done', patients: result.data.patients };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function bookAppointment(
  slug: string,
  _previous: BookingState,
  formData: FormData
): Promise<BookingState> {
  const parsed = createAppointmentRequest.safeParse({
    branchId: String(formData.get('branchId') ?? ''),
    patientId: String(formData.get('patientId') ?? ''),
    doctorProfileId: String(formData.get('doctorProfileId') ?? ''),
    startsAt: String(formData.get('startsAt') ?? ''),
    visitType: String(formData.get('visitType') ?? 'NEW'),
    source: 'FRONT_DESK',
    ...(text(formData, 'reason') ? { reason: text(formData, 'reason') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the booking and try again.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<AppointmentDetail>('/api/v1/appointments', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      /*
       * The API's own sentence, verbatim. A 409 here means somebody took the
       * slot between the board being drawn and this click, and "That time is no
       * longer free. Pick another slot." is more use than anything this layer
       * could invent.
       */
      message: result.message ?? 'The appointment could not be booked.',
    };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked', appointmentNumber: result.data.appointmentNumber };
}

/** Confirm, check in, start, complete — one step at a time. */
export async function moveAppointment(
  slug: string,
  appointmentId: string,
  status: 'CONFIRMED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED'
): Promise<BookingState> {
  const result = await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}/status`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { status },
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'That could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked' };
}

export async function cancelBooking(
  slug: string,
  appointmentId: string,
  _previous: BookingState,
  formData: FormData
): Promise<BookingState> {
  const parsed = cancelAppointmentRequest.safeParse({
    reason: String(formData.get('reason') ?? ''),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say why it is being cancelled.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}/cancel`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The booking could not be cancelled.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked' };
}

/** Nobody came. A different fact from a cancellation, and a different button. */
export async function markAbsent(slug: string, appointmentId: string): Promise<BookingState> {
  const result = await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}/no-show`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: {},
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'That could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked' };
}
