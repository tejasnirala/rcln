'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import type { BranchSummary, SupplierSummary } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { ProductPicker } from '@/components/tenant/product-picker';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createRequisitionAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * Asking for stock.
 *
 * ⚠️ IT DRAFTS AND COMMITS NOTHING, AND THE COPY SAYS SO TWICE. Submitting sends it
 *   for approval; approving does not order it either. Three steps because three
 *   different people are involved, and collapsing any two of them would put an
 *   irreversible act behind the same button as a reversible one.
 *
 * ⚠️ THE SUPPLIER IS A SUGGESTION AND THE FORM SAYS SO. The buyer decides who to
 *   actually order from, and the order records what happened.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
}

interface LineDraft {
  key: number;
  productId: string;
  quantity: string;
  suggestedSupplierId: string;
}

let nextKey = 1;

export function RequisitionForm({ slug, branches, suppliers }: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<ProcurementFormState, FormData>(
    createRequisitionAction.bind(null, slug),
    IDLE_FORM
  );

  const [lines, setLines] = useState<LineDraft[]>([
    { key: 0, productId: '', quantity: '', suggestedSupplierId: '' },
  ]);

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/procurement/requisitions/${state.createdId}`);
    }
  }, [router, state.status, state.createdId]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  if (branches.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Ask for stock
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">There is no branch to ask for.</p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Ask for stock
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          This drafts the request. Nothing is ordered until somebody approves it and a buyer raises
          the order.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          Who is asking
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Branch"
            name="branchId"
            required
            defaultValue={branches[0]?.id ?? ''}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            errors={err('branchId')}
            hint="Where the stock is needed."
          />
          <Input
            label="Needed by"
            name="requiredBy"
            type="date"
            errors={err('requiredBy')}
            hint="Optional. Helps the buyer prioritise."
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="border-rule flex items-baseline justify-between border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">What is needed</h2>
          <span className="text-muted text-[0.75rem]">
            Quantities are in the product’s base unit
          </span>
        </div>

        <ul className="space-y-4">
          {lines.map((line, index) => (
            <li key={line.key} className="border-rule bg-card space-y-3 rounded-md border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ProductPicker
                  slug={slug}
                  name={`lines.${index}.productId`}
                  label="Product"
                  required
                  filters={{ isStockItem: true, status: 'ACTIVE' }}
                  onChoose={(product) => updateLine(line.key, { productId: product?.id ?? '' })}
                  hint="Name, code, brand or barcode."
                />
                <Input
                  name={`lines.${index}.quantity`}
                  label="How much"
                  required
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                />
                <div className="sm:col-span-2">
                  <Select
                    name={`lines.${index}.suggestedSupplierId`}
                    label="Usually from"
                    value={line.suggestedSupplierId}
                    options={[
                      { value: '', label: 'The buyer decides' },
                      ...suppliers.map((s) => ({ value: s.id, label: s.name })),
                    ]}
                    onChange={(event) =>
                      updateLine(line.key, { suggestedSupplierId: event.target.value })
                    }
                    hint="A suggestion. The buyer chooses who to order from."
                  />
                </div>
              </div>

              {lines.length > 1 ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                >
                  Remove this line
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines((c) => [
              ...c,
              { key: nextKey++, productId: '', quantity: '', suggestedSupplierId: '' },
            ])
          }
        >
          Add another line
        </Button>

        {err('lines') ? (
          <p className="text-danger text-[0.8125rem]">{err('lines')?.join(' ')}</p>
        ) : null}
      </section>

      <Textarea
        name="notes"
        label="Notes"
        rows={3}
        errors={err('notes')}
        hint="Optional. Anything the approver or the buyer should know."
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/procurement/requisitions')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
