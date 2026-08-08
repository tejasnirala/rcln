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
  DoctorSummary,
  DoctorSpecialtyDetail,
  SpecialtyListResponse,
  UpdateDoctorRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { descendantRows } from './clinical-taxonomy.service.js';
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
      consultationFee: true,
      followUpFee: true,
      followUpFreeDays: true,
      isActive: true,
      branch: { select: { name: true } },
    },
  },
} as const;

type DoctorRow = Prisma.DoctorProfileGetPayload<{ select: typeof DOCTOR_SELECT }>;

/** `Decimal | null` -> the contract's decimal string. Never a float. */
function money(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

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
      consultationFee: money(b.consultationFee),
      followUpFee: money(b.followUpFee),
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
export async function listDoctors(
  ctx: TenantContext,
  query: DoctorListQuery = { includeDescendants: true }
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
          return { profiles: [] as DoctorRow[], chains: new Map() as AncestorChains };
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
    return { profiles, chains };
  });
  return rows.profiles.map((p) => toSummary(p, rows.chains));
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

export async function createDoctor(
  ctx: TenantContext,
  input: CreateDoctorRequest,
  options: DoctorActionOptions = {}
): Promise<DoctorDetail> {
  const row = await withTenant(ctx, async (tx) => {
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
        ...(input.experienceYears !== undefined ? { experienceYears: input.experienceYears } : {}),
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

    const chains = await loadAncestorChains(
      tx,
      created.specialties.map((s) => s.specialtyId)
    );
    return { created, chains };
  });

  return { ...toDetail(row.created, row.chains), schedules: [], exceptions: [] };
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
      ...(input.consultationFee !== undefined ? { consultationFee: input.consultationFee } : {}),
      ...(input.followUpFee !== undefined ? { followUpFee: input.followUpFee } : {}),
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
        ...(input.yearOfCompletion !== undefined
          ? { yearOfCompletion: input.yearOfCompletion }
          : {}),
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
