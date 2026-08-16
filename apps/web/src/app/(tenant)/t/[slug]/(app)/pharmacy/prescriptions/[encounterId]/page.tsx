import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PharmacyPrescriptionDetail } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { PharmacyPrescription } from '@/components/tenant/pharmacy-prescription';
import { pharmacyAccess } from '../../guard';

export const metadata: Metadata = { title: 'Prescription' };

/**
 * ⚠️ PHI, AND READ-ONLY. The dispensary reads the clinical record and writes only
 *   its own row beside it (invariant 7). Opening this writes one data-access row
 *   naming the patient.
 */
export default async function PharmacyPrescriptionPage({
  params,
}: {
  params: Promise<{ slug: string; encounterId: string }>;
}) {
  const { slug, encounterId } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to the dispensary here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const prescription = await api<PharmacyPrescriptionDetail>(
    `/api/v1/pharmacy/prescriptions/${encounterId}`,
    { slug, accessToken }
  );

  if (prescription.status === 404) notFound();
  if (!prescription.ok || !prescription.data) {
    return (
      <Alert tone="error">
        {prescription.message ?? 'That prescription could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <PharmacyPrescription
      slug={slug}
      prescription={prescription.data}
      canVerify={access.canVerify}
      canDispense={access.canDispense}
    />
  );
}
