/**
 * Patients: identity, branch registration, and the three medical-history lists.
 *
 * ⚠️ EVERY FIELD IN THIS FILE IS PHI. That constrains the contract itself, not
 * just what the service does with it:
 *
 *   - There is no `patientId` query parameter anywhere in here. A patient is
 *     addressed by path segment, never by query string — query strings end up
 *     in access logs, referrer headers and browser history.
 *   - `searchPatientQuery.q` is the ONLY free text that crosses the wire on a
 *     GET, and the route hashes it into `data_access_logs` rather than storing
 *     it. Nothing else about a patient may travel as a query parameter.
 *
 * ⚠️ NO `medicineId` OR `diagnosisId` ON THE HISTORY CONTRACTS.
 *   The §6 ERD has both and the catalogues they point at arrive in Phase 5.
 *   Accepting a uuid today with nothing behind it would validate the shape and
 *   guarantee nothing — see the note on `PatientAllergy` in schema.prisma.
 */
import { z } from 'zod';
import { uuid } from './common.js';

/** `YYYY-MM-DD`, a calendar date in the branch's timezone. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A phone as typed at the front desk, not E.164.
 *
 * Deliberately looser than `common.phone`: staff transcribe what is on a
 * scrap of paper, and refusing "98765 43210" at the counter means the record
 * does not get created at all. The messaging layer normalises before it dials —
 * that is where E.164 actually matters.
 */
const contactPhone = z
  .string()
  .min(6)
  .max(20)
  .regex(/^[+0-9][0-9\s-]*$/, 'digits, spaces and hyphens only');

export const genderValues = ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'] as const;

export const bloodGroupValues = [
  'A_POSITIVE',
  'A_NEGATIVE',
  'B_POSITIVE',
  'B_NEGATIVE',
  'AB_POSITIVE',
  'AB_NEGATIVE',
  'O_POSITIVE',
  'O_NEGATIVE',
  'UNKNOWN',
] as const;

export const maritalStatusValues = [
  'SINGLE',
  'MARRIED',
  'WIDOWED',
  'DIVORCED',
  'SEPARATED',
  'UNKNOWN',
] as const;

export const patientStatusValues = ['ACTIVE', 'INACTIVE', 'DECEASED', 'MERGED'] as const;

export const gender = z.enum(genderValues);
export const bloodGroup = z.enum(bloodGroupValues);
export const maritalStatus = z.enum(maritalStatusValues);

/**
 * India's health account number, in either published form.
 *
 * `12-3456-7890-1234` (14 digits, hyphens optional) or the address form
 * `someone@abdm`. Checked for shape only — the checksum belongs to the ABDM
 * gateway, and a local approximation of it would reject valid numbers.
 */
const abhaNumber = z
  .string()
  .max(32)
  .regex(
    /^(\d{2}-?\d{4}-?\d{4}-?\d{4}|[a-zA-Z0-9._]{3,}@[a-zA-Z]{3,})$/,
    'expected 14 digits or an ABHA address like someone@abdm'
  );

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The fields a person's record is made of, minus the ones the system issues.
 *
 * ⚠️ `uhid` IS ABSENT ON PURPOSE and there is no way to supply one. It is
 * issued from the `UHID` counter at registration. A client-supplied hospital
 * number is a collision waiting for the second front desk to open.
 */
const patientIdentityFields = {
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().max(100).trim().optional(),
  /** Mutually exclusive with `approxAgeYears` — see the refinement below. */
  dateOfBirth: calendarDate.optional(),
  /** For the walk-in who knows they are "about 60" and nothing more precise. */
  approxAgeYears: z.number().int().min(0).max(130).optional(),
  gender: gender.default('UNKNOWN'),
  bloodGroup: bloodGroup.default('UNKNOWN'),
  phone: contactPhone.optional(),
  email: z.email().max(255).toLowerCase().optional(),
  abhaNumber: abhaNumber.optional(),
  /**
   * Aadhaar, passport, driving licence — whatever was produced at the counter.
   * Not validated per-country: a country-specific regex here would reject a
   * foreign patient's passport, and the desk would work around it by leaving
   * the field blank.
   */
  nationalId: z.string().max(64).trim().optional(),
  maritalStatus: maritalStatus.default('UNKNOWN'),
};

/**
 * Two sources for one age is how a paediatric dose gets computed from the stale
 * one. Mirrored by the `patients_age_single_source` CHECK constraint — this
 * copy exists so the error names a field instead of arriving as a 23514.
 */
function refineAge(
  v: { dateOfBirth?: string | undefined; approxAgeYears?: number | undefined },
  ctx: z.RefinementCtx
): void {
  if (v.dateOfBirth !== undefined && v.approxAgeYears !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['approxAgeYears'],
      message: 'give a date of birth or an approximate age, not both',
    });
  }
}

export const patientAddressRequest = z.object({
  addressType: z.enum(['HOME', 'WORK', 'OTHER']).default('HOME'),
  line1: z.string().min(1).max(255).trim(),
  line2: z.string().max(255).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  pincode: z.string().max(10).trim().optional(),
  countryCode: z.string().length(2).toUpperCase().default('IN'),
  isPrimary: z.boolean().default(false),
});

export const patientContactRequest = z.object({
  /** Free text — a closed enum of family relations is a cultural assumption. */
  relation: z.string().min(1).max(64).trim(),
  name: z.string().min(1).max(255).trim(),
  phone: contactPhone,
  email: z.email().max(255).toLowerCase().optional(),
  isEmergency: z.boolean().default(false),
  /** Who may consent on the patient's behalf. Frequently a different person. */
  isGuardian: z.boolean().default(false),
});

/**
 * Register a patient, at a branch, in one call.
 *
 * `branchId` is required and not defaulted: an org-wide admin covers several
 * branches and "whichever one came first" is not a decision this contract gets
 * to make on their behalf. The patient row and the registration row are created
 * in one transaction, so a patient never exists attending nowhere.
 */
export const createPatientRequest = z
  .object({
    ...patientIdentityFields,
    branchId: uuid,
    address: patientAddressRequest.optional(),
    contacts: z.array(patientContactRequest).max(5).default([]),
  })
  .superRefine(refineAge);

/**
 * `branchId` is absent: moving a patient between branches is a registration,
 * not an edit. `status` is absent for the same reason — DECEASED and MERGED
 * each have their own call, because each has a second field that must move with
 * it and a partial update cannot enforce that.
 */
export const updatePatientRequest = z
  .object(patientIdentityFields)
  .partial()
  .superRefine(refineAge);

/** Register an existing patient at a second branch. Issues that branch's MRN. */
export const registerPatientAtBranchRequest = z.object({
  branchId: uuid,
});

/**
 * The front-desk search.
 *
 * ⚠️ `q` IS HASHED INTO `data_access_logs`, NEVER STORED. Two searches for the
 * same surname collide on the hash so the pattern is visible; the surname is
 * not recoverable from the table.
 *
 * `scope` defaults to the caller's own branches. Widening it to the whole
 * organization is legitimate — it is how a duplicate is found before it is
 * created (ADR-0016) — and every widened search is logged as such.
 */
export const searchPatientQuery = z.object({
  q: z.string().min(2).max(100).trim().optional(),
  scope: z.enum(['BRANCH', 'ORGANIZATION']).default('BRANCH'),
  status: z.enum(patientStatusValues).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ---------------------------------------------------------------------------
// Medical history
// ---------------------------------------------------------------------------

export const patientAllergyRequest = z.object({
  allergenType: z.enum(['DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER']).default('DRUG'),
  allergenText: z.string().min(1).max(255).trim(),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).default('MODERATE'),
  reaction: z.string().max(255).trim().optional(),
  notedOn: calendarDate.optional(),
});

export const patientConditionRequest = z
  .object({
    conditionText: z.string().min(1).max(255).trim(),
    status: z.enum(['ACTIVE', 'RESOLVED', 'CHRONIC']).default('ACTIVE'),
    onsetDate: calendarDate.optional(),
    resolvedDate: calendarDate.optional(),
    note: z.string().max(4000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.resolvedDate && v.onsetDate && v.resolvedDate < v.onsetDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolvedDate'],
        message: 'must not be before the onset date',
      });
    }
    /*
     * A chronic condition that has resolved was not chronic. Letting both
     * through produces a problem list that contradicts itself, and the
     * medication list downstream reads `CHRONIC` as "expect these drugs to
     * continue".
     */
    if (v.status === 'CHRONIC' && v.resolvedDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'a condition with a resolved date is RESOLVED, not CHRONIC',
      });
    }
  });

export const patientMedicationRequest = z
  .object({
    medicineText: z.string().min(1).max(255).trim(),
    /** "500mg twice daily after food" — one string, transcribed as written. */
    dosage: z.string().max(255).trim().optional(),
    startedOn: calendarDate.optional(),
    stoppedOn: calendarDate.optional(),
    isOngoing: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.stoppedOn && v.startedOn && v.stoppedOn < v.startedOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['stoppedOn'],
        message: 'must not be before the start date',
      });
    }
    if (v.isOngoing && v.stoppedOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['isOngoing'],
        message: 'a medicine with a stop date is not ongoing',
      });
    }
  });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const patientRegistrationDetail = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  mrn: z.string(),
  registeredAt: z.iso.datetime(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

export const patientAddressDetail = z.object({
  id: uuid,
  addressType: z.enum(['HOME', 'WORK', 'OTHER']),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  countryCode: z.string(),
  isPrimary: z.boolean(),
});

export const patientContactDetail = z.object({
  id: uuid,
  relation: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  isEmergency: z.boolean(),
  isGuardian: z.boolean(),
});

export const patientAllergyDetail = z.object({
  id: uuid,
  allergenType: z.enum(['DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER']),
  allergenText: z.string(),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE']),
  reaction: z.string().nullable(),
  notedOn: z.string().nullable(),
  notedByName: z.string().nullable(),
});

export const patientConditionDetail = z.object({
  id: uuid,
  conditionText: z.string(),
  status: z.enum(['ACTIVE', 'RESOLVED', 'CHRONIC']),
  onsetDate: z.string().nullable(),
  resolvedDate: z.string().nullable(),
  note: z.string().nullable(),
  notedByName: z.string().nullable(),
});

export const patientMedicationDetail = z.object({
  id: uuid,
  medicineText: z.string(),
  dosage: z.string().nullable(),
  startedOn: z.string().nullable(),
  stoppedOn: z.string().nullable(),
  isOngoing: z.boolean(),
  notedByName: z.string().nullable(),
});

/**
 * The list row.
 *
 * ⚠️ NO ADDRESS, NO EMAIL, NO ABHA, NO NATIONAL ID. A list is rendered for
 * whoever can open the screen; a full identity set on every row turns one
 * permission into a bulk export. What is here is what identifies the right
 * person at a counter and nothing more.
 */
export const patientSummary = z.object({
  id: uuid,
  uhid: z.string(),
  fullName: z.string(),
  gender: gender,
  /** Whole years, from `dateOfBirth` if known, else the stated approximation. */
  age: z.number().int().nullable(),
  /** True when `age` came from `approxAgeYears` — the screen says "approx". */
  ageIsApproximate: z.boolean(),
  phone: z.string().nullable(),
  status: z.enum(patientStatusValues),
  /** The MRN at the branch this row was matched through, when there is one. */
  mrn: z.string().nullable(),
  branchId: uuid.nullable(),
  /**
   * True when this patient attends none of the caller's branches. The screen
   * says so rather than presenting another branch's patient as one of its own.
   * See ADR-0016.
   */
  crossBranch: z.boolean(),
});

export const patientDetail = patientSummary.extend({
  firstName: z.string(),
  lastName: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  approxAgeYears: z.number().int().nullable(),
  bloodGroup: bloodGroup,
  email: z.string().nullable(),
  abhaNumber: z.string().nullable(),
  nationalId: z.string().nullable(),
  maritalStatus: maritalStatus,
  deceasedOn: z.string().nullable(),
  mergedIntoId: uuid.nullable(),
  registrations: z.array(patientRegistrationDetail),
  addresses: z.array(patientAddressDetail),
  contacts: z.array(patientContactDetail),
});

/**
 * The three history lists, fetched together.
 *
 * ⚠️ BEHIND `patient.medical_history.read`, WHICH THE RECEPTIONIST DOES NOT
 * HAVE. That is why this is a separate response from `patientDetail` and a
 * separate endpoint: folding it into the detail call would mean either the
 * front desk reads the problem list, or nobody does.
 */
export const patientHistoryResponse = z.object({
  allergies: z.array(patientAllergyDetail),
  conditions: z.array(patientConditionDetail),
  medications: z.array(patientMedicationDetail),
});

export const patientListResponse = z.object({
  patients: z.array(patientSummary),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

/**
 * The duplicate warning shown before a registration is committed.
 *
 * Org-wide by construction, including branches the caller cannot see — that is
 * the entire point (ADR-0016). It returns the minimum needed to recognise a
 * person, and `branchNames` is empty when the match is at a branch out of
 * scope, so the desk learns "this person is already registered somewhere here"
 * without learning where.
 */
export const patientDuplicateMatch = z.object({
  id: uuid,
  uhid: z.string(),
  fullName: z.string(),
  age: z.number().int().nullable(),
  gender: gender,
  phone: z.string().nullable(),
  matchedOn: z.array(z.enum(['PHONE', 'NAME_AND_DOB', 'ABHA', 'NATIONAL_ID'])),
  branchNames: z.array(z.string()),
});

export const patientDuplicateResponse = z.object({
  matches: z.array(patientDuplicateMatch),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Gender = z.infer<typeof gender>;
export type BloodGroup = z.infer<typeof bloodGroup>;
export type MaritalStatus = z.infer<typeof maritalStatus>;

export type CreatePatientRequest = z.infer<typeof createPatientRequest>;
export type UpdatePatientRequest = z.infer<typeof updatePatientRequest>;
export type RegisterPatientAtBranchRequest = z.infer<typeof registerPatientAtBranchRequest>;
export type SearchPatientQuery = z.infer<typeof searchPatientQuery>;
export type PatientAddressRequest = z.infer<typeof patientAddressRequest>;
export type PatientContactRequest = z.infer<typeof patientContactRequest>;
export type PatientAllergyRequest = z.infer<typeof patientAllergyRequest>;
export type PatientConditionRequest = z.infer<typeof patientConditionRequest>;
export type PatientMedicationRequest = z.infer<typeof patientMedicationRequest>;

export type PatientRegistrationDetail = z.infer<typeof patientRegistrationDetail>;
export type PatientAddressDetail = z.infer<typeof patientAddressDetail>;
export type PatientContactDetail = z.infer<typeof patientContactDetail>;
export type PatientAllergyDetail = z.infer<typeof patientAllergyDetail>;
export type PatientConditionDetail = z.infer<typeof patientConditionDetail>;
export type PatientMedicationDetail = z.infer<typeof patientMedicationDetail>;
export type PatientSummary = z.infer<typeof patientSummary>;
export type PatientDetail = z.infer<typeof patientDetail>;
export type PatientHistoryResponse = z.infer<typeof patientHistoryResponse>;
export type PatientListResponse = z.infer<typeof patientListResponse>;
export type PatientDuplicateMatch = z.infer<typeof patientDuplicateMatch>;
export type PatientDuplicateResponse = z.infer<typeof patientDuplicateResponse>;
