'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ConsultationTemplateListResponse, SpecialtySummary } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { ancestorLabel, buildTree } from '@/lib/taxonomy';
import {
  createTemplate,
  type TemplateFormState,
} from '@/app/(tenant)/t/[slug]/(app)/consultation-templates/actions';

/**
 * What a consultation is made of, here.
 *
 * NO PHI. Every string on this screen is configuration.
 *
 * ⚠️ THE PLATFORM TEMPLATES ARE READ-ONLY AND THE SCREEN SAYS SO RATHER THAN
 *   HIDING THEM. A clinic that cannot see the general consultation does not know
 *   what its doctors are getting, and "why does my dentist see a general form?"
 *   is unanswerable from a list that only shows what the clinic itself wrote.
 *
 * ⚠️ AND THE "APPLIES TO" COLUMN IS THE ONE THAT MATTERS. A template attached to
 *   Dermatology covers every sub-specialty beneath it and is superseded by
 *   anything more specific — which is invisible from a name alone, and is the
 *   thing somebody gets wrong when a template they published does not appear.
 */
export function ConsultationTemplateList({
  slug,
  data,
  specialties,
}: {
  slug: string;
  data: ConsultationTemplateListResponse;
  specialties: SpecialtySummary[];
}) {
  const [adding, setAdding] = useState(false);
  const [careContextId, setCareContextId] = useState('');
  const [state, formAction, pending] = useActionState<TemplateFormState, FormData>(
    createTemplate.bind(null, slug),
    {}
  );

  const tree = useMemo(() => buildTree(specialties), [specialties]);
  const careContexts = useMemo(
    () => specialties.filter((node) => node.type === 'CARE_CONTEXT'),
    [specialties]
  );

  /*
   * ⚠️ THE SPECIALTY PICKER IS FILTERED TO THE CHOSEN CARE CONTEXT, because the
   *   API refuses anything else — a node under Veterinary on a Human template is
   *   a document nobody can ever resolve, since the walk starts at the patient's
   *   care context. Filtering here turns a 400 into a shorter list.
   */
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
          <h1 className="text-drape text-xl font-semibold">Consultations</h1>
          <p className="text-muted mt-1 max-w-2xl text-[0.9375rem]">
            What your clinicians see when they open a visit: which sections appear, in what order,
            and over which clinical terms. The most specific template wins — a dermatology template
            covers hair &amp; scalp until you publish one for hair &amp; scalp itself. Templates
            marked <span className="text-muted font-mono text-[0.75rem]">shared</span> come with
            rcln.
          </p>
        </div>
        <Button type="button" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New template'}
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
              hint="Letters, digits and underscores."
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
            {/*
             * ⚠️ "EVERY OTHER CONSULTATION" IS THE DEFAULT AND THE COPY SAYS
             *   WHAT IT MEANS. Leaving this blank makes the care-context default
             *   — the template a doctor with no recorded specialty gets — which
             *   reads from a bare "Optional" as though it did nothing.
             */}
            <Select
              name="specialtyId"
              label="Applies to"
              hint="A more specific template always wins over this one."
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
          </div>
          <Textarea
            name="description"
            label="Description"
            hint="Optional. What this template is for, in your own words."
            rows={2}
            maxLength={2000}
          />
          <p className="text-muted text-[0.8125rem]">
            The new template starts as a draft of the general consultation. Nothing changes for
            anyone until you publish it.
          </p>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create template'}
          </Button>
        </form>
      ) : null}

      {data.templates.length === 0 ? (
        <Alert tone="info">No consultation templates yet.</Alert>
      ) : (
        <div className="border-rule overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[0.9375rem]">
            <thead className="bg-card text-muted text-[0.8125rem]">
              <tr>
                <th className="px-4 py-2 font-medium">Template</th>
                <th className="px-4 py-2 font-medium">Applies to</th>
                <th className="px-4 py-2 font-medium">Live</th>
                <th className="px-4 py-2 font-medium">Draft</th>
                <th className="px-4 py-2 font-medium">Origin</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((template) => (
                <tr key={template.id} className="border-rule border-t">
                  <td className="px-4 py-2">
                    <Link
                      href={`/consultation-templates/${template.id}`}
                      className="text-drape underline-offset-2 hover:underline"
                    >
                      {template.name}
                    </Link>
                    {!template.isActive ? (
                      <span className="text-muted ml-2 text-[0.75rem]">off</span>
                    ) : null}
                    <div className="text-muted font-mono text-[0.75rem]">{template.code}</div>
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {template.specialtyName ?? `Every ${template.careContextName} consultation`}
                  </td>
                  <td className="px-4 py-2 text-[0.8125rem]">
                    {template.publishedVersion ? (
                      <>
                        <span className="text-drape">v{template.publishedVersion.version}</span>
                        <span className="text-muted ml-2">
                          {template.publishedVersion.visibleSectionCount} sections
                        </span>
                      </>
                    ) : (
                      /* ⚠️ The state worth noticing: a template that exists,
                         appears configured, and resolves to nothing. */
                      <span className="text-muted">Not published</span>
                    )}
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {template.draftVersion ? `v${template.draftVersion.version}` : '—'}
                  </td>
                  <td className="text-muted px-4 py-2 text-[0.8125rem]">
                    {template.isOwn ? 'Yours' : 'shared'}
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
              href={`/consultation-templates?page=${data.page - 1}`}
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
              href={`/consultation-templates?page=${data.page + 1}`}
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
