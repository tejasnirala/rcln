import type { Metadata } from 'next';
import { api } from '@/lib/api';
import { countryOf, getAccessToken } from '@/lib/session';
import type { SupplierListResponse } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { SupplierForm } from '@/components/tenant/supplier-form';
import { procurementAccess } from '../../guard';

export const metadata: Metadata = { title: 'Add a supplier' };

export default async function NewSupplierPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await procurementAccess(slug);

  if (!access.canManageSuppliers) {
    return <Alert tone="error">You cannot add suppliers here.</Alert>;
  }

  const accessToken = await getAccessToken();
  const [countryCode, existing] = await Promise.all([
    countryOf(slug),
    // Only to offer the currencies this clinic already uses first. A failure here is
    // cosmetic, so it falls back to the built-in list rather than blocking the form.
    api<SupplierListResponse>('/api/v1/procurement/suppliers?limit=100', { slug, accessToken }),
  ]);

  const currencies = [
    ...new Set(
      (existing.data?.suppliers ?? [])
        .map((s) => s.defaultCurrency)
        .filter((code): code is string => code !== null)
    ),
  ];

  return <SupplierForm slug={slug} currencies={currencies} countryCode={countryCode} />;
}
