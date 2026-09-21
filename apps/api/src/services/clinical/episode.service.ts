/**
 * Treatment journeys — the grouping every appointment belongs to.
 *
 * ⚠️ AN EPISODE IS PHI. Its `title` is a clinical statement about a named person
 *   ("Androgenetic alopecia — management"), and so are `notes` and
 *   `closureReason`. The patient rules apply unchanged: nothing here reaches
 *   `recordAudit` except through the allow-list snapshot below, every read that
 *   discloses ONE episode calls `recordDataAccess` under `CLINICAL_EPISODE`, and
 *   ids only in logs, in Redis and in a URL.
 *
 * ── THE THREE QUESTIONS, AND WHY THIS FILE ONLY ANSWERS ONE ──────────────────
 *
 *   "what visit did this come from?"  ->  appointments.parent_appointment_id
 *   "what journey is this part of?"   ->  THIS FILE
 *   "what did the doctor ASK for?"    ->  follow-up recommendations (CE-4)
 *
 * The chain is not enough on its own: walking it is a recursive CTE on every
 * render where the episode is one indexed equality, a journey can BRANCH when a
 * patient is sent to a colleague and back, and a journey can start WITHOUT a
 * chain because a walk-in has no booking at all.
 *
 * See .kb/Consultation/FOLLOW_UP_ARCHITECTURE.md.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ClinicalEpisodeDetail,
  ClinicalEpisodeListResponse,
  ClinicalEpisodeQuery,
  CreateClinicalEpisodeRequest,
  UpdateClinicalEpisodeRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { assertBranchInScope } from '../shared/branch.js';

const EPISODE_PREFIX = 'EP';

/** Request metadata, carried onto the read trail. */
export interface EpisodeReadOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/**
 * A `@db.Date` column comes back as a Date pinned to UTC midnight.
 *
 * ⚠️ `toISOString().slice(0, 10)` IS CORRECT HERE AND WOULD BE WRONG FOR A
 *   TIMESTAMP. Postgres hands back a DATE with no zone, and the driver builds it
 *   at UTC midnight — so the UTC calendar day IS the stored day. Running it
 *   through a timezone conversion would shift it.
 */
function toCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * ⚠️ THE ALLOW-LIST THAT KEEPS A DIAGNOSIS OUT OF THE AUDIT TRAIL.
 *
 *   `title`, `notes` and `closureReason` are absent, and their absence is the
 *   entire protection — exactly as `appointments.reason` is kept out by
 *   `snapshot()` there rather than by `REDACTED_KEYS`. A deny-list cannot help:
 *   `title` is PHI here and is not PHI on half a dozen other entities that carry
 *   a column of that name.
 *
 *   DO NOT WIDEN THIS. Adding a field is a disclosure into a table compliance
 *   staff read without any right to read patient records.
 */
function snapshot(row: {
  id: string;
  code: string;
  status: string;
  patientId: string;
  primarySpecialtyId: string | null;
  openedOn: Date;
  closedOn: Date | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    patientId: row.patientId,
    primarySpecialtyId: row.primarySpecialtyId,
    openedOn: row.openedOn.toISOString(),
    closedOn: row.closedOn?.toISOString() ?? null,
  };
}

interface OpenEpisodeInput {
  patientId: string;
  /** The branch whose timezone decides what calendar day this opened on. */
  branchId: string;
  /** ⚠️ PHI. Optional — see below. */
  title?: string | undefined;
  primarySpecialtyId?: string | undefined;
}

/**
 * Open a journey.
 *
 * ⚠️ `title` IS OPTIONAL AND USUALLY ABSENT AT THIS POINT, DELIBERATELY. An
 *   episode is opened when a booking is made, and at booking time nobody yet
 *   knows what the journey is about — the front desk has a name and a slot. A
 *   required title would be answered with "Consultation" forever. The screen
 *   renders an untitled episode by its first diagnosis instead, which is a fact
 *   rather than a guess.
 *
 * ⚠️ `openedOn` IS RESOLVED IN POSTGRES FROM THE BRANCH'S ZONE, never in Node.
 *   The container runs UTC, so `new Date()` at 00:30 IST files the journey under
 *   the previous calendar day for every clinic in India. Same trap
 *   `branchLocalDate` exists for on the availability path.
 */
export async function openEpisode(
  tx: TxClient,
  ctx: TenantContext,
  input: OpenEpisodeInput
): Promise<{ id: string; code: string }> {
  const dates = await tx.$queryRaw<{ local_date: Date }[]>`
    SELECT (now() AT TIME ZONE b.timezone)::date AS local_date
      FROM branches b
     WHERE b.id = ${input.branchId}::uuid
  `;
  const openedOn = dates[0]?.local_date;
  if (!openedOn) throw new NotFoundError('Branch');

  /*
   * ⚠️ LAST BEFORE THE INSERT, for the reason `createAppointment` documents:
   * `issueNumber` takes a row lock held until COMMIT. Everything that can be
   * done without it is done above.
   *
   * No `branchId` — the counter is per ORGANIZATION (see NumberSequenceType).
   * A journey follows the patient, who is org-wide.
   */
  const number = await issueNumber(tx, ctx, {
    type: 'CLINICAL_EPISODE',
    prefix: EPISODE_PREFIX,
  });

  const created = await tx.clinicalEpisode.create({
    data: {
      organizationId: ctx.organizationId,
      patientId: input.patientId,
      code: number.formatted,
      openedOn,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.primarySpecialtyId !== undefined
        ? { primarySpecialtyId: input.primarySpecialtyId }
        : {}),
      ...(ctx.userId !== undefined ? { openedBy: ctx.userId } : {}),
    },
    select: {
      id: true,
      code: true,
      status: true,
      patientId: true,
      primarySpecialtyId: true,
      openedOn: true,
      closedOn: true,
    },
  });

  await recordAudit(tx, ctx, {
    action: 'CREATE',
    entityType: 'clinical_episode',
    entityId: created.id,
    after: snapshot(created),
    branchId: input.branchId,
  });

  return { id: created.id, code: created.code };
}

interface ResolveEpisodeInput {
  patientId: string;
  branchId: string;
  /**
   * The journey the caller explicitly chose — the front desk saying "this is
   * about the same thing as last time".
   */
  clinicalEpisodeId?: string | undefined;
  /**
   * Set only when booking a follow-up. The parent's journey is inherited
   * without anybody being asked, because a follow-up IS by definition a
   * continuation of what it follows.
   */
  inheritFromEpisodeId?: string | undefined;
}

/**
 * Decide which journey a new booking joins.
 *
 * ```text
 * booked as a follow-up of X   ->  X's episode, inherited silently
 * the caller named an episode  ->  that one, after checking it is usable
 * anything else                ->  a NEW episode opens
 * ```
 *
 * ⚠️ THE DEFAULT IS A NEW EPISODE, AND IT IS NEVER "THE PATIENT'S MOST RECENT
 *   OPEN ONE". That fallback is the tempting one and it is a clinical claim the
 *   software has no basis for: guessing that a sore throat in March belongs to
 *   January's diabetes journey is a diagnosis made by a default value. Joining
 *   an existing journey is always somebody's explicit decision — the follow-up
 *   link, or the front desk saying so.
 *
 * ⚠️ AN EPISODE OF ONE IS THE ORDINARY CASE, not a degenerate one. A single
 *   acute visit that never repeats is a complete journey, which is why the
 *   column is NOT NULL rather than nullable.
 */
export async function resolveEpisodeForBooking(
  tx: TxClient,
  ctx: TenantContext,
  input: ResolveEpisodeInput
): Promise<string> {
  if (input.inheritFromEpisodeId !== undefined) return input.inheritFromEpisodeId;

  if (input.clinicalEpisodeId !== undefined) {
    /*
     * `findFirst`, not `findUnique`, so RLS decides whether it is visible — a
     * caller naming another tenant's episode id must get "not found" and not a
     * foreign-key error that confirms the row exists.
     */
    const episode = await tx.clinicalEpisode.findFirst({
      where: { id: input.clinicalEpisodeId, deletedAt: null },
      select: { id: true, patientId: true, status: true },
    });
    if (!episode) throw new NotFoundError('Clinical episode');

    /*
     * ⚠️ THE PATIENT CHECK IS NOT PARANOIA. Both ids arrive from the same form,
     * and an episode picker that does not re-filter when the patient changes
     * would file one person's visit under another person's treatment history —
     * a PHI leak that looks like a UI bug and reads like a clinical record.
     */
    if (episode.patientId !== input.patientId) {
      throw new NotFoundError('Clinical episode');
    }
    if (episode.status === 'CLOSED') {
      throw new NotFoundError('Clinical episode');
    }
    return episode.id;
  }

  const opened = await openEpisode(tx, ctx, {
    patientId: input.patientId,
    branchId: input.branchId,
  });
  return opened.id;
}

// ---------------------------------------------------------------------------
// Reads
//
// ⚠️ EVERY ONE OF THESE DISCLOSES A NAMED PATIENT'S TREATMENT HISTORY, so every
//   one writes a `data_access_logs` row inside the transaction that read it.
//   That is the intended cost of the surface, not an oversight to optimise away.
// ---------------------------------------------------------------------------

/**
 * Every journey a patient has been on, newest first (§18).
 *
 * ⚠️ VISIT HISTORY BELONGS TO THE PATIENT, NOT TO THE CONSULTATION READING IT.
 *   `Patient -> Clinical Episode -> Appointments -> Consultations`. Nesting it
 *   under the current encounter would make one visit's record own the history of
 *   every other, and an amendment to the current one would sit above records it
 *   has no business owning.
 */
export async function listEpisodes(
  ctx: TenantContext,
  query: ClinicalEpisodeQuery,
  options: EpisodeReadOptions = {}
): Promise<ClinicalEpisodeListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      patientId: query.patientId,
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [total, rows] = await Promise.all([
      tx.clinicalEpisode.count({ where }),
      tx.clinicalEpisode.findMany({
        where,
        select: {
          id: true,
          code: true,
          title: true,
          status: true,
          patientId: true,
          primarySpecialtyId: true,
          primarySpecialty: { select: { name: true } },
          openedOn: true,
          closedOn: true,
          _count: { select: { appointments: true } },
        },
        /* Newest journey first, and `code` breaks the tie so the order is total
           — two episodes opened on one day would otherwise shuffle per query. */
        orderBy: [{ openedOn: 'desc' }, { code: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    await recordDataAccess(tx, ctx, {
      accessType: 'SEARCH',
      resource: 'CLINICAL_EPISODE',
      patientId: query.patientId,
      resultCount: rows.length,
      ...options,
    });

    return {
      episodes: rows.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        status: r.status,
        patientId: r.patientId,
        primarySpecialtyId: r.primarySpecialtyId,
        primarySpecialtyName: r.primarySpecialty?.name ?? null,
        openedOn: toCalendarDate(r.openedOn),
        closedOn: r.closedOn === null ? null : toCalendarDate(r.closedOn),
        appointmentCount: r._count.appointments,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

/**
 * One journey and its visits, in order — the timeline (§18, §19).
 *
 * ⚠️ THE APPOINTMENTS CARRY `parentAppointmentId` SO THE SCREEN CAN DRAW BOTH
 *   RELATIONSHIPS AT ONCE. The episode says which visits belong to the journey;
 *   the parent link says which came from which. A timeline that showed only the
 *   first would lose the fact that C was booked off B rather than off A.
 */
export async function getEpisode(
  ctx: TenantContext,
  episodeId: string,
  options: EpisodeReadOptions = {}
): Promise<ClinicalEpisodeDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.clinicalEpisode.findFirst({
      where: { id: episodeId, deletedAt: null },
      select: {
        id: true,
        code: true,
        title: true,
        notes: true,
        closureReason: true,
        status: true,
        patientId: true,
        primarySpecialtyId: true,
        primarySpecialty: { select: { name: true } },
        openedOn: true,
        closedOn: true,
        appointments: {
          where: { deletedAt: null },
          select: {
            id: true,
            appointmentNumber: true,
            scheduledStart: true,
            status: true,
            visitType: true,
            doctorProfileId: true,
            parentAppointmentId: true,
            doctorProfile: { select: { user: { select: { fullName: true } } } },
          },
          orderBy: { scheduledStart: 'asc' },
        },
      },
    });
    if (!row) throw new NotFoundError('Clinical episode');

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'CLINICAL_EPISODE',
      patientId: row.patientId,
      resourceId: row.id,
      ...options,
    });

    return {
      id: row.id,
      code: row.code,
      title: row.title,
      notes: row.notes,
      closureReason: row.closureReason,
      status: row.status,
      patientId: row.patientId,
      primarySpecialtyId: row.primarySpecialtyId,
      primarySpecialtyName: row.primarySpecialty?.name ?? null,
      openedOn: toCalendarDate(row.openedOn),
      closedOn: row.closedOn === null ? null : toCalendarDate(row.closedOn),
      appointmentCount: row.appointments.length,
      appointments: row.appointments.map((a) => ({
        id: a.id,
        appointmentNumber: a.appointmentNumber,
        scheduledStart: a.scheduledStart.toISOString(),
        status: a.status,
        visitType: a.visitType,
        doctorProfileId: a.doctorProfileId,
        doctorName: a.doctorProfile.user.fullName,
        parentAppointmentId: a.parentAppointmentId,
      })),
    };
  });
}

/**
 * Open a journey explicitly. Rare — booking normally does it.
 *
 * Exists for the front desk that knows, before any slot is picked, that a
 * patient is starting a course of treatment.
 */
export async function createEpisode(
  ctx: TenantContext,
  input: CreateClinicalEpisodeRequest
): Promise<{ id: string; code: string }> {
  assertBranchInScope(ctx, input.branchId);
  return withTenant(ctx, async (tx) => {
    const patient = await tx.patient.findFirst({
      where: { id: input.patientId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!patient) throw new NotFoundError('Patient');
    if (patient.status === 'MERGED') {
      throw new ConflictError('That record has been merged into another one.');
    }

    return openEpisode(tx, ctx, {
      patientId: input.patientId,
      branchId: input.branchId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.primarySpecialtyId !== undefined
        ? { primarySpecialtyId: input.primarySpecialtyId }
        : {}),
    });
  });
}

/**
 * Retitle, close or reopen.
 *
 * ⚠️ CLOSING IS NOT DELETING AND REOPENING IS LEGITIMATE. A journey a clinic
 *   thought was finished and that resumes six months later is the SAME journey;
 *   forcing a new one splits the history exactly where a clinician most wants it
 *   continuous. So `closedOn` and `closureReason` are cleared on reopen rather
 *   than kept as a confusing residue.
 */
export async function updateEpisode(
  ctx: TenantContext,
  episodeId: string,
  input: UpdateClinicalEpisodeRequest,
  options: EpisodeReadOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.clinicalEpisode.findFirst({
      where: { id: episodeId, deletedAt: null },
      select: {
        id: true,
        code: true,
        status: true,
        patientId: true,
        primarySpecialtyId: true,
        openedOn: true,
        closedOn: true,
      },
    });
    if (!existing) throw new NotFoundError('Clinical episode');

    const closing = input.status === 'CLOSED' && existing.status !== 'CLOSED';
    const reopening = input.status === 'OPEN' && existing.status === 'CLOSED';

    const updated = await tx.clinicalEpisode.update({
      where: { id: episodeId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.primarySpecialtyId !== undefined
          ? { primarySpecialtyId: input.primarySpecialtyId }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(closing
          ? {
              closedOn: new Date(),
              ...(input.closureReason !== undefined ? { closureReason: input.closureReason } : {}),
              ...(ctx.userId !== undefined ? { closedBy: ctx.userId } : {}),
            }
          : {}),
        ...(reopening ? { closedOn: null, closureReason: null, closedBy: null } : {}),
      },
      select: {
        id: true,
        code: true,
        status: true,
        patientId: true,
        primarySpecialtyId: true,
        openedOn: true,
        closedOn: true,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinical_episode',
      entityId: episodeId,
      before: snapshot(existing),
      after: snapshot(updated),
      ...options,
    });
  });
}
