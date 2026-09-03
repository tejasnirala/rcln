/**
 * One clinic, described once, used by every example in the documentation.
 *
 * ⚠️ THE POINT IS CORRELATION, NOT TIDINESS. A reader who follows the document
 *   top to bottom should be able to watch ONE story: Ravi Subramanian is
 *   registered at Indiranagar, books an appointment with Dr Meera Krishnan, is
 *   seen in an encounter, leaves with a prescription for the amoxicillin that
 *   the pharmacy dispenses out of a batch the clinic bought from MedSource on a
 *   purchase order — and is billed for it on one invoice. Every one of those
 *   endpoints lives in a different registry file, and the only thing that makes
 *   them the same story is that they all import the SAME id from here.
 *
 * ⚠️ SO NEVER WRITE A LITERAL UUID IN A REGISTRY FILE. `tests/unit/openapi.test.ts`
 *   fails on any UUID in the document that is not declared below. An invented id
 *   is not a small thing: it silently breaks the one property that makes the
 *   examples worth reading, and it is invisible in review because one UUID looks
 *   exactly like another.
 *
 * ⚠️ NOTHING HERE IS REAL AND NOTHING HERE IS PHI. The names are invented, and
 *   they are deliberately NOT drawn from the seed or from any database. Do not
 *   replace them with rows from a real clinic.
 *
 * Dates are fixed, never `new Date()` — a document that changes every time it is
 * built produces a diff on every deploy and tells nobody anything.
 */

/* ───────────────────────────── identifiers ───────────────────────────── */

/** The tenant. Every id below belongs to it. */
export const ORG_ID = 'd4e5f6a7-b8c9-4012-8345-6789abcdef01';

/** Bengaluru, Karnataka. The primary branch and the default for every example. */
export const BRANCH_ID = '8f1b0c4e-2d3a-4b5c-9e7f-1a2b3c4d5e6f';
/** Kochi, Kerala. The SECOND branch, and the one that makes inter-state tax real. */
export const BRANCH_KOCHI_ID = '3c9d5a71-8e42-4f16-b0d3-7a5e9c1f2b84';

/** Dr Meera Krishnan — the signed-in user in every session example. */
export const USER_ID = '2b6a9c14-7d58-4e93-a1f0-3c8b5d2e7a94';
export const MEMBERSHIP_ID = 'c1a7e930-5b64-4d82-9f03-8e2a6b1c4d75';
export const DOCTOR_ID = '7a4c8e21-9d05-4b73-8c16-2f9e0a5d3b68';
/** Lakshmi Menon — the front desk. Reads the chart, never authors it. */
export const RECEPTIONIST_MEMBERSHIP_ID = 'f2b8d641-0c39-4a75-9e82-5d1a7c3b6e09';
/** Suresh Kumar — the dispensing counter. */
export const PHARMACIST_MEMBERSHIP_ID = 'a9e3f570-6b12-4c84-8d95-1e4b8c0d7a63';

/** Ravi Subramanian. The patient the whole document follows. */
export const PATIENT_ID = '6d1e4b82-3f70-4a5c-9d18-2e7b0c9a4f63';
/** Meera Pillai — a SECOND patient, for list examples and duplicate matching. */
export const PATIENT_TWO_ID = 'b93f2c05-8a41-4e6d-97b2-0f5a1d3c8e74';
/**
 * Kaapi — Ravi's dog, and the document's one ANIMAL patient (PI-11).
 *
 * ⚠️ A `patients` ROW LIKE ANY OTHER, WITH `subjectType: 'ANIMAL'`. There is no
 *   parallel model for animals (ADR-0017), and the reference has to show that
 *   rather than describe it: the same UHID series, the same registration, the
 *   same chart.
 */
export const PATIENT_ANIMAL_ID = 'c5e21b74-9a30-4d68-8f52-1b7e0c4a3d96';
/** Ravi, as the OWNER on Kaapi's record — a `patient_contacts` row, per ADR-0017. */
export const ANIMAL_GUARDIAN_CONTACT_ID = '9b4e70c2-6d15-4a83-9e07-2f8c5b1a3d64';
export const ANIMAL_PROFILE_ID = '4d8f2a61-0c93-4b57-8e14-6a2d9f0b7c35';

export const APPOINTMENT_ID = '4e7b1a93-2c58-4f06-b9d4-8a3e5c1f7b20';
export const ENCOUNTER_ID = '9c2f6d18-7a43-4e95-8b01-3d6a2e9f4c57';
export const PRESCRIPTION_ID = '1f8a4c60-3e97-4b25-9d78-6c0b5a2e8d31';

export const PRODUCT_ID = '5b3e9a04-8c71-4d62-9f85-2a7c1e6b3d94';
export const BATCH_ID = '8d1c5f72-4a09-4e37-b628-9c3f0b7a5e14';
export const LOCATION_ID = '2a9f7c34-6d18-4b50-8e73-1c5a9d2f6b87';
export const SUPPLIER_ID = 'e6c0b382-1f47-4a95-8d26-7b3e5a1c9f40';
export const PURCHASE_ORDER_ID = '3f5d8b19-0e64-4c27-9a83-4d1b7e2c6a95';

export const INVOICE_ID = 'c74a2e60-9b38-4f15-8d07-5e2c1a9b3f68';
export const DISPENSE_ID = '0b8e3d57-2f91-4a64-9c38-7d5a0e1b6c92';
export const RECALL_ID = '6e2b9f41-5c07-4d83-a196-0f8c3b7e2a54';

/** A branch closure — Onam at the Kochi branch. */
export const CLOSURE_ID = '5e2f8a90-1c47-4d3b-8f6a-9b0c1d2e3f45';
/** An organization the platform admin switches into. */
export const OTHER_ORG_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

/* ─────────────────────────────── the clock ─────────────────────────────── */

/**
 * ⚠️ ONE DAY, AND EVERY TIME IN THE DOCUMENT SITS ON IT. The appointment is at
 *   09:30 clinic time, the encounter opens at 09:34, the prescription is signed
 *   at 09:52 and the pharmacy dispenses at 10:07 — a reader can put the story in
 *   order from the timestamps alone.
 *
 * Stored and shown in UTC with a `Z`, exactly as the wire carries it. Asia/Kolkata
 * is UTC+5:30, so 09:30 at the clinic is 04:00Z. That offset being visible in the
 * examples is the point: invariant 6 says the wire is UTC and the clinic's zone
 * is a rendering decision.
 */
export const TODAY = '2026-03-17';
export const APPOINTMENT_AT = '2026-03-17T04:00:00.000Z';
export const ENCOUNTER_OPENED_AT = '2026-03-17T04:04:00.000Z';
export const PRESCRIPTION_SIGNED_AT = '2026-03-17T04:22:00.000Z';
export const DISPENSED_AT = '2026-03-17T04:37:00.000Z';
export const INVOICED_AT = '2026-03-17T04:41:00.000Z';
/** When the patient first walked in, well before the day above. */
export const REGISTERED_AT = '2024-11-03T06:12:00.000Z';

/* ──────────────────────────────── the org ──────────────────────────────── */

export const ORGANIZATION = {
  id: ORG_ID,
  name: 'Alpha Clinic',
  slug: 'alpha',
  legalName: 'Alpha Clinic Healthcare Pvt Ltd',
  timezone: 'Asia/Kolkata',
  countryCode: 'IN',
  regionCode: 'KA',
  currency: 'INR',
  status: 'ACTIVE',
} as const;

export const BRANCH = {
  id: BRANCH_ID,
  name: 'Alpha Clinic — Indiranagar',
  code: 'BLR-IND',
  branchType: 'CLINIC',
  status: 'ACTIVE',
  isPrimary: true,
  timezone: 'Asia/Kolkata',
  phone: '+919845012345',
  email: 'indiranagar@alphaclinic.in',
  addressLine1: '221, 100 Feet Road',
  addressLine2: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  countryCode: 'IN',
  regionCode: 'KA',
} as const;

export const BRANCH_KOCHI = {
  ...BRANCH,
  id: BRANCH_KOCHI_ID,
  name: 'Alpha Clinic — Kochi',
  code: 'KOC-MG',
  isPrimary: false,
  phone: '+919847098765',
  email: 'kochi@alphaclinic.in',
  addressLine1: 'MG Road',
  addressLine2: null,
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682035',
  regionCode: 'KL',
} as const;

/** Monday–Friday 09:00–19:00, Saturday to 14:00, closed Sunday. */
export const OPERATING_HOURS = [
  { dayOfWeek: 1, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
  { dayOfWeek: 2, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
  { dayOfWeek: 3, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
  { dayOfWeek: 4, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
  { dayOfWeek: 5, opensAt: '09:00', closesAt: '19:00', isClosed: false, slotMinutes: 15 },
  { dayOfWeek: 6, opensAt: '09:00', closesAt: '14:00', isClosed: false, slotMinutes: 20 },
  { dayOfWeek: 0, opensAt: '00:00', closesAt: '00:00', isClosed: true, slotMinutes: 15 },
] as const;

/* ─────────────────────────────── the people ─────────────────────────────── */

export const USER = {
  id: USER_ID,
  fullName: 'Dr Meera Krishnan',
  email: 'meera@alphaclinic.in',
  phone: '+919845012345',
  isPlatformAdmin: false,
  mfaEnabled: false,
  emailVerified: true,
  phoneVerified: true,
  lastPlatformOrganizationId: null,
} as const;

export const DOCTOR = {
  id: DOCTOR_ID,
  membershipId: MEMBERSHIP_ID,
  fullName: 'Dr Meera Krishnan',
  registrationNumber: 'KMC-58214',
  registrationCouncil: 'Karnataka Medical Council',
  qualification: 'MBBS, MD (General Medicine)',
  experienceYears: 14,
  consultationMinutes: 15,
  status: 'ACTIVE',
} as const;

export const PATIENT = {
  id: PATIENT_ID,
  uhid: 'ALP-000241',
  subjectType: 'HUMAN',
  fullName: 'Ravi Subramanian',
  firstName: 'Ravi',
  lastName: 'Subramanian',
  gender: 'MALE',
  age: 47,
  ageIsApproximate: false,
  dateOfBirth: '1979-02-14',
  approxAgeYears: null,
  bloodGroup: 'O_POSITIVE',
  phone: '+919845067890',
  email: 'ravi.s@example.in',
  abhaNumber: null,
  nationalId: null,
  nationalIdType: null,
  maritalStatus: 'MARRIED',
  status: 'ACTIVE',
  deceasedOn: null,
  mergedIntoId: null,
  mrn: 'IND-1043',
  branchId: BRANCH_ID,
  crossBranch: false,
} as const;

export const PATIENT_TWO = {
  ...PATIENT,
  id: PATIENT_TWO_ID,
  uhid: 'ALP-000318',
  fullName: 'Lakshmi Pillai',
  firstName: 'Lakshmi',
  lastName: 'Pillai',
  gender: 'FEMALE',
  age: 34,
  dateOfBirth: '1992-07-09',
  bloodGroup: 'A_POSITIVE',
  phone: '+919847011223',
  email: 'lakshmi.p@example.in',
  maritalStatus: 'SINGLE',
  mrn: 'IND-1102',
} as const;

/**
 * Kaapi — the one ANIMAL patient in the reference (PI-11).
 *
 * ⚠️ THE HUMAN FIELDS ARE STILL HERE AND STILL MEAN SOMETHING, WHICH IS THE
 *   WHOLE POINT OF ADR-0017. `gender` is the animal's sex, `dateOfBirth` is when
 *   it was born, `phone` is null because a dog does not have one, and the OWNER
 *   is a `patient_contacts` row rather than a column. Nothing here is a parallel
 *   model; it is one `patients` row with `subjectType: 'ANIMAL'` and an
 *   extension row hanging off it.
 */
export const PATIENT_ANIMAL = {
  id: PATIENT_ANIMAL_ID,
  uhid: 'ALP-000402',
  subjectType: 'ANIMAL',
  fullName: 'Kaapi Subramanian',
  firstName: 'Kaapi',
  lastName: 'Subramanian',
  gender: 'MALE',
  age: 3,
  ageIsApproximate: false,
  dateOfBirth: '2023-05-20',
  approxAgeYears: null,
  bloodGroup: 'UNKNOWN',
  phone: null,
  email: null,
  abhaNumber: null,
  nationalId: null,
  nationalIdType: null,
  maritalStatus: 'UNKNOWN',
  status: 'ACTIVE',
  deceasedOn: null,
  mergedIntoId: null,
  mrn: 'IND-1178',
  branchId: BRANCH_ID,
  crossBranch: false,
} as const;

/** Ravi, as the owner on Kaapi's record. The `patient_contacts` row ADR-0017 means. */
export const ANIMAL_GUARDIAN_CONTACT = {
  id: ANIMAL_GUARDIAN_CONTACT_ID,
  relation: 'Owner',
  name: 'Ravi Subramanian',
  phone: '+919845067890',
  email: 'ravi.s@example.in',
  isEmergency: true,
  isGuardian: true,
} as const;

/**
 * ⚠️ `weightKg` IS A STRING AND THE EXAMPLE SAYS SO ON PURPOSE. `Decimal(8,3)`
 *   does not survive a JSON number, and this is the value a dose is multiplied
 *   by — a consumer that writes `weightKg * dosePerKg` against a number in the
 *   reference has been told the wrong thing about the wire.
 *
 * ⚠️ AND IT IS `"18.4"`, NOT `"18.400"`. Every decimal on this platform's wire
 *   goes through `decimalToString`, which preserves every significant digit and
 *   does NOT pad to the column's scale. The computed dose fields DO pad, because
 *   they are reported at a declared precision rather than echoed from a column —
 *   an example showing both padded would be quietly wrong about one of them.
 */
export const ANIMAL_PROFILE = {
  id: ANIMAL_PROFILE_ID,
  species: 'Dog',
  breed: 'Indie',
  weightKg: '18.4',
  weightRecordedOn: '2026-03-02',
  weightIsStale: false,
  guardianContactId: ANIMAL_GUARDIAN_CONTACT_ID,
  guardianName: 'Ravi Subramanian',
  guardianPhone: '+919845067890',
} as const;

/* ────────────────────────── catalogue and stock ────────────────────────── */

export const PRODUCT = {
  id: PRODUCT_ID,
  name: 'Amoxicillin 500mg Capsule',
  code: 'MED-AMOX-500',
  productType: 'MEDICINE',
  hsnCode: '30041020',
  scheduleClass: 'H',
  isPrescriptionRequired: true,
  unitOfMeasure: 'CAPSULE',
  status: 'ACTIVE',
} as const;

export const BATCH = {
  id: BATCH_ID,
  productId: PRODUCT_ID,
  batchNumber: 'AMX24K118',
  expiresOn: '2027-08-31',
  manufacturedOn: '2025-08-01',
  quantityOnHand: 480,
  locationId: LOCATION_ID,
} as const;

/**
 * The barcode on the Amoxicillin carton, and the GS1 DataMatrix printed beside
 * it — the same lot as `BATCH`, expiring on the same day.
 *
 * ⚠️ THE CHECK DIGIT IS REAL. `08901234567890` passes GS1 mod-10, and PI-23's
 *   resolver reports `CHECK_DIGIT_FAILED` on a payload that does not — so an
 *   example built from a plausible-looking made-up number would document a
 *   warning nobody asked for on the reference's own happy path.
 *
 * `890` is India's GS1 prefix, which is the right country for this clinic.
 */
export const PRODUCT_GTIN = '08901234567890';

/** As a reader transmits it: AI 01, AI 17, then the variable-length lot. */
export const SCAN_PAYLOAD = `01${PRODUCT_GTIN}17270831` + `10${BATCH.batchNumber}`;

/** As it is printed underneath, and as somebody types it when the reader dies. */
export const SCAN_PAYLOAD_BRACKETED = `(01)${PRODUCT_GTIN}(17)270831(10)${BATCH.batchNumber}`;

export const SUPPLIER = {
  id: SUPPLIER_ID,
  name: 'MedSource Distributors',
  code: 'SUP-MEDSRC',
  gstin: '29AABCM1234F1Z7',
  phone: '+918041237788',
  email: 'orders@medsource.in',
  status: 'ACTIVE',
} as const;

/* ──────────────────────────────── money ──────────────────────────────── */

/**
 * ⚠️ MINOR UNITS, ALWAYS — `24000` is ₹240.00, never 24000 rupees and never a
 *   float. Invariant: money is never a float anywhere in this system, and an
 *   example that shows `240.00` teaches a client to send the wrong thing.
 */
export const CONSULTATION_FEE_PAISE = 60000;
export const DISPENSE_LINE_PAISE = 24000;
export const INVOICE_TOTAL_PAISE = 84000;
/** 12% GST on medicine, split CGST 6 / SGST 6 because supply is intra-state. */
export const GST_RATE_PERCENT = 12;

export const CURRENCY = 'INR';

/* ─────────────────────────── access control ─────────────────────────── */

/**
 * Roles, titles and the assignments that connect them to people.
 *
 * ⚠️ A ROLE IS NOT A TITLE. `ROLE_*` decides what somebody may do;
 *   `DESIGNATION_*` is the words on their badge and grants nothing. They are
 *   separate columns on a membership and the document never conflates them.
 */
export const ROLE_DOCTOR_ID = 'b5d81f36-2a70-4c94-8e13-7f6c0a2b9d58';
export const ROLE_RECEPTION_ID = '4c9a2e78-1b53-4d06-9f82-3e5b7a1c6d40';
/** A role the clinic cloned for itself — the sanctioned way to widen invariant 7. */
export const ROLE_SENIOR_RECEPTION_ID = '2e8f4b70-9c15-4d63-8a92-1f7c3e5b0a48';

export const DESIGNATION_PHYSICIAN_ID = '9f3c5b81-6e24-4a70-8d13-5b2f7c0a9e46';
export const DESIGNATION_FRONT_DESK_ID = '6b0d3f92-7a48-4e15-8c63-2f9a1b5e7d04';
/** A title this clinic added; rcln ships no Ayurveda designation. */
export const DESIGNATION_AYURVEDA_ID = '3a7e1d54-0b96-4c28-8f41-6d2c9b5a0e73';

/** Dr Meera Krishnan's org-wide DOCTOR assignment. */
export const ROLE_ASSIGNMENT_ID = '7d2e9a54-3f61-4b08-9c75-0a6b1d3e8f92';
/** Lakshmi Menon's RECEPTIONIST assignment, confined to Indiranagar. */
export const RECEPTION_ASSIGNMENT_ID = '5a9e0c37-4b82-4d61-9f05-7c3a8e2b6d19';
export const OVERRIDE_ID = '0d7a4c93-8e26-4b51-9f70-3c5b1a2e6d84';
export const INVITATION_ID = 'a3f7c920-5d18-4b64-9e07-2c8a1f5b3d76';

/** The user behind {@link RECEPTIONIST_MEMBERSHIP_ID}. */
export const RECEPTIONIST_USER_ID = '8c4b1e75-2d90-4f38-a6c1-9e0b7d5a3f24';

export const RECEPTIONIST = {
  id: RECEPTIONIST_USER_ID,
  membershipId: RECEPTIONIST_MEMBERSHIP_ID,
  fullName: 'Lakshmi Menon',
  email: 'lakshmi@alphaclinic.in',
  phone: '+919847011223',
} as const;

/* ───────────────────────────── audit trail ───────────────────────────── */

export const AUDIT_UPDATE_ID = 'd0f4a916-8b23-4e57-9c60-1a8d3f5b7e24';
export const AUDIT_CREATE_ID = '7b1c9e04-3d68-4a12-8f95-2c7e0b4a6d38';
export const AUDIT_SUPPORT_ID = '3e8b5c71-0a49-4d26-9b83-6f2c1e7a5d90';

/**
 * An rcln staff member acting inside the clinic (ADR-0012).
 *
 * Deliberately not one of the clinic's own people: the whole point of
 * `onBehalfOf` is that the clinic can tell our writes from theirs.
 */
export const SUPPORT_USER = {
  id: 'f4a7d208-6c31-4e95-8b72-0d5a3c9e1b46',
  fullName: 'Priya Nair (rcln support)',
} as const;

/* ────────────────────────── practitioners ────────────────────────── */

/** General Medicine, and its parent Medicine — a taxonomy has depth. */
export const SPECIALTY_GENERAL_MEDICINE_ID = 'c8a05e37-4d19-4b62-9f84-2e7b1c6d0a93';
export const SPECIALTY_MEDICINE_ID = '1b7e4d09-8c52-4a36-9d71-6f0a3b5c2e84';
export const SPECIALTY_CARDIOLOGY_ID = '5f2c8b14-7a60-4e93-8d25-0c9b6a1e3f78';
/** A sub-specialty this clinic grafted onto the shipped tree. */
export const SPECIALTY_INTERVENTIONAL_ID = '7c04b8e6-2a51-4f73-9d68-3b0c5e1a7f92';
export const QUALIFICATION_MBBS_ID = '9d4a1c68-3b07-4f52-8e96-7a2d5b0c8e31';
export const QUALIFICATION_MD_ID = '2c6f9b53-0e84-4a17-9b40-8d3c1e7a5f92';
/** The row joining Dr Meera Krishnan to her MD, not the qualification itself. */
export const DOCTOR_QUALIFICATION_ROW_ID = '6a3d0f95-1c78-4e24-8b63-9f5a2c7b1d40';
export const DOCTOR_SCHEDULE_ID = '4b8e2c17-9d63-4a05-8f21-7e6b3c0a5d94';
export const DOCTOR_EXCEPTION_ID = '0f5b7a28-6d14-4c93-8e07-3a9c1b6e2d45';
export const DOCTOR_BRANCH_SETTING_ID = '8e1a4c73-5f92-4d08-b647-2c0d9b3a7e56';
/** The row joining Dr Meera Krishnan to General Medicine, not the specialty itself. */
export const DOCTOR_SPECIALTY_ROW_ID = '3d9f6c02-8b47-4e15-9a83-1c5e7b0d4a26';

/* ─────────────────────────── the visit itself ─────────────────────────── */

export const APPOINTMENT_NUMBER = 'APT-2026-004182';
/** Every visit belongs to an episode; a follow-up chain shares one. */
export const EPISODE_ID = '7e4a0b96-3c58-4d21-8f67-2b9d5c1a0e34';
export const EPISODE_CODE = 'EPI-2026-00913';
export const VITALS_ID = '1c9b6e40-5a37-4f82-9d05-8e3a7c2b4f61';
export const VITALS_REVISION_ID = '5d0f8c23-7b19-4e64-8a37-1c6b9e5a2d70';
/** The follow-up booked out of the same visit. */
export const FOLLOW_UP_APPOINTMENT_ID = '9a6c3e07-4d82-4b15-8f93-0e7b2a5c1d68';
export const FOLLOW_UP_NUMBER = 'APT-2026-004630';
/** The check-in event on the day board. */
export const STATUS_EVENT_ID = '2f7d9b41-6c03-4a58-8e92-5b1a0d7c3e64';
/** A recall the doctor asked for, which a later booking fulfils. */
export const RECOMMENDATION_ID = '8b3f0d67-5a29-4c14-9e78-2d6c1b0a5f43';

/* ─────────────────────────── the consultation ─────────────────────────── */

export const ENCOUNTER_NUMBER = 'ENC-2026-002877';
/** The row joining this consultation to its amoxicillin line. */
export const PRESCRIPTION_ROW_ID = '3b7f0a52-9d46-4c81-8e35-1a2c6b9d4e07';
export const DIAGNOSIS_ROW_ID = '8c5a1e93-0f27-4b64-9d18-6e3b7a2c5f80';
export const SYMPTOM_ROW_ID = '2d9e4b07-6c58-4a13-8f72-5b0a3c9e1d64';
export const TEMPLATE_ID = 'f0a6c384-1e59-4d70-8b26-7c4d9a0b3e15';
export const TEMPLATE_VERSION_ID = '6b2d8f41-3a07-4e95-9c68-0d5b1e7a4c32';
/** A coded clinical term — the vocabulary row, not the encounter row. */
export const CLINICAL_TERM_ID = 'a4e7b019-5c36-4f82-8d40-2b9c6e1a7d53';
/** The amended consultation — a NEW draft citing {@link ENCOUNTER_ID}. */
export const AMENDED_ENCOUNTER_ID = '4f0b7d29-8e63-4a51-9c07-2d5a1b8e6c34';
/** A stored document the consultation attaches. */
export const DOCUMENT_ID = '5c1e8a37-0b94-4d26-9f73-6a2b8c4e1d05';
/** A region on a body chart — where a finding was marked. */
export const VISUAL_REGION_ID = '9e4b2c70-6a15-4f83-8d29-3c7b0e5a1f46';

/* ────────────────────── consultation configuration ────────────────────── */

export const TEMPLATE_DRAFT_VERSION_ID = '2a8c5f60-7b31-4d94-8e26-0c9b4a7e3f18';
/**
 * The `HUMAN` care context — the platform `CARE_CONTEXT` node at the root of the
 * specialty taxonomy, seeded in `seed/data/specialties.ts`.
 */
export const CARE_CONTEXT_ID = 'd3f9b247-8e05-4a61-9c73-5b1d2e8a6c40';
/**
 * Its sibling, `VET`. The other platform care context, and the one Kaapi the dog
 * is treated under — a clinic that names only this one is the pet practice whose
 * front desk is never asked "person or animal?".
 */
export const CARE_CONTEXT_VET_ID = '1f6b3d95-7a20-4e48-8c31-9b5d0a2e7c64';
export const VISUAL_MAP_ID = 'b8025e73-4c19-4f86-9a52-7d3e0b6c1a94';

/* ───────────────────────────── onboarding ─────────────────────────────── */

/**
 * Alpha Clinic's organization-level profile row — the one whose `branch_id` is
 * NULL, recording what the clinic as a whole said it is.
 */
export const CLINIC_PROFILE_ID = '5a7c1e94-3b60-4d28-9f45-2e8b0c6a3d71';

/* ──────────────────────────── the dispensary ──────────────────────────── */

export const DISPENSE_NUMBER = 'DSP-2026-011204';
export const DISPENSE_LINE_ID = 'e2f7a504-8c61-4b39-9d70-3a5c1e8b6f42';
export const DISPENSE_ALLOCATION_ID = '7b0c4e18-2f95-4a63-8d51-6e9a3c0b5d27';
export const DISPENSE_RETURN_ID = 'c5983a26-0d47-4e81-9b32-8f6c1a4e7b90';
export const UNIT_CAPSULE_ID = '4a1f6d80-9b23-4c57-8e64-2d0b7a5c3f19';
export const FULFILMENT_ID = '9d3e5b71-6a08-4f42-8c95-1b7d0e2a6c53';
/** A different brand, same composition — what a substitution supplies instead. */
export const SUBSTITUTE_PRODUCT_ID = '6c2a9e83-5f14-4d70-8b96-1e7c3a0b5d48';

/* ──────────────────────────── regulatory law ──────────────────────────── */

export const JURISDICTION_ID = '3e0a7c95-1d68-4b24-8f37-9c5b2a6e0d81';
/** Karnataka, the region beneath {@link JURISDICTION_ID}. */
export const JURISDICTION_KA_ID = '1a5c8e04-6b27-4d93-8f10-7e2a9c3b5d68';
export const AUTHORITY_ID = 'a70b4d16-8e39-4c85-9a02-5f1d7b3c6e94';
export const RULE_PACK_ID = '5c8e1a73-4b26-4f90-8d65-0a3c9e7b2f18';
export const RULE_ID = 'd41f9b60-7c58-4a37-9e14-2b6a8d0c5e73';
export const REGULATORY_SOURCE_ID = '8f6d2c47-0a15-4e93-b782-3c9e5b1a4d60';

/* ─────────────────────────── catalogue masters ─────────────────────────── */

export const CATEGORY_ID = '6f2b8d05-3a94-4c17-8e60-1d7c5a9b2e43';
export const MANUFACTURER_ID = '0a4e7b31-9d26-4f58-8c73-5b2a6e1d0c94';
export const COMPOSITION_ID = 'e93c6a17-2b48-4d05-9f81-7a0e4b6c3d52';
export const INGREDIENT_ID = '4d8f0c62-5e73-4a91-8b24-6c1a9d3e7b05';
export const STORAGE_PROFILE_ID = '2b5a9e84-7c01-4f36-9d58-0e3b6a1c4d79';
export const UNIT_STRIP_ID = '8c30f4a5-1b67-4e29-9a84-3d5c7b0e2f16';
export const UNIT_CONVERSION_ID = 'f16d8b03-4a52-4c97-8e61-2b9d0c5a7e38';
export const PACKAGING_ID = '7e2c5f90-6d18-4b43-8a07-9c1b3e5d0a62';

/*
 * The CODES the same masters are known by in a spreadsheet.
 *
 * ⚠️ THE IMPORT NAMES THINGS BY CODE, NOT BY ID, so its examples need the other
 *   half of the fixtures that already exist above. These are the same capsule,
 *   the same category and the same manufacturer as `UNIT_CAPSULE_ID`,
 *   `CATEGORY_ID` and `MANUFACTURER_ID` — one clinic described once, which is
 *   what stops the reference telling 448 unrelated stories.
 */
/** The unit `UNIT_CAPSULE_ID` is known by on a catalogue sheet. */
export const UNIT_CAPSULE_CODE = 'CAP';
/** The category `CATEGORY_ID` is known by. */
export const CATEGORY_CODE = 'ANTIBIOTIC';
/** The manufacturer `MANUFACTURER_ID` is known by. */
export const MANUFACTURER_CODE = 'MFR-CIPLA';
/** A second product, so an import example can show more than one row. */
export const SECOND_PRODUCT_CODE = 'MED-PARA-650';
export const IDENTIFIER_ID = '5a9d1c48-0f36-4e72-9b85-4c7a2e6b1d03';

/* ────────────────────────────── inventory ────────────────────────────── */

export const SERIAL_ID = '3c7e0b58-9a24-4d61-8f95-2e6b4a0c7d13';
export const STOCK_TRANSFER_ID = 'a05b8e42-6c37-4915-8d70-1f4c9b2a6e58';
export const TRANSFER_LINE_ID = '9f4a2d76-0b58-4c31-8e69-5a7c3b1e0d24';
export const RESERVATION_ID = '61d3c8a0-7e94-4b25-9f38-0c5a8b2e6d71';
export const REASON_CODE_ID = 'c8e05b39-2a67-4d84-9c15-7b3f6a0e1d52';
export const STOCK_MOVEMENT_ID = '4e91a7c6-3d05-4b78-8f42-6a0c5e2b9d31';
export const STORAGE_AREA_ID = '7a5c0e93-8b14-4f26-9d80-3c6b1a4e7d59';
export const STORAGE_BIN_ID = '0d6b3f81-4a29-4e57-9c04-8b1e5a7d2c63';

/* ─────────────────────────────── procurement ─────────────────────────────── */

export const PURCHASE_ORDER_NUMBER = 'PO-2026-000742';
export const PO_LINE_ID = '2c6e9b40-8a37-4d15-9e72-1b8a0c5d3f64';
export const REQUISITION_ID = 'b47d0f28-3c69-4a51-8e94-6b2a5c1d0e73';
export const GOODS_RECEIPT_ID = '58a2c714-6e03-4b89-9d25-0f7c3a1b6e48';
export const GRN_LINE_ID = 'f39b6d51-0c84-4e27-9a63-5d1b8a2e7c40';
export const PURCHASE_RETURN_ID = '6d0a4e92-7b15-4c68-8f31-2a9c5b3e0d47';
export const SUPPLIER_PRODUCT_ID = '9b5f1c07-3a24-4e60-8d91-5c7b2e0a4f38';
export const SUPPLIER_TAX_ID = '4e8b3a07-1d56-4f92-8c40-7b2e9a6c5d13';
export const PURCHASE_RETURN_LINE_ID = '3f7a0d64-8c25-4e91-9b38-6d0c2a5e7b14';

/* ────────────────────── charging and consumption ────────────────────── */

export const CHARGE_REQUEST_ID = 'ab41e097-5c62-4d38-9e15-3b7a0c4f2d68';
export const CHARGE_POLICY_RULE_ID = '72e5b0d3-9a48-4c16-8f27-1d6c3b5a0e94';
export const PRODUCT_PRICE_ID = 'd6a83f15-4e07-4b92-8c36-0a5b1e7d2c48';
export const CONSUMPTION_TEMPLATE_ID = '1e0d5c86-3b74-4a29-9f51-8c2a6b0e4d37';
export const CONSUMPTION_TEMPLATE_LINE_ID = '95c7b230-8f16-4d54-9a83-2e0b7c1a5f69';
export const CONSUMPTION_RECORD_ID = '4b8a1d67-0c39-4e85-8b74-6f2c5a9e3d10';
export const ENCOUNTER_PROCEDURE_ID = '8f3c6a02-7d51-4b96-9e48-0b5a2c7e1d63';
export const CONSUMPTION_LINE_ID = '0c9e5b74-2a18-4f63-8d05-7b3a1c6e9d42';

/* ─────────────────────────── invoicing and tax ─────────────────────────── */

export const INVOICE_NUMBER = 'INV-2026-0004417';
export const INVOICE_ITEM_ID = 'af2c7b81-0e46-4d95-8a37-5c1b9e0a6d24';
export const CREDIT_NOTE_ID = '3d6e0a95-8b27-4c14-9f83-2b7a5c0e1d46';
export const TAX_REGISTRATION_ID = 'e04b9c37-5a18-4e62-8d70-1a6c4b2e9f53';
export const TAX_RULE_ID = '7f1a3e58-2c60-4b97-9d24-8e5b0a6c3f12';

/* ─────────────────────── recall and traceability ─────────────────────── */

export const RECALL_NUMBER = 'RCL-2026-000017';
export const RECALL_BATCH_ID = 'b1c86e40-3f97-4a25-8d63-0e5a7c2b9f18';

/* ────────────────────── subscription billing (rcln) ────────────────────── */

/** ⚠️ WHAT THE CLINIC PAYS **US** — never what a patient is charged. */
export const PLAN_PRICE_ID = '5b1e7a94-0c38-4d26-8f75-3a9c2b6e0d41';
export const PAYMENT_INTENT_ID = 'c92a4f60-7b15-4e83-9d24-6c0b8a3e5f17';
export const MANDATE_ID = '1d7f5c28-4a09-4b63-8e91-2f6a0c9b7d34';
export const SUBSCRIPTION_INVOICE_ID = '8e0c3b47-2d95-4a18-9f62-5b7a1c0e4d38';

/* ─────────────────────────── online pharmacy (PI-12) ────────────────────── */

/**
 * The same clinic sending the same patient the same medicine, by post.
 *
 * ⚠️ IT REUSES {@link PATIENT_ID}, {@link ENCOUNTER_ID} AND {@link PRODUCT_ID}
 *   DELIBERATELY. The reference tells ONE story end to end — Ravi Subramanian's
 *   amoxicillin, prescribed at his consultation, and here dispatched to his
 *   house instead of handed over the counter — so a reader can follow the same
 *   row from the prescription through the order to the parcel.
 */
export const ONLINE_ORDER_ID = 'c47a0e93-6b25-4f81-9d30-8a1c5e7b2f04';
export const ONLINE_ORDER_LINE_ID = '2f95c108-7d43-4b60-8e19-5a0c3b6e9d72';
export const ONLINE_ORDER_NUMBER = 'ORD-2026-000318';
export const ONLINE_SHIPMENT_ID = '6a3d0b57-1e94-4c28-8f65-9b2c7a0e4d13';
export const PATIENT_ADDRESS_ID = '9e4b2c76-0a38-4d51-8c97-3f1b6a5e0d24';
/** A consignment note, quoted back by the patient on the telephone. */
export const TRACKING_REFERENCE = 'BLR7742199814';

/** Where the parcel goes. ⚠️ PHI in every field but the two jurisdiction codes. */
export const DELIVERY_ADDRESS = {
  recipientName: 'Ravi Subramanian',
  recipientPhone: '+919845067890',
  addressLine1: '42 Laburnum Road',
  addressLine2: 'Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  destinationCountryCode: 'IN',
  destinationRegionCode: 'KA',
  patientAddressId: PATIENT_ADDRESS_ID,
} as const;
