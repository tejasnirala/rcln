'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import type { BranchSummary, InventoryLocationListResponse, ProductSummary } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProductPicker } from '@/components/tenant/product-picker';
import { lotsForProduct, type LotListState } from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';
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
 * ⚠️ BOTH PICKERS ASK THE SERVER NOW (PI-23), AND THE LOT ONE IS THE IMPORTANT
 *   HALF. This form used to receive the first hundred lots at ANY branch for ANY
 *   product and filter them in the browser, so the lot somebody was holding was
 *   simply absent whenever the clinic had more than a hundred open lots. Asking
 *   once the product AND the branch are known makes the list short enough to be
 *   complete — and it is the index `batches` already carries.
 *
 * A `LOT_AND_SERIAL` product needs both, so the lot field is required for one
 * and optional for a plain `SERIAL` product. The ledger's tracking CHECK is what
 * enforces it at the point it matters — this is the layer that says why.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  locations: InventoryLocationListResponse['locations'];
}

/** A serial belongs to a product tracked one of these two ways. */
const TRACKED_BY_SERIAL = ['SERIAL', 'LOT_AND_SERIAL'];

/**
 * What the lot field says about itself, in one place.
 *
 * ⚠️ IT SAYS "CHOOSE A PRODUCT FIRST" RATHER THAN SHOWING AN EMPTY LIST. An empty
 *   picker with no explanation is the state this form used to arrive in whenever
 *   the lot was outside the fetched page, and nobody could tell the two apart.
 */
function lotHint(
  product: ProductSummary | null,
  needsLot: boolean,
  lots: LotListState,
  loading: boolean
): string {
  if (product === null) return 'Choose a product first.';
  if (loading) return 'Loading this product’s lots…';
  if (lots.status === 'error') return lots.message;
  if (lots.status === 'done' && lots.lots.length === 0) {
    return needsLot
      ? 'This product is tracked by lot AND serial, and it has no open lot at this branch. Record the lot first.'
      : 'No open lot for this product at this branch.';
  }
  const capped = lots.status === 'done' && lots.capped ? ' Only the first hundred are listed.' : '';
  return needsLot
    ? `Required: this product is tracked by lot AND serial, so every movement must name both.${capped}`
    : `Only if this device came in an identified lot.${capped}`;
}

export function SerialForm({ slug, branches, locations }: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    createSerialAction.bind(null, slug),
    IDLE_FORM
  );

  const [product, setProduct] = useState<ProductSummary | null>(null);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [lots, setLots] = useState<LotListState>({ status: 'idle' });
  const [loadingLots, startLoadingLots] = useTransition();

  const needsLot = product?.trackingMode === 'LOT_AND_SERIAL';

  /**
   * The lots of one product at one branch.
   *
   * ⚠️ CALLED FROM THE TWO HANDLERS, NOT FROM AN EFFECT. It depends on both the
   *   product and the branch, and either can move last — so BOTH handlers pass
   *   the new value and the old one explicitly. An effect over `[product,
   *   branchId]` would read more naturally and is what `react-hooks` refuses:
   *   fetching in response to a render rather than to the act that caused it
   *   cascades a render, and both handlers already know exactly what changed.
   */
  const loadLots = (next: ProductSummary | null, forBranch: string): void => {
    if (next === null || forBranch === '') {
      setLots({ status: 'idle' });
      return;
    }
    startLoadingLots(async () => {
      setLots(await lotsForProduct(slug, next.id, forBranch));
    });
  };

  const lotOptions = useMemo(
    () => [
      { value: '', label: needsLot ? 'Choose a lot' : 'No lot' },
      ...(lots.status === 'done' ? lots.lots : []).map((b) => ({
        value: b.id,
        label: b.expiresOn ? `${b.lotNumber} — expires ${b.expiresOn}` : b.lotNumber,
      })),
    ],
    [lots, needsLot]
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
            onChange={(event) => {
              setBranchId(event.target.value);
              // The lots belonged to the other site, so they are re-asked for.
              loadLots(product, event.target.value);
            }}
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
          <ProductPicker
            slug={slug}
            name="productId"
            label="Product"
            required
            className="sm:col-span-2"
            errors={err('productId')}
            filters={{ isStockItem: true, status: 'ACTIVE', trackingModes: TRACKED_BY_SERIAL }}
            onChoose={(next) => {
              setProduct(next);
              loadLots(next, branchId);
            }}
            hint="Name, code, brand or barcode. Only products tracked by serial number can be searched here."
            emptyHint="Nothing matched among the products tracked by serial number. Set a product’s tracking mode to “by serial number” in the catalogue first — it decides what every future movement of it must name."
          />
          <Select
            name="batchId"
            label="Lot"
            required={needsLot}
            options={lotOptions}
            disabled={product === null || loadingLots}
            errors={err('batchId')}
            hint={lotHint(product, needsLot, lots, loadingLots)}
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
