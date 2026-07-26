import type { Metadata } from 'next';
import Link from 'next/link';
import type { BranchListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Your clinic',
};

/**
 * <slug>.rcln.com/ — the clinic's home.
 *
 * This is the app, not the marketing site. apps/web/AGENTS.md reserves boldness
 * for the marketing shell and spends none of it here: no display headline, no
 * prose about the roadmap. The first thing on the page should be a fact about
 * this clinic today.
 *
 * What it can honestly show is bounded by what exists. Appointments, revenue and
 * queues arrive in Phase 3, so the real content right now is the branch estate
 * and who is open — which is genuine operational information, not a placeholder.
 * The setup checklist stays only while something is actually unfinished.
 */
export default async function TenantHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Resolved by the (app) layout; memoised, so this is not a second request.
  const session = await getSession(slug);
  if (!session) return null;

  const membership = session.memberships.find(
    (m) => m.organizationId === session.activeOrganizationId
  );
  const activeBranch = membership?.branches.find((b) => b.id === session.activeBranchId);

  const canReadBranches = session.permissions.includes('branch.read');
  const result = canReadBranches
    ? await api<BranchListResponse>('/api/v1/branches', {
        slug,
        accessToken: await getAccessToken(),
      })
    : null;
  const branches = result?.data?.branches ?? [];

  // 0 = Sunday, matching dayOfWeek in the contract and Postgres extract(dow).
  const today = new Date().getDay();
  const openToday = branches.filter((b) => {
    const hours = b.operatingHours.find((h) => h.dayOfWeek === today);
    return b.status === 'ACTIVE' && hours && !hours.isClosed;
  });
  const withoutHours = branches.filter((b) => b.operatingHours.length === 0);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-ink text-[1.375rem] font-medium tracking-tight">
          {membership?.organizationName ?? slug}
        </h1>
        <p className="text-muted text-[0.8125rem]">
          {activeBranch ? `You are working at ${activeBranch.name}` : 'No branch selected'}
        </p>
      </div>

      {canReadBranches ? (
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <Stat label="Branches" value={String(branches.length)} />
          <Stat
            label="Open today"
            value={`${String(openToday.length)} of ${String(branches.length)}`}
            detail={
              openToday.length > 0
                ? openToday.map((b) => b.name).join(', ')
                : 'No opening hours cover today'
            }
          />
          <Stat
            label="Your access"
            value={membership?.roles.join(', ') ?? '—'}
            detail={`${String(session.permissions.length)} permissions at this branch`}
          />
        </dl>
      ) : null}

      {withoutHours.length > 0 ? (
        <section className="border-rule bg-card mt-8 rounded-lg border p-5">
          <h2 className="text-ink text-[0.9375rem] font-medium">Finish setting up</h2>
          <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
            {withoutHours.length === 1
              ? `${withoutHours[0]?.name ?? 'One branch'} has no opening hours, so it cannot offer bookable slots.`
              : `${String(withoutHours.length)} branches have no opening hours, so they cannot offer bookable slots.`}
          </p>
          <Link
            href="/branches"
            className="text-drape hover:text-drape-deep mt-3 inline-block py-1 text-[0.875rem] underline underline-offset-2"
          >
            Set opening hours
          </Link>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="eyebrow text-drape">Manage</h2>
        <ul className="border-rule bg-card divide-rule mt-3 divide-y rounded-lg border">
          {canReadBranches ? (
            <Entry
              href="/branches"
              label="Branches"
              detail="Locations, addresses and opening hours"
            />
          ) : null}
          {/* Members, roles and settings land in the slices after this one. An
              entry that does nothing yet is worse than no entry, so they are
              added when they work rather than shown greyed out. */}
        </ul>
      </section>

      <p className="text-muted mt-8 text-[0.8125rem] leading-relaxed">
        Appointments, prescriptions, pharmacy, lab and billing arrive in the phases after this one.
      </p>
    </>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="border-rule bg-card rounded-lg border px-5 py-4">
      <dt className="eyebrow text-muted">{label}</dt>
      <dd className="text-ink mt-1.5 text-[1.25rem] font-medium">{value}</dd>
      {detail ? <p className="text-muted mt-1 text-[0.75rem] leading-relaxed">{detail}</p> : null}
    </div>
  );
}

function Entry({ href, label, detail }: { href: string; label: string; detail: string }) {
  return (
    <li>
      <Link
        href={href}
        className="hover:bg-drape-tint/30 flex items-center gap-4 px-5 py-4 transition-colors"
      >
        <span className="min-w-0">
          <span className="text-ink block text-[0.9375rem] font-medium">{label}</span>
          <span className="text-muted block text-[0.8125rem]">{detail}</span>
        </span>
        <span aria-hidden="true" className="text-drape ml-auto">
          →
        </span>
      </Link>
    </li>
  );
}
