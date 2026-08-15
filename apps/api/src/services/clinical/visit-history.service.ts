/**
 * The read surfaces over everything CE-1…CE-4 stores (CE-5).
 *
 * Two questions, two functions, and they are not the same question:
 *
 * ```text
 * "what has happened to this patient?"   ->  getVisitHistory   the timeline
 * "what happened LAST time?"             ->  getPreviousVisit  the panel (§37)
 * ```
 *
 * ⚠️ BOTH ARE THE MOST CONCENTRATED PHI READS IN THE CODEBASE, and both write a
 *   `data_access_logs` row inside the transaction that read them. A visit
 *   history is one named person's entire clinical past in one response; that is
 *   the intended cost of the surface, not an oversight to optimise away.
 *
 * ⚠️ AND NEITHER WRITES ANYTHING. There is no function here, and no endpoint
 *   anywhere, that edits a finalized consultation — an amendment is a new row
 *   (CD-2). The previous visit is read-only because of the storage model, not
 *   because a screen hides a button.
 *
 * ── WHY VISIT HISTORY IS NOT THE EPISODE ENDPOINT (CD-14) ────────────────────
 *
 *   GET /clinical-episodes/:id       appointment.read         WHEN they came in
 *   GET /patients/:id/visit-history  clinical.encounter.read  WHAT was concluded
 *
 * The front desk works the first — booking a follow-up means knowing which
 * journey a visit belongs to, and the desk holds no clinical code at all. Only
 * somebody who may read the chart gets the second, because a list of diagnoses
 * is a chart however it is paginated. Widening `getEpisode` to carry the
 * diagnoses would have handed the desk the chart through the booking screen.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  EncounterVisitSummary,
  PreviousVisitResponse,
  PreviousVisitSourceValue,
  VisitHistoryQuery,
  VisitHistoryResponse,
  VisitHistoryVisit,
} from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { dueOn, encounterContentOf } from './encounter-content.service.js';

export interface VisitHistoryReadOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/** See `episode.service.ts` — a `@db.Date` comes back pinned to UTC midnight. */
function toCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * What a timeline entry needs from a consultation.
 *
 * ⚠️ COUNTS, NOT ROWS, FOR EVERYTHING EXCEPT THE DIAGNOSES. A timeline entry
 *   answers "what was this visit about" — the diagnosis and nothing else. Every
 *   prescription line of every visit in a patient's history would grow without
 *   bound and disclose far more than the screen renders. The dose is a question
 *   you open the record to ask, and `GET /encounters/:id` is where you ask it.
 *
 * ⚠️ `branch` IS HERE RATHER THAN ON THE CALLER BECAUSE A WALK-IN HAS NO
 *   APPOINTMENT TO TAKE A ZONE FROM (CD-1). Every clinical instant renders in
 *   the branch's zone (invariant 6), and the branch a walk-in was seen at is on
 *   the encounter itself.
 */
const ENCOUNTER_SUMMARY_SELECT = {
  id: true,
  status: true,
  encounterNumber: true,
  startedAt: true,
  finalizedAt: true,
  chiefComplaint: true,
  chiefComplaintDurationValue: true,
  chiefComplaintDurationUnit: true,
  onset: true,
  clinicalNotes: true,
  amendsEncounterId: true,
  amendedAt: true,
  appointmentId: true,
  branchId: true,
  clinicalEpisodeId: true,
  doctorProfileId: true,
  branch: { select: { timezone: true } },
  diagnoses: {
    select: { customText: true, item: { select: { name: true } } },
    /* ⚠️ PRIMARY FIRST. `DiagnosisRole`'s first member is PRIMARY, so ascending
       order puts the diagnosis the visit was about at the front — which is the
       only one a one-line timeline entry has room for. */
    orderBy: [{ role: 'asc' }, { displayOrder: 'asc' }],
  },
  recommendations: {
    where: { deletedAt: null },
    select: {
      isRequired: true,
      intervalValue: true,
      intervalUnit: true,
      recommendedDate: true,
      createdAt: true,
    },
    /* At most one lives at a time — a restatement soft-deletes the one before
       it — but ordering makes that a fact about the query rather than a hope. */
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
  _count: {
    select: {
      prescriptions: true,
      investigations: true,
      procedures: true,
      referrals: true,
      attachments: true,
    },
  },
} satisfies Prisma.EncounterSelect;

type EncounterSummaryRow = Prisma.EncounterGetPayload<{
  select: typeof ENCOUNTER_SUMMARY_SELECT;
}>;

/**
 * ⚠️ A CODED DIAGNOSIS AND A FREE-TEXT ONE ARE THE SAME LINE ON A TIMELINE. The
 *   distinction matters when authoring — it is why `custom_text` exists — and
 *   not when reading back what was concluded. A row with neither cannot exist:
 *   a CHECK constraint refuses it.
 */
function diagnosisNames(rows: EncounterSummaryRow['diagnoses']): string[] {
  return rows
    .map((row) => row.item?.name ?? row.customText)
    .filter((name): name is string => name !== null);
}

function toEncounterSummary(row: EncounterSummaryRow): EncounterVisitSummary {
  const recommendation = row.recommendations[0];
  return {
    id: row.id,
    status: row.status,
    encounterNumber: row.encounterNumber,
    startedAt: row.startedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    chiefComplaint: row.chiefComplaint,
    chiefComplaintDurationValue: row.chiefComplaintDurationValue,
    chiefComplaintDurationUnit: row.chiefComplaintDurationUnit,
    onset: row.onset,
    diagnoses: diagnosisNames(row.diagnoses),
    prescriptionCount: row._count.prescriptions,
    investigationCount: row._count.investigations,
    procedureCount: row._count.procedures,
    referralCount: row._count.referrals,
    attachmentCount: row._count.attachments,
    amendsEncounterId: row.amendsEncounterId,
    amendedAt: row.amendedAt?.toISOString() ?? null,
    followUpDueOn: recommendation === undefined ? null : dueOn(recommendation),
    followUpIsRequired: recommendation?.isRequired ?? null,
  };
}

/**
 * Oldest first, by whichever instant the visit actually has.
 *
 * ⚠️ A BOOKING SORTS ON ITS SLOT AND A WALK-IN ON WHEN THE CONSULTATION WAS
 *   OPENED, because those are the only instants each has. The two are not the
 *   same quantity — but both are "when the patient was in the room" to within
 *   the precision a timeline renders, and the alternative is every walk-in
 *   floating to one end of the journey regardless of when it happened.
 *
 * Both are ISO-8601 with a `Z`, which sorts lexicographically as it sorts
 * chronologically. That is a property of the format, not a coincidence.
 */
function visitOrder(a: VisitHistoryVisit, b: VisitHistoryVisit): number {
  const at = a.scheduledStart ?? a.encounter?.startedAt ?? '';
  const bt = b.scheduledStart ?? b.encounter?.startedAt ?? '';
  return at < bt ? -1 : at > bt ? 1 : 0;
}

/**
 * Every journey a patient has been on, newest first (§18).
 *
 * ⚠️ VISIT HISTORY BELONGS TO THE PATIENT, NOT TO THE CONSULTATION READING IT.
 *   `Patient -> Clinical Episode -> Appointments -> Consultations`, which is why
 *   this hangs off `/patients/:id` and not off the encounter that happens to be
 *   open. Nesting it under the current visit would make one record own the
 *   history of every other, and an amendment to the current one would sit above
 *   records it has no business owning.
 *
 * ⚠️ PAGINATED OVER EPISODES AND NOT OVER VISITS. A journey is the unit a
 *   clinician reads; splitting one across two pages shows half a course of
 *   treatment and calls it a page.
 *
 * ⚠️ A WALK-IN APPEARS EVEN THOUGH IT HAS NO BOOKING (CD-1). The visits of a
 *   journey are its appointments UNION its appointment-less encounters — a
 *   history assembled from `appointments` alone would silently omit every
 *   walk-in, which is the exact fact that made `encounters` its own table.
 */
export async function getVisitHistory(
  ctx: TenantContext,
  patientId: string,
  query: VisitHistoryQuery,
  options: VisitHistoryReadOptions = {}
): Promise<VisitHistoryResponse> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ 404 FOR A PATIENT RLS CANNOT SEE, RATHER THAN AN EMPTY HISTORY. "This
     *   patient has no visits" and "this patient is not yours" are different
     *   answers, and returning the first for the second is how a tenancy bug
     *   goes unnoticed for a year.
     */
    const patient = await tx.patient.findFirst({
      where: { id: patientId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundError('Patient');

    const where = { patientId, deletedAt: null };

    const [total, episodes] = await Promise.all([
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
          appointments: {
            where: { deletedAt: null },
            select: {
              id: true,
              appointmentNumber: true,
              scheduledStart: true,
              status: true,
              visitType: true,
              parentAppointmentId: true,
              branchId: true,
              branch: { select: { timezone: true } },
              doctorProfileId: true,
              doctorProfile: { select: { user: { select: { fullName: true } } } },
            },
            orderBy: { scheduledStart: 'asc' },
          },
          /*
           * ⚠️ CANCELLED DRAFTS ARE EXCLUDED AND AMENDED ORIGINALS ARE NOT. An
           *   abandoned draft was never a record of anything; a superseded one
           *   IS the record of what was concluded before the correction, and
           *   dropping it would make the amendment trail invisible on the only
           *   screen a clinician reads the history from.
           */
          encounters: {
            where: { deletedAt: null, status: { not: 'CANCELLED' } },
            select: ENCOUNTER_SUMMARY_SELECT,
            orderBy: { startedAt: 'asc' },
          },
        },
        /* Newest journey first; `code` breaks the tie so the order is total —
           two episodes opened on one day would otherwise shuffle per query. */
        orderBy: [{ openedOn: 'desc' }, { code: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    await recordDataAccess(tx, ctx, {
      accessType: 'SEARCH',
      resource: 'ENCOUNTER',
      patientId,
      resultCount: episodes.length,
      ...options,
    });

    return {
      patientId,
      episodes: episodes.map((episode) => {
        /*
         * ⚠️ THE LIVE CONSULTATION PER BOOKING, NOT EVERY ONE OF THEM. An
         *   amendment and its original share an appointment (CD-2), and the
         *   timeline entry for that visit shows the current record — the
         *   superseded one is reachable through `amendsEncounterId` on it.
         *   `startedAt asc` above means the last write into the map wins, which
         *   is the amendment.
         */
        const byAppointment = new Map<string, EncounterSummaryRow>();
        const walkIns: EncounterSummaryRow[] = [];
        for (const encounter of episode.encounters) {
          if (encounter.appointmentId === null) walkIns.push(encounter);
          else byAppointment.set(encounter.appointmentId, encounter);
        }

        const booked: VisitHistoryVisit[] = episode.appointments.map((appointment) => {
          const encounter = byAppointment.get(appointment.id);
          return {
            appointmentId: appointment.id,
            appointmentNumber: appointment.appointmentNumber,
            scheduledStart: appointment.scheduledStart.toISOString(),
            appointmentStatus: appointment.status,
            visitType: appointment.visitType,
            parentAppointmentId: appointment.parentAppointmentId,
            branchId: appointment.branchId,
            timezone: appointment.branch.timezone,
            doctorProfileId: appointment.doctorProfileId,
            doctorName: appointment.doctorProfile.user.fullName,
            encounter: encounter === undefined ? null : toEncounterSummary(encounter),
          };
        });

        /*
         * ⚠️ NO DOCTOR NAME ON A WALK-IN ROW, AND THAT IS NOT AN OMISSION. The
         *   encounter carries `doctorProfileId`, so the id is known — but
         *   loading the name would be a join per walk-in on a list endpoint, and
         *   the timeline renders the consultation's own line for it. Ids travel;
         *   the name is on the record you open.
         */
        const unbooked: VisitHistoryVisit[] = walkIns.map((encounter) => ({
          appointmentId: null,
          appointmentNumber: null,
          scheduledStart: null,
          appointmentStatus: null,
          visitType: null,
          parentAppointmentId: null,
          branchId: encounter.branchId,
          timezone: encounter.branch.timezone,
          doctorProfileId: encounter.doctorProfileId,
          doctorName: null,
          encounter: toEncounterSummary(encounter),
        }));

        return {
          id: episode.id,
          code: episode.code,
          title: episode.title,
          status: episode.status,
          patientId: episode.patientId,
          primarySpecialtyId: episode.primarySpecialtyId,
          primarySpecialtyName: episode.primarySpecialty?.name ?? null,
          openedOn: toCalendarDate(episode.openedOn),
          closedOn: episode.closedOn === null ? null : toCalendarDate(episode.closedOn),
          appointmentCount: episode._count.appointments,
          /* Oldest first WITHIN a journey, which is the order a course of
             treatment reads in. The journeys themselves are newest first. */
          visits: [...booked, ...unbooked].sort(visitOrder),
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

// ---------------------------------------------------------------------------
// The previous visit (§37)
// ---------------------------------------------------------------------------

/**
 * Everything the panel renders, in one read.
 *
 * ⚠️ THE WHOLE CONTENT AND NOT COUNTS, WHICH IS THE OPPOSITE OF THE TIMELINE
 *   ABOVE AND IS RIGHT FOR THE OPPOSITE REASON. The panel exists so a doctor
 *   can see the dose they prescribed last time WITHOUT LEAVING the consultation
 *   they are writing — counts would send them to another screen, which is the
 *   interruption the panel is for avoiding. It is one visit, so it is bounded.
 */
const PREVIOUS_SELECT = {
  ...ENCOUNTER_SUMMARY_SELECT,
  patientId: true,
  appointment: { select: { appointmentNumber: true, scheduledStart: true } },
  clinicalEpisode: { select: { code: true, title: true } },
  doctorProfile: { select: { user: { select: { fullName: true } } } },
} satisfies Prisma.EncounterSelect;

/**
 * The most recent consultation that is a statement about the patient.
 *
 * ⚠️ `FINALIZED` OR `AMENDED`, NEVER `DRAFT`. A draft is what somebody is in the
 *   middle of writing; showing it as "last time" would present an unsigned,
 *   half-typed record as clinical history. `AMENDED` is included because a
 *   superseded record still says what was concluded at that visit — its
 *   correction is a different row and sorts later on `finalizedAt`.
 */
async function findFinalized(
  tx: TxClient,
  filter: {
    patientId: string;
    appointmentId?: string;
    clinicalEpisodeId?: string;
    /** The visit being conducted. It is not its own history. */
    excludeAppointmentId?: string;
  }
): Promise<Prisma.EncounterGetPayload<{ select: typeof PREVIOUS_SELECT }> | null> {
  return tx.encounter.findFirst({
    where: {
      patientId: filter.patientId,
      deletedAt: null,
      status: { in: ['FINALIZED', 'AMENDED'] },
      ...(filter.appointmentId !== undefined ? { appointmentId: filter.appointmentId } : {}),
      ...(filter.clinicalEpisodeId !== undefined
        ? { clinicalEpisodeId: filter.clinicalEpisodeId }
        : {}),
      ...(filter.excludeAppointmentId !== undefined
        ? { NOT: { appointmentId: filter.excludeAppointmentId } }
        : {}),
    },
    select: PREVIOUS_SELECT,
    /* Signed most recently. `startedAt` breaks the tie for two records signed in
       the same millisecond, which a backfill can produce. */
    orderBy: [{ finalizedAt: 'desc' }, { startedAt: 'desc' }],
  });
}

/**
 * What the doctor sees when they open a follow-up.
 *
 * ⚠️ THREE WAYS TO FIND IT, AND THE ANSWER SAYS WHICH ONE RAN, because the three
 *   are not equally true:
 *
 * ```text
 * PARENT_APPOINTMENT  the booking this one was made from    a fact, FK-enforced
 * SAME_EPISODE        the last consultation in this journey  a strong inference
 * MOST_RECENT         the last consultation anywhere         a convenience
 * ```
 *
 *   A screen that presented all three with the same words would tell a doctor
 *   that an unrelated visit from March is what this follow-up follows — a
 *   clinical claim the software has no basis for, and the same trap
 *   `resolveEpisodeForBooking` refuses when it declines to guess an episode.
 *   The label is the screen's job; saying WHICH is this function's.
 */
export async function getPreviousVisit(
  ctx: TenantContext,
  appointmentId: string,
  options: VisitHistoryReadOptions = {}
): Promise<PreviousVisitResponse> {
  return withTenant(ctx, async (tx) => {
    const current = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: {
        id: true,
        patientId: true,
        branchId: true,
        clinicalEpisodeId: true,
        parentAppointmentId: true,
      },
    });
    if (!current) throw new NotFoundError('Appointment');
    /* ⚠️ 404, NOT 403 — whether a booking exists is itself tenant information. */
    if (!ctx.branchIds.includes(current.branchId)) throw new NotFoundError('Appointment');

    /*
     * ⚠️ ORDERED, AND THE ORDER IS THE POINT. The first hit wins; falling
     *   through to `MOST_RECENT` is legitimate and the screen labels it
     *   differently rather than pretending it is the same fact.
     */
    const found =
      (current.parentAppointmentId === null
        ? null
        : await findFinalized(tx, {
            patientId: current.patientId,
            appointmentId: current.parentAppointmentId,
          })) ??
      (await findFinalized(tx, {
        patientId: current.patientId,
        clinicalEpisodeId: current.clinicalEpisodeId,
        excludeAppointmentId: current.id,
      })) ??
      (await findFinalized(tx, {
        patientId: current.patientId,
        excludeAppointmentId: current.id,
      }));

    if (found === null) return { previous: null };

    /*
     * ⚠️ THE BRANCH CHECK APPLIES TO THE PREVIOUS VISIT TOO, NOT ONLY TO THE
     *   CURRENT ONE. A patient treated at two branches has a history spanning
     *   both, and a caller scoped to one must not read the other's consultation
     *   through this door. RLS scopes the organization; `branchIds` is the
     *   second layer, and it is this layer's job to apply it to BOTH rows.
     */
    if (!ctx.branchIds.includes(found.branchId)) return { previous: null };

    const source: PreviousVisitSourceValue =
      found.appointmentId !== null && found.appointmentId === current.parentAppointmentId
        ? 'PARENT_APPOINTMENT'
        : found.clinicalEpisodeId === current.clinicalEpisodeId
          ? 'SAME_EPISODE'
          : 'MOST_RECENT';

    const content = await encounterContentOf(tx, found.id);

    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'ENCOUNTER',
      patientId: current.patientId,
      resourceId: found.id,
      ...options,
    });

    return {
      previous: {
        source,
        appointmentId: found.appointmentId,
        appointmentNumber: found.appointment?.appointmentNumber ?? null,
        scheduledStart: found.appointment?.scheduledStart.toISOString() ?? null,
        branchId: found.branchId,
        timezone: found.branch.timezone,
        doctorProfileId: found.doctorProfileId,
        doctorName: found.doctorProfile.user.fullName,
        clinicalEpisodeId: found.clinicalEpisodeId,
        episodeCode: found.clinicalEpisode.code,
        episodeTitle: found.clinicalEpisode.title,
        encounter: toEncounterSummary(found),
        clinicalNotes: found.clinicalNotes,
        content,
      },
    };
  });
}
