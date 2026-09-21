import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { CompositionSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { CompositionList } from '@/components/tenant/composition-list';

export const metadata: Metadata = { title: 'Compositions' };

/**
 * <slug>.rcln.com/products/compositions
 *
 * NO PHI. A formula is a fact about a substance.
 */
export default async function CompositionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const compositions = await api<{ compositions: CompositionSummary[] }>(
    '/api/v1/compositions?includeInactive=true',
    { slug, accessToken: await getAccessToken() }
  );

  if (!compositions.ok) {
    return (
      <Alert tone="error">
        {compositions.message ?? 'Compositions could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <CompositionList
      compositions={compositions.data?.compositions ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
