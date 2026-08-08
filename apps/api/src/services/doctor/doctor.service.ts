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
  DoctorDetail,
  DoctorQualificationRequest,
  DoctorSummary,
  SpecialtyListResponse,
  UpdateDoctorRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
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
      specialty: { select: { code: true, name: true } },
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

function toSummary(row: DoctorRow): DoctorSummary {
  const specialties = row.specialties.map((s) => ({
    id: s.id,
    specialtyId: s.specialtyId,
    code: s.specialty.code,
    name: s.specialty.name,
    isPrimary: s.isPrimary,
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

function toDetail(row: DoctorRow): Omit<DoctorDetail, 'schedules' | 'exceptions'> {
  return {
    ...toSummary(row),
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
        select: { id: true, code: true, name: true, parentId: true, organizationId: true },
        orderBy: { name: 'asc' },
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

export async function listDoctors(ctx: TenantContext): Promise<DoctorSummary[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx.doctorProfile.findMany({
      where: { deletedAt: null },
      select: DOCTOR_SELECT,
      orderBy: { user: { fullName: 'asc' } },
    })
  );
  return rows.map(toSummary);
}

/**
 * Validate the specialty set before it reaches the database.
 *
 * The RESTRICTIVE `specialty_visible` policy would refuse an out-of-tenant id
 * anyway, but as a row-level security violation with no field name attached.
 * Reading them first turns that into a message naming what was wrong.
 */
async function assertSpecialtiesUsable(
  tx: TxClient,
  specialtyIds: string[],
  primaryId: string | undefined
): Promise<void> {
  if (specialtyIds.length === 0) {
    if (primaryId) {
      throw new ValidationError('A primary specialty must be one of the selected specialties.');
    }
    return;
  }

  const found = await tx.specialty.findMany({
    where: { id: { in: specialtyIds }, isActive: true, deletedAt: null },
    select: { id: true },
  });

  if (found.length !== specialtyIds.length) {
    throw new ValidationError('One or more specialties do not exist or are no longer active.');
  }
  if (primaryId && !specialtyIds.includes(primaryId)) {
    throw new ValidationError('A primary specialty must be one of the selected specialties.');
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

    await assertSpecialtiesUsable(tx, input.specialtyIds, input.primarySpecialtyId);

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
          create: input.specialtyIds.map((specialtyId) => ({
            organizationId: ctx.organizationId,
            specialtyId,
            isPrimary: specialtyId === input.primarySpecialtyId,
          })),
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

    return created;
  });

  return { ...toDetail(row), schedules: [], exceptions: [] };
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

    if (input.specialtyIds !== undefined) {
      await assertSpecialtiesUsable(tx, input.specialtyIds, input.primarySpecialtyId);

      // Replaced as a set: a doctor's specialties are read together, and a
      // partial update leaves no record of which entries are current.
      await tx.doctorSpecialty.deleteMany({ where: { doctorProfileId: doctorId } });
      await tx.doctorSpecialty.createMany({
        data: input.specialtyIds.map((specialtyId) => ({
          organizationId: ctx.organizationId,
          doctorProfileId: doctorId,
          specialtyId,
          isPrimary: specialtyId === input.primarySpecialtyId,
        })),
      });
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

    return after;
  });

  return toDetail(row);
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
