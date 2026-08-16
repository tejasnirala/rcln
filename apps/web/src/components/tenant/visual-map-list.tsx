'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import type { SpecialtySummary, VisualMapListResponse } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { ancestorLabel, buildTree } from '@/lib/taxonomy';
import {
  createChart,
  type ChartFormState,
} from '@/app/(tenant)/t/[slug]/(app)/visual-maps/actions';

/**
 * The charts a consultation can draw on, here.
 *
 * NO PHI. Every string on this screen is configuration.
 *
 * ⚠️ THE PLATFORM CHARTS ARE READ-ONLY AND THE SCREEN SAYS SO RATHER THAN HIDING
 *   THEM. A clinic that cannot see the odontogram does not know what its
 *   dentists are drawing on, and "where did the tooth chart come from?" is
 *   unanswerable from a list showing only what the clinic itself drew.
 *
 * ⚠️ AND THE CODE COLUMN IS THE ONE THAT MATTERS. A template cites a chart by
 *   CODE (CD-6) — that string is the whole join between the two screens, and it
 *   is what somebody has to type into a template's `mapCode`.
 */
export function VisualMapList({
  slug,
  data,
  specialties,
}: {
  slug: string;
  data: VisualMapListResponse;
  specialties: SpecialtySummary[];
}) {
  const [adding, setAdding] = useState(false);
  const [careContextId, setCareContextId] = useState('');
  const [state, formAction, pending] = useActionState<ChartFormState, FormData>(
    createChart.bind(null, slug),
    {}
  );

  const tree = useMemo(() => buildTree(specialties), [specialties]);
  const careContexts = useMemo(
    () => specialties.filter((node) => node.type === 'CARE_CONTEXT'),
    [specialties]
  );

  /* Filtered to the chosen care context for the reason the template form gives:
     a node under Veterinary on a Human chart is a row nothing can ever resolve. */
  const nodesUnderContext = useMemo(() => {
    if (careContextId === '') return [];
    const inContext = (node: SpecialtySummary): boolean => {
      let cursor: SpecialtySummary | undefined = node;
      for (let hop = 0; cursor && hop < 64; hop += 1) {
        if (cursor.id === careContextId) return true;
        cursor = cursor.parentId === null ? undefined : tree.byId.get(cursor.parentId);
      }
      return false;
    };
    return specialties
      .filter((node) => node.type !== 'CARE_CONTEXT' && inContext(node))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [careContextId, specialties, tree]);

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-drape text-xl font-semibold">Charts</h1>
          <p className="text-muted mt-1 max-w-2xl text-[0.9375rem]">
            The pictures a clinician marks findings on — a tooth chart, a scalp map, a body diagram.
            A consultation template names one by its code; what the clinician records on it is a row
            on the patient&rsquo;s record, never a mark on the picture. Charts marked{' '}
            <span className="text-muted font-mono text-[0.75rem]">shared</span> come with rcln.
          </p>
        </div>
        <Button type="button" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New chart'}
        </Button>
      </header>

      {adding ? (
        <form action={formAction} className="border-rule bg-card space-y-3 rounded-lg border p-4">
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Name" required maxLength={160} />
            <Input
              name="code"
              label="Code"
              hint="What a consultation template names this chart by. It cannot be changed later."
              required
              maxLength={64}
              className="font-mono text-[0.875rem]"
            />
            <Select
              name="careContextId"
              label="Kind of patient"
              hint="Decided by the patient, not the doctor."
              required
              value={careContextId}
              onChange={(event) => setCareContextId(event.target.value)}
              options={[
                { value: '', label: 'Choose one' },
                ...careContexts.map((node) => ({ value: node.id, label: node.name })),
              ]}
            />
            <Select
              name="specialtyId"
              label="Especially for"
              hint="Where it is offered first. It stays available everywhere."
              defaultValue=""
              disabled={careContextId === ''}
              options={[
                { value: '', label: 'Every consultation of this kind' },
                ...nodesUnderContext.map((node) => ({
                  value: node.id,
                  label: `${node.name}${ancestorLabel(tree, node.id) === '' ? '' : ` — ${ancestorLabel(tree, node.id)}`}`,
                })),
              ]}
            />
            <Input
              name="viewBox"
              label="Coordinate space"
              hint="Four numbers: left, top, width, height. Every region is placed inside it."
              required
              defaultValue="0 0 640 320"
              maxLength={64}
              className="font-mono text-[0.875rem]"
            />
          </div>
          <Textarea
            name="description"
            label="Description"
            hint="Optional. What this chart is a picture of, in your own words."
            rows={2}
            maxLength={2000}
          />
          <p className="text-muted text-[0.8125rem]">
            A new chart starts empty. Add its regions next — nothing can be drawn on it until it has
            some.
          </p>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create chart'}
          </Button>
        </form>
      ) : null}

      {data.items.length === 0 ? (
        <Alert tone="info">No charts yet.</Alert>
      ) : (
        <div className="border-rule overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[0.9375rem]">
            <thead className="bg-card text-muted text-[0.8125rem]">
              <tr>
                <th className="px-4 py-2 font-medium">Chart</th>
                <th className="px-4 py-2 font-medium">Especially for</th>
                <th className="px-4 py-2 font-medium">Regions</th>
                <th className="px-4 py-2 font-medium">Origin</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((map) => (
                <tr key={map.id} className="border-rule border-t">
                  <td className="px-4 py-2">
                    <Link
                      href={`/visual-maps/${map.id}`}
                      className="text-drape underline-offset-2 hover:underline"
                    >
                      {map.name}
                    </Link>
                    {!map.isActive ? (
                      <span className="text-muted ml-2 text-[0.75rem]">off</span>
                    ) : null}
                    <div className="text-muted font-mono text-[0.75rem]">{map.code}</div>
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {map.specialtyName ?? `Every ${map.careContextName} consultation`}
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {/* ⚠️ The state worth noticing: a chart that exists, reads as
                        configured, and has nothing to draw. */}
                    {map.regionCount === 0 ? 'None yet' : map.regionCount}
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {map.isOwn ? 'Yours' : 'shared'}
                  </td>
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
              href={`/visual-maps?page=${data.page - 1}`}
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
              href={`/visual-maps?page=${data.page + 1}`}
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
