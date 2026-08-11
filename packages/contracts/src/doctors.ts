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
import { feeScheduleAmount } from './fees.js';

/** `HH:MM`, wall-clock in the BRANCH's timezone. Never UTC. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM in 24-hour form');

/** `YYYY-MM-DD`, a calendar date in the branch's timezone. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

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

/**
 * ⚠️ THE NESTED COLLECTIONS ON `createDoctorRequest` ARE DELIBERATELY NOT HERE.
 *   PATCH edits the profile; qualifications, working hours, fees and pay each
 *   have their own endpoint with its own permission, and folding them into the
 *   partial update would give whoever may fix a typo in a bio a second, ungated
 *   route to a colleague's salary. They exist on create only because a doctor is
 *   registered in one sitting — see `createDoctorRequest`.
 */
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

/**
 * Correct a qualification already on a doctor.
 *
 * ⚠️ NULL CLEARS, ABSENT LEAVES ALONE, AND THE TWO ARE NOT THE SAME. `institute`
 *   and `yearOfCompletion` are nullable here and merely optional on the create
 *   request above, because correcting a record includes removing something that
 *   was entered in error. A partial update that treated a missing key as "clear"
 *   would wipe the institute every time somebody fixed the year — the same
 *   data-loss shape `updateDoctorRequest` documents about `specialtyIds`.
 *
 * ⚠️ `qualificationId` IS EDITABLE, DELIBERATELY. The commonest correction is
 *   picking the wrong degree from a list of near-identical names, and forcing a
 *   delete-then-add for that loses the row's `createdAt` and files two audit
 *   entries for one correction.
 */
export const updateDoctorQualificationRequest = z.object({
  qualificationId: uuid.optional(),
  institute: z.string().max(255).nullable().optional(),
  yearOfCompletion: z.number().int().min(1900).max(2100).nullable().optional(),
});

/**
 * Whether a doctor consults at a branch, and the free-revisit window there.
 *
 * ⚠️ NO FEES. `consultationFee` and `followUpFee` were here and are now the fee
 *   schedule's, because a price is per VISIT TYPE and two fields could only ever
 *   describe two of the five kinds of appointment this product books. They live
 *   at `PUT /v1/doctors/:doctorId/fees`, where a clinic default is inherited
 *   unless this doctor overrides it.
 *
 *   `followUpFreeDays` stays: it is not money. It is the window inside which a
 *   revisit is free, which is a property of the relationship between a doctor
 *   and a branch rather than a line on a price list.
 */
export const doctorBranchSettingRequest = z.object({
  branchId: uuid,
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

/**
 * How often the clinic has agreed to pay a doctor.
 *
 * ⚠️ `PER_SESSION` OVERLAPS WITH THE CONSULTATION FEE AND IS NOT THE SAME FACT.
 *   One is what the clinic PAYS the practitioner for turning up; the other is
 *   what the PATIENT is charged for being seen. A clinic can run both at once
 *   and most visiting-consultant arrangements do.
 */
export const payoutInterval = z.enum([
  'MONTHLY',
  'FORTNIGHTLY',
  'WEEKLY',
  'DAILY',
  'HOURLY',
  'PER_SESSION',
]);
export type PayoutIntervalValue = z.infer<typeof payoutInterval>;

/**
 * Agree what the clinic pays this doctor, or clear it.
 *
 * ⚠️ THIS LIVES IN THE REQUESTS SECTION ABOVE `createDoctorRequest` BECAUSE THAT
 *   SCHEMA EMBEDS IT. Zod schemas are values, so a reference below its use is a
 *   `ReferenceError` at import time rather than a type error — which is why the
 *   pay and schedule schemas were moved up here rather than left beside their
 *   response shapes.
 */
export const setDoctorCompensationRequest = z
  .object({
    /** Null clears the agreement. Zero is an agreed figure of nothing. */
    amountMinor: z.int().min(0).max(9_999_999_999).nullable(),
    interval: payoutInterval.nullable(),
  })
  .superRefine((value, ctx) => {
    /*
     * An amount without an interval is a number nobody can act on — "800,000"
     * is a fine salary and an absurd hourly rate — and an interval without an
     * amount is a schedule for paying nothing. They travel together.
     */
    if ((value.amountMinor === null) !== (value.interval === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval'],
        message: 'An amount and an interval are set together, or both cleared.',
      });
    }
  });
export type SetDoctorCompensationRequest = z.infer<typeof setDoctorCompensationRequest>;

/**
 * Register a doctor — the whole practitioner, in one submission.
 *
 * ⚠️ THE NESTED COLLECTIONS ARE PART OF THE CREATE AND OF NOTHING ELSE. A clinic
 *   registering a consultant knows their council number, their degrees, the days
 *   they consult, what patients are charged and what the clinic pays them, and
 *   knows all of it at the same moment. Making them save a bare profile and then
 *   walk five more screens produced doctors with no working hours, which is a
 *   doctor the front desk cannot book at all.
 *
 * ⚠️ ONE TRANSACTION, SO A REJECTED SCHEDULE MEANS NO DOCTOR. The alternative —
 *   the client firing five sequential calls — leaves a half-registered doctor
 *   behind whenever the third one 409s, and no screen owns cleaning that up.
 *
 * ⚠️ AND EVERY NESTED SECTION IS GATED SEPARATELY AT THE ROUTE. `doctor.create`
 *   gets you the profile; the hours need `doctor.schedule.manage`, the prices
 *   `billing.fee_schedule.manage` and the salary `doctor.compensation.manage`.
 *   Without those checks this body would be a way for whoever may add a
 *   colleague to also set their pay, which is precisely the fusion
 *   `doctor-compensation.service.ts` refuses at every other door.
 */
export const createDoctorRequest = z
  .object({
    ...doctorProfileFields,
    /** Degrees, with the institute and year where the clinic has them. */
    qualifications: z.array(doctorQualificationRequest).max(24).optional(),
    /** The recurring week. Blocks are validated against each other before insert. */
    schedules: z.array(doctorScheduleRequest).max(60).optional(),
    /**
     * Opening prices, at this doctor's organization-wide scope (`branchId` null).
     * Per-branch overrides are the fee grid's job on the profile afterwards.
     */
    fees: z.array(feeScheduleAmount).max(64).optional(),
    /** What the clinic pays. Omitted entirely means "nothing agreed yet". */
    compensation: setDoctorCompensationRequest.optional(),
  })
  .superRefine(oneClassificationForm);

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

/**
 * What the clinic has agreed to pay this doctor.
 *
 * ⚠️ A RECORD, NOT A PAYROLL RUN (§0.2 decision 6). There are no periods, no
 *   payslips, no reconciliation against what the doctor actually billed — that
 *   is the deferred Phase 4 compensation module, and `billing.doctor_payout.manage`
 *   was named for it. Nothing here moves money.
 *
 * ⚠️ ONE FIGURE PER DOCTOR, ORGANIZATION-WIDE (decision 7). A person has one
 *   employment contract; splitting it across branches is cost allocation, which
 *   is a different problem and not this one.
 *
 * ⚠️ NULL IS "NOT AGREED YET", AND IT IS NOT ZERO. An unpaid honorary consultant
 *   is a real arrangement and a clinic that has not got round to entering a
 *   salary is a different state; collapsing them shows every new doctor as
 *   working for nothing.
 */
export const doctorCompensationDetail = z.object({
  doctorProfileId: uuid,
  /** The organization's currency — what `amountMinor` is denominated in. */
  currency: z.string().length(3),
  amountMinor: z.int().nullable(),
  interval: payoutInterval.nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type DoctorCompensationDetail = z.infer<typeof doctorCompensationDetail>;

export const doctorBranchSettingDetail = z.object({
  id: uuid,
  branchId: uuid,
  branchName: z.string(),
  /** ⚠️ Fees are no longer here — see `doctorBranchSettingRequest`. */
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
  /**
   * The recurring week, so the roster can show who consults when.
   *
   * ⚠️ THREE STATES, AND THE THIRD IS THE FIELD NOT BEING THERE — the same shape
   *   as `liveInvoice` on `appointmentSummary`, for the same reason. An array
   *   means the caller holds `doctor.schedule.read`; `undefined` means nobody
   *   asked and the column is simply not on their screen. Sending `[]` to a
   *   caller who may not read schedules would state that a doctor has no working
   *   hours, which is a claim where absence is a silence.
   *
   * ⚠️ THE SPLIT FROM `doctor.directory.read` IS LOAD-BEARING. The roster is
   *   readable by the front desk; block caps, validity windows and inherited slot
   *   lengths are configuration, and the portal reads free slots through the
   *   availability engine without ever seeing them. See `doctors.routes.ts`.
   */
  schedules: z.array(doctorScheduleDetail).optional(),
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
export type UpdateDoctorQualificationRequest = z.infer<typeof updateDoctorQualificationRequest>;
export type DoctorBranchSettingRequest = z.infer<typeof doctorBranchSettingRequest>;
export type DoctorScheduleRequest = z.infer<typeof doctorScheduleRequest>;
export type DoctorScheduleExceptionRequest = z.infer<typeof doctorScheduleExceptionRequest>;
export type DecideScheduleExceptionRequest = z.infer<typeof decideScheduleExceptionRequest>;
