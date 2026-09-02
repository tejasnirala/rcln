'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { ConsumptionTemplateDetail } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { UsageNav } from '@/components/tenant/usage-nav';
import { ProductPicker } from '@/components/tenant/product-picker';
import {
  updateConsumptionTemplateAction,
  IDLE_USAGE_FORM,
  type UsageFormState,
} from '@/app/(tenant)/t/[slug]/(app)/usage/actions';

/**
 * One version of a template, and what it lists.
 *
 * ⚠️ THE LINES ARE EDITED AS A SET AND SAVED AS A SET. A template is read in one
 *   glance and written in one sitting — "the root canal tray" is a list somebody
 *   thinks about as a whole — and per-row saves would make reordering it three
 *   round trips and leave it half-written if one failed.
 *
 * ⚠️ THE QUANTITY IS IN WHATEVER UNIT THE CLINIC THINKS IN, AND THE UNIT SHOWN
 *   IS THE PRODUCT'S BASE. "2 pairs" and "2 mL" are how a tray is written down;
 *   the conversion to base units happens on the server through the one graph the
 *   ledger uses, so a template written in strips and a consumption recorded in
 *   tablets still compare.
 *
 * ⚠️ AN OPTIONAL LINE PRE-FILLS AT ZERO, WHICH THE HINT SAYS OUT LOUD. Using one
 *   is then a recorded departure — deliberately, because "sometimes we use a
 *   rubber dam" is the thing a clinic wants counted rather than assumed.
 *
 * ⚠️ NOT PHI.
 */
/**
 * ⚠️ THE LINE CARRIES THE PRODUCT'S NAME AND UNIT, NOT JUST ITS ID (PI-23). The
 *   editor used to hold a copy of the first two hundred stocked products to look
 *   an id up in, which is why a template citing anything outside that page had to
 *   be patched into the list by hand or it would be silently dropped on the next
 *   save. Carrying what is needed to DISPLAY the line makes that impossible.
 */
interface EditorLine {
  key: string;
  productId: string;
  productName: string;
  baseUnitSymbol: string;
  quantity: string;
  unitId: string;
  isOptional: boolean;
  note: string;
}

interface Props {
  slug: string;
  template: ConsumptionTemplateDetail;
  canManage: boolean;
}

export function ConsumptionTemplateEditor({ slug, template, canManage }: Props) {
  const [lines, setLines] = useState<EditorLine[]>(() =>
    template.lines.map((line) => ({
      key: line.id,
      productId: line.productId,
      productName: line.productName,
      baseUnitSymbol: line.baseUnitSymbol,
      quantity: line.quantity,
      unitId: line.unitId,
      isOptional: line.isOptional,
      note: line.note ?? '',
    }))
  );

  const [state, save, saving] = useActionState<UsageFormState, FormData>(
    updateConsumptionTemplateAction.bind(null, slug, template.id),
    IDLE_USAGE_FORM
  );

  function update(key: string, patch: Partial<EditorLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  const serialised = JSON.stringify(
    lines
      .filter((line) => line.productId !== '' && line.quantity !== '')
      .map((line, index) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitId: line.unitId,
        isOptional: line.isOptional,
        displayOrder: index,
        note: line.note === '' ? null : line.note,
      }))
  );

  return (
    <div className="space-y-8">
      <Link href={`/usage/templates`} className="text-muted text-[0.8125rem] hover:underline">
        ← Back to the templates
      </Link>

      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {template.name}
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          {template.itemName} · version {template.version} · in force from {template.effectiveFrom}
          {template.effectiveTo === null ? '' : ` to ${template.effectiveTo}`}
        </p>
      </header>

      <UsageNav />

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
      {state.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

      {template.status === 'RETIRED' ? (
        <Alert tone="info">
          This version has been withdrawn. It is kept because procedures recorded against it cite
          it, and it pre-fills nothing.
        </Alert>
      ) : null}

      <form action={save} className="space-y-6">
        <input type="hidden" name="lines" value={serialised} />

        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-ink text-[1rem]">What it uses</h2>
            <p className="text-muted text-[0.8125rem]">
              Quantities are in whatever unit the clinic thinks in.
            </p>
          </div>

          {lines.length === 0 ? (
            <p className="border-rule text-muted rounded-md border border-dashed p-4 text-[0.875rem]">
              Nothing listed yet. Add the first item this procedure uses.
            </p>
          ) : (
            <ul className="space-y-2">
              {lines.map((line) => {
                return (
                  <li
                    key={line.key}
                    className="border-rule bg-card space-y-3 rounded-md border p-4"
                  >
                    <ProductPicker
                      slug={slug}
                      label="Item"
                      disabled={!canManage}
                      filters={{ isStockItem: true, status: 'ACTIVE' }}
                      initial={
                        line.productId === ''
                          ? null
                          : { id: line.productId, name: line.productName }
                      }
                      onChoose={(product) => {
                        update(line.key, {
                          productId: product?.id ?? '',
                          productName: product?.name ?? '',
                          baseUnitSymbol: product?.baseUnitSymbol ?? '',
                          /* The unit follows the product: a strip of one thing
                             is not a unit of another. */
                          unitId: product?.baseUnitId ?? '',
                        });
                      }}
                      hint="Name, code, brand or barcode. Only stocked products can go on a template — a consultation fee is not a material."
                    />

                    <div className="flex flex-wrap items-end gap-3">
                      <label className="w-32 text-[0.8125rem]">
                        <span className="text-muted block pb-1">How much</span>
                        <input
                          disabled={!canManage}
                          inputMode="decimal"
                          className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
                          value={line.quantity}
                          onChange={(event) => {
                            update(line.key, { quantity: event.target.value });
                          }}
                        />
                      </label>

                      <span className="text-muted pb-2 text-[0.8125rem]">
                        {line.baseUnitSymbol}
                      </span>

                      <label className="flex items-center gap-2 pb-2 text-[0.8125rem]">
                        <input
                          type="checkbox"
                          disabled={!canManage}
                          checked={line.isOptional}
                          onChange={(event) => {
                            update(line.key, { isOptional: event.target.checked });
                          }}
                        />
                        <span className="text-ink">Sometimes</span>
                      </label>

                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => {
                            setLines((current) => current.filter((row) => row.key !== line.key));
                          }}
                          className="text-muted hover:text-danger pb-2 text-[0.875rem]"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {canManage ? (
            <button
              type="button"
              onClick={() => {
                setLines((current) => [
                  ...current,
                  {
                    key: `new-${String(current.length)}-${String(Date.now())}`,
                    productId: '',
                    productName: '',
                    baseUnitSymbol: '',
                    quantity: '',
                    unitId: '',
                    isOptional: false,
                    note: '',
                  },
                ]);
              }}
              className="border-rule text-ink hover:bg-card rounded-md border px-4 py-2 text-[0.875rem]"
            >
              Add an item
            </button>
          ) : null}

          <p className="text-muted text-[0.8125rem]">
            &ldquo;Sometimes&rdquo; pre-fills at zero, so using one is recorded as a departure from
            the template. That is the point — it is what tells a clinic how often it happens.
          </p>
        </section>

        {canManage ? (
          <section className="border-rule bg-card space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[0.8125rem]">
                <span className="text-muted block pb-1">This version is</span>
                <select
                  name="status"
                  defaultValue={template.status}
                  className="border-rule bg-card text-ink rounded-md border px-3 py-2 text-[0.875rem]"
                >
                  <option value="DRAFT">Being written</option>
                  <option value="ACTIVE">In force</option>
                  <option value="RETIRED">Withdrawn</option>
                </select>
              </label>

              <label className="text-[0.8125rem]">
                <span className="text-muted block pb-1">In force until</span>
                <input
                  type="date"
                  name="effectiveTo"
                  defaultValue={template.effectiveTo ?? ''}
                  className="border-rule bg-card text-ink rounded-md border px-3 py-2 text-[0.875rem]"
                />
              </label>
            </div>

            <p className="text-muted text-[0.8125rem]">
              Closing a version does not restate what past procedures used — each record keeps the
              figure it was pre-filled with.
            </p>

            <button
              type="submit"
              disabled={saving}
              className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </section>
        ) : null}
      </form>
    </div>
  );
}
