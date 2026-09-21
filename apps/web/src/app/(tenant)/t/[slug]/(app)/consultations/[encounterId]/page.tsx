import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type {
  ConsumptionListResponse,
  ConsumptionPlanResponse,
  EncounterDetail,
  InventoryLocationListResponse,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timezoneOfBranch } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsultationEngine } from '@/components/tenant/consultation-engine';
import { ConsumptionPanel } from '@/components/tenant/consumption-panel';
import { usageAccess } from '../../usage/guard';

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
  const timeZone = await timezoneOfBranch(slug, record.branchId);

  /*
   * ⚠️ WHAT THIS CONSULTATION CONSUMED (PI-9), FETCHED BESIDE THE RECORD RATHER
   *   THAN INSIDE THE ENGINE. It is not clinical content — the consultation
   *   engine renders the chart through the encounter's own frozen snapshot, and
   *   a stock movement has no place in that snapshot (invariant 7). It is
   *   rendered here, beside the record, which is exactly the relationship the
   *   two things have.
   *
   * ⚠️ AND IT IS WRITABLE ON A SCREEN THAT IS OTHERWISE READ-ONLY, WHICH IS NOT
   *   AN INCONSISTENCY. The clinical record of a signed consultation is
   *   immutable and there is no endpoint that edits one; what came off the
   *   trolley is a different fact with a different lifecycle, and it can be
   *   recorded late — a nurse reconciling a tray after the doctor has signed is
   *   the ordinary case rather than an exception.
   */
  const consumption = await usageAccess(slug);

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
        timeZone={timeZone}
        /* Reached by encounter id, not through a booking — see the page note. */
        appointmentId={null}
        encounter={record}
        canWrite={false}
        canFinalize={false}
        canAmend={false}
      />

      {consumption.canRead ? (
        <ConsumptionSection
          slug={slug}
          encounterId={encounterId}
          branchId={record.branchId}
          timeZone={timeZone}
          canRecord={consumption.canRecord}
          canOverride={consumption.canOverride}
        />
      ) : null}
    </div>
  );
}

/**
 * The consumption panel's own data, fetched separately.
 *
 * ⚠️ THREE REQUESTS RATHER THAN ONE, AND THEY ARE PARALLEL. The plan, what has
 *   already been recorded and the places stock can come from are three different
 *   endpoints owned by three different services; awaiting them in sequence would
 *   be the waterfall `vercel-react-best-practices` names first.
 *
 * ⚠️ THE PLAN IS FOR THE CONSULTATION ITSELF, NOT FOR A PROCEDURE. Anchoring to
 *   a named procedure is what the API prefers and what a dental workflow wants,
 *   but this screen is reached by encounter id from the visit history and has no
 *   procedure selected. Recording against the visit is the honest anchor for
 *   what it knows; a procedure-anchored panel belongs on the procedure, which is
 *   inside the consultation engine and is a screen PI-9 deliberately did not
 *   reshape.
 */
async function ConsumptionSection({
  slug,
  encounterId,
  branchId,
  timeZone,
  canRecord,
  canOverride,
}: {
  slug: string;
  encounterId: string;
  branchId: string;
  timeZone: string;
  canRecord: boolean;
  canOverride: boolean;
}) {
  const accessToken = await getAccessToken();

  const [plan, records, locations] = await Promise.all([
    api<ConsumptionPlanResponse>(
      `/api/v1/consumption/plan?encounterId=${encounterId}&branchId=${branchId}`,
      { slug, accessToken }
    ),
    api<ConsumptionListResponse>(
      `/api/v1/consumption/records?encounterId=${encounterId}&limit=50`,
      { slug, accessToken }
    ),
    api<InventoryLocationListResponse>(`/api/v1/inventory-locations?branchId=${branchId}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!plan.ok || !plan.data) {
    return (
      <Alert tone="info" className="mt-4">
        What this consultation used could not be loaded. The clinical record above is unaffected.
      </Alert>
    );
  }

  return (
    <ConsumptionPanel
      slug={slug}
      plan={plan.data}
      records={records.data?.items ?? []}
      locations={(locations.data?.locations ?? []).filter((location) => location.isActive)}
      timeZone={timeZone}
      canRecord={canRecord}
      canOverride={canOverride}
    />
  );
}
