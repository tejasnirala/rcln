import type { Metadata } from 'next';
import { PERMISSIONS } from '@rcln/permissions';
import type { ActiveIngredientSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { IngredientList } from '@/components/tenant/ingredient-list';

export const metadata: Metadata = { title: 'Ingredients' };

/**
 * <slug>.rcln.com/products/ingredients
 *
 * `includeInactive=true` for the reason the manufacturers page gives: this is
 * where retiring happens, so it has to show what it retired.
 *
 * NO PHI.
 */
export default async function IngredientsPage({ params }: { params: Promise<{ slug: string }> }) {
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

  const ingredients = await api<{ ingredients: ActiveIngredientSummary[] }>(
    '/api/v1/active-ingredients?includeInactive=true',
    { slug, accessToken: await getAccessToken() }
  );

  if (!ingredients.ok) {
    return (
      <Alert tone="error">
        {ingredients.message ?? 'Ingredients could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <IngredientList
      slug={slug}
      ingredients={ingredients.data?.ingredients ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
    />
  );
}
