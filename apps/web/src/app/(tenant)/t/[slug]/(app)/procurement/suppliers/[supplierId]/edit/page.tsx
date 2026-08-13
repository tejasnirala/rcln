import type { Metadata } from 'next';
import type { SupplierDetail, SupplierListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { countryOf, getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { SupplierForm } from '@/components/tenant/supplier-form';
import { procurementAccess } from '../../../guard';

export const metadata: Metadata = { title: 'Edit supplier' };

export default async function EditSupplierPage({
  params,
}: {
  params: Promise<{ slug: string; supplierId: string }>;
}) {
  const { slug, supplierId } = await params;
  const access = await procurementAccess(slug);

  if (!access.canManageSuppliers) {
    return <Alert tone="error">You cannot change suppliers here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const [supplier, countryCode, existing] = await Promise.all([
    api<SupplierDetail>(`/api/v1/procurement/suppliers/${supplierId}`, { slug, accessToken }),
    countryOf(slug),
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
  ]);

  if (!supplier.ok || !supplier.data) {
    return <Alert tone="error">{supplier.message ?? 'That supplier could not be loaded.'}</Alert>;
  }

  const currencies = [
    ...new Set(
      (existing.data?.suppliers ?? [])
        .map((s) => s.defaultCurrency)
        .filter((code): code is string => code !== null)
    ),
  ];

  return (
    <SupplierForm
      slug={slug}
      supplier={supplier.data}
      currencies={currencies}
      countryCode={countryCode}
    />
  );
}
