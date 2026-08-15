import Link from 'next/link';
import type { TimeFormat, VisitHistoryEpisode, VisitHistoryVisit } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { formatClinicDate, formatClinicDateTime } from '@/lib/format';

/**
 * Everything that has happened to one patient, journey by journey (CE-5, §18).
 *
 * ⚠️ A SERVER COMPONENT WITH NO CLIENT STATE, deliberately. Nothing on this
 *   screen is editable — a finalized consultation is immutable (CD-2) and a
 *   draft is edited on its own visit's page — so there is no form, no action
 *   and no `'use client'`. Shipping the history to the browser to make it
 *   interactive would be shipping PHI to make nothing happen.
 *
 * ⚠️ THE STRUCTURE IS THE JOURNEY, AND IT IS TRUE RATHER THAN DECORATIVE. Visits
 *   are grouped by `clinical_episode_id` — a real column, not an inference — and
 *   ordered oldest-first WITHIN a journey because that is how a course of
 *   treatment reads. The journeys themselves are newest first, because "what is
 *   going on with this patient now" is the question somebody opens this with.
 *   The rail down the left is a timeline; a numbered spine would be a rank, and
 *   these are dates.
 *
 * ⚠️ NO SPECIALTY LOGIC ANYWHERE IN HERE (§33). A dental visit and a
 *   dermatological one render identically, because what the server sent is a
 *   diagnosis and a count either way.
 */

const STATUS_WORDS: Record<string, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'With the doctor',
  COMPLETED: 'Seen',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not attend',
};

const ENCOUNTER_WORDS: Record<string, string> = {
  DRAFT: 'Being written',
  FINALIZED: 'Signed',
  AMENDED: 'Superseded by an amendment',
  CANCELLED: 'Abandoned',
};

export function VisitHistory({
  patientName,
  episodes,
  total,
  page,
  pageSize,
  patientId,
  timeFormat,
  canReadEpisode,
}: {
  /** Shown as the heading. ⚠️ Never in the tab title or the URL. */
  patientName: string;
  episodes: VisitHistoryEpisode[];
  total: number;
  page: number;
  pageSize: number;
  patientId: string;
  timeFormat: TimeFormat;
  /** `appointment.read` — the journey screen the front desk works. */
  canReadEpisode: boolean;
}) {
  return (
    <div>
      <Link href={`/patients/${patientId}`} className="text-muted text-[0.8125rem] hover:underline">
        ← Back to the record
      </Link>

      <header className="mt-4">
        <h1 className="font-display text-3xl tracking-tight">{patientName}</h1>
        <p className="text-muted mt-2 text-[0.9375rem]">
          Every treatment journey, and what was concluded at each visit.
        </p>
      </header>

      {episodes.length === 0 ? (
        <Alert tone="info" className="mt-5">
          Nothing recorded yet. A journey opens the first time this patient is booked in.
        </Alert>
      ) : (
        <ol className="mt-5 space-y-4">
          {episodes.map((episode) => (
            <li key={episode.id} className="border-rule bg-card rounded-lg border p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  {/*
                    ⚠️ AN UNTITLED JOURNEY RENDERS BY ITS FIRST DIAGNOSIS RATHER
                      THAN BY A PLACEHOLDER. A title is optional and usually
                      absent — at booking time nobody yet knows what the journey
                      is about, and a required one would be answered with
                      "Consultation" for ever. The diagnosis is a fact; "Untitled"
                      is an apology.
                  */}
                  <h2 className="text-[1.0625rem] font-medium">
                    {episode.title ?? firstDiagnosis(episode) ?? 'Not yet titled'}
                  </h2>
                  <p className="text-muted mt-1 text-[0.8125rem]">
                    <span className="font-mono">{episode.code}</span>
                    {' · opened '}
                    {formatClinicDate(`${episode.openedOn}T12:00:00Z`, 'UTC')}
                    {episode.primarySpecialtyName === null
                      ? null
                      : ` · ${episode.primarySpecialtyName}`}
                  </p>
                </div>
                <div className="text-right">
                  {/* Status in words. Never colour alone (WCAG 1.4.1). */}
                  <p className="eyebrow text-drape">
                    {episode.status === 'OPEN' ? 'Open' : 'Closed'}
                  </p>
                  <p className="text-muted mt-1 text-[0.8125rem] tabular-nums">
                    {episode.visits.length === 1 ? '1 visit' : `${episode.visits.length} visits`}
                  </p>
                  {canReadEpisode ? (
                    <Link
                      href={`/episodes/${episode.id}`}
                      className="mt-1 inline-block text-[0.8125rem] underline underline-offset-2"
                    >
                      The journey
                    </Link>
                  ) : null}
                </div>
              </div>

              {/*
                The rail. `border-l` on the list and a dot per visit: the line is
                the journey and the dots are when the patient was in the room.
              */}
              <ol className="border-rule mt-4 space-y-4 border-l pl-5">
                {episode.visits.map((visit) => (
                  <Visit
                    key={visit.appointmentId ?? visit.encounter?.id ?? ''}
                    visit={visit}
                    timeFormat={timeFormat}
                  />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}

      {total > pageSize ? (
        <nav aria-label="Pages" className="mt-5 flex items-center gap-4">
          {page > 1 ? (
            <Link
              href={`/patients/${patientId}/visit-history?page=${page - 1}`}
              className="text-[0.875rem] underline underline-offset-2"
            >
              ← Newer journeys
            </Link>
          ) : null}
          <span className="text-muted text-[0.8125rem] tabular-nums">
            {episodes.length} of {total}
          </span>
          {page * pageSize < total ? (
            <Link
              href={`/patients/${patientId}/visit-history?page=${page + 1}`}
              className="text-[0.875rem] underline underline-offset-2"
            >
              Older journeys →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/** The journey's own first conclusion, used when nobody has titled it. */
function firstDiagnosis(episode: VisitHistoryEpisode): string | null {
  for (const visit of episode.visits) {
    const name = visit.encounter?.diagnoses[0];
    if (name !== undefined) return name;
  }
  return null;
}

/**
 * One visit.
 *
 * ⚠️ A BOOKING WITH NO CONSULTATION AND A CONSULTATION WITH NO BOOKING ARE BOTH
 *   REAL AND READ DIFFERENTLY. The first is a no-show or a visit not written up;
 *   the second is a walk-in (CD-1). Rendering either as the other would state
 *   something untrue about the visit, which is why both halves are nullable all
 *   the way from the database to here.
 */
function Visit({ visit, timeFormat }: { visit: VisitHistoryVisit; timeFormat: TimeFormat }) {
  const encounter = visit.encounter;

  return (
    <li className="relative">
      {/* The dot on the rail. Decorative: the date beside it carries the meaning. */}
      <span
        aria-hidden="true"
        className="bg-drape absolute top-2 -left-[1.4375rem] h-2 w-2 rounded-full"
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="font-mono text-[0.875rem] tabular-nums">
          {/*
            ⚠️ IN THE BRANCH'S ZONE, WHICH TRAVELS ON THE ROW. Not the reader's,
              not the container's — a 16:40 IST visit printed as 11:10 with
              nothing on screen saying it had shifted is the bug invariant 6
              exists to prevent, and this screen renders dates from several
              branches at once.
          */}
          {visit.scheduledStart !== null
            ? formatClinicDateTime(visit.scheduledStart, visit.timezone, timeFormat)
            : encounter !== null
              ? formatClinicDateTime(encounter.startedAt, visit.timezone, timeFormat)
              : '—'}
        </p>
        {visit.appointmentNumber === null ? (
          <span className="text-muted text-[0.75rem]">Walk-in · no booking</span>
        ) : (
          <span className="text-muted font-mono text-[0.75rem]">{visit.appointmentNumber}</span>
        )}
        {visit.doctorName === null ? null : (
          <span className="text-muted text-[0.8125rem]">{visit.doctorName}</span>
        )}
      </div>

      {encounter === null ? (
        <p className="text-muted mt-1 text-[0.8125rem]">
          {visit.appointmentStatus === null
            ? 'No consultation recorded.'
            : `${STATUS_WORDS[visit.appointmentStatus] ?? visit.appointmentStatus} · nothing written up.`}
        </p>
      ) : (
        <div className="mt-1">
          {encounter.diagnoses.length === 0 ? (
            <p className="text-muted text-[0.8125rem]">
              {encounter.chiefComplaint ?? 'No diagnosis recorded.'}
            </p>
          ) : (
            <p className="text-[0.9375rem]">{encounter.diagnoses.join(' · ')}</p>
          )}

          <p className="text-muted mt-1 text-[0.75rem]">
            {ENCOUNTER_WORDS[encounter.status] ?? encounter.status}
            {encounter.encounterNumber === null ? null : (
              <>
                {' '}
                · <span className="font-mono">{encounter.encounterNumber}</span>
              </>
            )}
            {countsFor(encounter).map((line) => (
              <span key={line}> · {line}</span>
            ))}
          </p>

          <div className="mt-1 flex flex-wrap gap-3">
            <Link
              href={`/consultations/${encounter.id}`}
              className="text-[0.8125rem] underline underline-offset-2"
            >
              Read the consultation
            </Link>
            {visit.appointmentId === null ? null : (
              <Link
                href={`/appointments/${visit.appointmentId}`}
                className="text-muted text-[0.8125rem] underline underline-offset-2"
              >
                The visit
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * "2 prescriptions · 1 investigation".
 *
 * ⚠️ COUNTS AND NOT CONTENT, WHICH IS THE SERVER'S DECISION AND NOT THIS
 *   COMPONENT'S. A timeline entry answers what the visit was about; the dose is
 *   a question you open the record to ask, and the API sends no dose here.
 */
function countsFor(encounter: NonNullable<VisitHistoryVisit['encounter']>): string[] {
  const pairs: [number, string, string][] = [
    [encounter.prescriptionCount, 'prescription', 'prescriptions'],
    [encounter.investigationCount, 'investigation', 'investigations'],
    [encounter.procedureCount, 'procedure', 'procedures'],
    [encounter.referralCount, 'referral', 'referrals'],
    [encounter.attachmentCount, 'attachment', 'attachments'],
  ];
  return pairs
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}
