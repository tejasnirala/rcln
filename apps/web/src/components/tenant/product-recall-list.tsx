'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { ProductSummary, RecallSummary } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ProductRecallNav } from '@/components/tenant/product-recall-nav';
import { formatClinicDate } from '@/lib/format';
import {
  createRecallAction,
  IDLE_RECALL_FORM,
  type RecallFormState,
} from '@/app/(tenant)/t/[slug]/(app)/product-recalls/actions';

/**
 * Every product recall this clinic has raised, newest first.
 *
 * ⚠️ "PRODUCT RECALL", NOT "RECALL", AND THE DISAMBIGUATION IS NOT PEDANTRY. This
 *   workspace already has a `/recall` — the front desk's list of patients who
 *   were told to come back and have not (CE-5). Two tabs called Recall would
 *   send the person chasing a contaminated implant to a list of missed
 *   follow-ups. The API keeps the shorter word because `recall.notice.*` has no
 *   such neighbour; the SCREEN takes the longer one, because a screen is read by
 *   somebody in a hurry.
 *
 * ⚠️ THE COUNT IS "HELD OF TOTAL", NOT A PERCENTAGE OR A TICK. A recall is
 *   finished when every lot it names has been looked at, and a branch-scoped
 *   storekeeper can only pull the lots at their own site — so "4 of 7 pulled" is
 *   the honest state of the work and "executed" on its own is not.
 *
 * ⚠️ CLASS IS SHOWN AND NEVER USED TO SORT OR TO HIDE. A Class III recall of a
 *   mislabelled carton pulls stock exactly as hard as a Class I recall of a
 *   contaminated implant; the class changes how urgently the clinic works
 *   through the people who already received it, which is a human decision.
 *
 * ⚠️ NOT PHI. Every column here is a product, a lot count and a date.
 */
const STATUS_LABEL: Record<RecallSummary['status'], string> = {
  DRAFT: 'Being assembled',
  EXECUTED: 'Stock pulled',
  CLOSED: 'Finished',
  CANCELLED: 'Withdrawn',
};

const CLASS_LABEL: Record<RecallSummary['classification'], string> = {
  CLASS_I: 'Class I — serious harm',
  CLASS_II: 'Class II — reversible harm',
  CLASS_III: 'Class III — labelling',
  UNCLASSIFIED: 'Not classified',
};

const SOURCE_OPTIONS = [
  { value: 'MANUFACTURER', label: 'The manufacturer' },
  { value: 'REGULATOR', label: 'A regulator' },
  { value: 'SUPPLIER', label: 'The supplier' },
  { value: 'INTERNAL', label: 'Our own decision' },
];

interface Props {
  slug: string;
  recalls: RecallSummary[];
  meta: { total: number; page: number; limit: number };
  products: ProductSummary[];
  timeZone: string;
  canCreate: boolean;
}

export function ProductRecallList({ slug, recalls, meta, products, timeZone, canCreate }: Props) {
  const [adding, setAdding] = useState(false);
  const [state, create, creating] = useActionState<RecallFormState, FormData>(
    createRecallAction.bind(null, slug),
    IDLE_RECALL_FORM
  );

  /*
   * Close the form once the notice lands. Adjusted during render rather than in
   * an effect — the same note `charge-policy-list.tsx` carries.
   */
  const [lastStatus, setLastStatus] = useState(state.status);
  if (state.status !== lastStatus) {
    setLastStatus(state.status);
    if (state.status === 'saved') setAdding(false);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Product recalls
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          A notice records what was withdrawn and why. Recording one holds nothing — the lots are
          identified first, and pulling them is a separate, deliberate act.
        </p>
      </header>

      <ProductRecallNav />

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {canCreate ? (
        adding ? (
          <form action={create} className="border-rule bg-card space-y-4 rounded-md border p-4">
            <Select
              label="Which product"
              name="productId"
              hint="One product per notice. A notice covering three products is three pieces of work."
              options={[
                { value: '', label: 'Choose a product' },
                ...products.map((product) => ({
                  value: product.id,
                  label: `${product.name} (${product.code})`,
                })),
              ]}
              errors={state.fieldErrors?.productId}
            />
            <Input
              label="What to call this notice"
              name="title"
              hint="Something a colleague will recognise in a year."
              errors={state.fieldErrors?.title}
            />
            <Select label="Who says so" name="source" options={SOURCE_OPTIONS} />
            <Select
              label="How serious"
              name="classification"
              hint="Leave unclassified if the notice does not say. It changes how urgently people are contacted, never whether stock is pulled."
              options={[
                { value: 'UNCLASSIFIED', label: CLASS_LABEL.UNCLASSIFIED },
                { value: 'CLASS_I', label: CLASS_LABEL.CLASS_I },
                { value: 'CLASS_II', label: CLASS_LABEL.CLASS_II },
                { value: 'CLASS_III', label: CLASS_LABEL.CLASS_III },
              ]}
            />
            <Input
              label="Their notice number"
              name="noticeReference"
              hint="The regulator's or manufacturer's own reference, so this can be tied back to the announcement."
            />
            <Input label="Dated" name="noticeOn" type="date" />
            <Textarea
              label="Why"
              name="reason"
              hint="This sentence is written onto every stock movement the notice makes."
              errors={state.fieldErrors?.reason}
            />
            <Textarea label="Anything else worth recording" name="notes" />

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={creating}
                className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
              >
                {creating ? 'Recording…' : 'Record the notice'}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="text-muted hover:text-ink px-4 py-2 text-[0.875rem]"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="border-rule text-ink hover:bg-card rounded-md border px-4 py-2 text-[0.875rem] font-medium"
          >
            Record a notice
          </button>
        )
      ) : null}

      {recalls.length === 0 ? (
        <p className="text-muted text-[0.875rem]">
          No notices yet. That is the ordinary state of this screen.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[0.875rem]">
            <thead className="text-muted border-rule border-b">
              <tr>
                <th className="py-2 pr-4 font-medium">Reference</th>
                <th className="py-2 pr-4 font-medium">Product</th>
                <th className="py-2 pr-4 font-medium">Class</th>
                <th className="py-2 pr-4 font-medium">State</th>
                <th className="py-2 pr-4 font-medium">Lots pulled</th>
                <th className="py-2 pr-4 font-medium">Raised</th>
              </tr>
            </thead>
            <tbody>
              {recalls.map((recall) => (
                <tr key={recall.id} className="border-rule border-b last:border-0">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/product-recalls/${recall.id}`}
                      className="text-drape hover:underline"
                    >
                      {recall.reference}
                    </Link>
                    {recall.noticeReference ? (
                      <span className="text-muted block text-[0.75rem]">
                        {recall.noticeReference}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    {recall.productName}
                    <span className="text-muted block text-[0.75rem]">{recall.title}</span>
                  </td>
                  <td className="py-2 pr-4">{CLASS_LABEL[recall.classification]}</td>
                  <td className="py-2 pr-4">{STATUS_LABEL[recall.status]}</td>
                  <td className="py-2 pr-4">
                    {recall.heldCount} of {recall.batchCount}
                  </td>
                  <td className="py-2 pr-4">{formatClinicDate(recall.createdAt, timeZone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted text-[0.75rem]">
        {meta.total} notice{meta.total === 1 ? '' : 's'}.
      </p>
    </div>
  );
}
