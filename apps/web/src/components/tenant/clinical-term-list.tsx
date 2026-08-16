'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClinicalMasterListResponse, SpecialtyListResponse } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import {
  createTerm,
  deactivateTerm,
  type TermFormState,
} from '@/app/(tenant)/t/[slug]/(app)/clinical-terms/actions';

/**
 * The clinical vocabulary — the words this clinic can write down.
 *
 * NO PHI. Every string on this screen is a dictionary entry.
 *
 * ⚠️ THE PLATFORM ROWS ARE READ-ONLY AND THE SCREEN SAYS SO RATHER THAN HIDING
 *   THEM. A clinic that cannot see "Dental caries" will type its own, and the
 *   result is two words that render identically in every picker with no way for
 *   a clinician to tell which one they just chose. Showing them, marked, is what
 *   stops that.
 */
export function ClinicalTermList({
  slug,
  kind,
  kinds,
  search,
  data,
  specialties,
  canManage,
}: {
  slug: string;
  kind: string;
  kinds: readonly { value: string; label: string }[];
  search: string;
  data: ClinicalMasterListResponse;
  specialties: SpecialtyListResponse['specialties'];
  canManage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [state, formAction, pending] = useActionState<TermFormState, FormData>(
    createTerm.bind(null, slug, kind),
    {}
  );

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-drape text-xl font-semibold">Clinical terms</h1>
          <p className="text-muted mt-1 text-[0.9375rem]">
            The vocabulary your clinicians pick from. Terms marked{' '}
            <span className="text-muted font-mono text-[0.75rem]">shared</span> come with rcln and
            are the same everywhere; the rest are yours.
          </p>
        </div>
        {canManage ? (
          <Button type="button" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a term'}
          </Button>
        ) : null}
      </header>

      {/*
       * Tabs as links, not state. The kind is in the URL so a clinician can
       * bookmark "our diagnoses" and so the back button behaves — and because
       * the list is SERVER-paginated, a client-side tab would have to refetch
       * anyway.
       */}
      <nav className="border-rule flex flex-wrap gap-1 border-b pb-2" aria-label="Kind of term">
        {kinds.map((k) => (
          <Link
            key={k.value}
            href={`/clinical-terms?kind=${k.value}`}
            aria-current={k.value === kind ? 'page' : undefined}
            className={
              k.value === kind
                ? 'bg-drape-tint text-drape rounded-md px-3 py-1.5 text-[0.875rem] font-medium'
                : 'text-muted hover:text-drape rounded-md px-3 py-1.5 text-[0.875rem]'
            }
          >
            {k.label}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="kind" value={kind} />
        <Input
          name="search"
          label="Search"
          defaultValue={search}
          placeholder="Part of the term"
          fieldClassName="min-w-[16rem] flex-1"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {adding && canManage ? (
        <form action={formAction} className="border-rule bg-card space-y-3 rounded-lg border p-4">
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Name" required maxLength={255} />
            <Input
              name="code"
              label="Code"
              hint="Letters, digits and underscores."
              required
              maxLength={64}
              className="font-mono text-[0.875rem]"
            />
            {/*
             * ⚠️ THE HINT SAYS "SORTS FIRST", NOT "RESTRICTS TO". Relevance
             *   RANKS and never filters (§34) — a clinician who reads this as a
             *   restriction will tag defensively, and a term tagged to one
             *   specialty out of caution sorts below that specialty's own words
             *   everywhere else.
             */}
            <Select
              name="specialtyId"
              label="Especially relevant to"
              hint="Optional. Sorts this term first for that specialty — it never hides it from anyone else."
              defaultValue=""
              options={[
                { value: '', label: 'Everyone' },
                ...specialties.map((sp) => ({ value: sp.id, label: sp.name })),
              ]}
            />
            {kind === 'DIAGNOSIS' ? (
              <Input
                name="icd10"
                label="ICD-10 code"
                hint="Optional. Only enter one you have looked up — nothing here suggests a code."
                maxLength={64}
                className="font-mono text-[0.875rem]"
              />
            ) : null}
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add term'}
          </Button>
        </form>
      ) : null}

      {data.items.length === 0 ? (
        <Alert tone="info">
          {search === ''
            ? 'No terms of this kind yet.'
            : `Nothing matches “${search}”. Try a shorter fragment.`}
        </Alert>
      ) : (
        <div className="border-rule overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[0.9375rem]">
            <thead className="bg-card text-muted text-[0.8125rem]">
              <tr>
                <th className="px-4 py-2 font-medium">Term</th>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Coding</th>
                <th className="px-4 py-2 font-medium">Origin</th>
                {canManage ? (
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="border-rule border-t">
                  <td className="px-4 py-2">
                    {item.name}
                    {!item.isActive ? (
                      <span className="text-muted ml-2 text-[0.75rem]">withdrawn</span>
                    ) : null}
                  </td>
                  <td className="text-muted px-4 py-2 font-mono text-[0.8125rem]">{item.code}</td>
                  <td className="text-muted px-4 py-2 font-mono text-[0.8125rem]">
                    {item.codings.length === 0
                      ? '—'
                      : item.codings.map((c) => `${c.system} ${c.code}`).join(', ')}
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {item.isOwn ? 'Yours' : 'shared'}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-2 text-right">
                      {/*
                       * ⚠️ WITHDRAW, NOT DELETE, and the word on the button says
                       *   so. From CE-4 a consultation references these rows, and
                       *   deleting would destroy the record of what a clinician
                       *   concluded. A platform term offers nothing at all.
                       */}
                      {item.isOwn && item.isActive ? (
                        <button
                          type="button"
                          onClick={async () => {
                            await deactivateTerm(slug, item.id);
                            router.refresh();
                          }}
                          className="text-muted hover:text-drape text-[0.8125rem] underline"
                        >
                          Withdraw
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <nav className="flex items-center gap-3 text-[0.875rem]" aria-label="Pages">
          {data.page > 1 ? (
            <Link
              href={`/clinical-terms?kind=${kind}&page=${data.page - 1}${search === '' ? '' : `&search=${encodeURIComponent(search)}`}`}
              className="text-muted hover:text-drape underline"
            >
              Previous
            </Link>
          ) : null}
          <span className="text-muted">
            Page {data.page} of {totalPages}
          </span>
          {data.page < totalPages ? (
            <Link
              href={`/clinical-terms?kind=${kind}&page=${data.page + 1}${search === '' ? '' : `&search=${encodeURIComponent(search)}`}`}
              className="text-muted hover:text-drape underline"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
