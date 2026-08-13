'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import type {
  BranchSummary,
  InventoryLocationSummary,
  ManufacturerSummary,
  ProductSummary,
  PurchaseOrderDetail,
  SupplierSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createGoodsReceiptAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * Recording a delivery. The most consequential screen in this phase.
 *
 * Everything downstream is downstream of what is typed here: the lot number a recall
 * will search for, the expiry the nightly sweep will act on, the serial a device
 * history hangs off, and the cost every valuation will sum.
 *
 * ⚠️ IT DRAFTS AND MOVES NOTHING. Posting is the next screen, and it is what writes
 *   the ledger, creates the lot rows and rolls the cost — irreversibly, because a
 *   posted receipt is corrected by a return or an adjustment and never by an edit. A
 *   draft can be fixed by whoever is holding the box.
 *
 * ⚠️ THE LOT AND EXPIRY BOXES ARE SHOWN FOR EVERY LINE AND REQUIRED FOR SOME OF THEM,
 *   AND THE FORM CANNOT KNOW WHICH. Whether a product is batch-tracked or
 *   expiry-controlled is a column on the product; the server refuses the post with a
 *   sentence naming the product, which is more useful than this form guessing. What
 *   it does do is say so in the hint, so somebody keying a box of gloves does not
 *   hunt for a lot number that is not printed on it.
 *
 * ⚠️ A SERIAL-TRACKED PRODUCT IS ONE LINE PER DEVICE, QUANTITY ONE. A serial IS one
 *   physical thing, so five implants are five lines — the copy says it, and a CHECK
 *   constraint enforces it.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
  products: ProductSummary[];
  locations: InventoryLocationSummary[];
  manufacturers: ManufacturerSummary[];
  /** Pre-filled when the delivery is being recorded against an order. */
  order: PurchaseOrderDetail | null;
  moreProducts: boolean;
}

interface LineDraft {
  key: number;
  productId: string;
  purchaseOrderLineId: string;
  quantity: string;
  lotNumber: string;
  expiresOn: string;
  serialNumber: string;
  unitCost: string;
}

let nextKey = 1;

export function GoodsReceiptForm({
  slug,
  branches,
  suppliers,
  products,
  locations,
  manufacturers,
  order,
  moreProducts,
}: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<ProcurementFormState, FormData>(
    createGoodsReceiptAction.bind(null, slug),
    IDLE_FORM
  );

  const [branchId, setBranchId] = useState(order?.branchId ?? branches[0]?.id ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    order
      ? /*
         * Only the lines with something still due. A delivery against an order that
         * is already complete for one product would otherwise arrive pre-filled with
         * a quantity the over-receipt tolerance refuses.
         */
        order.lines
          .filter((line) => Number(line.outstandingQuantityBase) > 0)
          .map((line, index) => ({
            key: index,
            productId: line.productId,
            purchaseOrderLineId: line.id,
            quantity: line.outstandingQuantityBase,
            lotNumber: '',
            expiresOn: '',
            serialNumber: '',
            unitCost: '',
          }))
      : [
          {
            key: 0,
            productId: '',
            purchaseOrderLineId: '',
            quantity: '',
            lotNumber: '',
            expiresOn: '',
            serialNumber: '',
            unitCost: '',
          },
        ]
  );

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/procurement/goods-receipts/${state.createdId}`);
    }
  }, [router, state.status, state.createdId]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const branchLocations = useMemo(
    () => locations.filter((l) => l.branchId === branchId && l.isActive),
    [locations, branchId]
  );

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  if (branches.length === 0 || suppliers.length === 0 || locations.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record a delivery
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">A delivery needs a supplier and a shelf.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Add a supplier under Suppliers, and at least one location under Stock, first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-4xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record a delivery
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          This drafts it. Nothing reaches a shelf until you post it — and a posted delivery is
          corrected with a return, not an edit.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      {order ? (
        <>
          <input type="hidden" name="purchaseOrderId" value={order.id} />
          <input type="hidden" name="supplierId" value={order.supplierId} />
          <Alert tone="info">
            Against order {order.orderNumber ?? ''} from {order.supplierName}. Quantities are
            pre-filled with what is still due — change them to what actually arrived.
          </Alert>
        </>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What arrived, from whom
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
          />
          {order ? null : (
            <Select
              label="Supplier"
              name="supplierId"
              required
              options={[
                { value: '', label: 'Choose a supplier' },
                ...suppliers.map((s) => ({ value: s.id, label: s.name })),
              ]}
              errors={err('supplierId')}
            />
          )}
          <Select
            label="Onto which shelf"
            name="locationId"
            required
            options={[
              { value: '', label: 'Choose a shelf' },
              ...branchLocations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            errors={err('locationId')}
            hint="Where it is being put now."
          />
          <Input
            label="Arrived on"
            name="receivedAt"
            type="date"
            errors={err('receivedAt')}
            hint="Leave blank for today. Backdate it if the boxes came in on Friday."
          />
          <Input
            label="Their invoice number"
            name="supplierInvoiceNumber"
            errors={err('supplierInvoiceNumber')}
            hint="What the paperwork in the box says."
          />
          <Input
            label="Their invoice date"
            name="supplierInvoiceDate"
            type="date"
            errors={err('supplierInvoiceDate')}
          />
          <Input
            label="Currency"
            name="currency"
            errors={err('currency')}
            placeholder="INR"
            hint="Leave blank to use the order’s, or the supplier’s."
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="border-rule flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">What is in the boxes</h2>
          <span className="text-muted text-[0.75rem]">
            One line per lot. One line per device for anything serial-numbered.
          </span>
        </div>

        {moreProducts ? (
          <p className="text-muted text-[0.8125rem]">
            Showing the first {products.length} products. Searching the whole catalogue from here
            comes with the barcode scanner.
          </p>
        ) : null}

        <ul className="space-y-4">
          {lines.map((line, index) => (
            <li key={line.key} className="border-rule bg-card space-y-3 rounded-md border p-4">
              {line.purchaseOrderLineId ? (
                <input
                  type="hidden"
                  name={`lines.${index}.purchaseOrderLineId`}
                  value={line.purchaseOrderLineId}
                />
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Select
                  name={`lines.${index}.productId`}
                  label="Product"
                  required
                  value={line.productId}
                  options={[
                    { value: '', label: 'Choose a product' },
                    ...products.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })),
                  ]}
                  onChange={(event) => updateLine(line.key, { productId: event.target.value })}
                />
                <Input
                  name={`lines.${index}.quantity`}
                  label="How much arrived"
                  required
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                  hint="Count it. This is the number that becomes stock."
                />
                <Input
                  name={`lines.${index}.unitCost`}
                  label="Price per unit"
                  inputMode="decimal"
                  value={line.unitCost}
                  onChange={(event) => updateLine(line.key, { unitCost: event.target.value })}
                  hint={
                    line.purchaseOrderLineId
                      ? 'Blank uses what was ordered.'
                      : 'What was invoiced, per base unit.'
                  }
                />
                <Input
                  name={`lines.${index}.lotNumber`}
                  label="Lot number"
                  value={line.lotNumber}
                  onChange={(event) => updateLine(line.key, { lotNumber: event.target.value })}
                  hint="As printed on the pack. Required for anything batch-tracked."
                />
                <Input
                  name={`lines.${index}.expiresOn`}
                  label="Expires"
                  type="date"
                  value={line.expiresOn}
                  onChange={(event) => updateLine(line.key, { expiresOn: event.target.value })}
                  hint="Required where the product is expiry-controlled. Already-expired stock is refused."
                />
                <Input name={`lines.${index}.manufacturedOn`} label="Made on" type="date" />
                <Input
                  name={`lines.${index}.serialNumber`}
                  label="Serial number"
                  value={line.serialNumber}
                  onChange={(event) => updateLine(line.key, { serialNumber: event.target.value })}
                  hint="One device per line, quantity 1."
                />
                <Select
                  name={`lines.${index}.manufacturerId`}
                  label="Made by"
                  options={[
                    { value: '', label: 'As the catalogue says' },
                    ...manufacturers.map((m) => ({ value: m.id, label: m.name })),
                  ]}
                  hint="Only if the pack says somebody else."
                />
                <Input
                  name={`lines.${index}.taxAmount`}
                  label="Tax on this line"
                  inputMode="decimal"
                  hint="As invoiced. Recorded, never calculated."
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
          ))}
        </ul>

        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines((c) => [
              ...c,
              {
                key: nextKey++,
                productId: '',
                purchaseOrderLineId: '',
                quantity: '',
                lotNumber: '',
                expiresOn: '',
                serialNumber: '',
                unitCost: '',
              },
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
        <div className="border-rule flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">Delivery charges</h2>
          <span className="text-muted text-[0.75rem]">
            Shared across the lines by value, and counted in what the stock is worth
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Freight" name="freight" inputMode="decimal" errors={err('freightMinor')} />
          <Input label="Duty" name="duty" inputMode="decimal" errors={err('dutyMinor')} />
          <Input
            label="Handling"
            name="handling"
            inputMode="decimal"
            errors={err('handlingMinor')}
          />
        </div>
      </section>

      <Textarea
        name="notes"
        label="Notes"
        rows={3}
        errors={err('notes')}
        hint="Anything about the state it arrived in."
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/procurement/goods-receipts')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
