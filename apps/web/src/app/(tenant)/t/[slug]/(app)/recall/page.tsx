import type { Metadata } from 'next';
import { followUpRecallStatus } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { branchesInScope, getSession } from '@/lib/session';
import { todayIn } from '@/lib/calendar-range';
import { Alert } from '@/components/ui/alert';
import { RecallList } from '@/components/tenant/recall-list';
import { loadRecall } from './actions';

export const metadata: Metadata = {
  /** ⚠️ NEVER A PATIENT'S NAME. Every screen under this shell follows the rule. */
  title: 'Recall',
};

/**
 * <slug>.rcln.com/recall?status=DUE
 *
 * Who was told to come back and hasn't (CD-13). The endpoint has answered this
 * since CE-4 and nothing called it; this is the screen.
 *
 * ⚠️ `appointment.read`, NOT A CLINICAL CODE, AND THAT IS THE WHOLE ACCESS
 *   DECISION. This list is worked by the front desk: somebody rings the patient
 *   and books them in. The desk holds no clinical code at all, so gating the
 *   recall list behind `clinical.encounter.read` would mean the only people who
 *   can work it are the people who do not do that job. Advising a follow-up is
 *   authorship and happens in the consultation — invariant 7, applied to a chase
 *   rather than to a chart.
 *
 * ⚠️ OPENING IT WRITES A `data_access_logs` ROW under `PATIENT_LIST`, because
 *   the rows carry names and telephone numbers of people under ongoing
 *   treatment. That is the intended cost of a worklist that can be worked.
 *
 * The window lives in the URL so the list is linkable and the back button works.
 * That is safe for the same reason a date on the day board is: it discloses
 * nobody. A patient filter is deliberately not offered here.
 */
export default async function RecallPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { slug } = await params;
  const { status: rawStatus, page: rawPage } = await searchParams;

  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.APPOINTMENT_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the recall list here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  /*
   * A hand-edited `?status=` falls back to the default window rather than
   * erroring. It is a URL anybody can type, and a 400 on it helps nobody — the
   * same forgiving treatment the day board gives a bad `?date=`.
   */
  const parsed = followUpRecallStatus.safeParse(rawStatus);
  const status = parsed.success ? parsed.data : 'DUE';
  const page = Number.parseInt(rawPage ?? '1', 10);
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;

  /*
   * ⚠️ FROM THE SESSION, NOT `GET /branches`. That endpoint is behind
   *   `branch.read`, which the front desk does not hold — the screen whose main
   *   audience is the desk must not depend on a permission the desk lacks. Same
   *   call the day board records at length.
   */
  const inScope = await branchesInScope(slug);
  const branch = inScope.find((b) => b.id === session?.activeBranchId) ?? inScope[0];

  if (branch === undefined) {
    return <Alert tone="info">No clinic is in scope for you yet. Ask an administrator.</Alert>;
  }

  const recall = await loadRecall(slug, status, safePage, 30);

  if (recall === null) {
    return <Alert tone="error">The recall list could not be loaded.</Alert>;
  }

  return (
    <RecallList
      slug={slug}
      status={status}
      items={recall.items}
      total={recall.total}
      page={recall.page}
      timezone={branch.timezone}
      /* The clinic's clock face, from the session — see the day board's note. */
      timeFormat={branch.timeFormat}
      /*
       * ⚠️ TODAY IN THE BRANCH'S ZONE, NOT THE CONTAINER'S. Resolved here so the
       *   booking form's earliest bookable day and the diary agree on which day
       *   it is. `new Date().toISOString().slice(0, 10)` is today in UTC, which
       *   from half past five IST onwards is yesterday for every Indian clinic.
       */
      today={todayIn(branch.timezone)}
      canBook={permissions.includes(PERMISSIONS.APPOINTMENT_CREATE)}
      /* Declining is `appointment.update`: it changes a booking's fate, not the
         clinical record the doctor signed. */
      canDecline={permissions.includes(PERMISSIONS.APPOINTMENT_UPDATE)}
    />
  );
}
