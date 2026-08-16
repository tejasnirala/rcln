'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ConsultationTemplateDetail } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import {
  discardDraft,
  publishVersion,
  saveDraft,
  setTemplateActive,
  startDraft,
  type TemplateFormState,
} from '@/app/(tenant)/t/[slug]/(app)/consultation-templates/actions';

/**
 * One consultation template, and the document behind it.
 *
 * NO PHI. Every string on this screen is configuration.
 *
 * ── WHY THE DOCUMENT IS EDITED AS TEXT ───────────────────────────────────────
 *
 * ⚠️ A FORM BUILDER IS NOT THE HONEST SHAPE FOR THIS, AND NOT ONLY BECAUSE IT IS
 *   MORE WORK. The definition is a document with a closed grammar, and the
 *   server returns a SENTENCE naming the section and the key that is wrong —
 *   "section 3 does not say \"visible\"…". A builder that hides the document
 *   would have to translate that back into a widget, which means teaching the
 *   browser the grammar a second time; the two drift, and the version the
 *   browser believes is the one that silently switches a mandatory field off.
 *
 *   So: the document is the document, the server is the authority on whether it
 *   means anything, and the sections it produces are shown beside it in plain
 *   language, so nobody has to read JSON to see what a clinician will get.
 *
 * ⚠️ THE VERSION RAIL IS NUMBERED BECAUSE VERSIONS ARE NUMBERED. It is a real
 *   sequence and a real state machine, not decoration — v3 live, v4 in draft,
 *   v1 and v2 retired and still rendering the consultations that cite them.
 */
const STATE_COPY: Record<string, { label: string; note: string }> = {
  PUBLISHED: { label: 'Live', note: 'Every consultation this template applies to uses it.' },
  DRAFT: { label: 'Draft', note: 'Yours to change. Nobody sees it until you publish.' },
  RETIRED: {
    label: 'Retired',
    note: 'Superseded. Consultations recorded under it still render from it.',
  },
};

export function ConsultationTemplateEditor({
  slug,
  template,
  shownVersionId,
}: {
  slug: string;
  template: ConsultationTemplateDetail;
  shownVersionId: string | null;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);

  const shown = template.versions.find((v) => v.id === shownVersionId) ?? null;
  const isDraft = shown?.status === 'DRAFT';

  const [saveState, saveAction, saving] = useActionState<TemplateFormState, FormData>(
    saveDraft.bind(null, slug, template.id, shown?.id ?? ''),
    {}
  );

  const sections = readSections(template.definition);

  const run = async (action: () => Promise<TemplateFormState>): Promise<void> => {
    const result = await action();
    setNotice(result.error ?? null);
    if (result.error === undefined) router.refresh();
  };

  return (
    <div className="space-y-5">
      <nav className="text-muted text-[0.8125rem]">
        <Link href="/consultation-templates" className="hover:text-drape underline">
          Consultations
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-drape text-xl font-semibold">{template.name}</h1>
          <p className="text-muted mt-1 text-[0.9375rem]">
            {template.specialtyName === null
              ? `Applies to every ${template.careContextName} consultation with no more specific template.`
              : `Applies to ${template.specialtyName}, and everything beneath it.`}
          </p>
          <p className="text-muted mt-1 font-mono text-[0.75rem]">{template.code}</p>
        </div>
        {template.isOwn ? (
          <div className="flex gap-2">
            {template.draftVersion === null ? (
              <Button type="button" onClick={() => run(() => startDraft(slug, template.id))}>
                Start a draft
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              onClick={() => run(() => setTemplateActive(slug, template.id, !template.isActive))}
            >
              {template.isActive ? 'Turn off' : 'Turn on'}
            </Button>
          </div>
        ) : (
          /* ⚠️ Shown rather than hidden: a clinic that cannot see why it may not
             edit the general consultation will assume the screen is broken. */
          <p className="text-muted max-w-xs text-[0.8125rem]">
            This template comes with rcln and cannot be changed. Create your own for the same
            specialty — yours will take precedence.
          </p>
        )}
      </header>

      {notice ? <Alert tone="error">{notice}</Alert> : null}
      {!template.isActive ? (
        <Alert tone="warning">
          This template is turned off, so no consultation resolves to it. The next most specific
          template applies instead.
        </Alert>
      ) : null}
      {template.publishedVersion === null ? (
        <Alert tone="warning">
          Nothing is published yet, so this template applies to no consultation. Publish a version
          to put it into use.
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        {/* The version rail. A sequence, numbered because versions are. */}
        <nav aria-label="Versions" className="space-y-1">
          {template.versions.map((version) => {
            const copy = STATE_COPY[version.status] ?? { label: version.status, note: '' };
            const current = version.id === shownVersionId;
            return (
              <Link
                key={version.id}
                href={`/consultation-templates/${template.id}?versionId=${version.id}`}
                aria-current={current ? 'page' : undefined}
                className={
                  current
                    ? 'bg-drape-tint text-drape block rounded-md px-3 py-2'
                    : 'text-muted hover:text-drape block rounded-md px-3 py-2'
                }
              >
                <span className="font-mono text-[0.8125rem]">v{version.version}</span>
                <span className="ml-2 text-[0.8125rem]">{copy.label}</span>
                <span className="text-muted block text-[0.75rem]">
                  {version.visibleSectionCount} of {version.sectionCount} sections shown
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="space-y-4">
          {shown ? (
            <p className="text-muted text-[0.875rem]">{STATE_COPY[shown.status]?.note ?? ''}</p>
          ) : null}

          {/*
           * What a clinician actually gets, in order and in words. This is here
           * so that reading the document is never the only way to answer "what
           * does this consultation look like".
           */}
          {sections.length > 0 ? (
            <ol className="border-rule divide-rule divide-y rounded-lg border">
              {sections.map((section) => (
                <li key={section.key} className="flex flex-wrap gap-2 px-4 py-2 text-[0.9375rem]">
                  <span className="text-drape">{section.label}</span>
                  <span className="text-muted font-mono text-[0.75rem]">{section.type}</span>
                  {section.required ? (
                    <span className="text-muted text-[0.75rem]">must be answered</span>
                  ) : null}
                  {section.fieldCount > 0 ? (
                    <span className="text-muted text-[0.75rem]">
                      {section.fieldCount} field{section.fieldCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}

          {shown === null ? (
            <Alert tone="info">Choose a version to see what it configures.</Alert>
          ) : isDraft && template.isOwn ? (
            <form action={saveAction} className="space-y-3">
              {saveState.error ? <Alert tone="error">{saveState.error}</Alert> : null}
              {saveState.ok ? <Alert tone="success">Draft saved.</Alert> : null}
              <Textarea
                name="definition"
                label="Configuration"
                hint="Sections, their order and their fields. Referred to by code — never by id."
                rows={22}
                spellCheck={false}
                defaultValue={JSON.stringify(template.definition, null, 2)}
                className="font-mono text-[0.8125rem]"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="secondary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save draft'}
                </Button>
                <Button
                  type="button"
                  onClick={() => run(() => publishVersion(slug, template.id, shown.id))}
                >
                  Publish v{shown.version}
                </Button>
                {template.versions.length > 1 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => run(() => discardDraft(slug, template.id, shown.id))}
                  >
                    Discard draft
                  </Button>
                ) : null}
              </div>
              <p className="text-muted text-[0.8125rem]">
                Publishing retires the version it replaces. Consultations already recorded keep
                rendering from the version they were made under.
              </p>
            </form>
          ) : (
            <Textarea
              name="published-definition"
              label="Configuration"
              hint="Published and retired versions cannot be changed. Start a draft to make a new one."
              rows={22}
              readOnly
              spellCheck={false}
              value={JSON.stringify(template.definition, null, 2)}
              className="font-mono text-[0.8125rem]"
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface SectionRow {
  key: string;
  type: string;
  label: string;
  order: number;
  required: boolean;
  fieldCount: number;
}

/**
 * The sections of the shown document, in render order.
 *
 * ⚠️ READS DEFENSIVELY AND SHOWS NOTHING RATHER THAN GUESSING. The server has
 *   already parsed this document — it could not have been stored otherwise — so
 *   this is a display convenience over a value the browser receives as
 *   `unknown`, and it must not become a second grammar. Anything it cannot read
 *   simply does not appear in the summary, and the document below it is the
 *   authority.
 */
function readSections(definition: unknown): SectionRow[] {
  if (definition === null || typeof definition !== 'object') return [];
  const sections = (definition as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];

  return (
    sections
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
      )
      .filter((entry) => entry['visible'] === true)
      .map((entry) => ({
        key: typeof entry['key'] === 'string' ? entry['key'] : '',
        order: typeof entry['order'] === 'number' ? entry['order'] : Number.MAX_SAFE_INTEGER,
        type: typeof entry['type'] === 'string' ? entry['type'] : '',
        label: typeof entry['label'] === 'string' ? entry['label'] : '',
        required: entry['required'] === true,
        fieldCount: Array.isArray(entry['fields']) ? entry['fields'].length : 0,
      }))
      .filter((row) => row.key !== '' && row.label !== '')
      /* Same total order the engine renders in: `order`, then `key`. Two sections
       sharing an order would otherwise list in whatever order the JSON happened
       to be written in, which is stable until somebody edits an unrelated one. */
      .sort((a, b) => (a.order === b.order ? a.key.localeCompare(b.key) : a.order - b.order))
  );
}
