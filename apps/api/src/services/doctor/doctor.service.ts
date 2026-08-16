/**
 * Doctor profiles: who practises here, what they are qualified in, what they
 * charge at each branch.
 *
 * Working hours live in `doctor-schedule.service.ts` — they are read on every
 * booking by the availability engine, and keeping them apart stops a profile
 * read from dragging the whole week in with it.
 *
 * NO PHI HERE. A doctor is staff, not a patient, so audit snapshots may carry
 * their registration number and specialty. The moment this file starts joining
 * to `patients`, that stops being true.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateDoctorRequest,
  DoctorBranchSettingRequest,
  DoctorClassificationInput,
  DoctorListQuery,
  SpecialtyProficiency,
  DoctorDetail,
  DoctorQualificationRequest,
  DoctorScheduleDetail,
  DoctorSummary,
  DoctorSpecialtyDetail,
  ReferralTarget,
  ReferralTargetQuery,
  SpecialtyListResponse,
  UpdateDoctorQualificationRequest,
  UpdateDoctorRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { descendantRows } from './clinical-taxonomy.service.js';
import {
  assertNoInternalOverlap,
  createScheduleRow,
  isScheduleOverlap,
  listExceptions,
  listSchedules,
  listSchedulesForDoctors,
} from './doctor-schedule.service.js';
import { writeFeeEntries } from '../fees/fee-schedule.service.js';
import { writeDoctorCompensation } from './doctor-compensation.service.js';
import { resolveSettings, asPositiveInt } from '../settings/resolver.service.js';

export interface DoctorActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** Fallback when no `appointment.slot_minutes` is set anywhere. Matches the seed. */
const DEFAULT_SLOT_MINUTES = 15;
const SLOT_MINUTES_KEY = 'appointment.slot_minutes';

/** The shape Prisma is asked for, so list and detail cannot drift apart. */
const DOCTOR_SELECT = {
  id: true,
  userId: true,
  registrationNumber: true,
  registrationCouncil: true,
  registrationValidTill: true,
  experienceYears: true,
  bio: true,
  status: true,
  user: { select: { fullName: true } },
  specialties: {
    select: {
      id: true,
      specialtyId: true,
      isPrimary: true,
      proficiency: true,
      effectiveFrom: true,
      effectiveTo: true,
      isActive: true,
      specialty: { select: { code: true, name: true, type: true } },
    },
  },
  qualifications: {
    select: {
      id: true,
      qualificationId: true,
      institute: true,
      yearOfCompletion: true,
      qualification: { select: { code: true, name: true } },
    },
  },
  branchSettings: {
    select: {
      id: true,
      branchId: true,
      followUpFreeDays: true,
      isActive: true,
      branch: { select: { name: true } },
    },
  },
} as const;

type DoctorRow = Prisma.DoctorProfileGetPayload<{ select: typeof DOCTOR_SELECT }>;

/** `Date | null` -> `YYYY-MM-DD`. The column is a bare date; read it in UTC. */
function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Root-first chain above one node. Keyed by the node's own id. */
type AncestorChains = Map<string, DoctorSpecialtyDetail['ancestors']>;

interface AncestorRow {
  descendant_id: string;
  id: string;
  code: string;
  name: string;
  type: DoctorSpecialtyDetail['type'];
  depth: number;
}

/**
 * The ancestor chain for every supplied node, in ONE query.
 *
 * ⚠️ ONE STATEMENT FOR THE WHOLE PAGE, NOT ONE PER DOCTOR. The obvious shape is
 *   a walk per classification, which on a roster of forty doctors with three
 *   specialties each is a hundred and twenty round trips to render one list —
 *   the N+1 that makes a directory feel broken. The recursion starts from all
 *   the seed ids at once and carries `descendant_id` along so the rows can be
 *   grouped back afterwards.
 *
 * Runs inside the caller's `withTenant`, so RLS applies: an ancestor the tenant
 * cannot see simply does not come back, and the chain is short rather than wrong.
 */
async function loadAncestorChains(tx: TxClient, specialtyIds: string[]): Promise<AncestorChains> {
  const chains: AncestorChains = new Map();
  if (specialtyIds.length === 0) return chains;

  const rows = await tx.$queryRaw<AncestorRow[]>`
    WITH RECURSIVE chain AS (
      SELECT s.id AS descendant_id, s.id, s.parent_id, 0 AS depth
      FROM specialties s
      WHERE s.id = ANY (${specialtyIds}::uuid[]) AND s.deleted_at IS NULL
      UNION ALL
      SELECT c.descendant_id, p.id, p.parent_id, c.depth + 1
      FROM specialties p
      JOIN chain c ON c.parent_id = p.id
      WHERE p.deleted_at IS NULL
    )
    SELECT c.descendant_id, s.id, s.code, s.name, s.type, c.depth
    FROM chain c
    JOIN specialties s ON s.id = c.id
    -- depth 0 is the node itself; a breadcrumb repeats it from the row already.
    WHERE c.depth > 0
    ORDER BY c.descendant_id, c.depth DESC
  `;

  for (const row of rows) {
    const bucket = chains.get(row.descendant_id) ?? [];
    // ORDER BY depth DESC already puts the domain first.
    bucket.push({ id: row.id, code: row.code, name: row.name, type: row.type });
    chains.set(row.descendant_id, bucket);
  }
  return chains;
}

function toSummary(row: DoctorRow, chains: AncestorChains = new Map()): DoctorSummary {
  const specialties = row.specialties.map((s) => ({
    id: s.id,
    specialtyId: s.specialtyId,
    code: s.specialty.code,
    name: s.specialty.name,
    isPrimary: s.isPrimary,
    type: s.specialty.type,
    proficiency: s.proficiency,
    effectiveFrom: isoDate(s.effectiveFrom),
    effectiveTo: isoDate(s.effectiveTo),
    isActive: s.isActive,
    ancestors: chains.get(s.specialtyId) ?? [],
  }));

  return {
    id: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    status: row.status,
    registrationNumber: row.registrationNumber,
    experienceYears: row.experienceYears,
    primarySpecialty: specialties.find((s) => s.isPrimary)?.name ?? null,
    specialties,
    branchIds: row.branchSettings.filter((b) => b.isActive).map((b) => b.branchId),
  };
}

function toDetail(
  row: DoctorRow,
  chains: AncestorChains = new Map()
): Omit<DoctorDetail, 'schedules' | 'exceptions'> {
  return {
    ...toSummary(row, chains),
    registrationCouncil: row.registrationCouncil,
    registrationValidTill: isoDate(row.registrationValidTill),
    bio: row.bio,
    qualifications: row.qualifications.map((q) => ({
      id: q.id,
      qualificationId: q.qualificationId,
      code: q.qualification.code,
      name: q.qualification.name,
      institute: q.institute,
      yearOfCompletion: q.yearOfCompletion,
    })),
    branchSettings: row.branchSettings.map((b) => ({
      id: b.id,
      branchId: b.branchId,
      branchName: b.branch.name,
      followUpFreeDays: b.followUpFreeDays,
      isActive: b.isActive,
    })),
  };
}

/**
 * What goes on the audit row: the profile's own configuration.
 *
 * Deliberately excludes the nested collections — specialties and fees are
 * managed through their own calls and record their own rows, and dumping them
 * here buries the field that actually moved. `bio` is excluded because it is
 * free prose that can run to four thousand characters.
 */
function snapshot(row: DoctorRow): Record<string, unknown> {
  return {
    userId: row.userId,
    registrationNumber: row.registrationNumber,
    registrationCouncil: row.registrationCouncil,
    registrationValidTill: row.registrationValidTill,
    experienceYears: row.experienceYears,
    status: row.status,
  };
}

/**
 * Every specialty this clinic may attach: the platform catalogue plus its own.
 *
 * The RLS policy already limits the read to `organization_id IS NULL OR = ours`,
 * so this needs no explicit filter — but `isOwn` is computed here rather than
 * exposing `organizationId`, because the screen only needs to know whether the
 * row is editable.
 */
export async function listMasters(ctx: TenantContext): Promise<SpecialtyListResponse> {
  return withTenant(ctx, async (tx) => {
    const [specialties, qualifications] = await Promise.all([
      tx.specialty.findMany({
        where: { isActive: true, deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          parentId: true,
          organizationId: true,
          type: true,
          description: true,
          displayOrder: true,
        },
        // `displayOrder` first so siblings appear in the curated order, `name` to
        // break ties. Callers that need the TREE use /clinical-taxonomy; this
        // stays a flat catalogue and the ordering only has to be stable.
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      }),
      tx.qualification.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, code: true, name: true, organizationId: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      specialties: specialties.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        parentId: s.parentId,
        isOwn: s.organizationId !== null,
        type: s.type,
        description: s.description,
        displayOrder: s.displayOrder,
      })),
      qualifications: qualifications.map((q) => ({
        id: q.id,
        code: q.code,
        name: q.name,
        isOwn: q.organizationId !== null,
      })),
    };
  });
}

/**
 * The doctor list, optionally filtered by clinical classification.
 *
 * ⚠️ FILTERING BY SPECIALTY IS A SUBTREE QUESTION, NOT A STRING MATCH.
 *   "Find me a cardiologist" has to return the doctor tagged only "Structural
 *   Heart Disease" — whose record contains the word "cardio" precisely nowhere.
 *   The subtree is resolved through `descendantRows` from the taxonomy service
 *   rather than a second recursive CTE written here, so this filter and
 *   `GET /clinical-taxonomy/:id/tree` can never disagree about what is "under
 *   Cardiology". A second copy of that query is exactly how they would.
 *
 *   `includeSelf` is true: a doctor tagged Cardiology ITSELF must match a
 *   Cardiology filter, which is easy to lose when thinking only about children.
 */
/**
 * @param includeSchedules whether the caller holds `doctor.schedule.read`.
 *
 * ⚠️ FALSE OMITS THE FIELD ENTIRELY RATHER THAN SENDING `[]`. The roster is
 *   behind `doctor.directory.read` and the week is behind `doctor.schedule.read`
 *   — a split the router explains at length — so a caller without the second
 *   must not be told a doctor has no working hours. Absence is a silence; an
 *   empty array is a claim. Same three-state shape as `liveInvoice` on the day
 *   board, for the same reason.
 */
export async function listDoctors(
  ctx: TenantContext,
  query: DoctorListQuery = { includeDescendants: true },
  includeSchedules = false
): Promise<DoctorSummary[]> {
  const rows = await withTenant(ctx, async (tx) => {
    let specialtyIds: string[] | undefined;

    if (query.specialtyId) {
      if (query.includeDescendants) {
        const subtree = await descendantRows(tx, query.specialtyId, true, true);
        /*
         * Inactive nodes are INCLUDED in the subtree walk (the `true` above).
         * A retired sub-specialty still has doctors attached to it — see the
         * inactive-node asymmetry in assertSpecialtiesUsable — and hiding them
         * from a Cardiology search would make a doctor vanish from the
         * directory because of a curation decision about a node, not about them.
         */
        specialtyIds = subtree.map((n) => n.id);
        // An id the tenant cannot see yields an empty subtree. Matching nothing
        // is correct; falling through to "no filter" would list every doctor.
        if (specialtyIds.length === 0) {
          return {
            profiles: [] as DoctorRow[],
            chains: new Map() as AncestorChains,
            schedules: new Map<string, DoctorScheduleDetail[]>(),
          };
        }
      } else {
        specialtyIds = [query.specialtyId];
      }
    }

    const profiles = await tx.doctorProfile.findMany({
      where: {
        deletedAt: null,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(specialtyIds !== undefined
          ? { specialties: { some: { specialtyId: { in: specialtyIds } } } }
          : {}),
      },
      select: DOCTOR_SELECT,
      orderBy: { user: { fullName: 'asc' } },
    });

    // One walk for the whole roster, not one per doctor. See loadAncestorChains.
    const chains = await loadAncestorChains(tx, [
      ...new Set(profiles.flatMap((p) => p.specialties.map((s) => s.specialtyId))),
    ]);

    // Likewise one query for every doctor's week, not one call per row — see
    // `listSchedulesForDoctors`, which replaced an N+1 the roster made over HTTP.
    const schedules = includeSchedules
      ? await listSchedulesForDoctors(
          tx,
          ctx,
          profiles.map((p) => p.id)
        )
      : new Map<string, DoctorScheduleDetail[]>();

    return { profiles, chains, schedules };
  });

  return rows.profiles.map((p) => ({
    ...toSummary(p, rows.chains),
    ...(includeSchedules ? { schedules: rows.schedules.get(p.id) ?? [] } : {}),
  }));
}

/**
 * The two request forms collapse to one internal shape here, so nothing below
 * this line has to care which the client used.
 */
function normaliseClassifications(input: {
  specialtyIds?: string[] | undefined;
  classifications?: DoctorClassificationInput[] | undefined;
}): DoctorClassificationInput[] {
  if (input.classifications !== undefined) return input.classifications;
  return (input.specialtyIds ?? []).map((specialtyId) => ({ specialtyId }));
}

/**
 * Validate the classification set before it reaches the database.
 *
 * The RESTRICTIVE `specialty_visible` policy would refuse an out-of-tenant id
 * anyway, but as a row-level security violation with no field name attached.
 * Reading them first turns that into a message naming what was wrong.
 *
 * ⚠️ ONLY *NEWLY ADDED* NODES ARE REQUIRED TO BE ACTIVE, AND THAT ASYMMETRY IS
 *   THE POINT. A node retired last year must not be assignable today — but a
 *   doctor who was already classified under it stays classified under it. If
 *   this checked the whole set instead, retiring one node would make every
 *   affected doctor's profile unsaveable: the next unrelated edit to their bio
 *   would fail validation on a specialty the user never touched, with no way
 *   forward except silently dropping a true fact about their training.
 */
async function assertSpecialtiesUsable(
  tx: TxClient,
  entries: DoctorClassificationInput[],
  primaryId: string | undefined,
  alreadyAssignedIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const ids = entries.map((e) => e.specialtyId);

  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) {
    throw new ValidationError('The same classification was supplied more than once.');
  }

  if (ids.length === 0) {
    if (primaryId) {
      throw new ValidationError('A primary specialty must be one of the selected specialties.');
    }
    return;
  }

  // Existence is checked across the whole set; activeness only for additions.
  const found = await tx.specialty.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, isActive: true },
  });
  if (found.length !== ids.length) {
    throw new ValidationError('One or more specialties do not exist.');
  }

  const newlyInactive = found.filter((s) => !s.isActive && !alreadyAssignedIds.has(s.id));
  if (newlyInactive.length > 0) {
    throw new ValidationError(
      'One or more specialties are no longer active and cannot be newly assigned.'
    );
  }

  if (primaryId && !ids.includes(primaryId)) {
    throw new ValidationError('A primary specialty must be one of the selected specialties.');
  }
}

/** `YYYY-MM-DD` -> a UTC midnight Date for a bare `date` column. */
function toDateColumn(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

function classificationData(
  entry: DoctorClassificationInput,
  organizationId: string,
  primaryId: string | undefined
): {
  organizationId: string;
  specialtyId: string;
  isPrimary: boolean;
  proficiency: SpecialtyProficiency | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
} {
  return {
    organizationId,
    specialtyId: entry.specialtyId,
    isPrimary: entry.specialtyId === primaryId,
    proficiency: entry.proficiency ?? null,
    effectiveFrom: toDateColumn(entry.effectiveFrom),
    effectiveTo: toDateColumn(entry.effectiveTo),
  };
}

/**
 * Bring a doctor's classifications in line with the request.
 *
 * ⚠️ RECONCILED, NOT DELETED-AND-RECREATED. The previous implementation dropped
 *   every row and re-inserted the set, which was harmless while the join table
 *   held nothing but two foreign keys and a flag. It is not harmless now: a row
 *   carries `proficiency`, `effectiveFrom`, `effectiveTo` and its own
 *   `createdAt`, so wiping and rewriting turns "specialist here since 2019" into
 *   "recorded just now" on every unrelated profile edit.
 *
 *   It also matters for the audit trail: delete+insert reports every
 *   classification as changed on every save, which makes the history useless for
 *   the one question it exists to answer.
 */
async function reconcileClassifications(
  tx: TxClient,
  organizationId: string,
  doctorProfileId: string,
  entries: DoctorClassificationInput[],
  primaryId: string | undefined
): Promise<void> {
  const existing = await tx.doctorSpecialty.findMany({
    where: { doctorProfileId },
    select: { id: true, specialtyId: true },
  });
  const existingBySpecialty = new Map(existing.map((r) => [r.specialtyId, r.id]));
  const wanted = new Set(entries.map((e) => e.specialtyId));

  const removed = existing.filter((r) => !wanted.has(r.specialtyId)).map((r) => r.id);
  if (removed.length > 0) {
    await tx.doctorSpecialty.deleteMany({ where: { id: { in: removed } } });
  }

  /*
   * ⚠️ CLEAR EVERY PRIMARY BEFORE SETTING THE NEW ONE.
   *   `doctor_specialties_one_primary` is a partial unique index on
   *   (doctor_profile_id) WHERE is_primary. Updating rows one at a time in an
   *   arbitrary order can transiently leave two rows flagged, and the index
   *   rejects the second — a legitimate primary change would fail depending on
   *   iteration order. Clearing first makes the window impossible.
   */
  await tx.doctorSpecialty.updateMany({
    where: { doctorProfileId, isPrimary: true },
    data: { isPrimary: false },
  });

  for (const entry of entries) {
    const data = classificationData(entry, organizationId, primaryId);
    const existingId = existingBySpecialty.get(entry.specialtyId);

    if (existingId) {
      await tx.doctorSpecialty.update({
        where: { id: existingId },
        data: {
          isPrimary: data.isPrimary,
          proficiency: data.proficiency,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo,
        },
      });
    } else {
      await tx.doctorSpecialty.create({ data: { ...data, doctorProfileId } });
    }
  }
}

/**
 * One doctor, in full — the read-only profile screen.
 *
 * ⚠️ NOT PHI, AND THAT IS WHY THERE IS NO `recordDataAccess` CALL HERE. A
 *   practitioner's registration number, qualifications and consulting fees are
 *   facts about a member of staff, and several of them are on the clinic's
 *   public website. `data_access_logs` exists for reads of PATIENT records; a
 *   row per colleague-profile view would dilute the table that has to answer
 *   "who looked up their neighbour's chart".
 *
 * Behind DOCTOR_READ, which a doctor holds for their own profile. The roster is
 * a different code — see DOCTOR_DIRECTORY_READ — so this endpoint being open to
 * a doctor does not hand them a way to enumerate their colleagues: they would
 * need an id they have no way to obtain.
 */
export async function getDoctor(ctx: TenantContext, doctorId: string): Promise<DoctorDetail> {
  const row = await withTenant(ctx, async (tx) => {
    const profile = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: DOCTOR_SELECT,
    });
    if (!profile) throw new NotFoundError('Doctor');

    const chains = await loadAncestorChains(
      tx,
      profile.specialties.map((s) => s.specialtyId)
    );
    return { profile, chains };
  });

  /*
   * Schedules and exceptions come from their own service, which resolves each
   * block's effective slot length through the settings ladder (ADR-0015). Doing
   * it here would be a second implementation of that chain.
   */
  const [schedules, exceptions] = await Promise.all([
    listSchedules(ctx, doctorId),
    listExceptions(ctx, doctorId),
  ]);

  return { ...toDetail(row.profile, row.chains), schedules, exceptions };
}

/**
 * The caller's own profile.
 *
 * WHY THIS EXISTS RATHER THAN THE CLIENT FILTERING THE ROSTER
 *   A doctor does not hold DOCTOR_DIRECTORY_READ, so there is no roster for them
 *   to filter — that is the whole point of the split. This resolves the profile
 *   from `ctx.userId`, so the caller never needs an id they could not otherwise
 *   have obtained, and it is the only doctor row they can reach.
 *
 * 404 when the caller is not a doctor. `NotFoundError`, not `AuthorizationError`:
 * whether a given user has a doctor profile is tenant information, and the two
 * responses tell an outsider apart from a colleague.
 */
export async function getOwnDoctor(ctx: TenantContext): Promise<DoctorDetail> {
  const own = await withTenant(ctx, (tx) =>
    tx.doctorProfile.findFirst({
      where: { userId: ctx.userId, deletedAt: null },
      select: { id: true },
    })
  );
  if (!own) throw new NotFoundError('Doctor');

  return getDoctor(ctx, own.id);
}

/**
 * Attach one qualification inside a caller's transaction.
 *
 * The body of `addQualification` below, lifted so registration can record a
 * doctor's degrees in the transaction that creates them. A second copy would be
 * a second place for the "does this qualification exist" check to drift.
 */
async function createQualificationRow(
  tx: TxClient,
  ctx: TenantContext,
  doctorId: string,
  input: DoctorQualificationRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
  // As with specialties: the RESTRICTIVE policy would refuse an out-of-tenant
  // id as an RLS violation with no field attached. This names it.
  const qualification = await tx.qualification.findFirst({
    where: { id: input.qualificationId, isActive: true, deletedAt: null },
    select: { id: true },
  });
  if (!qualification) throw new ValidationError('That qualification does not exist.');

  const created = await tx.doctorQualification.create({
    data: {
      organizationId: ctx.organizationId,
      doctorProfileId: doctorId,
      qualificationId: input.qualificationId,
      ...(input.institute !== undefined ? { institute: input.institute } : {}),
      ...(input.yearOfCompletion !== undefined ? { yearOfCompletion: input.yearOfCompletion } : {}),
    },
    select: { id: true },
  });

  await recordAudit(tx, ctx, {
    action: 'CREATE',
    entityType: 'doctor_qualification',
    entityId: created.id,
    after: {
      doctorProfileId: doctorId,
      qualificationId: input.qualificationId,
      institute: input.institute ?? null,
    },
    ...options,
  });
}

/**
 * Register a doctor — profile, classifications, degrees, working hours, prices
 * and what the clinic pays — in ONE transaction.
 *
 * ⚠️ ALL OF IT COMMITS OR NONE OF IT DOES, AND THAT IS THE WHOLE REASON THE
 *   NESTED SHAPE EXISTS. The alternative the web app used to run — POST the
 *   profile, then fire four more calls — leaves a doctor with half a week of
 *   hours behind whenever the third call 409s, and no screen owns cleaning that
 *   up. A clinic then books against a practitioner whose Thursday clinic silently
 *   never made it in.
 *
 * ⚠️ EVERY NESTED SECTION IS AUTHORIZED AT THE ROUTE, NOT HERE. `doctor.create`
 *   reaches this function; the hours, prices and salary each need their own code,
 *   checked in `doctors.routes.ts` before the body is handed over. This service
 *   trusts its caller in exactly the way `writeDoctorCompensation` documents —
 *   there is one door and the guard is on it.
 *
 * ⚠️ BRANCH SCOPE AND BLOCK OVERLAP ARE CHECKED BEFORE THE TRANSACTION OPENS.
 *   Out-of-scope branches are a 404 like everywhere else, and a clash between two
 *   submitted blocks has to be named rather than left to the GiST constraint,
 *   which aborts the transaction and takes the profile with it.
 */
export async function createDoctor(
  ctx: TenantContext,
  input: CreateDoctorRequest,
  options: DoctorActionOptions = {}
): Promise<DoctorDetail> {
  const schedules = input.schedules ?? [];

  for (const block of schedules) {
    if (!ctx.branchIds.includes(block.branchId)) throw new NotFoundError('Branch');
  }
  assertNoInternalOverlap(schedules);

  const row = await createDoctorRecord(ctx, input, schedules, options);

  /*
   * Read the week back through the schedule service rather than shaping it here,
   * so the effective slot length comes off the one ladder (ADR-0015). Exceptions
   * are empty by construction — a doctor created a moment ago has no leave.
   */
  const written = schedules.length === 0 ? [] : await listSchedules(ctx, row.created.id);
  return { ...toDetail(row.created, row.chains), schedules: written, exceptions: [] };
}

async function createDoctorRecord(
  ctx: TenantContext,
  input: CreateDoctorRequest,
  schedules: CreateDoctorRequest['schedules'] & object,
  options: DoctorActionOptions
): Promise<{ created: DoctorRow; chains: AncestorChains }> {
  try {
    return await withTenant(ctx, async (tx) => {
      /*
       * `memberships` is RLS-enforced, so this read is already tenant-scoped —
       * but the explicit organizationId is defence in depth (ADR-0005), and it
       * turns "not a member here" into a 404 rather than a foreign-key error.
       */
      const membership = await tx.membership.findFirst({
        where: { userId: input.userId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!membership) {
        throw new NotFoundError('User');
      }

      const existing = await tx.doctorProfile.findFirst({
        where: { userId: input.userId, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError('That person already has a doctor profile.');
      }

      const entries = normaliseClassifications(input);
      await assertSpecialtiesUsable(tx, entries, input.primarySpecialtyId);

      const created = await tx.doctorProfile.create({
        data: {
          organizationId: ctx.organizationId,
          userId: input.userId,
          ...(input.registrationNumber !== undefined
            ? { registrationNumber: input.registrationNumber }
            : {}),
          ...(input.registrationCouncil !== undefined
            ? { registrationCouncil: input.registrationCouncil }
            : {}),
          ...(input.registrationValidTill !== undefined
            ? { registrationValidTill: new Date(`${input.registrationValidTill}T00:00:00Z`) }
            : {}),
          ...(input.experienceYears !== undefined
            ? { experienceYears: input.experienceYears }
            : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          specialties: {
            create: entries.map((entry) =>
              classificationData(entry, ctx.organizationId, input.primarySpecialtyId)
            ),
          },
        },
        select: DOCTOR_SELECT,
      });

      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'doctor_profile',
        entityId: created.id,
        after: snapshot(created),
        ...options,
      });

      /*
       * The rest of the practitioner, each through the same writer its own
       * endpoint uses. Sequential rather than concurrent: they share one
       * transaction, and Prisma serialises statements on it anyway.
       */
      for (const qualification of input.qualifications ?? []) {
        await createQualificationRow(tx, ctx, created.id, qualification, options);
      }

      for (const block of schedules) {
        await createScheduleRow(tx, ctx, created.id, block, options);
      }

      if (input.fees !== undefined && input.fees.length > 0) {
        /*
         * At this doctor's ORGANIZATION-WIDE scope. A per-branch override is a
         * later, deliberate act on the fee grid — pinning one at registration
         * would make the clinic's own default unreachable for this doctor at the
         * one branch they were first set up in.
         */
        await writeFeeEntries(
          tx,
          ctx,
          { doctorProfileId: created.id, branchId: null },
          input.fees,
          options
        );
      }

      if (input.compensation !== undefined) {
        await writeDoctorCompensation(tx, ctx, created.id, input.compensation, options);
      }

      const chains = await loadAncestorChains(
        tx,
        created.specialties.map((s) => s.specialtyId)
      );
      return { created, chains };
    });
  } catch (err) {
    /*
     * Caught OUTSIDE `withTenant`, for the reason `addSchedule` documents at
     * length: an exclusion violation aborts the transaction, so it can only be
     * translated once the callback has unwound. `assertNoInternalOverlap` has
     * already ruled out the submitted blocks clashing with each other, so
     * reaching this means a concurrent write — two admins registering the same
     * consultant's Tuesday at once.
     */
    if (isScheduleOverlap(err)) {
      throw new ConflictError(
        'Those working hours overlap a block this doctor already has at that branch on that day.'
      );
    }
    throw err;
  }
}

export async function updateDoctor(
  ctx: TenantContext,
  doctorId: string,
  input: UpdateDoctorRequest,
  options: DoctorActionOptions = {}
): Promise<Omit<DoctorDetail, 'schedules' | 'exceptions'>> {
  const row = await withTenant(ctx, async (tx) => {
    const before = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: DOCTOR_SELECT,
    });
    if (!before) throw new NotFoundError('Doctor');

    if (input.specialtyIds !== undefined || input.classifications !== undefined) {
      const entries = normaliseClassifications(input);
      // What this doctor is already tagged with, so a node retired since then
      // may be KEPT even though it could not be newly added. See the note on
      // assertSpecialtiesUsable.
      const alreadyAssigned = new Set(before.specialties.map((s) => s.specialtyId));

      await assertSpecialtiesUsable(tx, entries, input.primarySpecialtyId, alreadyAssigned);
      await reconcileClassifications(
        tx,
        ctx.organizationId,
        doctorId,
        entries,
        input.primarySpecialtyId
      );
    }

    const after = await tx.doctorProfile.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: doctorId } },
      data: {
        ...(input.registrationNumber !== undefined
          ? { registrationNumber: input.registrationNumber }
          : {}),
        ...(input.registrationCouncil !== undefined
          ? { registrationCouncil: input.registrationCouncil }
          : {}),
        ...(input.registrationValidTill !== undefined
          ? { registrationValidTill: new Date(`${input.registrationValidTill}T00:00:00Z`) }
          : {}),
        ...(input.experienceYears !== undefined ? { experienceYears: input.experienceYears } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      select: DOCTOR_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'doctor_profile',
      entityId: doctorId,
      before: snapshot(before),
      after: snapshot(after),
      ...options,
    });

    const chains = await loadAncestorChains(
      tx,
      after.specialties.map((s) => s.specialtyId)
    );
    return { after, chains };
  });

  return toDetail(row.after, row.chains);
}

/**
 * Retire a doctor. Soft delete, because prescriptions and appointments point at
 * this row and must keep resolving after the person has left.
 */
export async function archiveDoctor(
  ctx: TenantContext,
  doctorId: string,
  options: DoctorActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: DOCTOR_SELECT,
    });
    if (!before) throw new NotFoundError('Doctor');

    const after = await tx.doctorProfile.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: doctorId } },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
      select: DOCTOR_SELECT,
    });

    /*
     * Working hours are deactivated with the profile. Leaving them active would
     * keep the availability engine offering slots for someone who has left —
     * the engine filters on `is_active`, not on the profile's `deleted_at`.
     */
    await tx.doctorSchedule.updateMany({
      where: { doctorProfileId: doctorId },
      data: { isActive: false },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'doctor_profile',
      entityId: doctorId,
      before: snapshot(before),
      after: snapshot(after),
      ...options,
    });
  });
}

export async function setBranchSetting(
  ctx: TenantContext,
  doctorId: string,
  input: DoctorBranchSettingRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
  // Out of scope is a 404, never a 403 — the caller must not learn the branch
  // exists. Checked before the transaction, as the invitation service does.
  if (!ctx.branchIds.includes(input.branchId)) throw new NotFoundError('Branch');

  await withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    const existing = await tx.doctorBranchSetting.findFirst({
      where: { doctorProfileId: doctorId, branchId: input.branchId },
      select: { id: true },
    });

    const data = {
      ...(input.followUpFreeDays !== undefined ? { followUpFreeDays: input.followUpFreeDays } : {}),
      isActive: input.isActive,
    };

    if (existing) {
      await tx.doctorBranchSetting.update({ where: { id: existing.id }, data });
    } else {
      await tx.doctorBranchSetting.create({
        data: {
          organizationId: ctx.organizationId,
          doctorProfileId: doctorId,
          branchId: input.branchId,
          ...data,
        },
      });
    }

    await recordAudit(tx, ctx, {
      action: existing ? 'UPDATE' : 'CREATE',
      entityType: 'doctor_branch_setting',
      entityId: existing?.id ?? doctorId,
      after: { doctorProfileId: doctorId, branchId: input.branchId, ...data },
      branchId: input.branchId,
      ...options,
    });
  });
}

export async function addQualification(
  ctx: TenantContext,
  doctorId: string,
  input: DoctorQualificationRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    await createQualificationRow(tx, ctx, doctorId, input, options);
  });
}

/**
 * Correct a qualification already on a doctor.
 *
 * ⚠️ ABSENT LEAVES THE COLUMN ALONE; `null` CLEARS IT. Straight off the contract,
 *   and the reason the spread guards test `!== undefined` rather than being
 *   truthy — `yearOfCompletion: null` is an instruction and would be dropped by a
 *   truthiness check, as would a year of 0 if the range allowed one.
 *
 * ⚠️ THE DUPLICATE IS CAUGHT HERE, NOT LEFT TO THE INDEX.
 *   `doctor_qualifications` is unique on (org, doctor, qualification, institute),
 *   so re-pointing a row at a degree the doctor already holds from the same
 *   institute is a legitimate mistake with an illegitimate outcome: Prisma
 *   surfaces it as P2002 with no field a form can highlight. Reading first turns
 *   it into a sentence naming what clashed.
 */
export async function updateQualification(
  ctx: TenantContext,
  doctorId: string,
  qualificationRowId: string,
  input: UpdateDoctorQualificationRequest,
  options: DoctorActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.doctorQualification.findFirst({
      where: { id: qualificationRowId, doctorProfileId: doctorId },
      select: { id: true, qualificationId: true, institute: true, yearOfCompletion: true },
    });
    if (!before) throw new NotFoundError('Qualification');

    // Only when the degree itself is being re-pointed. The catalogue check is the
    // same one `createQualificationRow` makes, and for the same reason: an
    // out-of-tenant id would otherwise surface as an RLS violation with no field
    // attached.
    if (input.qualificationId !== undefined && input.qualificationId !== before.qualificationId) {
      const qualification = await tx.qualification.findFirst({
        where: { id: input.qualificationId, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (!qualification) throw new ValidationError('That qualification does not exist.');
    }

    const nextQualificationId = input.qualificationId ?? before.qualificationId;
    const nextInstitute = input.institute === undefined ? before.institute : input.institute;

    const clash = await tx.doctorQualification.findFirst({
      where: {
        doctorProfileId: doctorId,
        qualificationId: nextQualificationId,
        institute: nextInstitute,
        id: { not: before.id },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError('This doctor already has that qualification from that institute.');
    }

    const after = await tx.doctorQualification.update({
      where: { id: before.id },
      data: {
        ...(input.qualificationId !== undefined ? { qualificationId: input.qualificationId } : {}),
        ...(input.institute !== undefined ? { institute: input.institute } : {}),
        ...(input.yearOfCompletion !== undefined
          ? { yearOfCompletion: input.yearOfCompletion }
          : {}),
      },
      select: { id: true, qualificationId: true, institute: true, yearOfCompletion: true },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'doctor_qualification',
      entityId: before.id,
      before: {
        doctorProfileId: doctorId,
        qualificationId: before.qualificationId,
        institute: before.institute,
        yearOfCompletion: before.yearOfCompletion,
      },
      after: {
        doctorProfileId: doctorId,
        qualificationId: after.qualificationId,
        institute: after.institute,
        yearOfCompletion: after.yearOfCompletion,
      },
      ...options,
    });
  });
}

export async function removeQualification(
  ctx: TenantContext,
  doctorId: string,
  qualificationRowId: string,
  options: DoctorActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await tx.doctorQualification.findFirst({
      where: { id: qualificationRowId, doctorProfileId: doctorId },
      select: { id: true, qualificationId: true },
    });
    if (!row) throw new NotFoundError('Qualification');

    await tx.doctorQualification.delete({ where: { id: row.id } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'doctor_qualification',
      entityId: row.id,
      before: { doctorProfileId: doctorId, qualificationId: row.qualificationId },
      ...options,
    });
  });
}

/**
 * Resolve the slot length a schedule block will actually run at.
 *
 * Exported because the availability engine needs exactly this and must not
 * re-derive it — a second copy of the ladder is a second answer (ADR-0015).
 */
export async function effectiveSlotMinutes(
  tx: TxClient,
  ctx: TenantContext,
  scope: { branchId?: string | undefined; doctorProfileId?: string | undefined },
  override: number | null
): Promise<number> {
  if (override !== null) return override;

  const settings = await resolveSettings(tx, [SLOT_MINUTES_KEY], {
    organizationId: ctx.organizationId,
    ...(scope.branchId !== undefined ? { branchId: scope.branchId } : {}),
    ...(scope.doctorProfileId !== undefined ? { doctorProfileId: scope.doctorProfileId } : {}),
  });

  return asPositiveInt(settings.get(SLOT_MINUTES_KEY) ?? null, DEFAULT_SLOT_MINUTES);
}

/**
 * Colleagues this patient can be referred to (CE-5, §37).
 *
 * ⚠️ THIS IS NOT `listDoctors`, AND THE DIFFERENCE IS AN ACCESS DECISION RATHER
 *   THAN A QUERY OPTIMISATION. A DOCTOR deliberately does not hold
 *   `doctor.directory.read` — the roster is a personnel list, and `roles.ts`
 *   says so in as many words. But `encounter_referrals.doctor_profile_id` is a
 *   destination the contract offers and a CHECK constraint accepts, so the
 *   in-house referral has to be reachable from the screen that writes one.
 *
 *   What makes that safe is that this is a LOOKUP AND NOT AN ENUMERATION:
 *
 *     · `search` is REQUIRED, minimum two characters — there is no "list every
 *       doctor" form of this call, which is the whole reason it can sit behind
 *       a clinical code. You can confirm the colleague you already know; you
 *       cannot ask who works here.
 *     · The payload is a name and a primary specialty. No schedule, no contact
 *       details, no registration number, no fees, no employment status — every
 *       one of which `DoctorSummary` carries and the directory exists to serve.
 *     · ACTIVE profiles only. Referring a patient to somebody who has left is
 *       an instruction the patient cannot act on.
 *
 * ⚠️ AND IT IS NOT READ-AUDITED, WHICH IS CORRECT. A colleague's name is not
 *   PHI — no patient is named or implied by the request or the response. The
 *   referral that results IS audited, on the encounter, where the patient is.
 */
export async function searchReferralTargets(
  ctx: TenantContext,
  query: ReferralTargetQuery
): Promise<ReferralTarget[]> {
  return withTenant(ctx, async (tx) => {
    const profiles = await tx.doctorProfile.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        /*
         * ⚠️ `contains` WITH `mode: 'insensitive'`, NOT `$queryRaw`. The term is
         *   a bind parameter either way, but the query builder removes the
         *   question entirely — and this is a search box, which is where an
         *   interpolated string would land first.
         */
        user: { fullName: { contains: query.search, mode: 'insensitive' } },
      },
      select: {
        id: true,
        user: { select: { fullName: true } },
        specialties: {
          where: { isPrimary: true, isActive: true },
          select: { specialty: { select: { name: true } } },
          take: 1,
        },
      },
      orderBy: { user: { fullName: 'asc' } },
      take: query.pageSize,
    });

    return profiles.map((profile) => ({
      doctorProfileId: profile.id,
      name: profile.user.fullName,
      specialtyName: profile.specialties[0]?.specialty.name ?? null,
    }));
  });
}
