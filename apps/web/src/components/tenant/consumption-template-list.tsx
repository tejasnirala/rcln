'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { ClinicalMasterItem, ConsumptionTemplateSummary } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { UsageNav } from '@/components/tenant/usage-nav';
import {
  createConsumptionTemplateAction,
  IDLE_USAGE_FORM,
  type UsageFormState,
} from '@/app/(tenant)/t/[slug]/(app)/usage/actions';

/**
 * What each procedure normally uses.
 *
 * ⚠️ GROUPED BY PROCEDURE AND ORDERED BY VERSION WITHIN IT, BECAUSE THAT ORDER
 *   IS THE ANSWER. A flat list sorted by date would show three versions of one
 *   template with nothing saying which is in force — and "which one is in force"
 *   is the only question anybody opens this screen with. The live version is
 *   labelled; the rest are history and are shown as such.
 *
 * ⚠️ A TEMPLATE IS CREATED EMPTY AND FILLED ON ITS OWN PAGE. The line editor
 *   needs a product picker per row and a unit that depends on the product, which
 *   is a screen rather than a field — and a create form that tried to hold both
 *   would be the longest form in the product for the least frequent act.
 *
 * ⚠️ NOT PHI.
 */
const STATUS_LABEL: Record<ConsumptionTemplateSummary['status'], string> = {
  DRAFT: 'Being written',
  ACTIVE: 'In force',
  RETIRED: 'Withdrawn',
};

interface Props {
  slug: string;
  templates: ConsumptionTemplateSummary[];
  meta: { total: number; page: number; limit: number };
  procedures: ClinicalMasterItem[];
  canManage: boolean;
}

export function ConsumptionTemplateList({ slug, templates, procedures, canManage }: Props) {
  const [adding, setAdding] = useState(false);
  const [state, create, creating] = useActionState<UsageFormState, FormData>(
    createConsumptionTemplateAction.bind(null, slug),
    IDLE_USAGE_FORM
  );

  /*
   * Close the form once the template lands. Adjusted during render rather than
   * in an effect — the same note `charge-policy-list.tsx` carries.
   */
  const [lastStatus, setLastStatus] = useState(state.status);
  if (state.status !== lastStatus) {
    setLastStatus(state.status);
    if (state.status === 'saved') setAdding(false);
  }

  const byProcedure = new Map<string, ConsumptionTemplateSummary[]>();
  for (const template of templates) {
    const existing = byProcedure.get(template.itemId);
    if (existing) existing.push(template);
    else byProcedure.set(template.itemId, [template]);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Consumption templates
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          What a procedure normally uses. A template pre-fills the panel and deducts nothing — only
          what a clinician confirms moves stock.
        </p>
      </header>

      <UsageNav />

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {canManage ? (
        adding ? (
          <form action={create} className="border-rule bg-card space-y-4 rounded-md border p-4">
            <Select
              label="Procedure"
              name="itemId"
              hint="A template belongs to one procedure."
              options={[
                { value: '', label: 'Choose a procedure' },
                ...procedures.map((item) => ({ value: item.id, label: item.name })),
              ]}
              errors={state.fieldErrors?.itemId}
            />
            <Input
              label="What to call this version"
              name="name"
              hint="Something a colleague will recognise in a year."
              errors={state.fieldErrors?.name}
            />
            <Input
              label="In force from"
              name="effectiveFrom"
              type="date"
              hint="Leave blank to start today."
              errors={state.fieldErrors?.effectiveFrom}
            />
            <Input label="Why this version exists" name="notes" />

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={creating}
                className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create template'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                }}
                className="text-muted hover:text-ink text-[0.875rem]"
              >
                Cancel
              </button>
            </div>
            <p className="text-muted text-[0.8125rem]">
              It starts empty and being written. Add what it uses on the next screen, then put it in
              force.
            </p>
          </form>
        ) : procedures.length === 0 ? (
          <p className="border-rule text-muted rounded-md border border-dashed p-4 text-[0.875rem]">
            There are no procedures to write a template against yet. Add them to the clinical
            dictionary first.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium"
          >
            New template
          </button>
        )
      ) : null}

      {templates.length === 0 ? (
        <p className="border-rule text-muted rounded-md border border-dashed p-6 text-[0.875rem]">
          No templates yet. A procedure with no template records perfectly well — the panel just
          starts empty and the clinician adds what they used.
        </p>
      ) : (
        [...byProcedure.entries()].map(([itemId, versions]) => (
          <section key={itemId} className="space-y-2">
            <h2 className="text-ink text-[1rem]">{versions[0]?.itemName ?? 'Procedure'}</h2>
            <ul className="space-y-2">
              {versions.map((template) => (
                <li
                  key={template.id}
                  className="border-rule bg-card flex flex-wrap items-center gap-4 rounded-md border p-4"
                >
                  <span className="min-w-48 flex-1">
                    <Link
                      href={`/usage/templates/${template.id}`}
                      className="text-ink block text-[0.9375rem] underline-offset-2 hover:underline"
                    >
                      {template.name}
                    </Link>
                    <span className="text-muted block text-[0.8125rem]">
                      Version {template.version} · from {template.effectiveFrom}
                      {template.effectiveTo === null ? '' : ` to ${template.effectiveTo}`}
                    </span>
                  </span>
                  <span className="text-muted text-[0.8125rem]">
                    {template.lineCount === 1 ? '1 item' : `${String(template.lineCount)} items`}
                  </span>
                  <span
                    className={
                      template.status === 'ACTIVE'
                        ? 'border-drape text-drape rounded-full border px-3 py-1 text-[0.8125rem]'
                        : 'border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]'
                    }
                  >
                    {STATUS_LABEL[template.status]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
