'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import type {
  BranchSummary,
  InventoryLocationSummary,
  ProductSummary,
  BatchSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createTransferAction,
  IDLE_FORM,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Drafting a transfer.
 *
 * ⚠️ IT CREATES A DRAFT AND MOVES NOTHING, AND THE COPY SAYS SO. Stock leaves
 *   the shelf when the transfer is SENT, on the next screen, by somebody who has
 *   the boxes in front of them. Drafting and sending in one click would put the
 *   irreversible half behind the same button as the reversible one — and a
 *   drafted transfer can be edited or abandoned, while a sent one can only be
 *   cancelled, which writes compensating movements into a permanent ledger.
 *
 * ⚠️ THE DESTINATION SHELF IS OPTIONAL HERE AND REQUIRED AT RECEIPT — EXCEPT
 *   WITHIN ONE BRANCH. The sender proposes and the receiver decides, because the
 *   sender does not know which fridge has room today. When the two branches are
 *   the same there is nothing in transit and no later moment to decide in, so
 *   the field becomes required and the form says why.
 *
 * ⚠️ ONLY THE SENDING BRANCH'S SHELVES ARE OFFERED AS A SOURCE. A location list
 *   for a branch the user cannot see comes back empty under RLS — not an error,
 *   just nothing — so the destination is a BRANCH and not a shelf whenever the
 *   two differ.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  locations: InventoryLocationSummary[];
  products: ProductSummary[];
  batches: BatchSummary[];
  /** True when the product list was capped. Drives the honest hint below. */
  moreProducts: boolean;
}

interface LineDraft {
  key: number;
  productId: string;
  batchId: string;
  quantity: string;
}

let nextKey = 1;

export function TransferForm({
  slug,
  branches,
  locations,
  products,
  batches,
  moreProducts,
}: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    createTransferAction.bind(null, slug),
    IDLE_FORM
  );

  const [fromBranchId, setFromBranchId] = useState(branches[0]?.id ?? '');
  const [toBranchId, setToBranchId] = useState(branches[0]?.id ?? '');
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 0, productId: '', batchId: '', quantity: '' },
  ]);

  const isIntraBranch = fromBranchId === toBranchId;

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/stock/transfers/${state.createdId}`);
    }
  }, [router, state.status, state.createdId]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));

  const fromLocations = useMemo(
    () => locations.filter((l) => l.branchId === fromBranchId && l.isActive),
    [locations, fromBranchId]
  );
  const toLocations = useMemo(
    () => locations.filter((l) => l.branchId === toBranchId && l.isActive),
    [locations, toBranchId]
  );

  /**
   * Lots of the chosen product held at the SENDING branch.
   *
   * ⚠️ FILTERED BY BRANCH AS WELL AS BY PRODUCT. `batches` is branch-scoped, and
   *   a lot at the destination is a different row with the same lot number —
   *   offering it here would draft a line the API refuses with "that lot is held
   *   at a different branch", which is a correct refusal and a bad form.
   */
  const lotsFor = (productId: string) =>
    batches.filter((b) => b.productId === productId && b.branchId === fromBranchId);

  const productOptions = [
    { value: '', label: 'Choose a product' },
    ...products.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })),
  ];

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  if (branches.length === 0 || locations.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Move stock
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">There is nowhere to move stock between yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            A transfer goes from one shelf to another. Add at least one location under Locations
            first — a main pharmacy, a fridge, a store room.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Move stock
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          This drafts the transfer. Nothing leaves a shelf until you send it.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          From and to
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="fromBranchId"
            label="Sending branch"
            required
            value={fromBranchId}
            options={branchOptions}
            errors={err('fromBranchId')}
            onChange={(event) => setFromBranchId(event.target.value)}
            hint="The site the stock leaves. You need access to it."
          />
          <Select
            name="toBranchId"
            label="Receiving branch"
            required
            value={toBranchId}
            options={branchOptions}
            errors={err('toBranchId')}
            onChange={(event) => setToBranchId(event.target.value)}
            hint="Can be a site you do not work at. They sign for it."
          />
          <Select
            name="fromLocationId"
            label="From shelf"
            required
            options={fromLocations.map((l) => ({ value: l.id, label: l.name }))}
            errors={err('fromLocationId')}
          />
          <Select
            name="toLocationId"
            label="To shelf"
            required={isIntraBranch}
            options={[
              ...(isIntraBranch ? [] : [{ value: '', label: 'The receiver decides' }]),
              ...toLocations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            errors={err('toLocationId')}
            hint={
              isIntraBranch
                ? 'Within one branch the stock arrives the moment it leaves, so the shelf has to be chosen now.'
                : 'Leave this to the receiving branch unless you know which shelf has room.'
            }
          />
        </div>

        {isIntraBranch ? (
          <Alert tone="info">
            Both ends are the same branch, so this moves stock between two shelves in one step.
            Sending it records it as arrived.
          </Alert>
        ) : null}
      </section>

      <section className="space-y-4">
        <div className="border-rule flex items-baseline justify-between border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">What is going</h2>
          <span className="text-muted text-[0.75rem]">
            Quantities are in the product’s base unit
          </span>
        </div>

        {moreProducts ? (
          <p className="text-muted text-[0.8125rem]">
            Showing the first {products.length} products. Searching the whole catalogue from here
            comes with the barcode scanner.
          </p>
        ) : null}

        <ul className="space-y-4">
          {lines.map((line, index) => {
            const lots = lotsFor(line.productId);

            return (
              <li key={line.key} className="border-rule bg-card space-y-3 rounded-md border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select
                    name={`lines.${index}.productId`}
                    label="Product"
                    required
                    value={line.productId}
                    options={productOptions}
                    onChange={(event) =>
                      // The lot belongs to the old product, so it is cleared with
                      // it. Leaving it would draft a line the API refuses with
                      // "that lot is not a lot of this product".
                      updateLine(line.key, { productId: event.target.value, batchId: '' })
                    }
                  />

                  {lots.length > 0 ? (
                    <Select
                      name={`lines.${index}.batchId`}
                      label="Lot"
                      required
                      value={line.batchId}
                      options={[
                        { value: '', label: 'Choose a lot' },
                        ...lots.map((b) => ({
                          value: b.id,
                          label: `${b.lotNumber} · ${b.expiresOn ?? 'no expiry'} · ${b.quantityAvailable} ${b.baseUnitSymbol} available`,
                        })),
                      ]}
                      onChange={(event) => updateLine(line.key, { batchId: event.target.value })}
                      hint="Lots held at the sending branch, soonest to expire first."
                    />
                  ) : (
                    <Input
                      name={`lines.${index}.quantity`}
                      label="Quantity"
                      required
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                    />
                  )}
                </div>

                {lots.length > 0 ? (
                  <Input
                    name={`lines.${index}.quantity`}
                    label="Quantity"
                    required
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                    hint="How much of this lot is going, in the product’s base unit."
                  />
                ) : null}

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
            );
          })}
        </ul>

        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines((c) => [...c, { key: nextKey++, productId: '', batchId: '', quantity: '' }])
          }
        >
          Add another line
        </Button>

        {err('lines') ? (
          <p className="text-danger text-[0.8125rem]">{err('lines')?.join(' ')}</p>
        ) : null}
      </section>

      <section className="space-y-4">
        <Textarea
          name="notes"
          label="Notes"
          rows={3}
          errors={err('notes')}
          hint="Optional. Anything the receiving branch should know when they unpack it."
        />
      </section>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push('/stock/transfers')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
