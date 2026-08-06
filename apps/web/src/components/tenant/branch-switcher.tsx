'use client';

import { useTransition } from 'react';
import type { BranchSummary } from '@rcln/contracts';
import { switchBranch } from '@/app/(tenant)/t/[slug]/actions';
import { hardNavigate } from '@/lib/hard-navigate';
import { ScopeSwitcher } from '@/components/shell/scope-switcher';

/**
 * The branch segment of the scope chain.
 *
 * Which branch you are in decides what you can see and what you can do, so the
 * switch is a server round trip — a re-issued access token — and never a
 * client-side filter. `slug` is bound on the server, so the browser cannot
 * substitute another clinic's.
 */
export function BranchSwitcher({
  slug,
  branches,
  activeBranchId,
}: {
  slug: string;
  branches: BranchSummary[];
  activeBranchId: string | null;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <ScopeSwitcher
      label="Branch"
      placeholder="Choose a branch"
      pending={pending}
      currentId={activeBranchId}
      options={branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        detail: branch.city ? `${branch.code} · ${branch.city}` : branch.code,
      }))}
      onSwitch={(branchId) => {
        startTransition(async () => {
          await switchBranch(slug, branchId);
          /*
           * The action no longer redirects: a router navigation to `/` resolves
           * against the route tree and lands on the marketing page, because the
           * rewrite only applies to real requests. Reloading also re-reads every
           * server component under the new branch. See lib/hard-navigate.ts.
           */
          hardNavigate('/');
        });
      }}
    />
  );
}
