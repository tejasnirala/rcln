import type { Metadata } from 'next';
import type { BranchListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { BranchList } from '@/components/tenant/branch-list';

export const metadata: Metadata = {
  title: 'Branches',
};

/**
 * <slug>.rcln.com/branches
 *
 * The auth guard, header and branch switcher come from the `(app)` layout. This
 * page only fetches and hands off.
 *
 * A caller without `branch.read` gets 403 from the API rather than an empty
 * list, so the two are told apart below — an empty state that actually means
 * "you may not see this" is how a permissions bug goes unnoticed.
 */
export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await api<BranchListResponse>('/api/v1/branches', {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return (
      <Alert tone="error">
        {result.status === 403
          ? 'You do not have access to branch settings. Ask an administrator at this clinic.'
          : (result.message ?? 'Branches could not be loaded.')}
      </Alert>
    );
  }

  return <BranchList slug={slug} branches={result.data.branches} />;
}
