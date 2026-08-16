import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { EncounterDetail } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timezoneOfBranch } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsultationEngine } from '@/components/tenant/consultation-engine';

export const metadata: Metadata = {
  /** ⚠️ NEVER THE PATIENT'S NAME. Same rule as every clinical screen. */
  title: 'Consultation record',
};

/**
 * <slug>.rcln.com/consultations/<id> — one consultation, whole and read-only.
 *
 * The screen the visit history links into, and the one "read the full record"
 * means from a previous-visit summary.
 *
 * ⚠️ READ-ONLY BECAUSE OF THE STORAGE MODEL, NOT BECAUSE THIS PAGE HIDES A
 *   BUTTON. A finalized consultation is immutable and an amendment is a new row
 *   (CD-2); there is no endpoint anywhere that edits one. `canWrite`,
 *   `canFinalize` and `canAmend` are all false below, and if every one of them
 *   were flipped to true by a bug the API would still refuse — which is the
 *   difference between a rule and a rendering decision.
 *
 * ⚠️ AMENDING IS DELIBERATELY NOT OFFERED HERE EVEN TO SOMEBODY WHO HOLDS THE
 *   CODE. An amendment starts a new draft that belongs to a VISIT, and this
 *   route reaches a record by its own id — a walk-in among them, with no visit
 *   to return to. The place to correct a record is the visit's own page, which
 *   is one link away below.
 *
 * ⚠️ IT RENDERS THROUGH THE ENCOUNTER'S OWN FROZEN SNAPSHOT (§29). A
 *   consultation signed in 2026 renders through the 2026 configuration for
 *   ever, whatever the clinic has done to its template since — which is exactly
 *   what a history screen has to be able to promise.
 *
 * ⚠️ AND IT WRITES A `data_access_logs` ROW under `ENCOUNTER`. Reading a
 *   colleague's signed record is a disclosure, and it is meant to leave a trail.
 */
export default async function ConsultationRecordPage({
  params,
}: {
  params: Promise<{ slug: string; encounterId: string }>;
}) {
  const { slug, encounterId } = await params;
  const accessToken = await getAccessToken();

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.ENCOUNTER_READ)) {
    return (
      <Alert tone="error">
        You do not have access to consultation records here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const encounter = await api<EncounterDetail>(`/api/v1/encounters/${encounterId}`, {
    slug,
    accessToken,
  });

  if (encounter.status === 404) notFound();

  if (!encounter.ok || !encounter.data) {
    return (
      <Alert tone="error">
        {encounter.status === 403
          ? 'You do not have access to this consultation.'
          : (encounter.message ?? 'This consultation could not be loaded.')}
      </Alert>
    );
  }

  const record = encounter.data;

  return (
    <div>
      <Link
        href={`/patients/${record.patientId}/visit-history`}
        className="text-muted text-[0.8125rem] hover:underline"
      >
        ← Back to the visit history
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {record.appointmentId === null ? (
          <p className="text-muted text-[0.8125rem]">
            A walk-in consultation — there is no booking behind it.
          </p>
        ) : (
          <Link
            href={`/appointments/${record.appointmentId}`}
            className="text-[0.8125rem] underline underline-offset-2"
          >
            The visit this was recorded at
          </Link>
        )}
        <Link
          href={`/episodes/${record.clinicalEpisodeId}`}
          className="text-muted text-[0.8125rem] underline underline-offset-2"
        >
          The treatment journey
        </Link>
        {record.amendsEncounterId === null ? null : (
          <Link
            href={`/consultations/${record.amendsEncounterId}`}
            className="text-[0.8125rem] underline underline-offset-2"
          >
            The record this one corrects
          </Link>
        )}
      </div>

      {record.status === 'AMENDED' ? (
        <Alert tone="info" className="mt-4">
          This record has been superseded by an amendment. It is kept exactly as it was signed.
        </Alert>
      ) : null}

      {record.amendmentReason === null ? null : (
        <section className="border-rule bg-card mt-4 rounded-lg border p-5">
          <h2 className="eyebrow text-drape">Why this record was corrected</h2>
          <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{record.amendmentReason}</p>
        </section>
      )}

      <ConsultationEngine
        slug={slug}
        /* ⚠️ THE RECORD'S OWN BRANCH, NOT THE READER'S. Reached by encounter id
           rather than through a booking, so there is no row carrying a zone —
           but the encounter names its branch, and an org-wide reader opening a
           consultation written at another site must see the times where it
           happened. The appointments page passes the BOOKING's zone for the
           same reason; the two screens show one record and must agree. */
        timeZone={await timezoneOfBranch(slug, record.branchId)}
        /* Reached by encounter id, not through a booking — see the page note. */
        appointmentId={null}
        encounter={record}
        canWrite={false}
        canFinalize={false}
        canAmend={false}
      />
    </div>
  );
}
