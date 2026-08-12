'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import type {
  BatchListResponse,
  BranchSummary,
  InventoryLocationListResponse,
  ProductSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createSerialAction,
  IDLE_FORM,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Recording one physically identifiable unit.
 *
 * ⚠️ NO PATIENT FIELD, DELIBERATELY. Assigning a device to a named person is a
 *   PHI write with its own endpoint and its own audit path, and the moment it
 *   happens is a clinical one — it belongs beside the procedure that fitted the
 *   device (PI-9), not on the form that records the device arriving.
 *
 * ⚠️ ONLY SERIAL-TRACKED PRODUCTS ARE OFFERED, and the lot list is narrowed to
 *   the chosen product. A serial whose lot belongs to a different product is a
 *   valid-looking row the service refuses; filtering here means the refusal
 *   never has to be explained.
 *
 * A `LOT_AND_SERIAL` product needs both, so the lot field is required for one
 * and optional for a plain `SERIAL` product. The ledger's tracking CHECK is what
 * enforces it at the point it matters — this is the layer that says why.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  products: ProductSummary[];
  batches: BatchListResponse['batches'];
  locations: InventoryLocationListResponse['locations'];
  /** True when the lot list was capped. Drives the honest hint below. */
  moreLots: boolean;
}

export function SerialForm({ slug, branches, products, batches, locations, moreLots }: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    createSerialAction.bind(null, slug),
    IDLE_FORM
  );

  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');

  const product = useMemo(() => products.find((p) => p.id === productId), [productId, products]);
  const needsLot = product?.trackingMode === 'LOT_AND_SERIAL';

  /* Only this product's lots, at this branch. See the header. */
  const lotOptions = useMemo(
    () => [
      { value: '', label: needsLot ? 'Choose a lot' : 'No lot' },
      ...batches
        .filter((b) => b.productId === productId && b.branchId === branchId)
        .map((b) => ({
          value: b.id,
          label: b.expiresOn ? `${b.lotNumber} — expires ${b.expiresOn}` : b.lotNumber,
        })),
    ],
    [batches, branchId, needsLot, productId]
  );

  const locationOptions = useMemo(
    () => [
      { value: '', label: 'Not recorded' },
      ...locations
        .filter((l) => l.branchId === branchId)
        .map((l) => ({ value: l.id, label: l.name })),
    ],
    [branchId, locations]
  );

  useEffect(() => {
    if (state.status === 'saved') router.push('/stock/serials');
  }, [router, state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  if (products.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record a serial
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">No product is tracked by serial number yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Set a product’s tracking mode to “by serial number” in the catalogue first. It decides
            what every future movement of it must name.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-2xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record a serial
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          One device, one implant, one instrument set — identified individually for its whole life.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="branchId"
            label="Branch"
            required
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            errors={err('branchId')}
          />
          <Input
            name="serialNumber"
            label="Serial number"
            required
            maxLength={128}
            className="font-mono"
            errors={err('serialNumber')}
            hint="Exactly as printed. Unique for this product, not globally — makers reuse each other’s."
          />
          <div className="sm:col-span-2">
            <Select
              name="productId"
              label="Product"
              required
              options={products.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              errors={err('productId')}
            />
          </div>
          <Select
            name="batchId"
            label="Lot"
            required={needsLot}
            options={lotOptions}
            errors={err('batchId')}
            /*
             * ⚠️ THE CAP IS STATED WHEN IT BITES. The lot list is fetched whole
             *   for this branch and narrowed here to the chosen product, because
             *   the product is picked after the page loads — so a lot outside
             *   the first page simply is not in this select. Saying so beats an
             *   empty picker the user cannot explain.
             */
            hint={
              needsLot
                ? `Required: this product is tracked by lot AND serial, so every movement must name both.${
                    moreLots ? ' Only the most recent lots are listed.' : ''
                  }`
                : `Only if this device came in an identified lot.${
                    moreLots ? ' Only the most recent lots are listed.' : ''
                  }`
            }
          />
          <Select
            name="currentLocationId"
            label="Where it is"
            options={locationOptions}
            errors={err('currentLocationId')}
          />
          <Input
            name="expiresOn"
            label="Expires"
            type="date"
            errors={err('expiresOn')}
            hint="Only when the device has an expiry of its own, distinct from its lot’s."
          />
          <div className="sm:col-span-2">
            <Textarea name="notes" label="Notes" rows={3} maxLength={2000} errors={err('notes')} />
          </div>
        </div>
      </section>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record serial'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push('/stock/serials')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
