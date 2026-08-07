/**
 * Doctors: profiles, specialties, qualifications, per-branch fees and the
 * working hours the availability engine reads.
 *
 * ⚠️ SLOT DURATION HAS ONE AUTHORITATIVE SOURCE (ADR-0015).
 *   `slotMinutes` appears here ONLY on a schedule block, where null means
 *   "inherit". There is deliberately no `slotMinutes` on the branch-settings
 *   contract: the fallback is the resolved `appointment.slot_minutes` setting at
 *   DOCTOR → BRANCH → ORGANIZATION. Three fields claiming the same number is how
 *   the front desk's calendar and the patient portal end up disagreeing about
 *   whether 10:20 exists.
 */
import { z } from 'zod';
import { uuid } from './common.js';

/** `HH:MM`, wall-clock in the BRANCH's timezone. Never UTC. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM in 24-hour form');

/** `YYYY-MM-DD`, a calendar date in the branch's timezone. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * Money as a decimal string, never a float.
 *
 * A fee crosses the wire as "400.00" so no JSON number ever rounds it. The
 * service hands it straight to Prisma's Decimal.
 */
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'expected an amount like 400 or 400.00');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createDoctorRequest = z.object({
  /**
   * An existing member of the clinic. A doctor must be able to log in before
   * they can be scheduled, because they must be able to sign a prescription —
   * so onboarding is invite-then-profile, not profile-then-invite.
   */
  userId: uuid,
  registrationNumber: z.string().min(2).max(64).optional(),
  registrationCouncil: z.string().max(255).optional(),
  registrationValidTill: calendarDate.optional(),
  experienceYears: z.number().int().min(0).max(80).optional(),
  bio: z.string().max(4000).optional(),
  /** Specialty ids. Platform rows and this clinic's own are both valid. */
  specialtyIds: z.array(uuid).max(12).default([]),
  /** Which of `specialtyIds` leads the profile. Must be one of them. */
  primarySpecialtyId: uuid.optional(),
});

export const updateDoctorRequest = createDoctorRequest
  .omit({ userId: true })
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  });

export const doctorQualificationRequest = z.object({
  qualificationId: uuid,
  institute: z.string().max(255).optional(),
  yearOfCompletion: z.number().int().min(1900).max(2100).optional(),
});

export const doctorBranchSettingRequest = z.object({
  branchId: uuid,
  consultationFee: money.optional(),
  followUpFee: money.optional(),
  /** Days after a consultation within which a revisit is free. */
  followUpFreeDays: z.number().int().min(0).max(365).optional(),
  isActive: z.boolean().default(true),
});

/**
 * One recurring block of working hours.
 *
 * `endTime > startTime` is enforced here AND by a CHECK constraint. An overnight
 * clinic is two rows: allowing one would produce an inverted range that
 * `tstzrange` refuses deep inside the availability engine, where the error
 * cannot name a field.
 */
export const doctorScheduleRequest = z
  .object({
    branchId: uuid,
    /** 0 = Sunday, matching Postgres `extract(dow)` and `branch_operating_hours`. */
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: clockTime,
    endTime: clockTime,
    /** Null/absent inherits the resolved `appointment.slot_minutes` setting. */
    slotMinutes: z.number().int().min(5).max(240).optional(),
    /** Advisory cap on bookings in this block. Not enforced by a constraint. */
    maxPatients: z.number().int().min(1).max(500).optional(),
    validFrom: calendarDate,
    validTo: calendarDate.optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.endTime <= v.startTime) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'must be after the start time — an overnight clinic is two blocks',
      });
    }
    if (v.validTo && v.validTo < v.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'must not be before the start of the validity window',
      });
    }
  });

export const doctorScheduleExceptionRequest = z
  .object({
    /** Absent = every branch this doctor practises at. */
    branchId: uuid.optional(),
    exceptionType: z.enum(['LEAVE', 'BLOCK', 'EXTRA_SHIFT']),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    reason: z.string().max(255).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endsAt <= v.startsAt) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'must be after the start' });
    }
  });

/** Approve or reject a pending exception. A separate permission from raising one. */
export const decideScheduleExceptionRequest = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(255).optional(),
});

export const createSpecialtyRequest = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'uppercase letters, digits and underscores only'),
  name: z.string().min(2).max(255),
  parentId: uuid.optional(),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const specialtySummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  parentId: uuid.nullable(),
  /** False for a platform row, true for one this clinic added. */
  isOwn: z.boolean(),
});

export const qualificationSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  isOwn: z.boolean(),
});

export const doctorSpecialtyDetail = z.object({
  id: uuid,
  specialtyId: uuid,
  code: z.string(),
  name: z.string(),
  isPrimary: z.boolean(),
});

export const doctorQualificationDetail = z.object({
  id: uuid,
  qualificationId: uuid,
  code: z.string(),
  name: z.string(),
  institute: z.string().nullable(),
  yearOfCompletion: z.number().int().nullable(),
});

export const doctorBranchSettingDetail = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  consultationFee: z.string().nullable(),
  followUpFee: z.string().nullable(),
  followUpFreeDays: z.number().int().nullable(),
  isActive: z.boolean(),
});

export const doctorScheduleDetail = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  dayOfWeek: z.number().int(),
  startTime: z.string(),
  endTime: z.string(),
  /** Null means inherited — `effectiveSlotMinutes` says what it resolved to. */
  slotMinutes: z.number().int().nullable(),
  /** What the engine will actually use, after the settings ladder. */
  effectiveSlotMinutes: z.number().int(),
  maxPatients: z.number().int().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  isActive: z.boolean(),
});

export const doctorScheduleExceptionDetail = z.object({
  id: uuid,
  branchId: uuid.nullable(),
  branchName: z.string().nullable(),
  exceptionType: z.enum(['LEAVE', 'BLOCK', 'EXTRA_SHIFT']),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reason: z.string().nullable(),
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']),
  requestedBy: uuid.nullable(),
  decidedBy: uuid.nullable(),
  decidedAt: z.iso.datetime().nullable(),
});

/** The list row: enough to choose a doctor, without loading their whole file. */
export const doctorSummary = z.object({
  id: uuid,
  userId: uuid,
  fullName: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']),
  registrationNumber: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  primarySpecialty: z.string().nullable(),
  specialties: z.array(doctorSpecialtyDetail),
  /** Branches where this doctor has an ACTIVE branch setting. */
  branchIds: z.array(uuid),
});

export const doctorDetail = doctorSummary.extend({
  registrationCouncil: z.string().nullable(),
  registrationValidTill: z.string().nullable(),
  bio: z.string().nullable(),
  qualifications: z.array(doctorQualificationDetail),
  branchSettings: z.array(doctorBranchSettingDetail),
  schedules: z.array(doctorScheduleDetail),
  exceptions: z.array(doctorScheduleExceptionDetail),
});

export const doctorListResponse = z.object({ doctors: z.array(doctorSummary) });

export const specialtyListResponse = z.object({
  specialties: z.array(specialtySummary),
  qualifications: z.array(qualificationSummary),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecialtySummary = z.infer<typeof specialtySummary>;
export type QualificationSummary = z.infer<typeof qualificationSummary>;
export type DoctorSpecialtyDetail = z.infer<typeof doctorSpecialtyDetail>;
export type DoctorQualificationDetail = z.infer<typeof doctorQualificationDetail>;
export type DoctorBranchSettingDetail = z.infer<typeof doctorBranchSettingDetail>;
export type DoctorScheduleDetail = z.infer<typeof doctorScheduleDetail>;
export type DoctorScheduleExceptionDetail = z.infer<typeof doctorScheduleExceptionDetail>;
export type DoctorSummary = z.infer<typeof doctorSummary>;
export type DoctorDetail = z.infer<typeof doctorDetail>;
export type DoctorListResponse = z.infer<typeof doctorListResponse>;
export type SpecialtyListResponse = z.infer<typeof specialtyListResponse>;

export type CreateDoctorRequest = z.infer<typeof createDoctorRequest>;
export type UpdateDoctorRequest = z.infer<typeof updateDoctorRequest>;
export type DoctorQualificationRequest = z.infer<typeof doctorQualificationRequest>;
export type DoctorBranchSettingRequest = z.infer<typeof doctorBranchSettingRequest>;
export type DoctorScheduleRequest = z.infer<typeof doctorScheduleRequest>;
export type DoctorScheduleExceptionRequest = z.infer<typeof doctorScheduleExceptionRequest>;
export type DecideScheduleExceptionRequest = z.infer<typeof decideScheduleExceptionRequest>;
export type CreateSpecialtyRequest = z.infer<typeof createSpecialtyRequest>;
