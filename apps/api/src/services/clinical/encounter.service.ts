/**
 * The consultation: opening it, autosaving it, signing it, correcting it (CE-3).
 *
 * ⚠️ EVERY TEXT COLUMN HERE IS PHI, and the patient rules apply unchanged.
 *   Nothing reaches `recordAudit` except through the allow-list snapshot below —
 *   which reports THAT a chief complaint was recorded and never WHAT — every
 *   read that discloses one consultation writes a `data_access_logs` row under
 *   `ENCOUNTER`, and ids only in logs, in Redis and in a URL.
 *
 * ── THE LIFECYCLE, AND THE ONE RULE UNDERNEATH IT ────────────────────────────
 *
 *   open  →  DRAFT (created, or the existing one resumed)
 *              │  autosave, debounced, as often as the doctor types
 *              ▼
 *          FINALIZED  ── immutable, for ever (CD-2)
 *              │
 *              └─ amend → a NEW DRAFT citing it; this row becomes AMENDED
 *
 * ⚠️ NOTHING EDITS A FINALIZED CONSULTATION. Not a typo, not a correction, not
 *   "just this once". The correction is a fresh row that cites the old one,
 *   states a reason and is signed in its own right, and both stay readable for
 *   ever. A clinical record that can be silently rewritten is not a record —
 *   which is why `assertDraft` guards every writer here, exactly as
 *   `assertVersionIsDraft` guards the template service and `assertPackIsOpen`
 *   guards PI-5.
 *
 * ⚠️ AND THE CONFIGURATION IS FROZEN AT OPEN, NOT AT FINALIZE (§29). A clinic
 *   that publishes a new template version while a doctor is mid-consultation
 *   must not have the fields move under the cursor, and a record finalized in
 *   2026 must render through the 2026 form for ever. `template_snapshot` is
 *   written once and never rewritten.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import {
  documentProblems,
  requiredContentSections,
  validateEncounter,
  type ConsultationSectionType,
  type SectionAnswers,
  type TemplateDefinition,
} from '@rcln/clinical';
import type {
  AmendEncounterRequest,
  CancelEncounterRequest,
  EncounterDetail,
  EncounterSaveResponse,
  OpenEncounterRequest,
  SaveEncounterDraftRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { parseStoredDefinition } from './definition.js';
import { resolveConfiguration, sectionConfigs } from './consultation-config.service.js';
import { copyContentToAmendment, encounterContentOf } from './encounter-content.service.js';

const ENCOUNTER_PREFIX = 'ENC';

/** Request metadata, carried onto both trails. */
export interface EncounterRequestOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/**
 * ⚠️ THE ALLOW-LIST THAT KEEPS A DIAGNOSIS OUT OF THE AUDIT TRAIL.
 *
 *   `chiefComplaint`, `clinicalNotes`, `amendmentReason` and `cancelledReason`
 *   are absent, and their absence is the entire protection — the same call
 *   `episode.service.ts` makes about `title`. `REDACTED_KEYS` is the backstop
 *   under this, not a substitute for it.
 *
 *   "A chief complaint was recorded" is the auditable fact; what it said belongs
 *   to whoever may read the chart. DO NOT WIDEN THIS.
 */
function snapshot(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    encounterNumber: row.encounterNumber,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    clinicalEpisodeId: row.clinicalEpisodeId,
    doctorProfileId: row.doctorProfileId,
    templateVersionId: row.templateVersionId,
    hasChiefComplaint: row.chiefComplaint !== null && row.chiefComplaint !== '',
    hasClinicalNotes: row.clinicalNotes !== null && row.clinicalNotes !== '',
    amendsEncounterId: row.amendsEncounterId,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
  };
}

const AUDIT_SELECT = {
  id: true,
  status: true,
  encounterNumber: true,
  patientId: true,
  appointmentId: true,
  clinicalEpisodeId: true,
  doctorProfileId: true,
  templateVersionId: true,
  chiefComplaint: true,
  clinicalNotes: true,
  amendsEncounterId: true,
  finalizedAt: true,
} as const;

const DETAIL_SELECT = {
  ...AUDIT_SELECT,
  branchId: true,
  templateId: true,
  templateSnapshot: true,
  chiefComplaintDurationValue: true,
  chiefComplaintDurationUnit: true,
  onset: true,
  startedAt: true,
  amendedAt: true,
  amendmentReason: true,
  cancelledAt: true,
  cancelledReason: true,
  sections: {
    select: { sectionType: true, sectionKey: true, data: true, displayOrder: true },
    orderBy: { displayOrder: 'asc' },
  },
} as const;

type AuditRow = Prisma.EncounterGetPayload<{ select: typeof AUDIT_SELECT }>;
type DetailRow = Prisma.EncounterGetPayload<{ select: typeof DETAIL_SELECT }>;

/**
 * A stored JSONB column as an object.
 *
 * ⚠️ A NON-OBJECT READS AS EMPTY RATHER THAN THROWING, and this is the one place
 *   in the clinical code where a permissive read is right. `data` is written
 *   only by the autosave, which is given a validated object; a scalar or an
 *   array in that column means somebody wrote to the table by hand. Refusing to
 *   render the whole consultation over it would hide the fifteen sections that
 *   are fine — and finalization still refuses, because an empty section fails
 *   its required descriptors.
 */
function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The section answers as `@rcln/clinical` wants them. */
function answersOf(row: DetailRow): SectionAnswers[] {
  return row.sections.map((section) => ({
    key: section.sectionKey,
    data: asRecord(section.data),
  }));
}

/**
 * A whole consultation, rendered through ITS OWN FROZEN SNAPSHOT (§29).
 *
 * ⚠️ NEVER THROUGH THE LIVE TEMPLATE. A template edited in 2029 changes nothing
 *   about a consultation finalized in 2026, because the 2026 row carries its own
 *   copy of the configuration and never reads the template table to display
 *   itself. `parseStoredDefinition` is the one door to that copy — a service
 *   that reached into the JSONB would have deleted the guarantee.
 */
async function toDetail(tx: TxClient, row: DetailRow): Promise<EncounterDetail> {
  const definition = parseStoredDefinition(row.templateSnapshot, `Encounter ${row.id}`);
  const configuration = await sectionConfigs(tx, definition);
  /*
   * ⚠️ THE FIRST-CLASS CONTENT IS LOADED HERE AND ASSEMBLED NOWHERE ELSE
   *   (CE-4). One reader and one shape: a second assembly in the content
   *   service would be the same nine queries written twice, and the two would
   *   start to disagree about ordering the first time either was touched.
   */
  const content = await encounterContentOf(tx, row.id);

  return {
    content,
    id: row.id,
    status: row.status,
    encounterNumber: row.encounterNumber,
    branchId: row.branchId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    clinicalEpisodeId: row.clinicalEpisodeId,
    doctorProfileId: row.doctorProfileId,
    templateId: row.templateId,
    templateVersionId: row.templateVersionId,
    chiefComplaint: row.chiefComplaint,
    chiefComplaintDurationValue: row.chiefComplaintDurationValue,
    chiefComplaintDurationUnit: row.chiefComplaintDurationUnit,
    onset: row.onset,
    clinicalNotes: row.clinicalNotes,
    startedAt: row.startedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    amendsEncounterId: row.amendsEncounterId,
    amendedAt: row.amendedAt?.toISOString() ?? null,
    amendmentReason: row.amendmentReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
    configuration,
    answers: row.sections.map((section) => ({
      sectionType: section.sectionType,
      key: section.sectionKey,
      data: asRecord(section.data),
      displayOrder: section.displayOrder,
    })),
  };
}

/**
 * ⚠️ 404, NOT 403, FOR A BRANCH OUTSIDE THE CALLER'S SCOPE — whether a branch
 *   exists is itself tenant information, and the two responses tell an outsider
 *   apart from a colleague.
 */
function assertBranchInScope(ctx: TenantContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw new NotFoundError('Encounter');
}

/**
 * ⚠️ THE GUARD THAT MAKES A SIGNED RECORD A RECORD. Every writer calls it. A
 *   FINALIZED consultation is corrected by an amendment and never by an edit; an
 *   AMENDED one has already been superseded; a CANCELLED one was abandoned.
 */
function assertDraft(row: { status: string }): void {
  if (row.status === 'DRAFT') return;
  if (row.status === 'FINALIZED' || row.status === 'AMENDED') {
    throw new ConflictError(
      'This consultation has been signed. Correct it by recording an amendment, which keeps both records.'
    );
  }
  throw new ConflictError('This consultation was cancelled.');
}

/**
 * The one live consultation of a visit, if there is one.
 *
 * ⚠️ `DRAFT` OR `FINALIZED`, AND NEVER THE SUPERSEDED ONES. An amendment
 *   supersedes its original (CD-2), so an appointment carries a chain and
 *   exactly one row of it is current — the partial unique index says the same
 *   thing to the database. Three callers ask this question, and asking it three
 *   ways is how one of them would eventually resume a cancelled draft.
 */
async function liveEncounterFor(tx: TxClient, appointmentId: string): Promise<DetailRow | null> {
  return tx.encounter.findFirst({
    where: { appointmentId, deletedAt: null, status: { in: ['DRAFT', 'FINALIZED'] } },
    select: DETAIL_SELECT,
  });
}

async function loadForWrite(tx: TxClient, encounterId: string): Promise<DetailRow> {
  const row = await tx.encounter.findFirst({
    where: { id: encounterId, deletedAt: null },
    select: DETAIL_SELECT,
  });
  /* 404, never 403 — RLS has already filtered another tenant's row out. */
  if (!row) throw new NotFoundError('Encounter');
  return row;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

interface EncounterSubject {
  branchId: string;
  patientId: string;
  appointmentId: string | null;
  clinicalEpisodeId: string;
  doctorProfileId: string;
  subjectType: string;
}

/**
 * Where a walk-in happened.
 *
 * ⚠️ NEVER GUESSED WHEN THE CALLER CAN SEE SEVERAL BRANCHES. A consultation
 *   filed at the wrong site is invisible to the people who need it and visible
 *   to people who should not have it, because `branch_id` is what the RLS policy
 *   reads. One branch in scope is unambiguous; more than one is a question.
 */
function walkInBranch(ctx: TenantContext, requested: string | undefined): string {
  if (requested !== undefined) {
    assertBranchInScope(ctx, requested);
    return requested;
  }
  const only = ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined;
  if (only === undefined) {
    throw new ValidationError('Say which branch this walk-in consultation is at.');
  }
  return only;
}

async function subjectFromRequest(
  tx: TxClient,
  ctx: TenantContext,
  input: OpenEncounterRequest
): Promise<EncounterSubject> {
  if (input.appointmentId !== undefined) {
    const appointment = await tx.appointment.findFirst({
      where: { id: input.appointmentId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        patientId: true,
        doctorProfileId: true,
        clinicalEpisodeId: true,
        status: true,
        patient: { select: { subjectType: true } },
      },
    });
    if (!appointment) throw new NotFoundError('Appointment');
    assertBranchInScope(ctx, appointment.branchId);
    /*
     * ⚠️ A CANCELLED BOOKING IS NOT A VISIT. Writing a consultation against one
     *   would put a clinical record on a slot the clinic says did not happen —
     *   and the day board, the invoice and the recall list all read that status.
     */
    if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
      throw new ConflictError('That appointment did not take place.');
    }
    return {
      branchId: appointment.branchId,
      patientId: appointment.patientId,
      appointmentId: appointment.id,
      clinicalEpisodeId: appointment.clinicalEpisodeId,
      doctorProfileId: appointment.doctorProfileId,
      subjectType: appointment.patient.subjectType,
    };
  }

  /* A walk-in (CD-1): no booking, so every id the booking would have carried is
     supplied or derived here. */
  const patientId = input.patientId;
  const clinicalEpisodeId = input.clinicalEpisodeId;
  /* Both are guaranteed by the contract's refinements; the checks are for the
     type system and for any future caller that bypasses the route. */
  if (patientId === undefined || clinicalEpisodeId === undefined) {
    throw new ValidationError('A walk-in consultation needs a patient and a treatment journey.');
  }

  const branchId = walkInBranch(ctx, input.branchId);

  const patient = await tx.patient.findFirst({
    where: { id: patientId, deletedAt: null },
    select: { id: true, status: true, subjectType: true },
  });
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'MERGED') {
    throw new ConflictError('That record has been merged into another one.');
  }

  const episode = await tx.clinicalEpisode.findFirst({
    where: { id: clinicalEpisodeId, deletedAt: null },
    select: { id: true, patientId: true, status: true },
  });
  if (!episode) throw new NotFoundError('Clinical episode');
  /*
   * ⚠️ THE PATIENT CHECK IS NOT PARANOIA — the same one `resolveEpisodeForBooking`
   *   makes. Both ids arrive from one form, and a picker that does not re-filter
   *   when the patient changes files one person's consultation under another
   *   person's treatment history.
   */
  if (episode.patientId !== patientId) throw new NotFoundError('Clinical episode');
  if (episode.status === 'CLOSED') {
    throw new ConflictError('That treatment journey has been closed.');
  }

  const doctorProfileId = await resolveDoctorProfile(tx, ctx, input.doctorProfileId);

  return {
    branchId,
    patientId,
    appointmentId: null,
    clinicalEpisodeId,
    doctorProfileId,
    subjectType: patient.subjectType,
  };
}

/**
 * Whose consultation this is.
 *
 * ⚠️ DEFAULTS TO THE ACTING USER'S OWN DOCTOR PROFILE AND NEVER TO "THE FIRST
 *   DOCTOR AT THIS BRANCH". A clinical record names who wrote it; a default that
 *   guessed would attribute one clinician's findings to another.
 */
async function resolveDoctorProfile(
  tx: TxClient,
  ctx: TenantContext,
  requested: string | undefined
): Promise<string> {
  if (requested !== undefined) {
    const profile = await tx.doctorProfile.findFirst({
      where: { id: requested, deletedAt: null },
      select: { id: true },
    });
    if (!profile) throw new NotFoundError('Doctor');
    return profile.id;
  }

  if (ctx.userId === undefined) {
    throw new ValidationError('Say which doctor is conducting this consultation.');
  }
  const own = await tx.doctorProfile.findFirst({
    where: { userId: ctx.userId, deletedAt: null },
    select: { id: true },
  });
  if (!own) {
    throw new ValidationError(
      'You have no doctor profile, so say which doctor is conducting this consultation.'
    );
  }
  return own.id;
}

/**
 * Open the consultation for a visit — or resume the one already open.
 *
 * ⚠️ IDEMPOTENT, AND THE PARTIAL UNIQUE INDEX IS WHAT MAKES IT SAFE. A second
 *   call for the same appointment returns the SAME draft: a double-click, two
 *   tabs or a resumed session must not each produce a record of one visit. The
 *   read below is the fast path and the index is the guarantee — under a race,
 *   the second INSERT fails on the index rather than succeeding quietly.
 *
 * ⚠️ AND RESUMING RETURNS THE EXISTING SNAPSHOT UNTOUCHED. Re-resolving the
 *   template on resume is exactly the bug §29 describes: a clinic that publishes
 *   a new version at lunchtime would move the fields under a doctor who started
 *   at eleven.
 *
 * ⚠️ AND THE LOST RACE IS RESOLVED HERE RATHER THAN RETURNED (CE-8). The read
 *   below is a fast path, not a lock: two tabs opening one visit at the same
 *   instant both find nothing and both INSERT, and the index refuses the second.
 *   That refusal used to reach the doctor as a 409 on the one screen they cannot
 *   proceed without — for a consultation that exists and is theirs. The retry
 *   below re-reads it and answers with it, which is what the first call would
 *   have done a millisecond earlier.
 *
 *   ⚠️ IT RETRIES OUTSIDE THE TRANSACTION, NOT INSIDE IT. A constraint violation
 *     aborts the Postgres transaction; every subsequent statement in it fails
 *     with 25P02, so a `catch` around the INSERT could not read anything.
 */
export async function openEncounter(
  ctx: TenantContext,
  input: OpenEncounterRequest,
  options: EncounterRequestOptions = {}
): Promise<EncounterDetail> {
  const appointmentId = input.appointmentId;
  try {
    return await openEncounterOnce(ctx, input, options);
  } catch (error) {
    if (appointmentId === undefined || !isUniqueViolation(error)) throw error;

    /*
     * ⚠️ THIS PATH IS REACHABLE ONLY AFTER `openEncounterOnce` GOT AS FAR AS THE
     *   INSERT, AND THAT PRECONDITION IS LOAD-BEARING. `subjectFromRequest` has
     *   therefore already refused a cancelled booking, a booking at a branch
     *   outside scope, a merged patient and a closed episode — none of which is
     *   re-checked here, because none of them can have become true in the
     *   milliseconds since.
     *
     * ⚠️ AND THE RE-READ IS `getEncounterForAppointment`, NOT A SECOND COPY OF
     *   IT. That function already asks exactly this question — the live
     *   consultation of a visit, branch-checked, disclosure logged — and two
     *   implementations of "which record is current for this booking" is how one
     *   of them eventually resumes a cancelled draft.
     */
    const resumed = await getEncounterForAppointment(ctx, appointmentId, options);
    /*
     * ⚠️ NOTHING TO RESUME MEANS THE CLASH WAS SOMETHING ELSE ENTIRELY — a
     *   live amendment, a future constraint, a bug — and it becomes a 409 rather
     *   than being rethrown raw. A bare `23505` from the driver adapter is
     *   neither an `AppError` nor `P2002`, so rethrowing produces a 500 and a
     *   stack carrying the constraint's key values.
     *
     *   ⚠️ BUT THE ORIGINAL IS LOGGED BEFORE IT IS REPLACED. The caller gets the
     *     right status either way; the operator would otherwise lose the only
     *     evidence of WHICH constraint fired, and be told to retry something
     *     that will never succeed.
     */
    if (resumed === null) {
      logger.error(
        { err: error, appointmentId, organizationId: ctx.organizationId },
        'encounter insert hit a unique violation with no live encounter to resume'
      );
      throw new ConflictError('That consultation could not be opened. Try again.');
    }
    return resumed;
  }
}

/**
 * ⚠️ A UNIQUE VIOLATION, HOWEVER PRISMA 7 HAPPENS TO WRAP IT. The pg driver
 *   adapter does not always surface `P2002` — a raw `23505` arrives on the
 *   driver error instead — and `clinical-taxonomy.service.ts` says the same
 *   thing at more length. Reading both is what keeps this working across an
 *   adapter change.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002' || code === '23505') return true;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    return causeCode === 'P2002' || causeCode === '23505';
  }
  return false;
}

async function openEncounterOnce(
  ctx: TenantContext,
  input: OpenEncounterRequest,
  options: EncounterRequestOptions
): Promise<EncounterDetail> {
  return withTenant(ctx, async (tx) => {
    const subject = await subjectFromRequest(tx, ctx, input);

    if (subject.appointmentId !== null) {
      const existing = await liveEncounterFor(tx, subject.appointmentId);
      if (existing) {
        await recordDataAccess(tx, ctx, {
          accessType: 'VIEW',
          resource: 'ENCOUNTER',
          patientId: subject.patientId,
          resourceId: existing.id,
          ...options,
        });
        return toDetail(tx, existing);
      }
    }

    const resolved = await resolveConfiguration(tx, {
      subjectType: subject.subjectType,
      doctorProfileId: subject.doctorProfileId,
    });

    const created = await tx.encounter.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: subject.branchId,
        patientId: subject.patientId,
        appointmentId: subject.appointmentId,
        clinicalEpisodeId: subject.clinicalEpisodeId,
        doctorProfileId: subject.doctorProfileId,
        templateId: resolved.template.id,
        templateVersionId: resolved.template.versionId,
        /*
         * ⚠️ THE PARSED DEFINITION, NOT THE RAW COLUMN. What is frozen is what
         *   the engine understood, so a record renders from a document that has
         *   already been through the grammar once.
         */
        templateSnapshot: resolved.definition as unknown as Prisma.InputJsonObject,
      },
      select: DETAIL_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'encounter',
      entityId: created.id,
      after: snapshot(created),
      branchId: subject.branchId,
      ...options,
    });

    return toDetail(tx, created);
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One consultation, whole.
 *
 * ⚠️ WRITES A `data_access_logs` ROW, ALWAYS. This discloses one named patient's
 *   clinical record — the exact read this table exists for. The consultation
 *   CONFIG endpoint deliberately does not; the difference is that this one
 *   carries what the doctor wrote.
 */
export async function getEncounter(
  ctx: TenantContext,
  encounterId: string,
  options: EncounterRequestOptions = {}
): Promise<EncounterDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await loadForWrite(tx, encounterId);
    assertBranchInScope(ctx, row.branchId);

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'ENCOUNTER',
      patientId: row.patientId,
      resourceId: row.id,
      ...options,
    });

    return toDetail(tx, row);
  });
}

/**
 * The consultation recorded at one visit, if there is one.
 *
 * ⚠️ THE READER'S DOOR, AND IT DELIBERATELY CANNOT OPEN A DRAFT. `openEncounter`
 *   creates one, which is an act of authorship — an administrator opening a
 *   booking to read it must not thereby make "the doctor started a
 *   consultation" true. So the read is its own function behind its own code,
 *   and it answers `null` rather than creating anything.
 *
 * ⚠️ THE LIVE ONE, NOT EVERY ONE. An amendment supersedes its original (CD-2),
 *   so an appointment can carry several rows and exactly one of them is current.
 *   The visit-history surface that shows the whole chain is CE-5.
 */
export async function getEncounterForAppointment(
  ctx: TenantContext,
  appointmentId: string,
  options: EncounterRequestOptions = {}
): Promise<EncounterDetail | null> {
  return withTenant(ctx, async (tx) => {
    const row = await liveEncounterFor(tx, appointmentId);
    if (!row) return null;
    if (!ctx.branchIds.includes(row.branchId)) return null;

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'ENCOUNTER',
      patientId: row.patientId,
      resourceId: row.id,
      ...options,
    });

    return toDetail(tx, row);
  });
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/**
 * A debounced partial save of a draft (CD-8).
 *
 * ⚠️ IT VALIDATES NOTHING AGAINST THE DESCRIPTORS, AND THAT IS THE POINT. A
 *   draft is allowed to be incomplete — a doctor half way through an examination
 *   must not be interrupted by an error about a field they have not reached.
 *   What must be impossible is SIGNING an incomplete record, and that check
 *   lives on `finalizeEncounter`.
 *
 * ⚠️ NO AUDIT ROW PER KEYSTROKE. An autosave every few seconds for the length of
 *   a consultation would write hundreds of rows saying "a draft changed", which
 *   is the same mistake as auditing the day board — and `updatedAt` already
 *   records that it did. The audited events are the ones that change what the
 *   record IS: created, signed, amended, cancelled.
 */
export async function saveEncounterDraft(
  ctx: TenantContext,
  encounterId: string,
  input: SaveEncounterDraftRequest
): Promise<EncounterSaveResponse> {
  /*
   * ⚠️ THE SHAPE IS CHECKED BEFORE THE TRANSACTION OPENS, AND THE MEANING AT
   *   FINALIZATION (CE-8). A draft is allowed to be incomplete — that is what a
   *   draft IS — but it is not allowed to be a document nothing can render, and
   *   `data` is an open record on the wire by necessity, so this is the only
   *   place between an autosave and the JSONB column.
   *
   *   ⚠️ OUTSIDE `withTenant` BECAUSE IT NEEDS NOTHING FROM IT. Serialising a
   *     fifty-section payload inside the transaction would hold a pooled
   *     connection open for the length of a check whose whole purpose is to
   *     refuse that payload — the caller pays for the abuse twice.
   */
  for (const section of input.sections ?? []) {
    const shape = documentProblems(section.key, section.data);
    if (shape.length > 0) {
      throw new ValidationError(shape.map((entry) => entry.problem).join('; '));
    }
  }

  return withTenant(ctx, async (tx) => {
    const row = await loadForWrite(tx, encounterId);
    assertBranchInScope(ctx, row.branchId);
    assertDraft(row);

    const definition = parseStoredDefinition(row.templateSnapshot, `Encounter ${row.id}`);

    if (input.sections !== undefined && input.sections.length > 0) {
      /*
       * ⚠️ A SECTION KEY THE SNAPSHOT DOES NOT DECLARE IS REFUSED HERE RATHER
       *   THAN AT FINALIZATION. Storing it would mean a row that renders nowhere,
       *   and the clinician who typed into a renamed field would discover at
       *   signing time that what they wrote is gone.
       */
      const declared = new Map(definition.sections.map((section) => [section.key, section]));
      for (const section of input.sections) {
        const declaredSection = declared.get(section.key);
        if (declaredSection === undefined) {
          throw new ValidationError(`"${section.key}" is not a section of this consultation.`);
        }

        await tx.encounterSection.upsert({
          where: {
            organizationId_encounterId_sectionKey: {
              organizationId: ctx.organizationId,
              encounterId: row.id,
              sectionKey: section.key,
            },
          },
          create: {
            organizationId: ctx.organizationId,
            branchId: row.branchId,
            encounterId: row.id,
            sectionType: declaredSection.type,
            sectionKey: section.key,
            data: section.data as Prisma.InputJsonObject,
            displayOrder: declaredSection.order,
          },
          update: { data: section.data as Prisma.InputJsonObject },
          select: { id: true },
        });
      }
    }

    const updated = await tx.encounter.update({
      where: { id: row.id },
      data: {
        ...(input.chiefComplaint !== undefined ? { chiefComplaint: input.chiefComplaint } : {}),
        ...(input.chiefComplaintDurationValue !== undefined
          ? { chiefComplaintDurationValue: input.chiefComplaintDurationValue }
          : {}),
        ...(input.chiefComplaintDurationUnit !== undefined
          ? { chiefComplaintDurationUnit: input.chiefComplaintDurationUnit }
          : {}),
        ...(input.onset !== undefined ? { onset: input.onset } : {}),
        ...(input.clinicalNotes !== undefined ? { clinicalNotes: input.clinicalNotes } : {}),
      },
      select: { id: true, status: true, updatedAt: true },
    });

    return {
      id: updated.id,
      status: updated.status,
      savedAt: updated.updatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------

/**
 * The required first-class sections that have nothing in them (CE-4).
 *
 * ⚠️ THE HALF `@rcln/clinical` CANNOT ANSWER. The engine says WHICH sections a
 *   clinic marked required; the counting is here because the answers are rows
 *   in eight tables and that package holds no Prisma client and never will
 *   (CD-10). The rule itself is stated in exactly one place — the template.
 *
 * ⚠️ CE-6 CLOSED THE ONE PERMISSIVE BRANCH THIS FUNCTION HAD. `VISUAL_MAPPING`
 *   used to fall through `countFor`'s default and answer 1 — "there is
 *   something there" — because it was required-able with no table behind it.
 *   `clinical_findings` exists now, so it is counted like every other list, and
 *   `countFor` is exhaustive over the section types rather than defaulting. A
 *   template that requires a chart can no longer be signed with nothing drawn
 *   on it.
 */
async function missingRequiredContent(
  tx: TxClient,
  row: { id: string; chiefComplaint: string | null; clinicalNotes: string | null },
  definition: TemplateDefinition
): Promise<string[]> {
  const problems: string[] = [];

  for (const section of requiredContentSections(definition)) {
    switch (section.type) {
      /* Columns on `encounters`, not lists — see the engine's note. */
      case 'CHIEF_COMPLAINT':
        if (row.chiefComplaint === null || row.chiefComplaint.trim() === '') {
          problems.push(`"${section.label}" is required`);
        }
        break;
      case 'CLINICAL_NOTES':
        if (row.clinicalNotes === null || row.clinicalNotes.trim() === '') {
          problems.push(`"${section.label}" is required`);
        }
        break;
      default: {
        const count = await countFor(tx, section.type, row.id);
        if (count === 0) problems.push(`"${section.label}" has nothing recorded`);
      }
    }
  }

  return problems;
}

/**
 * How many rows one first-class section has.
 *
 * ⚠️ EXHAUSTIVE OVER `ConsultationSectionType`, WITH NO PERMISSIVE DEFAULT. The
 *   four members that answer 1 do so because they are not lists at all —
 *   CHIEF_COMPLAINT and CLINICAL_NOTES are columns the caller checked directly,
 *   and HISTORY and EXAMINATION are descriptor-driven and never reach here
 *   (`requiredContentSections` filters them out). A `default:` returning 1 would
 *   make a section type added to the engine and forgotten here silently
 *   signable — which is exactly what VISUAL_MAPPING was until this phase.
 */
async function countFor(
  tx: TxClient,
  type: ConsultationSectionType,
  encounterId: string
): Promise<number> {
  const where = { encounterId };
  switch (type) {
    case 'SYMPTOMS':
      return tx.encounterSymptom.count({ where });
    case 'DIAGNOSIS':
      return tx.encounterDiagnosis.count({ where });
    case 'PROCEDURE':
      return tx.encounterProcedure.count({ where });
    case 'PRESCRIPTION':
      return tx.encounterPrescription.count({ where });
    case 'INVESTIGATION':
      return tx.encounterInvestigation.count({ where });
    case 'ADVICE':
      return tx.encounterAdvice.count({ where });
    case 'REFERRAL':
      return tx.encounterReferral.count({ where });
    case 'ATTACHMENTS':
      return tx.encounterAttachment.count({ where });
    case 'FOLLOW_UP':
      return tx.encounterFollowUpRecommendation.count({
        where: { encounterId, deletedAt: null },
      });
    case 'VISUAL_MAPPING':
      return tx.clinicalFinding.count({ where });
    /* Not lists. See the note above — the caller checks the two columns itself,
       and the two descriptor-driven types never arrive here. */
    case 'CHIEF_COMPLAINT':
    case 'CLINICAL_NOTES':
    case 'HISTORY':
    case 'EXAMINATION':
      return 1;
  }
}

/**
 * Sign the record.
 *
 * The transaction that validates every descriptor-driven section against the
 * encounter's own snapshot, burns the branch's next encounter number, and
 * records who signed it.
 *
 * ⚠️ THE NUMBER IS ISSUED HERE AND NOT AT OPEN, so an abandoned draft burns
 *   none — the rule the four procurement counters follow. `issueNumber` takes a
 *   row lock held until COMMIT, so it is the last thing done before the write.
 */
export async function finalizeEncounter(
  ctx: TenantContext,
  encounterId: string,
  options: EncounterRequestOptions = {}
): Promise<EncounterDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await loadForWrite(tx, encounterId);
    assertBranchInScope(ctx, row.branchId);
    assertDraft(row);

    if (ctx.userId === undefined) {
      throw new ValidationError('A consultation is signed by a person.');
    }

    const definition = parseStoredDefinition(row.templateSnapshot, `Encounter ${row.id}`);
    const validated = validateEncounter(definition, answersOf(row));
    const contentProblems = await missingRequiredContent(tx, row, definition);
    if (!validated.ok || contentProblems.length > 0) {
      /*
       * ⚠️ BOTH HALVES IN ONE SENTENCE, AND ALL OF EACH. A doctor sent back
       *   three times for three missing things learns to distrust the button —
       *   which is why `encounterProblems` returns every descriptor problem
       *   rather than the first, and why the content problems are appended
       *   rather than checked in a second, earlier throw.
       */
      const problems = [...(validated.ok ? [] : [validated.problem]), ...contentProblems];
      throw new ValidationError(`This consultation is not complete: ${problems.join('; ')}`);
    }

    const number = await issueNumber(tx, ctx, {
      type: 'ENCOUNTER',
      branchId: row.branchId,
      prefix: ENCOUNTER_PREFIX,
    });

    const updated = await tx.encounter.update({
      where: { id: row.id },
      data: {
        status: 'FINALIZED',
        encounterNumber: number.formatted,
        finalizedAt: new Date(),
        finalizedBy: ctx.userId,
      },
      select: DETAIL_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'encounter',
      entityId: row.id,
      before: snapshot(row),
      after: snapshot(updated),
      branchId: row.branchId,
      ...options,
    });

    return toDetail(tx, updated);
  });
}

// ---------------------------------------------------------------------------
// Amending
// ---------------------------------------------------------------------------

/**
 * Correct a signed record by starting a new one that cites it (CD-2).
 *
 * ⚠️ THE ORIGINAL IS NOT TOUCHED BEYOND ITS STATUS. Its content, its number, its
 *   signature and its timestamps stay exactly as they were signed; it moves to
 *   AMENDED, which is how the chart knows it is no longer current. Both rows are
 *   readable for ever, which is the whole difference between an amendment and an
 *   edit.
 *
 * ⚠️ THE NEW ROW IS A DRAFT, NOT A SIGNED COPY. An amendment is a consultation
 *   in its own right: it is written, it is checked against the same snapshot,
 *   and it is signed by whoever made it.
 *
 * ⚠️ AND IT CARRIES THE ORIGINAL'S SNAPSHOT, NOT TODAY'S TEMPLATE. A correction
 *   to a 2026 record is a statement about the 2026 form; re-resolving would make
 *   the amendment answer a different set of questions from the record it
 *   corrects.
 */
export async function amendEncounter(
  ctx: TenantContext,
  encounterId: string,
  input: AmendEncounterRequest,
  options: EncounterRequestOptions = {}
): Promise<EncounterDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await loadForWrite(tx, encounterId);
    assertBranchInScope(ctx, row.branchId);

    if (row.status !== 'FINALIZED') {
      throw new ConflictError(
        row.status === 'DRAFT'
          ? 'This consultation has not been signed yet — edit it instead.'
          : 'Only the current signed consultation can be amended.'
      );
    }

    /* Marked first, so the partial unique index sees one live row per
       appointment at every point in the transaction. */
    const superseded = await tx.encounter.update({
      where: { id: row.id },
      data: { status: 'AMENDED', amendedAt: new Date() },
      select: AUDIT_SELECT,
    });

    const created = await tx.encounter.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: row.branchId,
        patientId: row.patientId,
        appointmentId: row.appointmentId,
        clinicalEpisodeId: row.clinicalEpisodeId,
        doctorProfileId: row.doctorProfileId,
        templateId: row.templateId,
        templateVersionId: row.templateVersionId,
        templateSnapshot: row.templateSnapshot as Prisma.InputJsonObject,
        amendsEncounterId: row.id,
        amendmentReason: input.reason,
        /* The content is carried over so the clinician corrects a copy of what
           was signed rather than retyping a consultation from memory. */
        chiefComplaint: row.chiefComplaint,
        chiefComplaintDurationValue: row.chiefComplaintDurationValue,
        chiefComplaintDurationUnit: row.chiefComplaintDurationUnit,
        onset: row.onset,
        clinicalNotes: row.clinicalNotes,
        sections: {
          create: row.sections.map((section) => ({
            organizationId: ctx.organizationId,
            branchId: row.branchId,
            sectionType: section.sectionType,
            sectionKey: section.sectionKey,
            data: asRecord(section.data) as Prisma.InputJsonObject,
            displayOrder: section.displayOrder,
          })),
        },
      },
      select: DETAIL_SELECT,
    });

    /*
     * ⚠️ THE CLINICAL CONTENT IS COPIED, NOT MOVED (CE-4). The record being
     *   corrected keeps every diagnosis, prescription and order it was signed
     *   with — that is the whole difference between an amendment and an edit.
     *   The copy also REMAPS `procedures.diagnosis_id`, without which every
     *   procedure on the amendment would cite a diagnosis on the original: a
     *   reference the composite FK happily permits and the chart cannot render.
     */
    await copyContentToAmendment(tx, ctx, row, { id: created.id, branchId: row.branchId });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'encounter',
      entityId: row.id,
      before: snapshot(row),
      after: snapshot(superseded),
      branchId: row.branchId,
      ...options,
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'encounter',
      entityId: created.id,
      after: snapshot(created),
      branchId: row.branchId,
      ...options,
    });

    /* Re-read: the copy above landed after `created` was selected. */
    return toDetail(tx, await loadForWrite(tx, created.id));
  });
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Abandon a draft.
 *
 * ⚠️ A DRAFT ONLY, AND THAT IS NOT AN OVERSIGHT. A signed consultation is never
 *   withdrawn — it is corrected by an amendment, which leaves both records
 *   standing. "This visit's record was deleted" is exactly what a clinical
 *   trail must never be able to say.
 *
 * ⚠️ RECORDED RATHER THAN DELETED. "The doctor started a consultation and
 *   abandoned it" is a fact about a visit, and the row keeps the appointment's
 *   history honest.
 */
export async function cancelEncounter(
  ctx: TenantContext,
  encounterId: string,
  input: CancelEncounterRequest,
  options: EncounterRequestOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const row = await loadForWrite(tx, encounterId);
    assertBranchInScope(ctx, row.branchId);
    assertDraft(row);

    const updated = await tx.encounter.update({
      where: { id: row.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        ...(ctx.userId !== undefined ? { cancelledBy: ctx.userId } : {}),
        ...(input.reason !== undefined ? { cancelledReason: input.reason } : {}),
      },
      select: AUDIT_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'encounter',
      entityId: row.id,
      before: snapshot(row),
      after: snapshot(updated),
      branchId: row.branchId,
      ...options,
    });
  });
}
