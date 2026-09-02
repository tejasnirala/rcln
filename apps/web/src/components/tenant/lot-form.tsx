'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import type { BranchSummary, ManufacturerSummary, ProductSummary } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { ProductPicker } from '@/components/tenant/product-picker';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createLotAction,
  IDLE_FORM,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Recording a lot.
 *
 * ⚠️ THIS CREATES THE LOT AND NOT THE STOCK, AND THE COPY SAYS SO. A batch row
 *   is the identity of a delivery — its number, its expiry, what it cost — and
 *   holds no quantity at all: how much is left is the sum of the balances across
 *   the shelves and conditions it sits in (PI-ADR-004). A "how many" field here
 *   would have to write a ledger row as a side effect of creating a row in
 *   another table, and a receipt that does not appear in the ledger as a receipt
 *   is what PI-4's goods receipt exists to prevent.
 *
 * ⚠️ ONLY BATCH-TRACKED PRODUCTS ARE OFFERED. A lot recorded against a product
 *   tracked NONE or SERIAL is a lot nothing can ever move — the service refuses
 *   it with a sentence, and offering the choice only to explain the refusal
 *   afterwards is a worse screen than not offering it. The filter is on the
 *   SEARCH now (PI-23), not on a pre-loaded list, so it holds for the whole
 *   catalogue rather than for its first hundred rows.
 *
 * ⚠️ THE EXPIRY FIELD BECOMES REQUIRED WHEN THE CHOSEN PRODUCT IS
 *   EXPIRY-CONTROLLED. A lot with no expiry on such a product is invisible to
 *   the expiry sweep FOR EVER — it is never quarantined and never appears in a
 *   near-expiry report. The database refuses it too; this is the layer that
 *   explains why.
 */
/**
 * The two tracking modes a lot may belong to. `LOT_AND_SERIAL` counts: a device
 * with both still arrives in a lot.
 */
const TRACKED_BY_LOT = ['LOT_BATCH', 'LOT_AND_SERIAL'];

interface Props {
  slug: string;
  branches: BranchSummary[];
  manufacturers: ManufacturerSummary[];
}

export function LotForm({ slug, branches, manufacturers }: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    createLotAction.bind(null, slug),
    IDLE_FORM
  );

  /*
   * ⚠️ WHAT IS CHOSEN, NOT WHICH ID IS CHOSEN. Two fields below change shape with
   *   the product — the expiry becomes required for an expiry-controlled one and
   *   the cost label names its base unit — so the form needs the ROW, and the
   *   picker hands it over. Before PI-23 that meant keeping a copy of the whole
   *   catalogue in the component to look the id up in.
   */
  const [product, setProduct] = useState<ProductSummary | null>(null);

  useEffect(() => {
    if (state.status === 'saved') router.push('/stock/lots');
  }, [router, state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));
  const manufacturerOptions = [
    { value: '', label: 'Same as the product’s' },
    ...manufacturers.map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <form action={action} className="max-w-2xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record a lot
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          A lot is the identity of a delivery: its number, its dates and what it cost. Putting stock
          into it is a separate step.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What arrived
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="branchId"
            label="Branch"
            required
            options={branchOptions}
            errors={err('branchId')}
            hint="The site holding it. A lot received at two sites is two lots."
          />
          <Input
            name="lotNumber"
            label="Lot number"
            required
            maxLength={128}
            className="font-mono"
            errors={err('lotNumber')}
            hint="Exactly as printed on the pack. Case is preserved."
          />
          <ProductPicker
            slug={slug}
            name="productId"
            label="Product"
            required
            className="sm:col-span-2"
            errors={err('productId')}
            filters={{ isStockItem: true, status: 'ACTIVE', trackingModes: TRACKED_BY_LOT }}
            onChoose={setProduct}
            hint="Name, code, brand or barcode. Only products tracked by lot can be searched here."
            emptyHint="Nothing matched among the products tracked by lot. A lot belongs to a product whose tracking mode is “by lot / batch” — set that on the product in the catalogue first."
          />
          <div className="sm:col-span-2">
            <Select
              name="manufacturerId"
              label="Manufacturer"
              options={manufacturerOptions}
              errors={err('manufacturerId')}
              hint="Only when this lot was made by someone other than the product’s usual maker — contract manufacture, or a repackager."
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Dates</h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            name="manufacturedOn"
            label="Manufactured"
            type="date"
            errors={err('manufacturedOn')}
          />
          <Input
            name="expiresOn"
            label="Expires"
            type="date"
            required={product?.isExpiryControlled ?? false}
            errors={err('expiresOn')}
            hint={
              product?.isExpiryControlled
                ? 'Required: this product is expiry-controlled, and a lot with no expiry would never be swept.'
                : 'Leave blank if this product does not expire.'
            }
          />
          <Input
            name="retestOn"
            label="Re-test"
            type="date"
            errors={err('retestOn')}
            hint="Reagents and some actives are re-dated rather than expiring."
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Cost</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="unitCost"
            label={`Cost per ${product?.baseUnitSymbol ?? 'base unit'}`}
            type="number"
            step="0.01"
            min="0"
            errors={err('unitCostBase')}
            /*
             * ⚠️ PER BASE UNIT, NOT PER PACK, AND THE LABEL SAYS WHICH. Stored
             *   per base unit so a supplier changing from strips of 10 to strips
             *   of 15 does not silently restate the value of everything already
             *   on the shelf.
             */
            hint="Per single unit, not per pack. Leave blank if you are not recording cost."
          />
          <Input
            name="currency"
            label="Currency"
            maxLength={3}
            className="font-mono uppercase"
            errors={err('currency')}
            hint="Required if you enter a cost. A number with no currency is one that gets added to a different one."
          />
          <div className="sm:col-span-2">
            <Textarea name="notes" label="Notes" rows={3} maxLength={2000} errors={err('notes')} />
          </div>
        </div>
      </section>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record lot'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push('/stock/lots')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
