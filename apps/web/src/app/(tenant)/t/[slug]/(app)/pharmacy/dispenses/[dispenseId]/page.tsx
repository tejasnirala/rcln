import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { DispenseDetail as DispenseDetailShape } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timeFormatOf, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DispenseDetail } from '@/components/tenant/dispense-detail';
import { pharmacyAccess } from '../../guard';

export const metadata: Metadata = { title: 'Dispense' };

/**
 * ⚠️ PHI. Opening this writes one data-access row naming the patient.
 *
 * ⚠️ TIMES RENDER IN THE CLINIC'S ZONE AND FORMAT, never the browser's
 *   (invariant 6).
 */
export default async function DispensePage({
  params,
}: {
  params: Promise<{ slug: string; dispenseId: string }>;
}) {
  const { slug, dispenseId } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to the dispensary here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [dispense, timezone, timeFormat] = await Promise.all([
    api<DispenseDetailShape>(`/api/v1/pharmacy/dispenses/${dispenseId}`, { slug, accessToken }),
    timezoneOf(slug),
    timeFormatOf(slug),
  ]);

  if (dispense.status === 404) notFound();
  if (!dispense.ok || !dispense.data) {
    return (
      <Alert tone="error">
        {dispense.message ?? 'That supply could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <DispenseDetail
      slug={slug}
      dispense={dispense.data}
      timezone={timezone}
      timeFormat={timeFormat}
      canTakeReturns={access.canTakeReturns}
    />
  );
}
