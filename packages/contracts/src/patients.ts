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
import { careSubjectType } from './clinical.js';
import { isValidNationalId, nationalIdFormatFor } from './locale.js';

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
  /*
   * ⚠️ `.trim()` COMES BEFORE `.min(1)`, AND THE ORDER IS THE CHECK. Zod runs
   *   checks in declaration order and a transform does not re-run the ones
   *   before it, so `z.string().min(1).max(100).trim()` accepts `"   "` and
   *   hands back `""` — a required field satisfied by whitespace. Verified
   *   against the pinned zod: `.min(1).max(64).trim().safeParse('   ')` is
   *   `{ success: true, data: '' }`.
   *
   *   Every `.trim()` in this file is ordered this way for that reason (PI-11
   *   review). It is not a style preference and it is not safe to "tidy" back.
   */
  firstName: z.string().trim().min(1).max(100),
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
   *
   * ⚠️ THE VALUE IS STILL NOT VALIDATED HERE, and the original reasoning is
   *   unchanged: a country-specific regex on this field alone would reject a
   *   foreign patient's passport, and the desk would work around it by leaving
   *   the field blank — which loses the identity check entirely.
   *
   *   What changed is that the desk can now SAY which document it is, in
   *   `nationalIdType`. The format check moved onto that pairing (see the
   *   refinement below), so it applies only when somebody chose a type that has
   *   a known shape — and `PASSPORT` and `OTHER` are offered in every country
   *   precisely so there is always a way through.
   *
   * Stored normalised: no spaces, no hyphens, upper-cased.
   */
  nationalId: z.string().max(64).trim().optional(),
  /**
   * Which document `nationalId` is — `AADHAAR`, `PAN`, `NHS_NUMBER`, `PASSPORT`.
   * The vocabulary is per country and lives in `locale.ts`; see the column
   * comment for why this is not an enum.
   */
  nationalIdType: z.string().max(32).trim().toUpperCase().optional(),
  maritalStatus: maritalStatus.default('UNKNOWN'),
};

/**
 * Whether the record is a person or an animal (PI-11).
 *
 * ⚠️ ON THE CREATE CONTRACT ONLY, AND DELIBERATELY ABSENT FROM THE UPDATE ONE.
 *   A patient does not change species. What `subject_type` actually governs is
 *   which care-context ROOT the consultation engine resolves — so flipping it on
 *   a record that already has encounters against it would leave a chart written
 *   under one taxonomy being read under another, and would orphan the
 *   `animal_profiles` row without deleting it. A record registered as the wrong
 *   kind is a merge, not an edit.
 *
 * Defaults to HUMAN, so every existing caller is unchanged.
 */
const subjectTypeField = { subjectType: careSubjectType.default('HUMAN') };

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

/**
 * The ID, against the type the desk chose.
 *
 * ⚠️ ADVISORY BY DESIGN, AND LENIENT WHEN IT CANNOT BE SURE. The country comes
 *   from the address, which is optional — so a patient registered with no
 *   address gets no format check at all. That is deliberate: the alternative is
 *   guessing a country from the branch and rejecting a document on the strength
 *   of a guess, and this field's whole history is that a rejection makes the
 *   desk leave it blank. `isValidNationalId` is lenient for an unknown country
 *   and for any type without a pattern.
 *
 * A type with no value is refused, because it says nothing and reads on screen
 * as though a document was recorded.
 */
function refineNationalId(
  v: {
    nationalId?: string | undefined;
    nationalIdType?: string | undefined;
    address?: { countryCode?: string | undefined } | undefined;
  },
  ctx: z.RefinementCtx
): void {
  if (v.nationalIdType !== undefined && (v.nationalId ?? '').trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['nationalId'],
      message: 'enter the number, or clear the ID type',
    });
    return;
  }

  if (!isValidNationalId(v.address?.countryCode, v.nationalIdType, v.nationalId)) {
    const format = nationalIdFormatFor(v.address?.countryCode, v.nationalIdType);
    ctx.addIssue({
      code: 'custom',
      path: ['nationalId'],
      message: format
        ? `does not look like a ${format.label}, e.g. ${format.example}`
        : 'does not look valid for that ID type',
    });
  }
}

export const patientAddressRequest = z.object({
  addressType: z.enum(['HOME', 'WORK', 'OTHER']).default('HOME'),
  line1: z.string().trim().min(1).max(255),
  line2: z.string().max(255).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  pincode: z.string().max(10).trim().optional(),
  countryCode: z.string().length(2).toUpperCase().default('IN'),
  isPrimary: z.boolean().default(false),
});

/**
 * The relations a front desk picks from, most common first.
 *
 * ⚠️ A SUGGESTION LIST, NOT AN ENUM, AND `relation` STAYS FREE TEXT BELOW.
 *   The original comment is right that a closed set of family relations is a
 *   cultural assumption — "next friend", "sister-in-law", a village elder and a
 *   care-home key worker are all real answers a fixed list would refuse. What
 *   the desk actually needs is not to type "Spouse" four hundred times.
 *
 *   So the UI offers these and keeps a free-text escape, and the CONTRACT
 *   accepts anything. A clinic that needs a relation this list has never heard
 *   of can still record it, which is the property worth keeping.
 */
export const commonContactRelations = [
  'Spouse',
  'Parent',
  'Child',
  'Sibling',
  'Grandparent',
  'Grandchild',
  'Son-in-law',
  'Daughter-in-law',
  'Friend',
  'Neighbour',
  'Guardian',
  'Carer',
  'Employer',
] as const;

/**
 * A weight in kilograms, as a decimal string.
 *
 * ⚠️ A STRING AND NOT A NUMBER, ALL THE WAY DOWN. `animal_profiles.weight_kg` is
 *   `Decimal(8,3)` and a JSON number is a double — 3.2 kg does not survive the
 *   round trip as 3.2, and this is the value a dose is multiplied by. The same
 *   call `decimalString` in `products.ts` makes about a pack size, for a reason
 *   with more at stake.
 *
 * Up to five whole digits and three decimals, matching the column. Zero is
 * refused: an animal that weighs nothing has not been weighed.
 */
const weightKg = z
  .string()
  .trim()
  .regex(/^\d{1,5}(\.\d{1,3})?$/, 'expected a weight in kilograms, e.g. 3.200')
  .refine((value) => Number.parseFloat(value) > 0, 'a weight must be greater than zero');

/**
 * The animal behind an `ANIMAL` patient record (PI-11, ADR-0017).
 *
 * ⚠️ EVERY FIELD IS OPTIONAL, INCLUDING THE SPECIES, AND THAT IS NOT LAZINESS.
 *   A cat arrives at a veterinary clinic already ill and the owner does not know
 *   the breed, has not weighed it, and is not the registered owner. Refusing the
 *   registration until all of that is known is how the animal gets no record at
 *   all — the same argument `patients.date_of_birth` records about a fabricated
 *   1st-January birthday. What is NOT optional is that anything recorded is
 *   recorded honestly, which is what the refinements below enforce.
 */
export const animalProfileRequest = z
  .object({
    /** Free text. A clinic that treats a tortoise must not need a migration. */
    species: z.string().trim().min(1).max(64).optional(),
    breed: z.string().trim().min(1).max(128).optional(),
    weightKg: weightKg.optional(),
    /**
     * The day the animal was put on the scales.
     *
     * ⚠️ REQUIRED WHENEVER A WEIGHT IS GIVEN, and mirrored by the
     *   `animal_profiles_weight_date_needs_weight` CHECK. A weight with no date
     *   is a dosing hazard: a puppy weighed at eight weeks and dosed at eight
     *   months is the error the calculator exists to make visible, and it cannot
     *   see it without this.
     */
    weightRecordedOn: calendarDate
      /*
       * ⚠️ NOT IN THE FUTURE, AND THIS IS A SAFETY CHECK RATHER THAN TIDINESS
       *   (PI-11 review). `2027-03-02` typed for `2026-03-02` makes the
       *   staleness calculation negative, which sits below every threshold — so
       *   the weight would read as fresh forever and the one signal this feature
       *   exists to raise would be switched off for that animal until somebody
       *   re-weighed it.
       *
       *   Compared in UTC against the server's day. A clinic a day ahead of UTC
       *   could in principle be refused its own "today" for a few hours; that is
       *   the safe direction, and the alternative — a branch timezone this
       *   contract does not have — is not available here.
       */
      .refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        'a weigh-in cannot be in the future'
      )
      .optional(),
    /**
     * The owner, as an existing `patient_contacts` row on this same animal.
     *
     * ADR-0017's "the owner is an existing contact". Mutually exclusive with the
     * two free-text fields below, mirroring the
     * `animal_profiles_one_guardian_form` CHECK.
     */
    guardianContactId: uuid.optional(),
    /** The owner as written on a scrap of paper, when no contact row exists. */
    guardianName: z.string().trim().min(1).max(255).optional(),
    guardianPhone: contactPhone.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.weightKg !== undefined && v.weightRecordedOn === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['weightRecordedOn'],
        message: 'say when the animal was weighed — a weight with no date cannot be dosed from',
      });
    }
    if (v.weightRecordedOn !== undefined && v.weightKg === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['weightKg'],
        message: 'enter the weight, or clear the date',
      });
    }
    /*
     * Two spellings of one owner is how a recall notice gets posted to the wrong
     * address. The contact row is the better answer, so the free text is what
     * gives way — but the message says so rather than silently dropping it.
     */
    if (v.guardianContactId !== undefined && (v.guardianName ?? v.guardianPhone) !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['guardianName'],
        message: 'the owner is either a contact on this record or a typed name, not both',
      });
    }
  });

/**
 * An animal profile on a human record, and a human record with none.
 *
 * The first is refused for the reason given on `createPatientRequest`. The
 * second is PERMITTED — an animal registered in a hurry with nothing known about
 * it yet is a real and common state, and the profile is filled in later through
 * `PUT /patients/{patientId}/animal-profile`.
 */
function refineSubject(
  v: { subjectType?: string | undefined; animalProfile?: unknown },
  ctx: z.RefinementCtx
): void {
  if (v.animalProfile !== undefined && v.subjectType !== 'ANIMAL') {
    ctx.addIssue({
      code: 'custom',
      path: ['animalProfile'],
      message: 'only an animal patient has an animal profile',
    });
  }
}

export const patientContactRequest = z.object({
  /** Free text — a closed enum of family relations is a cultural assumption. */
  relation: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
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
    ...subjectTypeField,
    branchId: uuid,
    address: patientAddressRequest.optional(),
    contacts: z.array(patientContactRequest).max(5).default([]),
    /**
     * Species, breed, weight and owner, when the patient is an animal (PI-11).
     *
     * ⚠️ REFUSED ALONGSIDE `subjectType: 'HUMAN'`, in the refinement below. An
     *   animal profile on a human record is not merely untidy: `animal_profiles`
     *   is a LEFT join the dispensing path reads a species out of, and a row
     *   sitting under a human patient would feed a species to a
     *   `SPECIES_RESTRICTION` rule about a person.
     */
    animalProfile: animalProfileRequest.optional(),
  })
  .superRefine(refineAge)
  .superRefine(refineNationalId)
  .superRefine(refineSubject);

/**
 * `branchId` is absent: moving a patient between branches is a registration,
 * not an edit. `status` is absent for the same reason — DECEASED and MERGED
 * each have their own call, because each has a second field that must move with
 * it and a partial update cannot enforce that.
 */
export const updatePatientRequest = z
  .object(patientIdentityFields)
  .partial()
  .superRefine(refineAge)
  /*
   * No `address` on an edit, so the country is always unknown here and the
   * format check is always lenient — see `refineNationalId`. The type/value
   * pairing is still enforced, which is the half that matters on this path.
   */
  .superRefine(refineNationalId);

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
  q: z.string().trim().min(2).max(100).optional(),
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
  allergenText: z.string().trim().min(1).max(255),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).default('MODERATE'),
  reaction: z.string().max(255).trim().optional(),
  notedOn: calendarDate.optional(),
});

export const patientConditionRequest = z
  .object({
    conditionText: z.string().trim().min(1).max(255),
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
    medicineText: z.string().trim().min(1).max(255),
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

/**
 * The animal behind an `ANIMAL` record, as it comes back.
 *
 * ⚠️ THE OWNER IS RESOLVED TO A NAME AND A PHONE WHATEVER FORM IT IS STORED IN.
 *   A screen must not have to know whether this clinic recorded the owner as a
 *   contact row or as free text — it renders `guardianName` and `guardianPhone`
 *   either way, and `guardianContactId` tells it whether there is a contact to
 *   link to. Making the caller branch on that is how one of the two forms ends
 *   up never being rendered.
 */
export const animalProfileDetail = z.object({
  id: uuid,
  species: z.string().nullable(),
  breed: z.string().nullable(),
  /** ⚠️ A decimal STRING. See `weightKg` on the request. */
  weightKg: z.string().nullable(),
  weightRecordedOn: z.string().nullable(),
  /**
   * True when the recorded weight is old enough that it should be checked before
   * anything is dosed from it, or when there is a weight and no date at all.
   *
   * ⚠️ COMPUTED SERVER-SIDE AGAINST THE BRANCH'S DAY, NOT IN THE BROWSER. A
   *   staleness threshold evaluated against the viewer's clock is a different
   *   answer in a different timezone, and this one is safety-relevant.
   */
  weightIsStale: z.boolean(),
  /** Set when the owner is a contact row on this record. Null when typed. */
  guardianContactId: uuid.nullable(),
  guardianName: z.string().nullable(),
  guardianPhone: z.string().nullable(),
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
  /**
   * Person or animal (PI-11). On the SUMMARY as well as the detail, because a
   * list that renders an animal exactly like a person is a list a receptionist
   * reads the wrong row off — and because `gender` and `age` mean something
   * different on each.
   */
  subjectType: careSubjectType,
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
  /** Which document it is. Null on rows written before the type was asked for. */
  nationalIdType: z.string().nullable(),
  maritalStatus: maritalStatus,
  deceasedOn: z.string().nullable(),
  mergedIntoId: uuid.nullable(),
  registrations: z.array(patientRegistrationDetail),
  addresses: z.array(patientAddressDetail),
  contacts: z.array(patientContactDetail),
  /**
   * Present only when `subjectType` is `ANIMAL`, and null even then until
   * somebody fills it in (PI-11).
   *
   * ⚠️ ON THE IDENTITY RESPONSE AND NOT BEHIND `patient.medical_history.read`.
   *   Species, breed and owner are how the front desk identifies the right
   *   animal at a counter — the same job `phone` does for a person — and the
   *   weight is a measurement, not a diagnosis. What IS behind the history
   *   permission is everything on `patientHistoryResponse`, unchanged.
   */
  animalProfile: animalProfileDetail.nullable(),
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
// Weight-based dosing (PI-11)
// ---------------------------------------------------------------------------

/** A dose amount, as a decimal string. See `weightKg` for why it is not a number. */
const doseAmount = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, 'expected an amount, e.g. 15.5')
  .refine((value) => Number.parseFloat(value) > 0, 'an amount must be greater than zero');

/**
 * "How much of this do I give a 3.2 kg cat?"
 *
 * ⚠️ THE WEIGHT IS NOT ON THIS REQUEST, AND ITS ABSENCE IS THE POINT OF THE
 *   ENDPOINT. The server reads it off `animal_profiles`, so the answer is
 *   computed from the weight in the RECORD rather than from a number retyped at
 *   a keyboard — and the response says how old that weight is. A calculator that
 *   accepted a weight would be a calculator anybody could run in their head, and
 *   would lose the one safety property this one has.
 *
 * ⚠️ AND EVERY OTHER NUMBER HERE COMES FROM THE CLINICIAN READING A LABEL. The
 *   platform holds no formulary and originates no mg/kg figure — see the header
 *   of `@rcln/clinical`'s `dosing.ts`. This endpoint multiplies; it does not
 *   recommend.
 */
export const doseCalculationRequest = z
  .object({
    /** How much per kilogram, per single administration. */
    dosePerKg: doseAmount,
    /**
     * What the amounts are in — `mg`, `ml`, `IU`. Echoed back verbatim and never
     * converted: this endpoint does no unit algebra, and a caller that mixes mg
     * and ml across the fields below gets an answer in a unit of their own
     * invention. `@rcln/inventory`'s conversion engine is the place for that, and
     * a dose is not a stock quantity.
     */
    unit: z.string().trim().min(1).max(16),
    /** Omit to ask only for the single dose; the daily total then comes back null. */
    dosesPerDay: z.number().int().min(1).max(24).optional(),
    /** The label's ceiling on one dose, where it states one. */
    maxSingleDose: doseAmount.optional(),
    /** The label's ceiling on a day's total. Requires `dosesPerDay`. */
    maxDailyDose: doseAmount.optional(),
  })
  .superRefine((v, ctx) => {
    /*
     * Mirrors the same refusal in `weightBasedDose`, so the error names a field
     * instead of arriving as a sentence from a package. A stated cap that
     * nothing can evaluate is an error, never a cap quietly ignored.
     */
    if (v.maxDailyDose !== undefined && v.dosesPerDay === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dosesPerDay'],
        message: 'a daily maximum needs the number of doses a day',
      });
    }
  });

export const doseCalculationResponse = z.object({
  /** The weight the answer was computed from, straight off the record. */
  weightKg: z.string(),
  weightRecordedOn: z.string().nullable(),
  /** ⚠️ True means CHECK THE WEIGHT, not "this answer is wrong". */
  weightIsStale: z.boolean(),
  unit: z.string(),
  /** One administration, to three decimal places. */
  singleDose: z.string(),
  /** `singleDose × dosesPerDay`, or null when no frequency was given. */
  dailyDose: z.string().nullable(),
  /**
   * Which stated maximum the answer is sitting on, or null when neither bound.
   *
   * ⚠️ WHEN SET, `singleDose` IS THE CAPPED FIGURE. A screen that renders this as
   *   a footnote beside an uncapped number has shown a dose the label prohibits.
   */
  cappedBy: z.enum(['SINGLE', 'DAILY']).nullable(),
  /** False when the exact value needed more places and was rounded DOWN. */
  exact: z.boolean(),
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
export type AnimalProfileRequest = z.infer<typeof animalProfileRequest>;
export type AnimalProfileDetail = z.infer<typeof animalProfileDetail>;
export type DoseCalculationRequest = z.infer<typeof doseCalculationRequest>;
export type DoseCalculationResponse = z.infer<typeof doseCalculationResponse>;
