'use server';

import { revalidatePath } from 'next/cache';
import {
  createDoctorRequest,
  doctorQualificationRequest,
  doctorScheduleRequest,
  updateDoctorQualificationRequest,
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

/**
 * Both paths the roster and the profile are reachable by.
 *
 * ⚠️ THE DETAIL PAGE IS NOW WHERE EDITING HAPPENS, so every action that changes
 *   a doctor has to revalidate it as well as the list. Revalidating only the
 *   roster meant saving working hours on `/doctors/<id>` left the panel showing
 *   the block that had just been removed, until a hard reload.
 */
function revalidateDoctor(slug: string, doctorId?: string): void {
  revalidatePath(`/t/${slug}/doctors`);
  if (doctorId !== undefined) revalidatePath(`/t/${slug}/doctors/${doctorId}`);
}

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

/**
 * A repeatable section the form submitted as one JSON field.
 *
 * ⚠️ THE JSON IS NOT TRUSTED, for exactly the reasons `classificationsFrom`
 *   spells out above. This turns a string into something Zod can look at and
 *   nothing more — `createDoctorRequest` re-validates the shape immediately
 *   after, with the same schema the API enforces.
 *
 * Absent and empty are the same thing here, unlike classifications: these
 * sections only ever appear on the create form, where there is nothing existing
 * to leave alone.
 */
function rowsFrom(formData: FormData, key: string): unknown[] {
  const raw = formData.get(key);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The fee boxes, in the same major-unit-in/minor-unit-out convention as
 * `saveFees` in the fees actions — a clinic types 400 or 400.50 and the wire
 * carries integers.
 *
 * ⚠️ A BLANK BOX IS OMITTED, NOT SENT AS `null`. On the fee GRID null means
 *   "delete the row at this scope and go back to inheriting", which is a real
 *   instruction. At registration there is nothing to delete, and sending nulls
 *   would write an audit row claiming six prices were cleared on a doctor who
 *   never had any.
 */
function feesFrom(formData: FormData): {
  fees: { feeType: string; amountMinor: number }[];
  bad: string | null;
} {
  const fees: { feeType: string; amountMinor: number }[] = [];

  for (const feeType of formData.getAll('feeType').map(String)) {
    const raw = String(formData.get(`amount.${feeType}`) ?? '').trim();
    if (raw === '') continue;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return { fees: [], bad: `amount.${feeType}` };
    fees.push({ feeType, amountMinor: Math.round(parsed * 100) });
  }

  return { fees, bad: null };
}

export async function createDoctor(
  slug: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const picked = classificationsFrom(formData);

  const { fees, bad } = feesFrom(formData);
  if (bad !== null) {
    return {
      status: 'error',
      message: 'Enter an amount like 400 or 400.50, or leave the box blank.',
      fieldErrors: { [bad]: ['Enter an amount, or leave it blank.'] },
    };
  }

  /*
   * What the clinic pays. Blank means nothing has been agreed, which is a real
   * and common state — see `doctorCompensationDetail`, where null is explicitly
   * not zero. The key is omitted entirely rather than sent as a pair of nulls,
   * so no compensation row is written for a doctor nobody has agreed a figure
   * with.
   */
  const salaryRaw = String(formData.get('salaryAmount') ?? '').trim();
  let compensation: { amountMinor: number; interval: string } | undefined;
  if (salaryRaw !== '') {
    const amount = Number(salaryRaw);
    if (!Number.isFinite(amount) || amount < 0) {
      return {
        status: 'error',
        message: 'Enter an amount like 120000, or leave it blank.',
        fieldErrors: { salaryAmount: ['Enter an amount, or leave it blank.'] },
      };
    }
    compensation = {
      amountMinor: Math.round(amount * 100),
      interval: String(formData.get('salaryInterval') ?? '') || 'MONTHLY',
    };
  }

  const qualifications = rowsFrom(formData, 'qualifications');
  const schedules = rowsFrom(formData, 'schedules');

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
    ...(text(formData, 'registrationValidTill')
      ? { registrationValidTill: text(formData, 'registrationValidTill') }
      : {}),
    ...(text(formData, 'bio') ? { bio: text(formData, 'bio') } : {}),
    /*
     * The rest of the practitioner, in the same submission. Empty sections are
     * omitted rather than sent as `[]` so the API's per-section permission gates
     * do not fire on a form that simply had nothing in that part — a caller
     * without `doctor.compensation.manage` must be able to add a doctor.
     */
    ...(qualifications.length > 0 ? { qualifications } : {}),
    ...(schedules.length > 0 ? { schedules } : {}),
    ...(fees.length > 0 ? { fees } : {}),
    ...(compensation !== undefined ? { compensation } : {}),
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

  revalidateDoctor(slug);
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

  revalidateDoctor(slug, doctorId);
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

  revalidateDoctor(slug, doctorId);
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

  revalidateDoctor(slug, doctorId);
  return { status: 'saved', message: 'Working hours removed.' };
}

/**
 * Attach a degree to a doctor already on the roster.
 *
 * Registration collects these inline, in one body — this is the same act
 * afterwards, when a consultant finishes a fellowship or the clinic finds the
 * certificate it was missing. Same endpoint the create path folds into its
 * transaction, so the two cannot disagree about what a qualification is.
 */
export async function addQualification(
  slug: string,
  doctorId: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const parsed = doctorQualificationRequest.safeParse({
    qualificationId: String(formData.get('qualificationId') ?? ''),
    ...(text(formData, 'institute') ? { institute: text(formData, 'institute') } : {}),
    ...(number(formData, 'yearOfCompletion') !== undefined
      ? { yearOfCompletion: number(formData, 'yearOfCompletion') }
      : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/doctors/${doctorId}/qualifications`, {
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

  revalidateDoctor(slug, doctorId);
  return { status: 'saved', message: 'Qualification added.' };
}

/**
 * Correct a qualification that is already recorded.
 *
 * ⚠️ A CLEARED BOX SENDS `null`, NOT NOTHING. On this endpoint absent means
 *   "leave the column alone" and null means "clear it" — see
 *   `updateDoctorQualificationRequest`. Emptying the institute field has to
 *   reach the API as an instruction, or correcting a record would be able to add
 *   detail and never remove it.
 */
export async function updateQualification(
  slug: string,
  doctorId: string,
  rowId: string,
  _previous: DoctorFormState,
  formData: FormData
): Promise<DoctorFormState> {
  const parsed = updateDoctorQualificationRequest.safeParse({
    qualificationId: String(formData.get('qualificationId') ?? ''),
    institute: text(formData, 'institute') ?? null,
    yearOfCompletion: number(formData, 'yearOfCompletion') ?? null,
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/doctors/${doctorId}/qualifications/${rowId}`, {
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

  revalidateDoctor(slug, doctorId);
  return { status: 'saved', message: 'Qualification updated.' };
}

/** `rowId` is the join row, not the qualification — a doctor can hold the same
 *  degree from two institutes, and the catalogue id would not tell them apart. */
export async function removeQualification(
  slug: string,
  doctorId: string,
  rowId: string
): Promise<DoctorFormState> {
  const result = await api(`/api/v1/doctors/${doctorId}/qualifications/${rowId}`, {
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

  revalidateDoctor(slug, doctorId);
  return { status: 'saved', message: 'Qualification removed.' };
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

  revalidateDoctor(slug, doctorId);
  return { status: 'saved', message: 'Doctor retired.' };
}
