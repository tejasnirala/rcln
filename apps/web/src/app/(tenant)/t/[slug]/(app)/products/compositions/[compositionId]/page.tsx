import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PERMISSIONS } from '@rcln/permissions';
import type {
  ActiveIngredientSummary,
  CompositionSummary,
  UnitListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { CompositionForm } from '@/components/tenant/composition-form';

export const metadata: Metadata = { title: 'Composition' };

/**
 * <slug>.rcln.com/products/compositions/<id>
 *
 * A composition in another tenant is filtered out by RLS before the service sees
 * it, so the API answers 404 — indistinguishable from one that never existed,
 * which is the intent.
 */
export default async function CompositionPage({
  params,
}: {
  params: Promise<{ slug: string; compositionId: string }>;
}) {
  const { slug, compositionId } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [composition, ingredients, units] = await Promise.all([
    api<CompositionSummary>(`/api/v1/compositions/${compositionId}`, { slug, accessToken }),
    api<{ ingredients: ActiveIngredientSummary[] }>('/api/v1/active-ingredients', {
      slug,
      accessToken,
    }),
    api<UnitListResponse>('/api/v1/units', { slug, accessToken }),
  ]);

  if (composition.status === 404) notFound();

  if (!composition.ok || !composition.data) {
    return (
      <Alert tone="error">
        {composition.message ?? 'This composition could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <CompositionForm
      slug={slug}
      ingredients={ingredients.data?.ingredients ?? []}
      units={units.data?.units ?? []}
      composition={composition.data}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
