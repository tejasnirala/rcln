'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import { parseVisualMap } from '@rcln/clinical';
import type { VisualMapDetail } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { VisualMapChart } from '@/components/tenant/visual-mapping';
import {
  addRegion,
  removeRegion,
  updateChart,
  type ChartFormState,
} from '@/app/(tenant)/t/[slug]/(app)/visual-maps/actions';

/**
 * One chart: what it draws, and every place on it.
 *
 * NO PHI. A chart names no patient; the preview below is the same renderer the
 * consultation uses, with nothing marked on it.
 *
 * ⚠️ THE GEOMETRY IS EDITED AS JSON, DELIBERATELY, AND THIS IS THE ONE PLACE
 *   THAT WILL LOOK UNFINISHED. A drag-and-drop chart designer is a real product
 *   and it is not CE-6 — what this phase owes is that a clinic CAN configure a
 *   chart without a deploy, and that the engine refuses a document that says
 *   nothing checkable. The preview is what makes the JSON legible: paste, save,
 *   look. Same trade the consultation template editor makes with its definition.
 *
 * ⚠️ AND THE PLATFORM CHART IS SHOWN AND NOT EDITABLE. A clinic that cannot see
 *   the odontogram cannot tell its dentists what they are drawing on.
 */
export function VisualMapEditor({ slug, map }: { slug: string; map: VisualMapDetail }) {
  const [addingRegion, setAddingRegion] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [chartState, chartAction, chartPending] = useActionState<ChartFormState, FormData>(
    updateChart.bind(null, slug, map.id),
    {}
  );
  const [regionState, regionAction, regionPending] = useActionState<ChartFormState, FormData>(
    addRegion.bind(null, slug, map.id),
    {}
  );

  const parsed = useMemo(
    () => parseVisualMap({ code: map.code, viewBox: map.viewBox, regions: map.regions }),
    [map]
  );

  const groups = useMemo(
    () => map.regions.filter((region) => region.parentId === null),
    [map.regions]
  );

  const remove = async (regionId: string) => {
    setRemoving(regionId);
    setRemoveError(null);
    const result = await removeRegion(slug, map.id, regionId);
    if (result.error !== undefined) setRemoveError(result.error);
    setRemoving(null);
  };

  return (
    <div className="space-y-5">
      <header>
        <Link href="/visual-maps" className="text-muted hover:text-drape text-[0.875rem] underline">
          Charts
        </Link>
        <h1 className="text-drape mt-1 text-xl font-semibold">{map.name}</h1>
        <p className="text-muted mt-1 text-[0.9375rem]">
          <span className="font-mono text-[0.8125rem]">{map.code}</span> ·{' '}
          {map.specialtyName ?? `every ${map.careContextName} consultation`} ·{' '}
          {map.isOwn ? 'yours' : 'comes with rcln, read-only'}
        </p>
        {map.description === null ? null : (
          <p className="text-muted mt-2 max-w-2xl text-[0.9375rem]">{map.description}</p>
        )}
      </header>

      <section>
        <h2 className="eyebrow text-drape">Preview</h2>
        <div className="mt-2">
          {parsed.ok ? (
            <VisualMapChart
              map={parsed.value}
              marks={new Map()}
              selectedId={null}
              onSelect={null}
            />
          ) : (
            <Alert tone="error">
              This chart cannot be drawn: {parsed.problem}. Fix the region below — nothing already
              recorded on it is lost.
            </Alert>
          )}
        </div>
      </section>

      {map.isOwn ? (
        <form action={chartAction} className="border-rule bg-card space-y-3 rounded-lg border p-4">
          <h2 className="eyebrow text-drape">Chart</h2>
          {chartState.error ? <Alert tone="error">{chartState.error}</Alert> : null}
          {chartState.ok ? <Alert tone="success">Saved.</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Name" required maxLength={160} defaultValue={map.name} />
            <Input
              name="viewBox"
              label="Coordinate space"
              hint="Four numbers: left, top, width, height."
              required
              maxLength={64}
              defaultValue={map.viewBox}
              className="font-mono text-[0.875rem]"
            />
          </div>
          <label className="flex items-center gap-2 text-[0.9375rem]">
            <input type="checkbox" name="isActive" defaultChecked={map.isActive} />
            In use. Turning it off hides it from templates; records that already cite it keep it.
          </label>
          <Button type="submit" disabled={chartPending}>
            {chartPending ? 'Saving…' : 'Save chart'}
          </Button>
        </form>
      ) : null}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="eyebrow text-drape">Regions</h2>
            <p className="text-muted mt-1 text-[0.9375rem]">
              A region with no shape groups the ones under it and is not drawn.
            </p>
          </div>
          {map.isOwn ? (
            <Button type="button" onClick={() => setAddingRegion((v) => !v)}>
              {addingRegion ? 'Cancel' : 'Add region'}
            </Button>
          ) : null}
        </div>

        {removeError === null ? null : (
          <Alert tone="error" className="mt-3">
            {removeError}
          </Alert>
        )}

        {addingRegion ? (
          <form
            action={regionAction}
            className="border-rule bg-card mt-3 space-y-3 rounded-lg border p-4"
          >
            {regionState.error ? <Alert tone="error">{regionState.error}</Alert> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                name="code"
                label="Code"
                hint="What records refer to it by. It cannot be changed later."
                required
                maxLength={64}
                className="font-mono text-[0.875rem]"
              />
              <Input name="label" label="Label" required maxLength={160} />
              <Select
                name="parentId"
                label="Groups under"
                defaultValue=""
                options={[
                  { value: '', label: 'Nothing — it stands on its own' },
                  ...groups.map((region) => ({ value: region.id, label: region.label })),
                ]}
              />
            </div>
            <Textarea
              name="metadata"
              label="Shape"
              hint='Leave empty for a grouping region. Otherwise: {"shape":{"kind":"RECT","x":8,"y":40,"width":34,"height":60,"radius":6}}'
              rows={4}
              className="font-mono text-[0.8125rem]"
            />
            <Button type="submit" disabled={regionPending}>
              {regionPending ? 'Adding…' : 'Add region'}
            </Button>
          </form>
        ) : null}

        {map.regions.length === 0 ? (
          <Alert tone="info" className="mt-3">
            Nothing on this chart yet. A consultation that draws it will say so rather than showing
            a blank picture.
          </Alert>
        ) : (
          <div className="border-rule mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-[0.9375rem]">
              <thead className="bg-card text-muted text-[0.8125rem]">
                <tr>
                  <th className="px-4 py-2 font-medium">Region</th>
                  <th className="px-4 py-2 font-medium">Groups under</th>
                  <th className="px-4 py-2 font-medium">Drawn</th>
                  {map.isOwn ? <th className="px-4 py-2 font-medium">Remove</th> : null}
                </tr>
              </thead>
              <tbody>
                {map.regions.map((region) => (
                  <tr key={region.id} className="border-rule border-t">
                    <td className="px-4 py-2">
                      {region.label}
                      <div className="text-muted font-mono text-[0.75rem]">{region.code}</div>
                    </td>
                    <td className="text-muted px-4 py-2 text-[0.8125rem]">
                      {region.parentId === null
                        ? '—'
                        : (map.regions.find((other) => other.id === region.parentId)?.label ?? '—')}
                    </td>
                    <td className="text-muted px-4 py-2 text-[0.8125rem]">
                      {region.metadata === null ? 'Grouping only' : 'Yes'}
                    </td>
                    {map.isOwn ? (
                      <td className="px-4 py-2">
                        <Button
                          variant="ghost"
                          onClick={() => void remove(region.id)}
                          disabled={removing === region.id}
                        >
                          {removing === region.id ? 'Removing…' : 'Remove'}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
