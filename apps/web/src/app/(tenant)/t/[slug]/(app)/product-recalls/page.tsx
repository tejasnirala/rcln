import type { Metadata } from 'next';
import type { RecallListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ProductRecallList } from '@/components/tenant/product-recall-list';
import { recallAccess } from './guard';

export const metadata: Metadata = { title: 'Recall notices' };

/**
 * <slug>.rcln.com/product-recalls — every notice this clinic has raised.
 *
 * ⚠️ NOT PHI. Every column is a product, a lot count and a date; the names of the
 *   people who received a recalled lot are behind a second permission and are
 *   reached from the notice itself.
 */
export default async function RecallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await recallAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to recall notices here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = new URLSearchParams();
  for (const key of ['status', 'productId', 'classification', 'search', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  /*
   * ⚠️ THE PRODUCT LIST IS GONE FROM THIS PAGE ENTIRELY (PI-23). It used to be
   *   fetched only when the create form could be shown — two hundred rows, for a
   *   picker that could not reach the rest of the catalogue. The picker searches
   *   now, so the page pays for nothing at all until somebody types.
   */
  const [recalls, timeZone] = await Promise.all([
    api<RecallListResponse>(`/api/v1/recalls?${search.toString()}`, { slug, accessToken }),
    timezoneOf(slug),
  ]);

  if (!recalls.ok || !recalls.data) {
    return (
      <Alert tone="error">
        {recalls.message ?? 'This could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ProductRecallList
      slug={slug}
      recalls={recalls.data.items}
      meta={recalls.data}
      timeZone={timeZone}
      canCreate={access.canCreate}
    />
  );
}
