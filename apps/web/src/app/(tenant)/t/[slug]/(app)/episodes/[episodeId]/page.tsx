import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ClinicalEpisodeDetail } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timeFormatOf, timezoneOf } from '@/lib/session';
import { formatClinicDate, formatClinicDateTime } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { AppointmentStatusChip } from '@/components/tenant/appointment-status';

export const metadata: Metadata = {
  /** ⚠️ NEVER THE PATIENT'S NAME, and never the journey's title — it is usually
   *   a diagnosis by another name. The heading carries both; the chrome does not. */
  title: 'Treatment journey',
};

/**
 * <slug>.rcln.com/episodes/<id> — one treatment journey and the visits along it.
 *
 * ⚠️ `appointment.read`, NOT A CLINICAL CODE, AND THAT IS THE SPLIT CD-14
 *   RECORDS. This screen answers WHEN somebody came in: bookings, in order, with
 *   the chain between them. It carries no diagnosis, which is why the front desk
 *   can open it — they pick a journey while making an appointment, and they hold
 *   no clinical code at all. What was CONCLUDED is the visit history, behind
 *   `clinical.encounter.read`, and the link to it below is offered only to a
 *   caller who holds that.
 *
 * ⚠️ IT STILL WRITES A `data_access_logs` ROW under `CLINICAL_EPISODE`. A journey
 *   title is a clinical statement about a named person even when no diagnosis
 *   travels with it — "Androgenetic alopecia — management" names a condition and
 *   the patient it belongs to.
 *
 * ⚠️ THE CHAIN AND THE JOURNEY ARE DRAWN AT THE SAME TIME, and they are two
 *   different facts. The episode says which visits belong together;
 *   `parentAppointmentId` says which was booked off which. A timeline showing
 *   only the first would lose that C came from B rather than from A.
 */
export default async function EpisodePage({
  params,
}: {
  params: Promise<{ slug: string; episodeId: string }>;
}) {
  const { slug, episodeId } = await params;
  const accessToken = await getAccessToken();

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.APPOINTMENT_READ)) {
    return (
      <Alert tone="error">
        You do not have access to treatment journeys here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const [episode, timezone, timeFormat] = await Promise.all([
    api<ClinicalEpisodeDetail>(`/api/v1/clinical-episodes/${episodeId}`, { slug, accessToken }),
    /*
     * ⚠️ THE ORGANIZATION'S DEFAULT ZONE, BECAUSE AN EPISODE IS ORG-SCOPED AND
     *   ITS VISITS ARE NOT. `clinicalEpisodeDetail` does not carry a per-visit
     *   timezone, so a journey spanning two branches renders both halves in one
     *   zone. That is a known narrowing of invariant 6 rather than a silent one:
     *   the label below states which zone the times are in, and the visit
     *   history — which does carry the zone per row — is the screen that gets it
     *   exactly right.
     */
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  if (episode.status === 404) notFound();

  if (!episode.ok || !episode.data) {
    return (
      <Alert tone="error">
        {episode.status === 403
          ? 'You do not have access to this journey.'
          : (episode.message ?? 'This journey could not be loaded.')}
      </Alert>
    );
  }

  const journey = episode.data;
  const canReadHistory = permissions.includes(PERMISSIONS.ENCOUNTER_READ);

  /* Which visit came from which, so the rail can say "follows on from". */
  const numbers = new Map(journey.appointments.map((a) => [a.id, a.appointmentNumber]));

  return (
    <div>
      <Link
        href={`/patients/${journey.patientId}`}
        className="text-muted text-[0.8125rem] hover:underline"
      >
        ← Back to the record
      </Link>

      <header className="border-rule bg-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-lg border p-5">
        <div className="min-w-0">
          <h1 className="font-display text-3xl tracking-tight">
            {journey.title ?? 'Treatment journey'}
          </h1>
          <p className="text-muted mt-2 text-[0.9375rem]">
            Opened {formatClinicDate(`${journey.openedOn}T12:00:00Z`, 'UTC')}
            {journey.closedOn === null
              ? null
              : ` · closed ${formatClinicDate(`${journey.closedOn}T12:00:00Z`, 'UTC')}`}
            {journey.primarySpecialtyName === null ? null : ` · ${journey.primarySpecialtyName}`}
          </p>
          <p className="text-muted mt-1 text-[0.75rem]">Times at {timezone.replace('_', ' ')}</p>
        </div>

        <div className="text-right">
          <p className="eyebrow text-drape">Journey</p>
          <p className="mt-1 font-mono text-[0.9375rem]">{journey.code}</p>
          {/* Status in words. Never colour alone (WCAG 1.4.1). */}
          <p className="text-muted mt-1 text-[0.8125rem]">
            {journey.status === 'OPEN' ? 'Open' : 'Closed'}
          </p>
        </div>
      </header>

      {journey.notes === null ? null : (
        <section className="border-rule bg-card mt-4 rounded-lg border p-5">
          <h2 className="eyebrow text-drape">Notes</h2>
          <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{journey.notes}</p>
        </section>
      )}

      {journey.closureReason === null ? null : (
        <section className="border-rule bg-card mt-4 rounded-lg border p-5">
          <h2 className="eyebrow text-drape">Why it was closed</h2>
          <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{journey.closureReason}</p>
        </section>
      )}

      <section className="border-rule bg-card mt-4 rounded-lg border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="eyebrow text-drape">Visits</h2>
          {canReadHistory ? (
            <Link
              href={`/patients/${journey.patientId}/visit-history`}
              className="text-[0.8125rem] underline underline-offset-2"
            >
              What was concluded at each →
            </Link>
          ) : null}
        </div>

        {journey.appointments.length === 0 ? (
          <p className="text-muted mt-3 text-[0.9375rem]">
            No bookings on this journey yet. A walk-in consultation can belong to one without any.
          </p>
        ) : (
          <ol className="border-rule mt-4 space-y-4 border-l pl-5">
            {journey.appointments.map((visit) => (
              <li key={visit.id} className="relative">
                <span
                  aria-hidden="true"
                  className="bg-drape absolute top-2 -left-[1.4375rem] h-2 w-2 rounded-full"
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/appointments/${visit.id}`}
                    className="font-mono text-[0.875rem] tabular-nums underline underline-offset-2"
                  >
                    {formatClinicDateTime(visit.scheduledStart, timezone, timeFormat)}
                  </Link>
                  <span className="text-muted font-mono text-[0.75rem]">
                    {visit.appointmentNumber}
                  </span>
                  <span className="text-muted text-[0.8125rem]">{visit.doctorName}</span>
                </div>
                <p className="text-muted mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.75rem]">
                  {/* The same chip the day board and the consultation page use —
                      a cancelled visit in a treatment journey is the one row
                      somebody reading the timeline needs to spot. */}
                  <AppointmentStatusChip status={visit.status} />
                  {VISIT_WORDS[visit.visitType] ?? visit.visitType}
                  {visit.parentAppointmentId === null ? null : (
                    <>
                      {' · follows on from '}
                      <span className="font-mono">
                        {numbers.get(visit.parentAppointmentId) ?? 'an earlier visit'}
                      </span>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const VISIT_WORDS: Record<string, string> = {
  NEW: 'First visit',
  FOLLOW_UP: 'Follow-up',
  WALK_IN: 'Walk-in',
  TELECONSULT: 'Teleconsultation',
  PROCEDURE: 'Procedure',
};
