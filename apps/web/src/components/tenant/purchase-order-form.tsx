'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import type {
  BranchSummary,
  InventoryLocationSummary,
  ProductSummary,
  PurchaseRequisitionDetail,
  SupplierProductListResponse,
  SupplierSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createPurchaseOrderAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * Raising an order.
 *
 * ⚠️ IT DRAFTS AND SENDS NOTHING. The order goes to the supplier when it is ISSUED,
 *   on the next screen — and issuing burns an order number the supplier will quote
 *   back, so it is deliberately a second, separate act.
 *
 * ⚠️ PICKING A PRICED ROW FILLS THE PRICE IN AND THE SERVER RESOLVES IT AGAIN. What
 *   the form shows is a preview; the figure stored on the line is computed at
 *   ordering time from the quantity actually ordered, so a rounding here can never
 *   become a cost on a shelf. A buyer who has been quoted something else overrides
 *   it, because a phone negotiation beats a catalogue.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
  products: ProductSummary[];
  locations: InventoryLocationSummary[];
  priceBook: SupplierProductListResponse['supplierProducts'];
  /** Pre-filled when the order is being raised from an approved requisition. */
  requisition: PurchaseRequisitionDetail | null;
  moreProducts: boolean;
}

interface LineDraft {
  key: number;
  productId: string;
  supplierProductId: string;
  quantity: string;
  unitCost: string;
}

let nextKey = 1;

export function PurchaseOrderForm({
  slug,
  branches,
  suppliers,
  products,
  locations,
  priceBook,
  requisition,
  moreProducts,
}: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<ProcurementFormState, FormData>(
    createPurchaseOrderAction.bind(null, slug),
    IDLE_FORM
  );

  const [branchId, setBranchId] = useState(requisition?.branchId ?? branches[0]?.id ?? '');
  const [supplierId, setSupplierId] = useState(
    // The requisition's own suggestion, when every line agrees on one. A buyer
    // still changes it; this only saves the commonest keystroke.
    requisition?.lines[0]?.suggestedSupplierId ?? ''
  );
  const [lines, setLines] = useState<LineDraft[]>(
    requisition
      ? requisition.lines.map((line, index) => ({
          key: index,
          productId: line.productId,
          supplierProductId: '',
          quantity: line.quantityBase,
          unitCost: '',
        }))
      : [{ key: 0, productId: '', supplierProductId: '', quantity: '', unitCost: '' }]
  );

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/procurement/purchase-orders/${state.createdId}`);
    }
  }, [router, state.status, state.createdId]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const branchLocations = useMemo(
    () => locations.filter((l) => l.branchId === branchId && l.isActive),
    [locations, branchId]
  );

  /** This supplier's priced rows for one product. */
  const pricedFor = (productId: string) =>
    priceBook.filter(
      (row) => row.productId === productId && row.supplierId === supplierId && row.isActive
    );

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  if (branches.length === 0 || suppliers.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Raise an order
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">There is nobody to order from yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Add a supplier first. An order names who it goes to.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Raise an order
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          This drafts the order. Nothing goes to the supplier until you issue it.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      {requisition ? (
        <>
          <input type="hidden" name="requisitionId" value={requisition.id} />
          <Alert tone="info">
            Filled in from requisition {requisition.requisitionNumber ?? ''}, approved by{' '}
            {requisition.approvedByName ?? 'an approver'}. Change anything the supplier has quoted
            differently.
          </Alert>
        </>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          Who and where
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Branch"
            name="branchId"
            required
            value={branchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            errors={err('branchId')}
            onChange={(event) => setBranchId(event.target.value)}
            hint="The site the stock is for."
          />
          <Select
            label="Supplier"
            name="supplierId"
            required
            value={supplierId}
            options={[
              { value: '', label: 'Choose a supplier' },
              ...suppliers.map((s) => ({ value: s.id, label: s.name })),
            ]}
            errors={err('supplierId')}
            onChange={(event) => setSupplierId(event.target.value)}
          />
          <Input
            label="Currency"
            name="currency"
            defaultValue=""
            errors={err('currency')}
            placeholder="INR"
            hint="Leave blank to use the supplier’s. Nothing converts between currencies."
          />
          <Input
            label="Expected"
            name="expectedDate"
            type="date"
            errors={err('expectedDate')}
            hint="When they said it would arrive."
          />
          <div className="sm:col-span-2">
            <Select
              label="Deliver to"
              name="deliverToLocationId"
              options={[
                { value: '', label: 'Decided when it arrives' },
                ...branchLocations.map((l) => ({ value: l.id, label: l.name })),
              ]}
              errors={err('deliverToLocationId')}
              hint="Optional. Whoever signs for it picks the shelf."
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="border-rule flex items-baseline justify-between border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">What is being ordered</h2>
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
            const priced = pricedFor(line.productId);

            return (
              <li key={line.key} className="border-rule bg-card space-y-3 rounded-md border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select
                    name={`lines.${index}.productId`}
                    label="Product"
                    required
                    value={line.productId}
                    options={[
                      { value: '', label: 'Choose a product' },
                      ...products.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })),
                    ]}
                    onChange={(event) =>
                      // The priced row belongs to the old product, so it clears
                      // with it — keeping it would draft a line the API refuses.
                      updateLine(line.key, { productId: event.target.value, supplierProductId: '' })
                    }
                  />
                  <Input
                    name={`lines.${index}.quantity`}
                    label="How much"
                    required
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                  />

                  {priced.length > 0 ? (
                    <Select
                      name={`lines.${index}.supplierProductId`}
                      label="Their catalogue entry"
                      value={line.supplierProductId}
                      options={[
                        { value: '', label: 'Not from the price book' },
                        ...priced.map((row) => ({
                          value: row.id,
                          label: `${row.supplierSku} · ${row.currency} ${(row.pricePerPackMinor / 100).toFixed(2)} per ${row.packUnitSymbol} of ${row.quantityPerPack}`,
                        })),
                      ]}
                      onChange={(event) =>
                        updateLine(line.key, { supplierProductId: event.target.value })
                      }
                      hint="Prices the line from what you recorded for them."
                    />
                  ) : null}

                  <Input
                    name={`lines.${index}.unitCost`}
                    label="Price per unit"
                    inputMode="decimal"
                    value={line.unitCost}
                    onChange={(event) => updateLine(line.key, { unitCost: event.target.value })}
                    hint={
                      priced.length > 0
                        ? 'Overrides the price book, if you have been quoted something else.'
                        : 'What you are paying per base unit.'
                    }
                  />
                  <Input
                    name={`lines.${index}.taxAmount`}
                    label="Tax on this line"
                    inputMode="decimal"
                    hint="What the supplier is charging. Recorded, never calculated."
                  />
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
            );
          })}
        </ul>

        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines((c) => [
              ...c,
              { key: nextKey++, productId: '', supplierProductId: '', quantity: '', unitCost: '' },
            ])
          }
        >
          Add another line
        </Button>

        {err('lines') ? (
          <p className="text-danger text-[0.8125rem]">{err('lines')?.join(' ')}</p>
        ) : null}
      </section>

      <section className="space-y-4">
        <Textarea name="terms" label="Terms" rows={2} errors={err('terms')} />
        <Textarea name="notes" label="Notes" rows={3} errors={err('notes')} />
      </section>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/procurement/purchase-orders')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
