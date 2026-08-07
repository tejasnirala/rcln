/**
 * Patients: identity, branch registration, address and next of kin.
 *
 * Medical history lives in `patient-history.service.ts` — it sits behind a
 * different permission (`patient.medical_history.read`, which the front desk
 * does not have), and keeping the two apart is what stops a receptionist's
 * patient lookup from dragging a problem list in with it.
 *
 * ⚠️ THIS IS THE FIRST FILE IN THE SYSTEM THAT READS PHI. Three rules, and none
 * of them is enforced by the type system:
 *
 *   1. EVERY READ THAT DISCLOSES A PATIENT CALLS `recordDataAccess`, inside the
 *      transaction that read it. A read whose log can fail independently is a
 *      read with no evidence.
 *   2. NOTHING REACHES `recordAudit` EXCEPT THROUGH `snapshot()` BELOW. The
 *      `REDACTED_KEYS` backstop in audit.service.ts is the second layer; this
 *      allow-list is the first, and it is the one that actually holds.
 *   3. IDS ONLY in logs, in Redis and in a URL. There is no code path here that
 *      puts a name in any of the three.
 *
 * ⚠️ BRANCH SCOPING IS DONE BY THE `patient_registrations` JOIN, NOT BY A
 *   PREDICATE ON `patients`.
 *   `patients` carries no `branch_isolation` policy, deliberately (ADR-0016):
 *   identity is org-wide so that a front desk can find the duplicate head
 *   office already created. What is branch-local is ATTENDANCE, and every list
 *   in this file reaches it through `patient_registrations`, whose RESTRICTIVE
 *   policy makes the filter enforced by Postgres rather than remembered by the
 *   query. That is why the lateral join below is a LEFT join with no branch
 *   predicate written out: RLS has already applied it, and a row that comes
 *   back with a NULL branch is precisely a patient of some other branch.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreatePatientRequest,
  PatientAddressRequest,
  PatientContactRequest,
  PatientDetail,
  PatientDuplicateMatch,
  PatientListResponse,
  PatientSummary,
  RegisterPatientAtBranchRequest,
  SearchPatientQuery,
  UpdatePatientRequest,
} from '@rcln/contracts';
import { AuthorizationError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { resolveSettings } from '../settings/resolver.service.js';

/** Request metadata, carried onto both trails. */
export interface PatientActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl` — it carries the term. */
  route?: string | undefined;
}

const UHID_PREFIX_KEY = 'patient.uhid_prefix';
const MRN_PREFIX_KEY = 'patient.mrn_prefix';
/** Fallbacks when the settings are unset. Both match the seed. */
const DEFAULT_UHID_PREFIX = 'P';
const DEFAULT_MRN_PREFIX = 'MRN';

const PATIENT_SELECT = {
  id: true,
  uhid: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  approxAgeYears: true,
  gender: true,
  bloodGroup: true,
  phone: true,
  email: true,
  abhaNumber: true,
  nationalId: true,
  maritalStatus: true,
  status: true,
  deceasedOn: true,
  mergedIntoId: true,
  registrations: {
    select: {
      id: true,
      branchId: true,
      mrn: true,
      registeredAt: true,
      status: true,
      branch: { select: { name: true } },
    },
    orderBy: { registeredAt: 'asc' },
  },
  addresses: {
    select: {
      id: true,
      addressType: true,
      line1: true,
      line2: true,
      city: true,
      state: true,
      pincode: true,
      countryCode: true,
      isPrimary: true,
    },
    orderBy: { isPrimary: 'desc' },
  },
  contacts: {
    select: {
      id: true,
      relation: true,
      name: true,
      phone: true,
      email: true,
      isEmergency: true,
      isGuardian: true,
    },
    orderBy: { isEmergency: 'desc' },
  },
} as const;

type PatientRow = Prisma.PatientGetPayload<{ select: typeof PATIENT_SELECT }>;

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** `Date | null` -> `YYYY-MM-DD`. The columns are bare dates; read them in UTC. */
function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Age in whole years, from whichever source the record actually has.
 *
 * Computed rather than stored: a stored age is wrong from the day after it is
 * written, and paediatric dosing is the place that error surfaces.
 */
function ageFrom(dateOfBirth: Date | null, approxAgeYears: number | null): number | null {
  if (dateOfBirth === null) return approxAgeYears;
  const now = new Date();
  let years = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    years -= 1;
  }
  return years < 0 ? null : years;
}

function fullNameOf(firstName: string, lastName: string | null): string {
  return lastName === null || lastName === '' ? firstName : `${firstName} ${lastName}`;
}

/**
 * The list row. `mrn`/`branchId` come from the first registration RLS let
 * through — which is to say, one at a branch the caller is scoped to. None
 * visible means this patient attends some other branch.
 */
function toSummary(row: PatientRow): PatientSummary {
  const visible = row.registrations[0] ?? null;
  return {
    id: row.id,
    uhid: row.uhid,
    fullName: fullNameOf(row.firstName, row.lastName),
    gender: row.gender,
    age: ageFrom(row.dateOfBirth, row.approxAgeYears),
    ageIsApproximate: row.dateOfBirth === null && row.approxAgeYears !== null,
    phone: row.phone,
    status: row.status,
    mrn: visible?.mrn ?? null,
    branchId: visible?.branchId ?? null,
    crossBranch: visible === null,
  };
}

function toDetail(row: PatientRow): PatientDetail {
  return {
    ...toSummary(row),
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: isoDate(row.dateOfBirth),
    approxAgeYears: row.approxAgeYears,
    bloodGroup: row.bloodGroup,
    email: row.email,
    abhaNumber: row.abhaNumber,
    nationalId: row.nationalId,
    maritalStatus: row.maritalStatus,
    deceasedOn: isoDate(row.deceasedOn),
    mergedIntoId: row.mergedIntoId,
    registrations: row.registrations.map((r) => ({
      id: r.id,
      branchId: r.branchId,
      branchName: r.branch.name,
      mrn: r.mrn,
      registeredAt: r.registeredAt.toISOString(),
      status: r.status,
    })),
    addresses: row.addresses.map((a) => ({
      id: a.id,
      addressType: a.addressType,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      countryCode: a.countryCode,
      isPrimary: a.isPrimary,
    })),
    contacts: row.contacts.map((c) => ({
      id: c.id,
      relation: c.relation,
      name: c.name,
      phone: c.phone,
      email: c.email,
      isEmergency: c.isEmergency,
      isGuardian: c.isGuardian,
    })),
  };
}

/**
 * ⚠️ THE ALLOW-LIST. THE ONLY THING FROM THIS FILE THAT MAY REACH `audit_logs`.
 *
 * Not a subset of the row chosen for tidiness — every field NOT here is one a
 * compliance reader has no business seeing in a mutation trail. Name, date of
 * birth, phone, email, address, ABHA and the national id are all absent, and
 * `uhid` is present precisely because it is the identifier that lets the trail
 * say WHICH record moved without saying who the person is.
 *
 * The enums are here because "gender was corrected" and "the record was marked
 * deceased" are exactly the changes an audit trail exists to show, and none of
 * the six enums discloses anything on its own.
 *
 * ⚠️ NEVER `{ ...row }`. That is the one edit that silently defeats this, and
 * `REDACTED_KEYS` in audit.service.ts is the backstop for the day someone makes
 * it — a backstop, not a permission.
 */
function snapshot(row: PatientRow): Record<string, unknown> {
  return {
    uhid: row.uhid,
    gender: row.gender,
    bloodGroup: row.bloodGroup,
    maritalStatus: row.maritalStatus,
    status: row.status,
    /*
     * Whether an identifier is recorded, never what it is. "Somebody added an
     * ABHA number to this record" is auditable; the number is not.
     */
    hasDateOfBirth: row.dateOfBirth !== null,
    hasPhone: row.phone !== null,
    hasEmail: row.email !== null,
    hasAbhaNumber: row.abhaNumber !== null,
    hasNationalId: row.nationalId !== null,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse a branch the caller has no scope for, with a message.
 *
 * The `branch_isolation` policy on `patient_registrations` would refuse the
 * INSERT anyway — as a row-level security violation with no field name on it.
 * This turns that into an error the front desk can act on.
 */
function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) {
    throw new AuthorizationError('You do not have access to that clinic.');
  }
}

/**
 * The prefix for a number series, from the settings ladder.
 *
 * `branchId` is passed for the MRN and omitted for the UHID — the MRN series is
 * per branch and may be styled per branch, and a UHID is org-wide with no
 * equivalent choice to make.
 */
async function resolvePrefix(
  tx: TxClient,
  ctx: TenantContext,
  key: string,
  fallback: string,
  branchId?: string
): Promise<string> {
  const settings = await resolveSettings(tx, [key], {
    organizationId: ctx.organizationId,
    ...(branchId !== undefined ? { branchId } : {}),
  });
  const resolved = settings.get(key);
  return typeof resolved === 'string' && resolved !== '' ? resolved : fallback;
}

/**
 * Create the registration row and issue that branch's MRN.
 *
 * ⚠️ `issueNumber` IS CALLED AS LATE AS POSSIBLE — it takes a row lock held
 * until COMMIT, and that lock serialises every concurrent registration at this
 * branch. One statement wide, not the width of the whole registration.
 */
async function createRegistration(
  tx: TxClient,
  ctx: TenantContext,
  patientId: string,
  branchId: string
): Promise<{ id: string; mrn: string }> {
  const prefix = await resolvePrefix(tx, ctx, MRN_PREFIX_KEY, DEFAULT_MRN_PREFIX, branchId);
  const issued = await issueNumber(tx, ctx, { type: 'MRN', branchId, prefix });

  const created = await tx.patientRegistration.create({
    data: {
      organizationId: ctx.organizationId,
      patientId,
      branchId,
      mrn: issued.formatted,
      registeredBy: ctx.userId,
    },
    select: { id: true },
  });

  return { id: created.id, mrn: issued.formatted };
}

/**
 * The registration a booking is made against, creating it if this is the first
 * time this patient has attended this branch.
 *
 * WHY BOOKING REGISTERS RATHER THAN REFUSING
 *   Attending a clinic IS registering at it — that is what
 *   `patient_registrations` means (ADR-0016) — so a front desk that has found
 *   the right person and picked a slot should not be sent away to press a
 *   different button first. The alternative is a dead end that ends in a second
 *   `patients` row being created, which is the exact failure the org-wide
 *   duplicate check exists to prevent.
 *
 * The MRN it issues is identical to the one `registerAtBranch` would have
 * issued; the only difference is what prompted it, and `audit_logs` records
 * that. Callers pass their own transaction, so the registration is rolled back
 * with the booking that failed.
 */
export async function ensureRegistration(
  tx: TxClient,
  ctx: TenantContext,
  patientId: string,
  branchId: string
): Promise<{ id: string; mrn: string; created: boolean }> {
  /*
   * Branch-scoped by RLS, so this cannot see a registration at a branch out of
   * scope — but the unique index (organization_id, patient_id, branch_id) can,
   * and refuses. The caller books inside one transaction, so that refusal
   * surfaces as the conflict it is rather than as a duplicate row.
   */
  const existing = await tx.patientRegistration.findFirst({
    where: { patientId, branchId },
    select: { id: true, mrn: true },
  });
  if (existing) return { ...existing, created: false };

  const created = await createRegistration(tx, ctx, patientId, branchId);
  return { ...created, created: true };
}

/** `YYYY-MM-DD` -> a UTC midnight `Date`, which is how bare dates are stored. */
function toDateColumn(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Plain scalars rather than `Prisma.PatientUpdateInput`, so the same object can
 * be spread into a `create` as well. Prisma's update-input types wrap every
 * field in a `{ set: … }` union that a create will not accept.
 */
type PatientIdentityData = Partial<{
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  approxAgeYears: number | null;
  gender: PatientRow['gender'];
  bloodGroup: PatientRow['bloodGroup'];
  phone: string;
  email: string;
  abhaNumber: string;
  nationalId: string;
  maritalStatus: PatientRow['maritalStatus'];
}>;

/**
 * The identity fields, mapped from a request onto Prisma input.
 *
 * Shared by create and update so the two cannot diverge — in particular so the
 * age-exclusivity rule below is applied on both paths.
 */
function identityData(input: UpdatePatientRequest): PatientIdentityData {
  return {
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.dateOfBirth !== undefined
      ? { dateOfBirth: toDateColumn(input.dateOfBirth), approxAgeYears: null }
      : {}),
    /*
     * Setting one clears the other, mirroring the `patients_age_single_source`
     * CHECK. Without this, correcting a guessed age with a real birth date
     * leaves both columns populated and the INSERT fails as a 23514 that names
     * a constraint rather than a field.
     */
    ...(input.approxAgeYears !== undefined
      ? { approxAgeYears: input.approxAgeYears, dateOfBirth: null }
      : {}),
    ...(input.gender !== undefined ? { gender: input.gender } : {}),
    ...(input.bloodGroup !== undefined ? { bloodGroup: input.bloodGroup } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.abhaNumber !== undefined ? { abhaNumber: input.abhaNumber } : {}),
    ...(input.nationalId !== undefined ? { nationalId: input.nationalId } : {}),
    ...(input.maritalStatus !== undefined ? { maritalStatus: input.maritalStatus } : {}),
  };
}

/**
 * Address and contact fields, mapped explicitly rather than spread.
 *
 * `exactOptionalPropertyTypes` is on, so `{ ...input }` hands Prisma
 * `line2: undefined` where it wants `string | null` — and the same spread would
 * quietly carry any field a future contract adds straight into the database
 * without anyone deciding it should. Explicit is the point, not a workaround.
 */
function addressData(input: PatientAddressRequest): {
  addressType: PatientAddressRequest['addressType'];
  line1: string;
  countryCode: string;
  isPrimary: boolean;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
} {
  return {
    addressType: input.addressType,
    line1: input.line1,
    countryCode: input.countryCode,
    isPrimary: input.isPrimary,
    ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
  };
}

function contactData(input: PatientContactRequest): {
  relation: string;
  name: string;
  phone: string;
  isEmergency: boolean;
  isGuardian: boolean;
  email?: string;
} {
  return {
    relation: input.relation,
    name: input.name,
    phone: input.phone,
    isEmergency: input.isEmergency,
    isGuardian: input.isGuardian,
    ...(input.email !== undefined ? { email: input.email } : {}),
  };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

interface DuplicateRow {
  id: string;
  uhid: string;
  first_name: string;
  last_name: string | null;
  date_of_birth: Date | null;
  approx_age_years: number | null;
  gender: PatientRow['gender'];
  phone: string | null;
  matched_phone: boolean;
  matched_name_dob: boolean;
  matched_abha: boolean;
  matched_national_id: boolean;
}

/**
 * "Is this person already here?" — asked before a registration is committed.
 *
 * ⚠️ ORG-WIDE ON PURPOSE, INCLUDING BRANCHES THE CALLER CANNOT SEE.
 *   This is the whole reason `patients` has no branch policy (ADR-0016). A
 *   front desk that cannot see head office already registered someone will
 *   register them again, and the second record has no allergy list on it.
 *
 *   What it deliberately does NOT return is where the match is: `branchNames`
 *   is built from the registrations RLS lets through, so a match at a branch
 *   out of scope comes back with an empty array. The desk learns "already
 *   registered here" without learning which clinic.
 */
export async function findDuplicates(
  ctx: TenantContext,
  probe: {
    phone?: string | undefined;
    firstName?: string | undefined;
    dateOfBirth?: string | undefined;
    abhaNumber?: string | undefined;
    nationalId?: string | undefined;
  }
): Promise<PatientDuplicateMatch[]> {
  const phone = probe.phone ?? null;
  const firstName = probe.firstName ?? null;
  const dateOfBirth = probe.dateOfBirth ?? null;
  const abhaNumber = probe.abhaNumber ?? null;
  const nationalId = probe.nationalId ?? null;

  if (phone === null && abhaNumber === null && nationalId === null && firstName === null) {
    return [];
  }

  return withTenant(ctx, async (tx) => {
    /*
     * Raw because the name limb compares against the same expression the
     * trigram index is built on — `lower(first_name || ' ' || coalesce(...))` —
     * and Prisma cannot generate an expression Postgres will match to that
     * index. Every value is a bound parameter; `organization_id` is passed
     * explicitly as defence in depth on top of RLS (ADR-0005).
     */
    const rows = await tx.$queryRaw<DuplicateRow[]>`
      SELECT p.id, p.uhid, p.first_name, p.last_name, p.date_of_birth,
             p.approx_age_years, p.gender, p.phone,
             (${phone}::text IS NOT NULL AND p.phone = ${phone}::text)          AS matched_phone,
             (${firstName}::text IS NOT NULL AND ${dateOfBirth}::date IS NOT NULL
                AND lower(p.first_name) = lower(${firstName}::text)
                AND p.date_of_birth = ${dateOfBirth}::date)                     AS matched_name_dob,
             (${abhaNumber}::text IS NOT NULL AND p.abha_number = ${abhaNumber}::text) AS matched_abha,
             (${nationalId}::text IS NOT NULL AND p.national_id = ${nationalId}::text) AS matched_national_id
      FROM patients p
      WHERE p.organization_id = ${ctx.organizationId}::uuid
        AND p.deleted_at IS NULL
        AND p.status <> 'MERGED'
        AND (
             (${phone}::text IS NOT NULL AND p.phone = ${phone}::text)
          OR (${abhaNumber}::text IS NOT NULL AND p.abha_number = ${abhaNumber}::text)
          OR (${nationalId}::text IS NOT NULL AND p.national_id = ${nationalId}::text)
          OR (${firstName}::text IS NOT NULL AND ${dateOfBirth}::date IS NOT NULL
              AND lower(p.first_name) = lower(${firstName}::text)
              AND p.date_of_birth = ${dateOfBirth}::date)
        )
      ORDER BY p.created_at DESC
      LIMIT 10
    `;

    if (rows.length === 0) return [];

    /*
     * Branch names come from a SECOND, RLS-filtered read rather than a join in
     * the statement above — the raw query bypasses nothing, but reading them
     * through Prisma makes it obvious that this list is scoped and the match
     * list is not.
     */
    const registrations = await tx.patientRegistration.findMany({
      where: { patientId: { in: rows.map((r) => r.id) } },
      select: { patientId: true, branch: { select: { name: true } } },
    });
    const branchNames = new Map<string, string[]>();
    for (const r of registrations) {
      const list = branchNames.get(r.patientId) ?? [];
      list.push(r.branch.name);
      branchNames.set(r.patientId, list);
    }

    return rows.map((r) => {
      const matchedOn: PatientDuplicateMatch['matchedOn'] = [];
      if (r.matched_phone) matchedOn.push('PHONE');
      if (r.matched_name_dob) matchedOn.push('NAME_AND_DOB');
      if (r.matched_abha) matchedOn.push('ABHA');
      if (r.matched_national_id) matchedOn.push('NATIONAL_ID');

      return {
        id: r.id,
        uhid: r.uhid,
        fullName: fullNameOf(r.first_name, r.last_name),
        age: ageFrom(r.date_of_birth, r.approx_age_years),
        gender: r.gender,
        phone: r.phone,
        matchedOn,
        branchNames: branchNames.get(r.id) ?? [],
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a new patient at a branch.
 *
 * The patient row and its first registration are created in ONE transaction, so
 * a patient never exists attending nowhere — which would be a record nobody's
 * list contains and only a direct id lookup could reach.
 *
 * ⚠️ NO `recordDataAccess` HERE, DELIBERATELY. `data_access_logs` answers "who
 * READ whose chart"; a creation is a write and `audit_logs` records it. Logging
 * it on both trails would make every registration look like a disclosure.
 */
export async function createPatient(
  ctx: TenantContext,
  input: CreatePatientRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  assertBranchInScope(ctx, input.branchId);

  const row = await withTenant(ctx, async (tx) => {
    const uhidPrefix = await resolvePrefix(tx, ctx, UHID_PREFIX_KEY, DEFAULT_UHID_PREFIX);
    const uhid = await issueNumber(tx, ctx, { type: 'UHID', prefix: uhidPrefix });

    const created = await tx.patient.create({
      data: {
        organizationId: ctx.organizationId,
        uhid: uhid.formatted,
        // `identityData` takes a partial; the contract guarantees firstName.
        firstName: input.firstName,
        ...identityData(input),
      },
      select: { id: true },
    });

    /*
     * Address and kin are created as separate statements rather than as a
     * nested `create`. Their FK to the patient is the COMPOSITE
     * (organization_id, patient_id), so Prisma's nested input treats
     * `organizationId` as owned by the relation and refuses it as a scalar —
     * the same composite FK that makes a cross-tenant child unrepresentable
     * (ADR-0004). Same transaction, so the atomicity is unchanged.
     */
    if (input.address !== undefined) {
      await tx.patientAddress.create({
        data: {
          organizationId: ctx.organizationId,
          patientId: created.id,
          ...addressData(input.address),
        },
      });
    }
    for (const contact of input.contacts) {
      await tx.patientContact.create({
        data: {
          organizationId: ctx.organizationId,
          patientId: created.id,
          ...contactData(contact),
        },
      });
    }

    await createRegistration(tx, ctx, created.id, input.branchId);

    const full = await tx.patient.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: created.id } },
      select: PATIENT_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient',
      entityId: created.id,
      after: snapshot(full),
      branchId: input.branchId,
      ...options,
    });

    return full;
  });

  return toDetail(row);
}

/**
 * Register an existing patient at a second branch.
 *
 * One `patients` row, a second MRN. This is what keeps a hospital group from
 * accumulating two records for one person — see ADR-0016.
 */
export async function registerAtBranch(
  ctx: TenantContext,
  patientId: string,
  input: RegisterPatientAtBranchRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  assertBranchInScope(ctx, input.branchId);

  const row = await withTenant(ctx, async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!patient) throw new NotFoundError('Patient');
    if (patient.status === 'MERGED') {
      throw new ConflictError('That record has been merged into another one.');
    }

    /*
     * ⚠️ THIS READ IS BRANCH-SCOPED BY RLS, so it cannot see a registration at
     * a branch out of scope — but the unique index (organization_id, patient_id,
     * branch_id) can, and refuses. That is the correct outcome and the reason
     * the conflict is caught below rather than only checked here: an existence
     * check under RLS is advice, and the index is the answer.
     */
    const existing = await tx.patientRegistration.findFirst({
      where: { patientId, branchId: input.branchId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('This patient is already registered at that clinic.');
    }

    await createRegistration(tx, ctx, patientId, input.branchId);

    const full = await tx.patient.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: patientId } },
      select: PATIENT_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_registration',
      entityId: patientId,
      after: { uhid: full.uhid, branchId: input.branchId },
      branchId: input.branchId,
      ...options,
    });

    return full;
  });

  return toDetail(row);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface SearchRow {
  id: string;
  total: bigint;
}

/**
 * The front-desk search.
 *
 * ⚠️ ONE `data_access_logs` ROW PER SEARCH, NEVER ONE PER RESULT. The row
 * carries the result count and a SHA-256 of the term — never the term, and
 * never a patient id, because a search names no one record.
 *
 * ⚠️ SEARCHES ARE NEVER DEDUPLICATED. Repeatedly searching for the same person
 * is itself the signal this table exists to surface; collapsing eleven attempts
 * into one would erase it.
 *
 * The query is raw for one reason: the name limb must compare against the exact
 * expression `patients_name_trgm_idx` is built on, and Prisma cannot generate
 * it. Without that index every search is a sequential scan whose cost grows
 * with the number of patients on the PLATFORM, because RLS filters after the
 * scan, not before it.
 */
export async function searchPatients(
  ctx: TenantContext,
  query: SearchPatientQuery,
  options: PatientActionOptions = {}
): Promise<PatientListResponse> {
  const term = query.q ?? null;
  const status = query.status ?? null;
  const orgWide = query.scope === 'ORGANIZATION';
  const offset = (query.page - 1) * query.limit;

  return withTenant(ctx, async (tx) => {
    /*
     * Two passes. The raw statement chooses WHICH patients and in what order —
     * that is the part needing the expression index — and Prisma then loads the
     * rows through the same `PATIENT_SELECT` every other read uses, so list and
     * detail cannot drift apart and the registrations come back RLS-filtered
     * without a hand-written branch predicate.
     *
     * `branch_scope` is applied here as an explicit `= ANY`, matching the
     * policy on `patient_registrations`. Belt and braces: RLS constrains the
     * EXISTS subquery already, and repeating it makes the intent of `orgWide`
     * legible in the statement instead of hiding in a policy.
     */
    const rows = await tx.$queryRaw<SearchRow[]>`
      SELECT p.id, count(*) OVER () AS total
      FROM patients p
      WHERE p.organization_id = ${ctx.organizationId}::uuid
        AND p.deleted_at IS NULL
        AND (${status}::text IS NULL OR p.status = ${status}::"PatientStatus")
        AND (
          ${orgWide}::boolean
          OR EXISTS (
            SELECT 1 FROM patient_registrations r
            WHERE r.organization_id = p.organization_id
              AND r.patient_id = p.id
              AND r.branch_id = ANY (${ctx.branchIds}::uuid[])
          )
        )
        AND (
          ${term}::text IS NULL
          OR lower(p.first_name || ' ' || coalesce(p.last_name, ''))
               LIKE '%' || lower(${term}::text) || '%'
          OR p.phone LIKE '%' || ${term}::text || '%'
          OR lower(p.uhid) = lower(${term}::text)
          OR EXISTS (
            SELECT 1 FROM patient_registrations r2
            WHERE r2.organization_id = p.organization_id
              AND r2.patient_id = p.id
              AND lower(r2.mrn) = lower(${term}::text)
          )
        )
      ORDER BY p.created_at DESC
      LIMIT ${query.limit} OFFSET ${offset}
    `;

    const total = rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0;
    const ids = rows.map((r) => r.id);

    const patients =
      ids.length === 0
        ? []
        : await tx.patient.findMany({ where: { id: { in: ids } }, select: PATIENT_SELECT });

    // `findMany` does not preserve the `IN` order; the raw pass decided it.
    const byId = new Map(patients.map((p) => [p.id, p]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((p): p is PatientRow => p !== undefined)
      .map(toSummary);

    await recordDataAccess(tx, ctx, {
      accessType: 'SEARCH',
      resource: 'PATIENT_LIST',
      resultCount: ordered.length,
      ...(term !== null ? { searchTerm: term } : {}),
      ...options,
    });

    return {
      patients: ordered,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
      },
    };
  });
}

/**
 * One patient's record.
 *
 * ⚠️ READING A PATIENT WHO ATTENDS NONE OF YOUR BRANCHES IS PERMITTED AND
 * LOGGED — see ADR-0016. It has to be, or the duplicate check that precedes a
 * registration cannot show anybody what it found. The response says so
 * (`crossBranch`), and `data_access_logs` records it either way.
 */
export async function getPatient(
  ctx: TenantContext,
  patientId: string,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, deletedAt: null },
      select: PATIENT_SELECT,
    });
    if (!patient) throw new NotFoundError('Patient');

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PATIENT',
      patientId,
      resourceId: patientId,
      branchId: patient.registrations[0]?.branchId ?? null,
      ...options,
    });

    return patient;
  });

  return toDetail(row);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function updatePatient(
  ctx: TenantContext,
  patientId: string,
  input: UpdatePatientRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.patient.findFirst({
      where: { id: patientId, deletedAt: null },
      select: PATIENT_SELECT,
    });
    if (!before) throw new NotFoundError('Patient');
    if (before.status === 'MERGED') {
      throw new ConflictError('That record has been merged into another one and is read-only.');
    }

    const after = await tx.patient.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: patientId } },
      data: identityData(input),
      select: PATIENT_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'patient',
      entityId: patientId,
      before: snapshot(before),
      after: snapshot(after),
      ...options,
    });

    return after;
  });

  return toDetail(row);
}

/**
 * Erase a patient record. Soft, and behind `patient.delete`, which is withheld
 * from ORG_ADMIN and sits with the owner.
 *
 * Soft because appointments, prescriptions and invoices point at this row and
 * must keep resolving — and because a record that vanishes is indistinguishable
 * from one that never existed, which is the opposite of what a clinical archive
 * is for. This is NOT how a death is recorded: that is `status = DECEASED`,
 * which leaves the record readable.
 */
export async function deletePatient(
  ctx: TenantContext,
  patientId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.patient.findFirst({
      where: { id: patientId, deletedAt: null },
      select: PATIENT_SELECT,
    });
    if (!before) throw new NotFoundError('Patient');

    await tx.patient.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: patientId } },
      data: { status: 'INACTIVE', deletedAt: new Date() },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient',
      entityId: patientId,
      before: snapshot(before),
      ...options,
    });
  });
}

// ---------------------------------------------------------------------------
// Address and next of kin
// ---------------------------------------------------------------------------

/** Confirm the patient exists before writing a child row against them. */
async function assertPatientExists(tx: TxClient, patientId: string): Promise<void> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, deletedAt: null },
    select: { id: true },
  });
  if (!patient) throw new NotFoundError('Patient');
}

export async function addAddress(
  ctx: TenantContext,
  patientId: string,
  input: PatientAddressRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  const row = await withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    /*
     * Demoting the previous primary is done here rather than by a partial
     * unique index — see the model. It must happen BEFORE the insert, or the
     * new row is the one demoted.
     */
    if (input.isPrimary) {
      await tx.patientAddress.updateMany({
        where: { patientId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const created = await tx.patientAddress.create({
      data: { organizationId: ctx.organizationId, patientId, ...addressData(input) },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_address',
      entityId: created.id,
      // The address itself is PHI and stays off the trail. That one was added
      // is the auditable fact.
      after: { patientId, addressType: input.addressType, isPrimary: input.isPrimary },
      ...options,
    });

    return tx.patient.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: patientId } },
      select: PATIENT_SELECT,
    });
  });

  return toDetail(row);
}

export async function removeAddress(
  ctx: TenantContext,
  patientId: string,
  addressId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientAddress.findFirst({
      where: { id: addressId, patientId },
      select: { id: true, addressType: true, isPrimary: true },
    });
    if (!existing) throw new NotFoundError('Address');

    await tx.patientAddress.delete({ where: { id: addressId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient_address',
      entityId: addressId,
      before: { patientId, addressType: existing.addressType, isPrimary: existing.isPrimary },
      ...options,
    });
  });
}

export async function addContact(
  ctx: TenantContext,
  patientId: string,
  input: PatientContactRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  const row = await withTenant(ctx, async (tx) => {
    await assertPatientExists(tx, patientId);

    const created = await tx.patientContact.create({
      data: { organizationId: ctx.organizationId, patientId, ...contactData(input) },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'patient_contact',
      entityId: created.id,
      // `name` and `phone` belong to a third party who never consented to being
      // in an audit trail. Only the shape of the relationship goes on it.
      after: {
        patientId,
        relation: input.relation,
        isEmergency: input.isEmergency,
        isGuardian: input.isGuardian,
      },
      ...options,
    });

    return tx.patient.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: patientId } },
      select: PATIENT_SELECT,
    });
  });

  return toDetail(row);
}

export async function removeContact(
  ctx: TenantContext,
  patientId: string,
  contactId: string,
  options: PatientActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.patientContact.findFirst({
      where: { id: contactId, patientId },
      select: { id: true, relation: true },
    });
    if (!existing) throw new NotFoundError('Contact');

    await tx.patientContact.delete({ where: { id: contactId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'patient_contact',
      entityId: contactId,
      before: { patientId, relation: existing.relation },
      ...options,
    });
  });
}

/**
 * Exported for the tests, which assert that the audit snapshot of a patient
 * carries no name, no date of birth and no identifier. Importing the function
 * they are checking is stronger than re-deriving the field list in the test,
 * where it would drift the first time a column is added.
 */
export const __testing = { snapshot, ageFrom };
