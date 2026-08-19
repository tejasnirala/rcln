'use server';

import { revalidatePath } from 'next/cache';
import {
  animalProfileRequest,
  createPatientRequest,
  doseCalculationRequest,
  patientAllergyRequest,
  patientConditionRequest,
  patientContactRequest,
  patientMedicationRequest,
  updatePatientRequest,
  type DoseCalculationResponse,
  type PatientDetail,
  type PatientDuplicateMatch,
  type PatientDuplicateResponse,
  type PatientListResponse,
  type PatientSummary,
} from '@rcln/contracts';
import { api, fieldErrorsFrom } from '@/lib/api';
import { lookupPostalCode as lookupPostalCodeImpl, type PostalLookup } from '@/lib/postal';
import { getAccessToken } from '@/lib/session';

/*
 * Patients — the first screen in this app that handles PHI.
 *
 * ⚠️ THE SEARCH TERM NEVER BECOMES A URL.
 *   Every other list in this app pages and filters through query parameters,
 *   which is the right pattern and the wrong one here: a patient search term is
 *   somebody's surname, and a query parameter lands in the browser's history,
 *   the referrer header of the next request, and the access log of every proxy
 *   in between. CONVENTIONS states it as a rule; this is the screen it was
 *   written for.
 *
 *   So the search is a server ACTION returning results into component state,
 *   not a navigation. The cost is that the results are not linkable or
 *   refreshable, which is the correct trade — a link to a set of patient
 *   records is precisely the artefact we do not want to exist.
 *
 * `slug` is threaded through every action and turned into the Host header by
 * api(). These actions are bound to the slug on the server before they reach
 * the browser, so a client cannot re-point one at another clinic.
 */

export type PatientFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set when a registration was refused because the person is already here. */
  duplicates?: PatientDuplicateMatch[];
  /** The id of the record just created, so the screen can offer to open it. */
  patientId?: string;
};

export type SearchState = {
  status: 'idle' | 'error' | 'done';
  message?: string;
  patients: PatientSummary[];
  /** Echoed back so the results can say what they are results for. */
  scope: 'BRANCH' | 'ORGANIZATION';
  total: number;
};

/**
 * ⚠️ NOT EXPORTED, AND IT CANNOT BE.
 *
 * Every export from a `'use server'` module must be an async function — Next
 * turns each one into a callable server reference. A plain constant does not
 * survive that: importing it from a Client Component yields `undefined`, and
 * the failure lands wherever the value is first read, not at the import. Here
 * it surfaced as `Cannot read properties of undefined (reading 'length')` in
 * the results list, several frames from the actual mistake.
 *
 * The client's own copy lives in `patient-search.tsx`, which is where
 * `doctor-list.tsx` keeps its `IDLE` for the same reason. The two are kept in
 * step by `SearchState`, which is a TYPE and so erases at compile time — types
 * may cross this boundary, values may not.
 */
const EMPTY_SEARCH: SearchState = {
  status: 'idle',
  patients: [],
  scope: 'BRANCH',
  total: 0,
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

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchPatients(
  slug: string,
  _previous: SearchState,
  formData: FormData
): Promise<SearchState> {
  const term = text(formData, 'q');
  const scope = formData.get('scope') === 'ORGANIZATION' ? 'ORGANIZATION' : 'BRANCH';

  if (term === undefined) {
    return { ...EMPTY_SEARCH, scope };
  }

  /*
   * The term still travels as a query parameter on THIS hop — server container
   * to API container, over the internal network, to an endpoint that hashes it
   * into `data_access_logs` rather than storing it. What it never does is reach
   * the browser's address bar. That is the boundary that matters: the internal
   * hop has no history, no referrer and no third party on it.
   */
  const query = new URLSearchParams({ q: term, scope, limit: '25' });
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
      scope,
      total: 0,
    };
  }

  return {
    status: 'done',
    patients: result.data.patients,
    scope,
    total: result.data.meta.total,
  };
}

/**
 * Ask whether this person is already registered, before creating a record.
 *
 * A POST rather than a GET all the way down: the probe carries a phone number
 * and a date of birth, and neither belongs in a URL.
 */
export async function checkForDuplicates(
  slug: string,
  probe: {
    phone?: string;
    firstName?: string;
    dateOfBirth?: string;
    /**
     * An identity DOCUMENT, and the strongest signal of the four.
     *
     * ⚠️ THE ONLY TWO FIELDS THE DATABASE ACTUALLY ENFORCES. `patients` carries
     *   partial unique indexes on `(organization_id, national_id)` and
     *   `(organization_id, abha_number)`, so a clash on either is not a warning
     *   the desk can work past — the registration WILL be refused. Probing them
     *   before submit is what turns that refusal into "open the record that
     *   already exists" instead of a dead end at the end of a long form.
     */
    nationalId?: string;
    abhaNumber?: string;
  }
): Promise<PatientDuplicateMatch[]> {
  const result = await api<PatientDuplicateResponse>('/api/v1/patients/duplicate-check', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: probe,
  });
  return result.ok && result.data ? result.data.matches : [];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerPatient(
  slug: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const line1 = text(formData, 'line1');
  const contactName = text(formData, 'contactName');

  const isAnimal = text(formData, 'subjectType') === 'ANIMAL';
  const species = text(formData, 'species');
  const breed = text(formData, 'breed');

  const parsed = createPatientRequest.safeParse({
    firstName: String(formData.get('firstName') ?? ''),
    branchId: String(formData.get('branchId') ?? ''),
    subjectType: isAnimal ? 'ANIMAL' : 'HUMAN',
    /*
     * ⚠️ ONLY SENT FOR AN ANIMAL, AND ONLY WHEN SOMETHING WAS TYPED. The
     *   contract refuses an animal profile on a human record — a stray empty
     *   object from a hidden fieldset would turn "the desk registered a person"
     *   into a validation error about a field nobody could see.
     *
     * The WEIGHT is deliberately not on this form. It needs the date it was
     * taken alongside it, and a registration desk with a queue is not where an
     * animal gets put on the scales — that is the animal panel on the chart.
     */
    ...(isAnimal && (species !== undefined || breed !== undefined)
      ? {
          animalProfile: {
            ...(species !== undefined ? { species } : {}),
            ...(breed !== undefined ? { breed } : {}),
          },
        }
      : {}),
    ...(text(formData, 'lastName') ? { lastName: text(formData, 'lastName') } : {}),
    ...(text(formData, 'dateOfBirth') ? { dateOfBirth: text(formData, 'dateOfBirth') } : {}),
    ...(number(formData, 'approxAgeYears') !== undefined
      ? { approxAgeYears: number(formData, 'approxAgeYears') }
      : {}),
    ...(text(formData, 'gender') ? { gender: text(formData, 'gender') } : {}),
    ...(text(formData, 'bloodGroup') ? { bloodGroup: text(formData, 'bloodGroup') } : {}),
    ...(text(formData, 'phone') ? { phone: text(formData, 'phone') } : {}),
    ...(text(formData, 'email') ? { email: text(formData, 'email') } : {}),
    ...(text(formData, 'abhaNumber') ? { abhaNumber: text(formData, 'abhaNumber') } : {}),
    ...(text(formData, 'nationalId') ? { nationalId: text(formData, 'nationalId') } : {}),
    /*
     * Only sent alongside a value. `refineNationalId` refuses a type with an
     * empty number, and an untouched select would otherwise turn "no ID
     * produced" into a validation error on a field nobody filled in.
     */
    ...(text(formData, 'nationalId') && text(formData, 'nationalIdType')
      ? { nationalIdType: text(formData, 'nationalIdType') }
      : {}),
    ...(line1 !== undefined
      ? {
          address: {
            line1,
            ...(text(formData, 'city') ? { city: text(formData, 'city') } : {}),
            ...(text(formData, 'state') ? { state: text(formData, 'state') } : {}),
            ...(text(formData, 'pincode') ? { pincode: text(formData, 'pincode') } : {}),
            /*
             * The branch's country, carried on a hidden input. It decides the
             * postcode format, the ID types offered and the dialling code — and
             * it is what `refineNationalId` validates against, so it has to
             * reach the contract rather than staying a UI-only fact.
             */
            ...(text(formData, 'countryCode')
              ? { countryCode: text(formData, 'countryCode') }
              : {}),
            isPrimary: true,
          },
        }
      : {}),
    /*
     * One contact on the registration form, not a repeater. The desk records
     * the person to ring; a full list of kin is an edit made later, when there
     * is someone to make it who is not holding up a queue.
     */
    contacts:
      contactName !== undefined
        ? [
            {
              name: contactName,
              relation: String(formData.get('contactRelation') ?? 'Family'),
              phone: String(formData.get('contactPhone') ?? ''),
              isEmergency: true,
            },
          ]
        : [],
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
      message: result.message ?? 'The patient could not be registered.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/patients`);
  return {
    status: 'saved',
    patientId: result.data.id,
    message: `Registered as ${result.data.uhid}`,
  };
}

export async function updatePatient(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const parsed = updatePatientRequest.safeParse({
    ...(text(formData, 'firstName') ? { firstName: text(formData, 'firstName') } : {}),
    ...(text(formData, 'lastName') ? { lastName: text(formData, 'lastName') } : {}),
    ...(text(formData, 'dateOfBirth') ? { dateOfBirth: text(formData, 'dateOfBirth') } : {}),
    ...(text(formData, 'gender') ? { gender: text(formData, 'gender') } : {}),
    ...(text(formData, 'bloodGroup') ? { bloodGroup: text(formData, 'bloodGroup') } : {}),
    ...(text(formData, 'phone') ? { phone: text(formData, 'phone') } : {}),
    ...(text(formData, 'email') ? { email: text(formData, 'email') } : {}),
    ...(text(formData, 'maritalStatus') ? { maritalStatus: text(formData, 'maritalStatus') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/patients/${patientId}`, {
    method: 'PATCH',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The record could not be updated.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

/** Register an existing patient at another clinic in the group. One record. */
export async function registerAtBranch(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const result = await api(`/api/v1/patients/${patientId}/registrations`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { branchId: String(formData.get('branchId') ?? '') },
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The patient could not be registered.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

export async function addContact(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const parsed = patientContactRequest.safeParse({
    relation: String(formData.get('relation') ?? ''),
    name: String(formData.get('name') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    isEmergency: checked(formData, 'isEmergency'),
    isGuardian: checked(formData, 'isGuardian'),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/patients/${patientId}/contacts`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The contact could not be added.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

// ---------------------------------------------------------------------------
// Medical history
// ---------------------------------------------------------------------------

export async function addAllergy(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const parsed = patientAllergyRequest.safeParse({
    allergenText: String(formData.get('allergenText') ?? ''),
    allergenType: String(formData.get('allergenType') ?? 'DRUG'),
    severity: String(formData.get('severity') ?? 'MODERATE'),
    ...(text(formData, 'reaction') ? { reaction: text(formData, 'reaction') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/patients/${patientId}/allergies`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The allergy could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

export async function removeAllergy(
  slug: string,
  patientId: string,
  allergyId: string
): Promise<void> {
  await api(`/api/v1/patients/${patientId}/allergies/${allergyId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });
  revalidatePath(`/t/${slug}/patients/${patientId}`);
}

export async function addCondition(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const parsed = patientConditionRequest.safeParse({
    conditionText: String(formData.get('conditionText') ?? ''),
    status: String(formData.get('status') ?? 'ACTIVE'),
    ...(text(formData, 'onsetDate') ? { onsetDate: text(formData, 'onsetDate') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/patients/${patientId}/conditions`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The condition could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

export async function removeCondition(
  slug: string,
  patientId: string,
  conditionId: string
): Promise<void> {
  await api(`/api/v1/patients/${patientId}/conditions/${conditionId}`, {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });
  revalidatePath(`/t/${slug}/patients/${patientId}`);
}

export async function addMedication(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const parsed = patientMedicationRequest.safeParse({
    medicineText: String(formData.get('medicineText') ?? ''),
    ...(text(formData, 'dosage') ? { dosage: text(formData, 'dosage') } : {}),
    ...(text(formData, 'startedOn') ? { startedOn: text(formData, 'startedOn') } : {}),
    isOngoing: true,
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api(`/api/v1/patients/${patientId}/medications`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The medicine could not be recorded.' };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved' };
}

/** Stop a medicine. Its own call, because `isOngoing` and `stoppedOn` move together. */
export async function stopMedication(
  slug: string,
  patientId: string,
  medicationId: string
): Promise<void> {
  await api(`/api/v1/patients/${patientId}/medications/${medicationId}/stop`, {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: {},
  });
  revalidatePath(`/t/${slug}/patients/${patientId}`);
}

/**
 * Postcode -> city and state, for the address on the registration form.
 *
 * The same implementation the clinic signup form uses, wrapped as this module's
 * own Server Action — see `lib/postal.ts`. It runs on the server, so no
 * patient's postcode reaches a third party from the front desk's machine, and
 * `null` (no data for that country, a timeout, a 404) is an ordinary answer that
 * simply leaves the fields to be typed.
 */
// ---------------------------------------------------------------------------
// The animal behind an ANIMAL record (PI-11)
// ---------------------------------------------------------------------------

/**
 * Species, breed, weight and owner.
 *
 * ⚠️ A REPLACE, NOT A PATCH, AND THE FORM HAS TO SEND EVERY FIELD. `PUT` clears
 *   what it is not sent — which is the behaviour that makes clearing a weight
 *   actually clear it, and the reason the panel renders every field as an input
 *   pre-filled from the record rather than as a set of optional additions.
 */
export async function saveAnimalProfile(
  slug: string,
  patientId: string,
  _previous: PatientFormState,
  formData: FormData
): Promise<PatientFormState> {
  const guardianContactId = text(formData, 'guardianContactId');

  const parsed = animalProfileRequest.safeParse({
    ...(text(formData, 'species') ? { species: text(formData, 'species') } : {}),
    ...(text(formData, 'breed') ? { breed: text(formData, 'breed') } : {}),
    ...(text(formData, 'weightKg') ? { weightKg: text(formData, 'weightKg') } : {}),
    ...(text(formData, 'weightRecordedOn')
      ? { weightRecordedOn: text(formData, 'weightRecordedOn') }
      : {}),
    /*
     * The owner is one form or the other, never both — the contract refuses the
     * pair. The select wins when it has a value, so the free-text inputs are not
     * even read: sending both would surface as a field error on a control the
     * person did not touch.
     */
    ...(guardianContactId !== undefined
      ? { guardianContactId }
      : {
          ...(text(formData, 'guardianName')
            ? { guardianName: text(formData, 'guardianName') }
            : {}),
          ...(text(formData, 'guardianPhone')
            ? { guardianPhone: text(formData, 'guardianPhone') }
            : {}),
        }),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<PatientDetail>(`/api/v1/patients/${patientId}/animal-profile`, {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body: parsed.data,
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.message ?? 'The animal details could not be saved.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  revalidatePath(`/t/${slug}/patients/${patientId}`);
  return { status: 'saved', message: 'Animal details saved' };
}

export type DoseState = {
  status: 'idle' | 'error' | 'done';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  dose?: DoseCalculationResponse;
};

/**
 * "How much do I give?"
 *
 * ⚠️ THE ANSWER IS RETURNED INTO COMPONENT STATE AND NEVER INTO A URL, for the
 *   reason the search is an action rather than a navigation — see the header.
 *   A link that reproduces "276 mg for patient 6d1e…" is an artefact we do not
 *   want to exist, and this one would additionally be a therapeutic quantity
 *   attached to an identifiable record.
 *
 * ⚠️ AND THE WEIGHT IS NOT ON THIS FORM. It comes off the record on the server.
 *   A field here would let somebody retype it, and the whole value of the
 *   calculator is that they cannot.
 */
export async function calculateDose(
  slug: string,
  patientId: string,
  _previous: DoseState,
  formData: FormData
): Promise<DoseState> {
  const parsed = doseCalculationRequest.safeParse({
    dosePerKg: String(formData.get('dosePerKg') ?? ''),
    unit: String(formData.get('unit') ?? ''),
    ...(number(formData, 'dosesPerDay') !== undefined
      ? { dosesPerDay: number(formData, 'dosesPerDay') }
      : {}),
    ...(text(formData, 'maxSingleDose') ? { maxSingleDose: text(formData, 'maxSingleDose') } : {}),
    ...(text(formData, 'maxDailyDose') ? { maxDailyDose: text(formData, 'maxDailyDose') } : {}),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<DoseCalculationResponse>(
    `/api/v1/patients/${patientId}/dose-calculations`,
    { method: 'POST', slug, accessToken: await getAccessToken(), body: parsed.data }
  );

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message: result.message ?? 'The dose could not be calculated.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  return { status: 'done', dose: result.data };
}

export async function lookupPostalCode(
  countryCode: string,
  postalCode: string
): Promise<PostalLookup | null> {
  return lookupPostalCodeImpl(countryCode, postalCode);
}
