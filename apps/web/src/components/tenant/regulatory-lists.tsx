'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import type {
  JurisdictionListResponse,
  RegulatoryAuthorityListResponse,
  RegulatorySourceListResponse,
  RulePackListResponse,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RegulatoryNav } from '@/components/tenant/regulatory-nav';
import { maturityLabel } from '@/components/tenant/maturity-rail';
import { formatClinicDate } from '@/lib/format';

/**
 * The four read-only lists under Rules, in one file.
 *
 * ⚠️ ONE FILE BECAUSE THEY ARE ONE SCREEN WITH FOUR TABS, and four near-identical
 *   files is how one of them ends up with a different empty state, a different
 *   pager, or — worse here — a different way of saying "this is configuration,
 *   not compliance".
 *
 * ⚠️ NONE OF THEM HAS A SAVE BUTTON, AND NONE OF THEM SHOULD GROW ONE. A clinic
 *   reads the law and never writes it: `regulatory.rule.manage` is a platform
 *   code, the console lives on the admin host, and the database refuses a write
 *   from any transaction that names a tenant. What a clinic maintains is on the
 *   product — Catalogue → a product → Regulatory.
 *
 * NO PHI on any of these screens.
 */

function useNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const goToPage = useCallback(
    (page: number) => {
      const next = new URLSearchParams(searchParams.toString());
      if (page <= 1) next.delete('page');
      else next.set('page', String(page));
      startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router, searchParams]
  );

  return { goToPage, pending };
}

function Pager({
  meta,
  onPage,
}: {
  meta: { page: number; totalPages: number };
  onPage: (page: number) => void;
}) {
  if (meta.totalPages <= 1) return null;

  return (
    <nav aria-label="Pages" className="mt-4 flex items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        disabled={meta.page <= 1}
        onClick={() => onPage(meta.page - 1)}
      >
        Previous
      </Button>
      <span className="text-muted text-[0.8125rem]">
        Page {meta.page} of {meta.totalPages}
      </span>
      <Button
        type="button"
        variant="secondary"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPage(meta.page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

function SectionHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <header>
      <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">{title}</h1>
      <p className="text-muted mt-1 max-w-prose text-[0.875rem]">{blurb}</p>
    </header>
  );
}

function Empty({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="border-rule bg-card rounded-md border p-10 text-center">
      <p className="text-ink text-[0.9375rem]">{headline}</p>
      <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">{detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function JurisdictionList({
  jurisdictions,
  meta,
}: {
  jurisdictions: JurisdictionListResponse['jurisdictions'];
  meta: JurisdictionListResponse['meta'];
}) {
  const { goToPage, pending } = useNavigation();

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Where rules apply"
        blurb="A country, or a state or province of one. A branch is evaluated against its own place first and its country second."
      />
      <RegulatoryNav />

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        {jurisdictions.length === 0 ? (
          <Empty
            headline="No places are set up yet."
            detail="Rules are added country by country. Until one covers your branch, dispensing questions come back undetermined — which means the answer is no."
          />
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {jurisdictions.map((j) => (
              <li key={j.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3.5">
                <span className="text-ink font-mono text-[0.8125rem]">{j.label}</span>
                <span className="text-ink text-[0.9375rem] font-medium">{j.name}</span>
                <span className="text-muted ml-auto text-[0.8125rem]">
                  {j.rulePackCount === 0
                    ? 'No rule packs'
                    : `${j.rulePackCount} rule ${j.rulePackCount === 1 ? 'pack' : 'packs'}`}
                  {' · '}
                  {j.authorityCount === 1 ? '1 regulator' : `${j.authorityCount} regulators`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Pager meta={meta} onPage={goToPage} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AuthorityList({
  authorities,
  meta,
}: {
  authorities: RegulatoryAuthorityListResponse['authorities'];
  meta: RegulatoryAuthorityListResponse['meta'];
}) {
  const { goToPage, pending } = useNavigation();

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Who writes the rules"
        blurb="The bodies whose publications the rules are taken from. One place can have several — a national regulator and a state one write different things."
      />
      <RegulatoryNav />

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        {authorities.length === 0 ? (
          <Empty
            headline="No regulators are recorded yet."
            detail="A rule cites the document a regulator published, so regulators are recorded before any rule is."
          />
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {authorities.map((a) => (
              <li key={a.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink font-mono text-[0.8125rem]">{a.code}</span>
                  <span className="text-ink text-[0.9375rem] font-medium">{a.name}</span>
                  <span className="text-muted ml-auto font-mono text-[0.75rem]">
                    {a.jurisdictionLabel}
                  </span>
                </div>
                {a.remit ? (
                  <p className="text-muted mt-1 max-w-prose text-[0.8125rem]">{a.remit}</p>
                ) : null}
                {a.websiteUrl ? (
                  <a
                    href={a.websiteUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                    className="text-drape mt-1 inline-block text-[0.8125rem] underline"
                  >
                    {a.websiteUrl}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pager meta={meta} onPage={goToPage} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RulePackList({
  packs,
  meta,
}: {
  packs: RulePackListResponse['packs'];
  meta: RulePackListResponse['meta'];
}) {
  const { goToPage, pending } = useNavigation();

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Rule packs"
        blurb="One place, one version, a set of rules, and a published document behind every one of them."
      />
      <RegulatoryNav />

      {/*
       * ⚠️ STATED ONCE, AT THE TOP, AND NOT LEFT TO THE BADGES. Anything below
       *   `Live` is configuration, and a screen that showed only per-pack states
       *   would let a reader infer that a configured pack is a checked one.
       */}
      <Alert tone="info">
        Rule packs are configuration, not compliance. rcln makes no claim that any pack is complete
        or current for your clinic, and nothing in this software can mark one reviewed — that is a
        named person’s decision.
      </Alert>

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        {packs.length === 0 ? (
          <Empty
            headline="No rule packs yet."
            detail="Until a pack covers your branch’s place, every regulatory question comes back undetermined — and undetermined means the answer is no."
          />
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {packs.map((pack) => (
              <li key={pack.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/regulatory/rule-packs/${pack.id}`}
                    className="text-ink hover:text-drape text-[0.9375rem] font-medium"
                  >
                    {pack.name}
                  </Link>
                  <span className="text-muted font-mono text-[0.75rem]">
                    {pack.jurisdictionLabel} · v{pack.version}
                  </span>
                  <span
                    className={
                      pack.isProductionEnabled
                        ? 'text-drape border-drape/30 ml-auto rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                        : 'text-muted border-rule ml-auto rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                    }
                  >
                    {maturityLabel(pack.maturity)}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {pack.ruleCount === 1 ? '1 rule' : `${pack.ruleCount} rules`} · in force from{' '}
                  {pack.effectiveFrom}
                  {pack.effectiveTo ? ` to ${pack.effectiveTo}` : ''} · {pack.authorityCode}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Pager meta={meta} onPage={goToPage} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SourceList({
  sources,
  meta,
  timezone,
}: {
  sources: RegulatorySourceListResponse['sources'];
  meta: RegulatorySourceListResponse['meta'];
  /**
   * ⚠️ `retrievedAt` IS AN INSTANT — when somebody last read the document — so
   *   it is rendered in the clinic's zone rather than sliced out of an ISO
   *   string, which would show the UTC day. `publishedOn` is a `@db.Date` and is
   *   already a calendar day; it is printed as stored.
   */
  timezone: string;
}) {
  const { goToPage, pending } = useNavigation();

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Says who"
        blurb="The published documents behind the rules. Every rule cites one — no source, no rule."
      />
      <RegulatoryNav />

      <section aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : ''}>
        {sources.length === 0 ? (
          <Empty
            headline="No sources are recorded yet."
            detail="Sources are recorded before rules are written, so that every refusal can be traced back to the document it came from."
          />
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {sources.map((source) => (
              <li key={source.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">{source.title}</span>
                  <span className="text-muted font-mono text-[0.75rem]">
                    {source.jurisdictionLabel} · {source.authorityCode}
                  </span>
                  <span className="text-muted border-rule ml-auto rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                    {source.reviewStatus === 'VERIFIED'
                      ? 'Checked'
                      : source.reviewStatus === 'UNVERIFIED'
                        ? 'Not re-checked'
                        : source.reviewStatus === 'UNAVAILABLE'
                          ? 'Cannot be found'
                          : 'Replaced'}
                  </span>
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {source.documentReference ? `${source.documentReference} · ` : ''}
                  {source.ruleCount === 1 ? '1 rule' : `${source.ruleCount} rules`}
                  {source.publishedOn ? ` · published ${source.publishedOn}` : ''}
                  {source.retrievedAt
                    ? ` · last read ${formatClinicDate(source.retrievedAt, timezone)}`
                    : ''}
                </p>
                {source.sourceUrl ? (
                  <a
                    href={source.sourceUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                    className="text-drape mt-1 inline-block max-w-full truncate text-[0.8125rem] underline"
                  >
                    {source.sourceUrl}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pager meta={meta} onPage={goToPage} />
      </section>
    </div>
  );
}
