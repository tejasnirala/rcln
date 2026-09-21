import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PharmacyPrescriptionDetail, SubstitutionResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SubstitutionPanel } from '@/components/tenant/substitution-panel';
import { pharmacyAccess } from '../../../../guard';

export const metadata: Metadata = { title: 'Equivalents' };

/**
 * ⚠️ GATED ON THE READ CODE, BECAUSE IT AUTHORISES NOTHING. It answers "what is
 *   equivalent, and what would the rules say"; the supply asks the engine again
 *   at the moment of supplying and never trusts an answer a screen carried.
 */
export default async function SubstitutionsPage({
  params,
}: {
  params: Promise<{ slug: string; encounterId: string; productId: string }>;
}) {
  const { slug, encounterId, productId } = await params;
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

  const item = prescription.data.items.find((line) => line.productId === productId);
  const search = new URLSearchParams({ branchId: prescription.data.branchId });
  if (item?.outstandingQuantityBase) search.set('quantityBase', item.outstandingQuantityBase);

  const substitution = await api<SubstitutionResponse>(
    `/api/v1/pharmacy/substitutions/${productId}?${search.toString()}`,
    { slug, accessToken }
  );

  if (!substitution.ok || !substitution.data) {
    return (
      <Alert tone="warning">
        {substitution.message ??
          'Equivalents could not be worked out for this medicine. It may have no composition recorded in the catalogue.'}
      </Alert>
    );
  }

  return (
    <SubstitutionPanel
      encounterId={encounterId}
      substitution={substitution.data}
      baseUnitSymbol={item?.baseUnitSymbol ?? ''}
    />
  );
}
