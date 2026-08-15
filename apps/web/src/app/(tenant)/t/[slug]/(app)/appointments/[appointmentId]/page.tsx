import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AppointmentDetail } from '@rcln/contracts';
import { temperatureUnitFor } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { formatClinicDateTime } from '@/lib/format';
import { countryOf, getAccessToken, getSession, timeFormatOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { VitalsPanel } from '@/components/tenant/vitals-panel';
import { AppointmentBillingPanel } from '@/components/tenant/appointment-billing-panel';
import { ConsultationEngine } from '@/components/tenant/consultation-engine';
import { loadAppointmentBilling, loadVitals } from '../actions';
import { loadConsultation, openConsultation } from '../consultation-actions';

export const metadata: Metadata = {
  /**
   * ⚠️ NEVER THE PATIENT'S NAME, for the same reason the patient chart's is not:
   *   a tab title is read over a shoulder, screenshotted into a support ticket
   *   and written into browser history. The heading names them; the chrome
   *   does not.
   */
  title: 'Consultation',
};

/**
 * <slug>.rcln.com/appointments/<id> — one visit.
 *
 * THREE CALLERS, ONE PAGE, AND EVERY DIFFERENCE BETWEEN THEM IS A PERMISSION
 *   A DOCTOR arrives from their day board and this is the consultation: opening
 *   it STARTS the visit, and this is where the diagnosis gets written. THE FRONT
 *   DESK arrives from the same board and this is where they record the vitals.
 *   AN ADMINISTRATOR arrives to read what happened, and changes nothing by
 *   arriving. Which of those you get is decided by three separate codes below —
 *   never by a role check, and never by two routes that would drift apart.
 *
 * ⚠️ THE THREE CODES, AND WHY THEY ARE NOT ONE
 *   `clinical.encounter.create` — starts the visit and writes the consultation.
 *     DOCTOR alone among the system roles. This is the one that POSTs.
 *   `clinical.encounter.read`   — reads what was written. Administrators hold it.
 *   `clinical.vitals.read`      — sees the observations. The doctor reads them;
 *     `clinical.vitals.record`, a fourth code, is what lets you take one, and the
 *     doctor deliberately does not hold it.
 *
 * ⚠️ THE AUTHOR'S PATH ISSUES A POST DURING RENDER, AND THAT IS ONLY SAFE
 *   BECAUSE THE TRANSITION IS IDEMPOTENT. `POST /consultation` moves a
 *   CHECKED_IN booking to IN_PROGRESS so the board reflects a doctor who has
 *   taken the patient in without anybody pressing a button. A render can happen
 *   more than once — a refresh, a revalidation — so the second and every later
 *   call must change nothing and write no trail row. `onConsultationOpened`
 *   guarantees that by declining any move that is not a legal forward step; the
 *   guarantee lives in the service, where it cannot be lost by an edit here.
 *
 *   ⚠️ WHICH IS WHY IT IS GATED ON `create` AND NOT ON `read`. It used to be the
 *     read code, which meant an administrator opening a booking to look at it
 *     moved the patient to "with the doctor" on the day board — a side effect
 *     nobody asked for, from a page they came to read.
 *
 * ⚠️ OPENING THIS PAGE WRITES `data_access_logs` ROWS — one for the booking, one
 *   for the vitals. That is the intended cost of a screen that discloses one
 *   named patient's clinical content.
 *
 * The diagnosis and prescription surface is deliberately a placeholder. It is
 * specialty-specific and gets designed on its own; what is real here is the
 * route, the access split, the automatic status transition and the vitals.
 */
export default async function ConsultationPage({
  params,
}: {
  params: Promise<{ slug: string; appointmentId: string }>;
}) {
  const { slug, appointmentId } = await params;
  const accessToken = await getAccessToken();

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  /** May write the consultation up. DOCTOR, and whoever a clinic grants it to. */
  const canConsult = permissions.includes(PERMISSIONS.ENCOUNTER_CREATE);
  /** May read what was written. Administrators too — oversight, not authorship. */
  const canReadEncounter = permissions.includes(PERMISSIONS.ENCOUNTER_READ);

  /*
   * The author's open starts the visit; everyone else reads it. Both return the
   * same shape, so nothing below has to know which one ran.
   */
  const appointment = canConsult
    ? await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}/consultation`, {
        method: 'POST',
        slug,
        accessToken,
      })
    : await api<AppointmentDetail>(`/api/v1/appointments/${appointmentId}`, {
        slug,
        accessToken,
      });

  if (appointment.status === 404) notFound();

  if (!appointment.ok || !appointment.data) {
    return (
      <Alert tone="error">
        {appointment.status === 403
          ? 'You do not have access to this appointment.'
          : (appointment.message ?? 'This appointment could not be loaded.')}
      </Alert>
    );
  }

  const visit = appointment.data;

  /*
   * ⚠️ TWO CODES, NOT ONE, AND THE DOCTOR IS ON DIFFERENT SIDES OF THEM. Reading
   *   this used to require `clinical.vitals.record` — which meant the only way to
   *   let somebody SEE a blood pressure was to let them type one in. A doctor now
   *   holds the read and not the write: they consult, and the cuff belongs to
   *   whoever is with the patient beforehand.
   */
  const canReadVitals = permissions.includes(PERMISSIONS.VITALS_READ);
  const canRecordVitals = permissions.includes(PERMISSIONS.VITALS_RECORD);

  /*
   * ⚠️ THE READER'S ACTIVE BRANCH, WHERE `visit.timezone` IS THE BOOKING'S OWN.
   *   The two can differ — an org-wide admin scoped to one clinic opening a
   *   booking made at another — and the asymmetry is deliberate. Getting the ZONE
   *   wrong renders the wrong instant, plausibly, so it travels on the row.
   *   Getting the FORMAT wrong renders the right instant in the other shape,
   *   which is a preference and not a fact. If clock face ever needs to follow
   *   the booking, `timeFormat` becomes an additive field on `appointmentDetail`
   *   beside `timezone`.
   */
  const timeFormat = await timeFormatOf(slug);

  // Only for a caller who may see them; a 403 would otherwise be swallowed into
  // an empty panel, which reads as "none taken" and is a different fact.
  const vitals = canReadVitals ? await loadVitals(slug, appointmentId) : null;

  /*
   * ⚠️ `billing.invoice.read` AND NOT `appointment.read`, WHICH IS WHAT MAKES
   *   THIS PANEL ABSENT RATHER THAN EMPTY FOR A DOCTOR WHO DOES NOT HOLD IT. A
   *   clinician who may open the chart does not thereby learn what the clinic
   *   charged for it — and the seeded DOCTOR role does hold the read, so most
   *   doctors will see it. Fetching it regardless and rendering nothing on a 403
   *   would read as "this visit has not been billed", which is a claim rather
   *   than a silence.
   */
  const canReadBilling = permissions.includes(PERMISSIONS.INVOICE_READ);
  const billing = canReadBilling ? await loadAppointmentBilling(slug, appointmentId) : null;

  /*
   * ⚠️ THE AUTHOR OPENS, THE READER READS, AND THE TWO ARE DIFFERENT CALLS
   *   (CE-3). `openConsultation` creates the draft if there is none, which is an
   *   act of authorship and is safe from a render only because the endpoint is
   *   idempotent — a second call returns the same draft rather than a second
   *   record of one visit. A reader gets `loadConsultation`, which creates
   *   nothing and answers null when nothing has been written up.
   */
  const opened = canConsult
    ? await openConsultation(slug, appointmentId)
    : canReadEncounter
      ? ({ ok: true, encounter: await loadConsultation(slug, appointmentId) } as const)
      : null;

  const consultation = opened === null ? null : opened.ok ? opened.encounter : null;
  /* The API's sentence — usually "no published template applies", which names a
     thing somebody can go and fix. */
  const consultationProblem = opened !== null && !opened.ok ? opened.message : null;

  return (
    <div>
      <Link
        href={`/appointments?date=${visit.scheduledStart.slice(0, 10)}`}
        className="text-muted text-[0.8125rem] hover:underline"
      >
        ← Back to the day
      </Link>

      <header className="border-rule bg-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-lg border p-5">
        <div className="min-w-0">
          <h1 className="font-display text-3xl tracking-tight">{visit.patientName}</h1>
          {/*
            ⚠️ IN THE BRANCH'S ZONE, WHICH THE BOOKING CARRIES. This line used to
              be `new Date(...).toLocaleString()` — no zone, so the runtime's,
              and the runtime rendering this is a Node container in UTC. A 16:40
              booking at an Indian clinic printed as 11:10 and nothing on screen
              said it had been shifted. The zone is on the row precisely so this
              cannot be got wrong again; the label states it too.
          */}
          <p className="text-muted mt-2 text-[0.9375rem]">
            {formatClinicDateTime(visit.scheduledStart, visit.timezone, timeFormat)} ·{' '}
            {visit.doctorName}
          </p>
          <p className="text-muted mt-1 text-[0.75rem]">
            Times at {visit.timezone.replace('_', ' ')}
          </p>
          {/* Status in words. Never colour alone (WCAG 1.4.1). */}
          <p className="text-muted mt-1 text-[0.8125rem]">
            {STATUS_WORDS[visit.status] ?? visit.status} · {VISIT_WORDS[visit.visitType]}
          </p>
        </div>

        <div className="text-right">
          <p className="eyebrow text-drape">Token</p>
          {/* Mono: this is the number called out in the waiting room. */}
          <p className="mt-1 font-mono text-[0.9375rem]">{visit.appointmentNumber}</p>
          <p className="text-muted mt-1 font-mono text-[0.75rem]">{visit.uhid}</p>
        </div>
      </header>

      {/*
       * The chain, in both directions. A follow-up gets its own token — the link
       * is `parentAppointmentId`, which the database enforces — so the parent's
       * number is shown rather than implied by a shared one.
       */}
      {visit.parentAppointmentId !== null || visit.followUps.length > 0 ? (
        <section className="border-rule bg-card mt-4 rounded-lg border p-5">
          <h2 className="eyebrow text-drape">Visit chain</h2>
          {visit.parentAppointmentId !== null ? (
            <p className="mt-3 text-[0.9375rem]">
              Follows on from{' '}
              <Link
                href={`/appointments/${visit.parentAppointmentId}`}
                className="underline underline-offset-2"
              >
                <span className="font-mono">
                  {visit.parentAppointmentNumber ?? 'earlier visit'}
                </span>
              </Link>
            </p>
          ) : null}
          {visit.followUps.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {visit.followUps.map((followUp) => (
                <li key={followUp.id} className="text-[0.9375rem]">
                  <Link
                    href={`/appointments/${followUp.id}`}
                    className="underline underline-offset-2"
                  >
                    <span className="font-mono">{followUp.appointmentNumber}</span>
                  </Link>
                  <span className="text-muted text-[0.8125rem]">
                    {' · '}
                    {formatClinicDateTime(followUp.scheduledStart, visit.timezone, timeFormat)}
                    {' · '}
                    {STATUS_WORDS[followUp.status] ?? followUp.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {visit.reason !== null ? (
        <section className="border-rule bg-card mt-4 rounded-lg border p-5">
          <h2 className="eyebrow text-drape">Reason given</h2>
          <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{visit.reason}</p>
        </section>
      ) : null}

      {canReadVitals && vitals !== null ? (
        <VitalsPanel
          slug={slug}
          appointmentId={appointmentId}
          vitals={vitals}
          canRecord={canRecordVitals}
          timezone={visit.timezone}
          timeFormat={timeFormat}
          /*
           * ⚠️ °F FOR AN INDIAN CLINIC, °C FOR A BRITISH ONE — a display and
           *   data-entry unit, decided by where the clinic is. The reading is
           *   stored in Celsius either way; `saveVitals` re-resolves this from
           *   the session before converting, so this prop only decides what is
           *   drawn.
           */
          temperatureUnit={temperatureUnitFor(await countryOf(slug))}
        />
      ) : null}

      {billing === null ? null : (
        <AppointmentBillingPanel
          slug={slug}
          billing={billing}
          /*
           * Raising the bill is `billing.invoice.create` — the same code as the
           * generic create route, because this endpoint is a shortcut through it
           * and not a wider power. A reader without it still sees what the visit
           * cost and what it is billed on.
           */
          canRaise={permissions.includes(PERMISSIONS.INVOICE_CREATE)}
        />
      )}

      {/*
       * ⚠️ TWO AUDIENCES, ONE SECTION, AND THE PERMISSION IS THE CONTROL. Anyone
       *   with `clinical.encounter.read` sees the consultation — an administrator
       *   has every reason to read what was concluded. Only
       *   `clinical.encounter.create` gets the form; everyone else gets the same
       *   sections, read-only. The API is the gate either way: a reader who
       *   forged the request still fails `authorize`.
       *
       * ⚠️ THE DRAFT IS OPENED FROM THE AUTHOR'S PATH ONLY, and only because the
       *   endpoint is idempotent — a second call returns the SAME draft rather
       *   than a second record of one visit, which is what makes it safe to issue
       *   during a render that can happen more than once. A reader must not open
       *   one: "the doctor started a consultation" would then be a fact created
       *   by an administrator looking at the booking.
       */}
      {canReadEncounter ? (
        consultation === null ? (
          <section className="border-rule bg-card mt-4 rounded-lg border border-dashed p-5">
            <h2 className="eyebrow text-drape">Consultation</h2>
            <p className="text-muted mt-3 text-[0.9375rem]">
              {canConsult
                ? (consultationProblem ??
                  'This consultation could not be opened. Check that a consultation template is published for this care context.')
                : 'Nothing has been written up for this visit yet. The consulting doctor opens the consultation.'}
            </p>
          </section>
        ) : (
          <ConsultationEngine
            slug={slug}
            appointmentId={appointmentId}
            encounter={consultation}
            canWrite={canConsult}
            canFinalize={permissions.includes(PERMISSIONS.ENCOUNTER_CLOSE)}
            canAmend={permissions.includes(PERMISSIONS.ENCOUNTER_AMEND)}
          />
        )
      ) : null}
    </div>
  );
}

const STATUS_WORDS: Record<string, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_PROGRESS: 'With the doctor',
  COMPLETED: 'Seen',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not attend',
};

const VISIT_WORDS: Record<string, string> = {
  NEW: 'First visit',
  FOLLOW_UP: 'Follow-up',
  WALK_IN: 'Walk-in',
  TELECONSULT: 'Teleconsultation',
  PROCEDURE: 'Procedure',
};
