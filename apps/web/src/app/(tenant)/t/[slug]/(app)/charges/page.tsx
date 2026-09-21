import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ChargeQueueSummary, ChargeRequestListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { branchesInScope, getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ChargeQueue } from '@/components/tenant/charge-queue';
import { chargesAccess } from './guard';

export const metadata: Metadata = { title: 'Waiting to be billed' };

/**
 * The charge queue.
 *
 * ⚠️ PHI: every row names a patient and a medicine, except a counter sale. The
 *   API writes a `data_access_logs` row for the list itself, with a count and no
 *   name.
 *
 * ⚠️ THE DEFAULT FILTER IS `PENDING`, AND IT IS APPLIED HERE RATHER THAN IN THE
 *   CONTRACT. A default in the Zod schema would apply to every caller of the
 *   endpoint including a report; this screen's job is what is outstanding, and
 *   somebody who wants the whole history changes the filter.
 */
export default async function ChargesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await chargesAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to charges here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = new URLSearchParams();
  for (const key of [
    'branchId',
    'status',
    'kind',
    'patientId',
    'needsAttention',
    'from',
    'to',
    'page',
  ]) {
    const value = one(key);
    if (value) search.set(key, value);
  }
  if (!search.has('status') && one('status') === undefined) search.set('status', 'PENDING');

  const summarySearch = new URLSearchParams();
  const branchFilter = one('branchId');
  if (branchFilter) summarySearch.set('branchId', branchFilter);

  const [session, branches, charges, summary] = await Promise.all([
    getSession(slug),
    branchesInScope(slug),
    api<ChargeRequestListResponse>(`/api/v1/charging/requests?${search.toString()}`, {
      slug,
      accessToken,
    }),
    api<ChargeQueueSummary>(`/api/v1/charging/requests/summary?${summarySearch.toString()}`, {
      slug,
      accessToken,
    }),
  ]);

  if (!charges.ok || !charges.data) {
    return (
      <Alert tone="error">
        {charges.message ?? 'The charge queue could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ChargeQueue
      slug={slug}
      charges={charges.data.items}
      meta={charges.data}
      summary={
        summary.data ?? {
          branchId: branchFilter ?? null,
          pending: 0,
          needsAttention: 0,
          suppressed: 0,
          invoiced: 0,
          estimatedValueMinor: 0,
          currency: 'INR',
        }
      }
      branches={branches}
      canDecide={access.canDecide}
      /*
       * ⚠️ RAISING THE INVOICE IS `billing.invoice.create`, NOT A CHARGING CODE.
       *   The two are separate acts and the screen has to ask both questions:
       *   somebody may approve a charge and have no business raising a bill.
       */
      canBill={(session?.permissions ?? []).includes(PERMISSIONS.INVOICE_CREATE)}
    />
  );
}
