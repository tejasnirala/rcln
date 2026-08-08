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
import { specialtyProficiency, taxonomyNodeType } from './clinical-taxonomy.js';
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

/**
 * One clinical classification, with the detail a bare id cannot carry.
 *
 * The richer half of the two request forms below. Everything but `specialtyId`
 * is optional, so `{ specialtyId }` and a plain id are the same assignment.
 */
export const doctorClassificationInput = z
  .object({
    specialtyId: uuid,
    /** Advisory display label. ⚠️ NEVER an authorization input. */
    proficiency: specialtyProficiency.nullish(),
    effectiveFrom: calendarDate.nullish(),
    effectiveTo: calendarDate.nullish(),
  })
  .refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: 'effectiveTo cannot be before effectiveFrom',
    path: ['effectiveTo'],
  });

const doctorProfileFields = {
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
  /**
   * Specialty ids. Platform rows and this clinic's own are both valid.
   *
   * The simple form, and still the one the existing screens send. Equivalent to
   * `classifications: ids.map(specialtyId => ({ specialtyId }))`.
   */
  specialtyIds: z.array(uuid).max(12).default([]),
  /**
   * The richer form: the same set, plus proficiency and effective dates.
   *
   * ⚠️ SUPPLY ONE FORM OR THE OTHER, NEVER BOTH — the refinement below rejects
   *   that outright rather than picking a winner. Two fields describing one set
   *   is exactly how a client ends up "saving" specialties that silently do not
   *   persist because the other field took precedence.
   */
  classifications: z.array(doctorClassificationInput).max(24).optional(),
  /**
   * Which entry leads the profile. Must be one of the supplied ids, in whichever
   * form was used.
   *
   * ⚠️ ANCESTORS ARE NOT ASSIGNED, AND THAT IS DELIBERATE. Tagging a doctor with
   *   Structural Heart Disease does NOT write rows for Interventional Cardiology
   *   and Cardiology. Those are DERIVED — `GET /clinical-taxonomy/:id/ancestors`
   *   renders the chain, and the descendant-aware doctor filter finds this doctor
   *   under Cardiology anyway. Materialising the ancestors would copy the tree
   *   into this join table, and re-parenting a node would then silently
   *   invalidate every row written before the move.
   */
  primarySpecialtyId: uuid.optional(),
} as const;

/**
 * Reject the two request forms being used at once.
 *
 * `specialtyIds` defaults to `[]`, so "both supplied" is `classifications`
 * present AND `specialtyIds` non-empty.
 */
const oneClassificationForm = (
  v: { specialtyIds?: string[] | undefined; classifications?: unknown[] | undefined },
  ctx: z.RefinementCtx
): void => {
  if (v.classifications !== undefined && (v.specialtyIds?.length ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['classifications'],
      message: 'Supply either specialtyIds or classifications, not both.',
    });
  }
};

export const createDoctorRequest = z.object(doctorProfileFields).superRefine(oneClassificationForm);

/**
 * ⚠️ `specialtyIds` IS REDECLARED WITHOUT ITS `.default([])`, AND THAT FIXES A
 *   SILENT DATA-LOSS BUG. Do not "tidy" it back to inheriting the create shape.
 *
 *   `.partial()` makes a key optional but does NOT suppress a default nested
 *   inside it: `z.object({ ids: z.array(uuid).default([]) }).partial()` parses
 *   `{ bio: 'x' }` into `{ bio: 'x', specialtyIds: [] }`. Verified, not assumed.
 *
 *   The service treats "specialtyIds supplied" as "replace the set with exactly
 *   this", so under the inherited shape EVERY partial update carried an empty
 *   set — `PATCH { bio }` deleted every specialty the doctor had. No error, 200
 *   OK, and the classifications simply gone. Dropping the default restores the
 *   distinction PATCH depends on: absent means "leave alone", `[]` means "clear".
 */
const updateDoctorFields = z
  .object(doctorProfileFields)
  .omit({ userId: true })
  .partial()
  .extend({
    specialtyIds: z.array(uuid).max(12).optional(),
  });

export const updateDoctorRequest = updateDoctorFields
  .extend({
    status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  })
  .superRefine(oneClassificationForm);

/**
 * Filters for the doctor list.
 *
 * ⚠️ `specialtyId` IS A SUBTREE FILTER, NOT AN EQUALITY FILTER. Asking for
 *   Cardiology returns doctors tagged Cardiology, Interventional Cardiology,
 *   Structural Heart Disease and everything else beneath it. That is what
 *   "find me a cardiologist" means, and it is the reason this cannot be a
 *   name match — a doctor tagged only "Structural Heart Disease" has no
 *   "cardio" anywhere in their record.
 *
 *   `includeDescendants=false` narrows it to that exact node, for the rare
 *   caller who wants "tagged precisely this and nothing below it".
 */
export const doctorListQuery = z.object({
  specialtyId: uuid.optional(),
  includeDescendants: z.stringbool().default(true),
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

// `createSpecialtyRequest` was here. It was declared, exported, and imported by
// nothing — no route, no service, no screen ever used it. It is replaced by
// `createTaxonomyNodeRequest` in clinical-taxonomy.ts, which is wired to a real
// endpoint and carries the type/description/displayOrder the tree needs. Leaving
// both would have meant two contracts for one operation and a coin flip about
// which one a future caller picks.

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * A specialty as the doctor screens need it.
 *
 * ⚠️ ADDITIVE ONLY. `doctor-list.tsx` and `appointment-board.tsx` already read
 *   this shape; the taxonomy fields below were appended and nothing was removed
 *   or renamed. The richer traversal shape is `taxonomyNode` in
 *   `clinical-taxonomy.ts` — this stays the flat catalogue entry.
 */
export const specialtySummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  parentId: uuid.nullable(),
  /** False for a platform row, true for one this clinic added. */
  isOwn: z.boolean(),
  type: taxonomyNodeType,
  description: z.string().nullable(),
  displayOrder: z.number().int(),
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
  /** Where this classification sits in the tree. For rendering, never for authz. */
  type: taxonomyNodeType,
  proficiency: specialtyProficiency.nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  /**
   * ⚠️ THE ASSIGNMENT'S OWN FLAG, NOT THE NODE'S. A doctor may still hold a
   *   classification whose taxonomy node has since been retired, and it is
   *   returned regardless — dropping it would rewrite their history to say they
   *   were never trained in something they were. Read the node's status from
   *   the taxonomy API if a screen needs to mark it as no longer offered.
   */
  isActive: z.boolean(),
  /**
   * The chain from the clinical domain down to this node's parent, root first.
   * The node itself is not repeated — a breadcrumb is `[...ancestors, this]`.
   *
   * ⚠️ DERIVED ON READ, NOT STORED. Assigning "Structural Heart Disease" writes
   *   ONE `doctor_specialties` row; Medical, Cardiology and Interventional
   *   Cardiology are computed from `parent_id` when the profile is read.
   *
   *   Storing them as extra rows was considered and rejected: re-parenting a
   *   node would leave every row written before the move asserting a chain that
   *   is no longer true, silently and with nothing to detect it. Deriving costs
   *   one recursive CTE per request and cannot go stale.
   *
   *   This is what the brief means by "do not require clients to provide
   *   redundant ancestors" — the server resolves the path, the client renders it.
   */
  ancestors: z.array(
    z.object({
      id: uuid,
      code: z.string(),
      name: z.string(),
      type: taxonomyNodeType,
    })
  ),
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

export type DoctorClassificationInput = z.infer<typeof doctorClassificationInput>;
export type DoctorListQuery = z.infer<typeof doctorListQuery>;
export type CreateDoctorRequest = z.infer<typeof createDoctorRequest>;
export type UpdateDoctorRequest = z.infer<typeof updateDoctorRequest>;
export type DoctorQualificationRequest = z.infer<typeof doctorQualificationRequest>;
export type DoctorBranchSettingRequest = z.infer<typeof doctorBranchSettingRequest>;
export type DoctorScheduleRequest = z.infer<typeof doctorScheduleRequest>;
export type DoctorScheduleExceptionRequest = z.infer<typeof doctorScheduleExceptionRequest>;
export type DecideScheduleExceptionRequest = z.infer<typeof decideScheduleExceptionRequest>;
