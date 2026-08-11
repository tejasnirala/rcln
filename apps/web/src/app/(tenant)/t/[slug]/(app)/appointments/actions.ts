'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelAppointmentRequest,
  createAppointmentRequest,
  createAppointmentInvoiceRequest,
  createPatientRequest,
  followUpAppointmentRequest,
  recordVitalsRequest,
  temperatureRangeFor,
  temperatureUnitFor,
  toCelsius,
  vitalRangeMessage,
  type AppointmentBilling,
  type AppointmentDetail,
  type AppointmentListResponse,
  type AvailabilityResponse,
  type CreateAppointmentInvoiceRequest,
  type InvoiceDetail,
  type PatientDetail,
  type PatientListResponse,
  type PatientSummary,
  type RecordVitalsRequest,
  type VitalsListResponse,
  type VitalsReading,
  type VitalsRevision,
  type VitalsRevisionsResponse,
  type WorkingDaysResponse,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { countryOf, getAccessToken } from '@/lib/session';

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
  /** Echoed back so the "nobody matched" panel can offer to register them. */
  term?: string;
};

/** The outcome of registering a walk-in from inside the booking panel. */
export type QuickRegisterState = {
  status: 'idle' | 'error' | 'created';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** The record just created, ready to be booked without a second lookup. */
  patient?: PatientSummary;
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

/**
 * The board, for one day or for a span of them.
 *
 * `to` is INCLUSIVE and defaults to `from`, so the day view is this same call
 * with both ends on the same date — the week and month views are a wider bound
 * on one read, not three endpoints that could drift apart.
 */
/**
 * Which days this doctor consults on, so the picker can grey out the rest.
 *
 * ⚠️ A SEPARATE, CHEAPER CALL THAN `loadAvailability`, ON PURPOSE. It answers
 *   yes/no per day for a whole month; asking the slot engine thirty times to
 *   learn the same thing would run the whole availability computation per day.
 *   It also never enumerates a slot, so nothing about who is booked crosses the
 *   wire to draw a calendar.
 */
export async function loadWorkingDays(
  slug: string,
  branchId: string,
  doctorProfileId: string,
  from: string,
  to: string
): Promise<WorkingDaysResponse | null> {
  const query = new URLSearchParams({ branchId, doctorProfileId, from, to });
  const result = await api<WorkingDaysResponse>(
    `/api/v1/appointments/availability/days?${query.toString()}`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data : null;
}

export async function loadDay(
  slug: string,
  branchId: string,
  date: string,
  to?: string,
  doctorProfileId?: string
): Promise<AppointmentListResponse | null> {
  const query = new URLSearchParams({ branchId, date });
  if (to !== undefined && to !== date) query.set('to', to);
  /*
   * ⚠️ FILTERED AT THE API AND NOT IN THE BOARD, WHICH IS THE OPPOSITE OF HOW
   *   THE STATUS FILTER WORKS — and both are right. The day tally is computed
   *   from the rows this call returns, so narrowing to one doctor narrows the
   *   tally with it, and "Dr Rao's day: four arrived, two done" is the honest
   *   answer to the question somebody asked. A STATUS filter must not do that:
   *   the tally is the thing being filtered BY, and a tally that hid every
   *   status but the chosen one could never be clicked off again.
   */
  if (doctorProfileId !== undefined && doctorProfileId !== '') {
    query.set('doctorProfileId', doctorProfileId);
  }

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
 *
 * ⚠️ IT TAKES THE TERM DIRECTLY, NOT A `FormData`, AND THAT IS WHY IT WORKS.
 *   It used to be driven by `useActionState` from a `<form>` nested inside the
 *   booking form — which is invalid HTML, so the parser DROPPED the inner form
 *   and re-parented the field and its button onto the outer one. "Find" then
 *   submitted the booking, never the lookup, and the search silently did
 *   nothing. There is no inner form now; the panel calls this itself.
 */
export async function lookupPatients(slug: string, rawTerm: string): Promise<LookupState> {
  const term = rawTerm.trim() === '' ? undefined : rawTerm.trim();
  if (term === undefined) return EMPTY_LOOKUP;

  const query = new URLSearchParams({ q: term, scope: 'BRANCH', limit: '10' });
  const result = await api<PatientListResponse>(`/api/v1/patients?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 403
          ? 'You do not have access to patient records here.'
          : (result.message ?? 'The search could not be run.'),
      patients: [],
      term,
    };
  }

  return { status: 'done', patients: result.data.patients, term };
}

/**
 * Register the walk-in who is standing at the desk, from inside the booking
 * panel.
 *
 * ⚠️ THE SAME `POST /patients` THE REGISTRATION SCREEN USES, WITH THE SAME
 *   CONTRACT AND THE SAME PERMISSION. This is a shorter FORM, not a lighter
 *   record: the UHID is issued the same way, the org-wide duplicate check still
 *   refuses a second row for someone already here, and the reply is the full
 *   patient. What it saves is the trip to another screen and back, which is the
 *   step where a queue forms and a duplicate gets created.
 *
 * `branchId` is passed rather than bound because the panel already books
 * against one branch and the two must be the same; the API re-checks it is in
 * the caller's scope, so a tampered value buys nothing.
 */
export async function registerAndPick(
  slug: string,
  branchId: string,
  input: {
    firstName: string;
    lastName?: string;
    phone?: string;
    gender?: string;
    approxAgeYears?: number;
    dateOfBirth?: string;
  }
): Promise<QuickRegisterState> {
  const parsed = createPatientRequest.safeParse({
    branchId,
    firstName: input.firstName,
    ...(input.lastName ? { lastName: input.lastName } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.gender ? { gender: input.gender } : {}),
    ...(input.approxAgeYears !== undefined ? { approxAgeYears: input.approxAgeYears } : {}),
    ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<PatientDetail>('/api/v1/patients', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      /*
       * The API's own sentence. A 409 here is the duplicate check having found
       * this person already registered, and "already registered — search for
       * them instead" is more use than anything this layer could invent.
       */
      message: result.message ?? 'The patient could not be registered.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/patients`);
  return { status: 'created', patient: result.data };
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

/**
 * Withdraw a booking that should never have been made.
 *
 * ⚠️ NOT THE SAME BUTTON AS CANCEL, and the interface must not let it look like
 *   one. Cancelling records that a real appointment was called off; this erases
 *   a mis-click. The API refuses anything that is not a FUTURE booking still in
 *   BOOKED, so the button is only offered where it would actually work — but the
 *   API is the check, not the button.
 */
export async function deleteBooking(slug: string, appointmentId: string): Promise<BookingState> {
  const result = await api<null>(`/api/v1/appointments/${appointmentId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    // The API's own sentence: it knows whether the block was the status, the
    // time, or a follow-up hanging off it, and this layer does not.
    return { status: 'error', message: result.message ?? 'The booking could not be deleted.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked' };
}

/**
 * Book the next visit in the same chain.
 *
 * Only the time comes from this form. The patient and the branch are read off
 * the parent by the API and cannot be sent from here — which is what stops a
 * follow-up quietly becoming a booking for somebody else.
 */
export async function bookFollowUp(
  slug: string,
  appointmentId: string,
  _previous: BookingState,
  formData: FormData
): Promise<BookingState> {
  const parsed = followUpAppointmentRequest.safeParse({
    startsAt: String(formData.get('startsAt') ?? ''),
    ...(text(formData, 'doctorProfileId')
      ? { doctorProfileId: text(formData, 'doctorProfileId') }
      : {}),
    ...(text(formData, 'reason') ? { reason: text(formData, 'reason') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Pick a time for the follow-up.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}/follow-up`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return { status: 'error', message: result.message ?? 'The follow-up could not be booked.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  return { status: 'booked', appointmentNumber: result.data.appointmentNumber };
}

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

export type VitalsState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/**
 * Every correction ever made to one reading, with both values.
 *
 * ⚠️ A DIFFERENT ENDPOINT FROM `readRecordHistory`, AND A DIFFERENT SECURITY
 *   DOMAIN. `GET /audit` says who touched a record and deliberately carries no
 *   measurements — it is read through `audit.record.read`, which people with no
 *   clinical access hold. What a blood pressure WAS before somebody corrected it
 *   is clinical content, so it comes from the clinical side, behind
 *   `clinical.vitals.record`, and the read is logged like any other.
 */
export async function loadVitalsRevisions(
  slug: string,
  appointmentId: string,
  vitalsId: string
): Promise<VitalsRevision[] | null> {
  const result = await api<VitalsRevisionsResponse>(
    `/api/v1/appointments/${appointmentId}/vitals/${vitalsId}/revisions`,
    { slug, accessToken: await getAccessToken() }
  );
  return result.ok && result.data ? result.data.revisions : null;
}

/** One visit's readings, oldest first. Null when the caller may not read them. */
export async function loadVitals(
  slug: string,
  appointmentId: string
): Promise<VitalsReading[] | null> {
  const result = await api<VitalsListResponse>(`/api/v1/appointments/${appointmentId}/vitals`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data.vitals : null;
}

/**
 * A number the clinician typed, or undefined if they left the box empty.
 *
 * ⚠️ `Number('')` IS 0, WHICH IS A REAL AND ALARMING BLOOD PRESSURE. An empty
 *   box means "not measured" and must not reach the API as a value at all —
 *   this is the one conversion in the form where being clever produces a
 *   clinical record that is simply false.
 */
function measurement(formData: FormData, key: string): number | undefined {
  const raw = String(formData.get(key) ?? '').trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** `temperatureC` (the contract's field) -> `temperature` (the form's box). */
function forTemperatureBox(errors: Record<string, string[]>): Record<string, string[]> {
  const { temperatureC, ...rest } = errors;
  return temperatureC === undefined ? errors : { ...rest, temperature: temperatureC };
}

/**
 * One set of observations, off the form and into the contract's shape.
 *
 * ⚠️ SHARED BY RECORDING AND BY CORRECTING, AND IT HAS TO BE. The correction
 *   form IS the recording form with values in it, so a second copy of this
 *   conversion is a second set of bounds, a second temperature unit and a second
 *   chance for one of them to disagree with the other. Both callers below send
 *   whatever this produces and nothing else.
 */
async function readingFrom(
  slug: string,
  formData: FormData
): Promise<{ ok: true; body: RecordVitalsRequest } | { ok: false; state: VitalsState }> {
  /*
   * ⚠️ THE UNIT IS RESOLVED HERE, FROM THE SESSION — IT IS NOT SENT BY THE FORM.
   *   A hidden `unit` input would be a field a client could change, and changing
   *   it turns 99.4 into 99.4°C: a temperature no living patient has, stored
   *   without complaint because it is inside the survivability bounds after the
   *   wrong conversion. The clinic's country decides, the same country the
   *   labels were rendered from, and the browser has no say in it.
   */
  const unit = temperatureUnitFor(await countryOf(slug));
  const typedTemperature = measurement(formData, 'temperature');

  /*
   * Range-checked in the unit that was TYPED, before conversion, so the message
   * names numbers the clinician recognises. Converting first would have a nurse
   * who typed 200 told the value must be at most 45.
   */
  if (typedTemperature !== undefined) {
    const range = temperatureRangeFor(unit);
    if (typedTemperature < range.min || typedTemperature > range.max) {
      const message = vitalRangeMessage(range);
      return {
        ok: false,
        state: { status: 'error', message, fieldErrors: { temperature: [message] } },
      };
    }
  }

  const parsed = recordVitalsRequest.safeParse({
    ...(measurement(formData, 'heightCm') !== undefined
      ? { heightCm: measurement(formData, 'heightCm') }
      : {}),
    ...(measurement(formData, 'weightKg') !== undefined
      ? { weightKg: measurement(formData, 'weightKg') }
      : {}),
    /*
     * ⚠️ CONVERTED TO CELSIUS ON THE WAY IN, AND THE API ONLY EVER SEES CELSIUS.
     *   `recordVitalsRequest.temperatureC` means what it says in every country;
     *   this is the one place a Fahrenheit number exists on the server, and it
     *   stops existing on the next line.
     */
    ...(typedTemperature !== undefined ? { temperatureC: toCelsius(typedTemperature, unit) } : {}),
    ...(measurement(formData, 'pulseBpm') !== undefined
      ? { pulseBpm: measurement(formData, 'pulseBpm') }
      : {}),
    ...(measurement(formData, 'respiratoryRateBpm') !== undefined
      ? { respiratoryRateBpm: measurement(formData, 'respiratoryRateBpm') }
      : {}),
    ...(measurement(formData, 'systolicMmHg') !== undefined
      ? { systolicMmHg: measurement(formData, 'systolicMmHg') }
      : {}),
    ...(measurement(formData, 'diastolicMmHg') !== undefined
      ? { diastolicMmHg: measurement(formData, 'diastolicMmHg') }
      : {}),
    ...(measurement(formData, 'spo2Percent') !== undefined
      ? { spo2Percent: measurement(formData, 'spo2Percent') }
      : {}),
    ...(measurement(formData, 'bloodGlucoseMgDl') !== undefined
      ? { bloodGlucoseMgDl: measurement(formData, 'bloodGlucoseMgDl') }
      : {}),
    ...(text(formData, 'notes') ? { notes: text(formData, 'notes') } : {}),
  });

  if (!parsed.success) {
    return {
      ok: false,
      state: {
        status: 'error',
        /*
         * The contract's own message, which says the useful thing: "A blood
         * pressure needs both numbers", "A pulse is between 20 and 300 bpm".
         */
        message: parsed.error.issues[0]?.message ?? 'Check the readings and try again.',
        /*
         * The contract's field is `temperatureC`; the form's box is `temperature`,
         * because what it asks for depends on the country. Re-pointed here so an
         * error the contract raised still lands on the box that caused it —
         * otherwise it is on screen, attached to nothing, and the field it belongs
         * to renders clean.
         */
        fieldErrors: forTemperatureBox(fieldErrorsFrom(parsed.error.issues)),
      },
    };
  }

  return { ok: true, body: parsed.data };
}

/**
 * Record a set of observations.
 *
 * Side effect at the API: this may check the patient in. The board is
 * revalidated for that reason, not only for the reading itself.
 */
export async function saveVitals(
  slug: string,
  appointmentId: string,
  _previous: VitalsState,
  formData: FormData
): Promise<VitalsState> {
  const reading = await readingFrom(slug, formData);
  if (!reading.ok) return reading.state;

  const result = await api<VitalsReading>(`/api/v1/appointments/${appointmentId}/vitals`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: reading.body,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The readings could not be saved.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  return { status: 'saved' };
}

/**
 * Correct a reading that was mistyped.
 *
 * ⚠️ NOT THE SAME ACT AS RECORDING ONE, AND THE INTERFACE MUST NOT LET IT LOOK
 *   LIKE ONE. Recording adds an observation — a repeat blood pressure twenty
 *   minutes later is a second reading, and the first one is why the patient was
 *   sat down. This rewrites a value that was never taken: 1200 typed for 120.
 *   The API records which measurements moved, and who moved them, on the audit
 *   trail; it never records what they were.
 *
 * ⚠️ A PUT, SO IT REPLACES. An empty box means "not measured", exactly as it
 *   does on the recording form — the form arrives populated, so a cleared box is
 *   a deliberate act rather than an omission.
 */
export async function correctVitals(
  slug: string,
  appointmentId: string,
  vitalsId: string,
  _previous: VitalsState,
  formData: FormData
): Promise<VitalsState> {
  const reading = await readingFrom(slug, formData);
  if (!reading.ok) return reading.state;

  const result = await api<VitalsReading>(
    `/api/v1/appointments/${appointmentId}/vitals/${vitalsId}`,
    { method: 'PUT', slug, accessToken: await getAccessToken(), body: reading.body }
  );

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The correction could not be saved.' };
  }

  revalidatePath(`/t/${slug}/appointments`);
  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  return { status: 'saved' };
}

// ---------------------------------------------------------------------------
// Billing the visit
// ---------------------------------------------------------------------------

/**
 * What billing this visit would look like, and what it is already on.
 *
 * ⚠️ BEHIND `billing.invoice.read` AND NOT `appointment.read`, WHICH IS WHY THE
 *   CALLER IS CHECKED BEFORE THIS IS CALLED RATHER THAN AFTER. A doctor who may
 *   open the chart does not thereby learn what the clinic charged for it, so a
 *   403 here is an ordinary answer for a legitimate reader of the page — and
 *   swallowing it into an empty panel would read as "this visit has not been
 *   billed", which is a claim rather than a silence.
 *
 * ⚠️ AND THIS READ WRITES NO `data_access_logs` ROW. It carries ids, a fee and an
 *   invoice state — no name, no line description, nothing clinical. The bill
 *   itself is `GET /v1/invoices/:id`, which does log.
 */
export async function loadAppointmentBilling(
  slug: string,
  appointmentId: string
): Promise<AppointmentBilling | null> {
  const result = await api<AppointmentBilling>(`/api/v1/appointments/${appointmentId}/billing`, {
    slug,
    accessToken: await getAccessToken(),
  });
  return result.ok && result.data ? result.data : null;
}

/**
 * Raise the bill for this visit.
 *
 * ⚠️ THERE ARE NO LINES IN THIS REQUEST, AND THAT IS THE POINT OF THE ENDPOINT.
 *   The line comes from the doctor's rate card at the visit's branch, the
 *   customer block from the patient, and the date of supply from the day the
 *   visit was scheduled for — read in that branch's zone, so a bill raised in
 *   April for a March consultation is taxed as March was. Anything richer than
 *   one consultation line is the invoice editor, which this hands off to.
 *
 * ⚠️ `unitPriceMinor` IS THE ESCAPE HATCH, NOT THE PATH. It exists so a clinic
 *   that never filled in a doctor's fees can still bill from this door, and it
 *   confers nothing `billing.invoice.create` did not already carry through
 *   `POST /v1/invoices`. An unpriced visit refuses rather than billing zero,
 *   because a draft at zero from a rate card nobody filled in is a bill that
 *   looks paid.
 */
export async function raiseAppointmentInvoice(
  slug: string,
  appointmentId: string,
  input: CreateAppointmentInvoiceRequest
): Promise<{ status: 'error'; message: string } | { status: 'done'; invoiceId: string }> {
  const parsed = createAppointmentInvoiceRequest.safeParse(input);

  if (!parsed.success) {
    return { status: 'error', message: 'Check the amount and try again.' };
  }

  const result = await api<InvoiceDetail>(`/api/v1/appointments/${appointmentId}/invoice`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      /*
       * The API's own sentence. The refusals that matter here are a visit
       * already on a live invoice, a cancelled visit, a no-show — which is
       * blocked deliberately, because a missed appointment is not a consultation
       * — and a rate card with no fee in it.
       */
      message: result.message ?? 'The invoice could not be raised.',
    };
  }

  revalidatePath(`/t/${slug}/appointments`);
  revalidatePath(`/t/${slug}/appointments/${appointmentId}`);
  revalidatePath(`/t/${slug}/invoices`);
  return { status: 'done', invoiceId: result.data.id };
}
