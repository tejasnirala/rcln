import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ActiveIngredientSummary, UnitListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { CompositionForm } from '@/components/tenant/composition-form';

export const metadata: Metadata = { title: 'Add a composition' };

/**
 * <slug>.rcln.com/products/compositions/new
 *
 * ⚠️ NO INGREDIENTS MEANS A BLOCKED SCREEN AND NOT AN EMPTY PICKER. A composition
 *   needs at least one, the contract says so with `.min(1)`, and a form whose only
 *   required select has nothing in it is nine fields somebody fills in before
 *   being told. It sends them one link back instead — the same call
 *   `/products/new` makes about units.
 */
export default async function NewCompositionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)) {
    return (
      <Alert tone="error">
        You do not have permission to add compositions here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [ingredients, units] = await Promise.all([
    api<{ ingredients: ActiveIngredientSummary[] }>('/api/v1/active-ingredients', {
      slug,
      accessToken,
    }),
    api<UnitListResponse>('/api/v1/units', { slug, accessToken }),
  ]);

  if ((ingredients.data?.ingredients.length ?? 0) === 0) {
    return (
      <Alert tone="info">
        There are no ingredients to build a composition from yet. Add them under Ingredients first —
        a composition is one or more of them, each at a strength.
      </Alert>
    );
  }

  return (
    <CompositionForm
      slug={slug}
      ingredients={ingredients.data?.ingredients ?? []}
      units={units.data?.units ?? []}
      canManage
    />
  );
}
