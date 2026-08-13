'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import type {
  BranchSummary,
  GoodsReceiptDetail,
  InventoryLocationSummary,
  ProductSummary,
  SupplierSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createPurchaseReturnAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * Sending stock back.
 *
 * ⚠️ EVERY LINE MUST SAY WHICH STOCK IT IS TAKING, AND THERE IS NO PRE-SELECTED
 *   ANSWER. Returning sound stock ordered in error, stock refused at inspection and
 *   stock found damaged in the box are three different records, and defaulting to
 *   "available" would let a mis-click send sellable stock away and file it as
 *   routine. Not choosing fails validation, which is the intended outcome.
 *
 * ⚠️ IT DRAFTS AND MOVES NOTHING. Sending is the next screen and it writes the
 *   movements; stock a supplier posts back afterwards is a new delivery, because that
 *   is what it physically is.
 */
const BUCKETS = [
  { value: '', label: 'Which stock is going back?' },
  { value: 'AVAILABLE', label: 'Sound stock — ordered in error' },
  { value: 'QUARANTINED', label: 'On hold — refused at inspection' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'RECALLED', label: 'Recalled' },
  { value: 'BLOCKED', label: 'Blocked' },
];

interface Props {
  slug: string;
  branches: BranchSummary[];
  suppliers: SupplierSummary[];
  products: ProductSummary[];
  locations: InventoryLocationSummary[];
  /** Pre-filled when the return is being raised from a delivery. */
  receipt: GoodsReceiptDetail | null;
  moreProducts: boolean;
}

interface LineDraft {
  key: number;
  productId: string;
  goodsReceiptLineId: string;
  batchId: string;
  quantity: string;
  statusFrom: string;
}

let nextKey = 1;

export function PurchaseReturnForm({
  slug,
  branches,
  suppliers,
  products,
  locations,
  receipt,
  moreProducts,
}: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<ProcurementFormState, FormData>(
    createPurchaseReturnAction.bind(null, slug),
    IDLE_FORM
  );

  const [branchId, setBranchId] = useState(receipt?.branchId ?? branches[0]?.id ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    receipt
      ? receipt.lines.map((line, index) => ({
          key: index,
          productId: line.productId,
          goodsReceiptLineId: line.id,
          batchId: line.batchId ?? '',
          quantity: '',
          /*
           * A line refused at inspection is already on hold, so that is the honest
           * pre-fill for it — and it is the only case where the answer is knowable
           * from the document rather than from the person holding the box.
           */
          statusFrom: line.qualityStatus === 'REJECTED' ? 'QUARANTINED' : '',
        }))
      : [
          {
            key: 0,
            productId: '',
            goodsReceiptLineId: '',
            batchId: '',
            quantity: '',
            statusFrom: '',
          },
        ]
  );

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/procurement/returns/${state.createdId}`);
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
          Send stock back
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">A return needs a supplier and a shelf.</p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Send stock back
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          This drafts the return. Nothing leaves a shelf until you send it.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      {receipt ? (
        <>
          <input type="hidden" name="goodsReceiptId" value={receipt.id} />
          <input type="hidden" name="supplierId" value={receipt.supplierId} />
          <Alert tone="info">
            Against delivery {receipt.receiptNumber ?? ''} from {receipt.supplierName}. Enter how
            much of each line is going back — blank lines are left out.
          </Alert>
        </>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          Who and why
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
          {receipt ? null : (
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
            label="Leaving from"
            name="locationId"
            required
            options={[
              { value: '', label: 'Choose a shelf' },
              ...branchLocations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            errors={err('locationId')}
          />
          <Input
            label="Currency"
            name="currency"
            errors={err('currency')}
            placeholder="INR"
            hint="Leave blank to use the delivery’s, or the supplier’s."
          />
          <div className="sm:col-span-2">
            <Textarea
              label="Why is it going back?"
              name="reason"
              required
              rows={3}
              errors={err('reason')}
              hint="The supplier is asked for a credit on this. A return with no reason gets refused."
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What is going back
        </h2>

        {moreProducts ? (
          <p className="text-muted text-[0.8125rem]">
            Showing the first {products.length} products.
          </p>
        ) : null}

        <ul className="space-y-4">
          {lines.map((line, index) => (
            <li key={line.key} className="border-rule bg-card space-y-3 rounded-md border p-4">
              {line.goodsReceiptLineId ? (
                <input
                  type="hidden"
                  name={`lines.${index}.goodsReceiptLineId`}
                  value={line.goodsReceiptLineId}
                />
              ) : null}
              {line.batchId ? (
                <input type="hidden" name={`lines.${index}.batchId`} value={line.batchId} />
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
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
                  label="How much"
                  required
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                />
                <Select
                  name={`lines.${index}.statusFrom`}
                  label="Which stock"
                  required
                  value={line.statusFrom}
                  options={BUCKETS}
                  onChange={(event) => updateLine(line.key, { statusFrom: event.target.value })}
                  hint="What is leaving, and in what condition."
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
                goodsReceiptLineId: '',
                batchId: '',
                quantity: '',
                statusFrom: '',
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

      <Textarea name="notes" label="Notes" rows={3} errors={err('notes')} />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/procurement/returns')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
