'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import type {
  BranchSummary,
  InventoryLocationSummary,
  ProductSummary,
  StockReasonCodeSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProductPicker } from '@/components/tenant/product-picker';
import { lotsForProduct, type LotListState } from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';
import {
  IDLE_FORM,
  recordAdjustmentAction,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Correcting a count (PI-3.1).
 *
 * ⚠️ THE DIRECTION IS A CHOICE, NEVER A MINUS SIGN. There is no way to type a
 *   negative quantity on this form and there must not be: the ledger derives
 *   every sign from the movement type, and a form that could post `-5` is one
 *   keystroke from posting it on a receipt — where the resulting row is
 *   indistinguishable from a genuine issue in every report that reads the
 *   ledger.
 *
 * ⚠️ AND THE REASON IS A LIST, NOT A BOX. This is where shrinkage hides, and
 *   free text turns it into `BROKEN`, `BREAKAGE` and `BROKE` — three categories
 *   describing one event, in the report a clinic uses to decide whether it has a
 *   theft problem. The list is filtered by the direction, because "found in the
 *   fridge" cannot explain stock going missing.
 *
 * ⚠️ AN ADJUSTMENT IS NOT THE ONLY THING THIS FORM DOES, AND THE OTHERS ARE HERE
 *   BECAUSE THEY ARE THE SAME ACT. Recording damage, a disposal, a return or a
 *   quarantine is a person standing at a shelf saying what happened to what is
 *   on it. Splitting them into five screens would mean five places to look for
 *   "the box got crushed" and five chances to pick the wrong one.
 */
const MOVEMENT_TYPES = [
  { value: 'ADJUSTMENT', label: 'Correct the count' },
  { value: 'DAMAGE', label: 'Damaged' },
  { value: 'DISPOSAL', label: 'Thrown away' },
  { value: 'RETURN', label: 'Came back to us' },
  { value: 'QUARANTINE', label: 'Put on hold' },
  { value: 'QUARANTINE_RELEASE', label: 'Taken off hold' },
];

/**
 * Which buckets each movement takes from and puts into.
 *
 * ⚠️ MIRRORS `DEFAULT_STATUS` IN `@rcln/inventory`, AND THE SERVER IS THE ONE
 *   THAT DECIDES. This exists so the form can SAY what will happen — "this takes
 *   it out of available and marks it damaged" — before the person presses the
 *   button. If the two ever disagree, the server wins and the form is wrong on
 *   screen only; that is the right way round, and it is why the fields are sent
 *   rather than the sentence.
 *
 * `DISPOSAL` deliberately has no default source: what is being destroyed —
 * expired, damaged, on hold — is the entire content of the record, and
 * defaulting it to available would let a mis-click destroy sellable stock and
 * record it as routine.
 */
const BUCKETS: Record<string, { from?: string; to?: string; explains: string }> = {
  DAMAGE: {
    from: 'AVAILABLE',
    to: 'DAMAGED',
    explains: 'Takes it out of the dispensable count and marks it damaged. It stays countable.',
  },
  DISPOSAL: {
    explains:
      'Removes it permanently. Say which stock is being destroyed — this is the one movement with no default, because what is thrown away is usually not the good stock.',
  },
  RETURN: {
    to: 'AVAILABLE',
    explains: 'Puts it back into the dispensable count.',
  },
  QUARANTINE: {
    from: 'AVAILABLE',
    to: 'QUARANTINED',
    explains: 'Holds it back. It stays on the shelf and stops being dispensable.',
  },
  QUARANTINE_RELEASE: {
    from: 'QUARANTINED',
    to: 'AVAILABLE',
    explains: 'Puts held stock back into the dispensable count.',
  },
};

const STOCK_STATUSES = [
  { value: 'AVAILABLE', label: 'Available' },
  { value: 'QUARANTINED', label: 'On hold' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'RECALLED', label: 'Recalled' },
];

interface Props {
  slug: string;
  branches: BranchSummary[];
  locations: InventoryLocationSummary[];
  reasonCodes: StockReasonCodeSummary[];
}

export function AdjustmentForm({ slug, branches, locations, reasonCodes }: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    recordAdjustmentAction.bind(null, slug),
    IDLE_FORM
  );

  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [movementType, setMovementType] = useState('ADJUSTMENT');
  const [direction, setDirection] = useState<'INCREASE' | 'DECREASE'>('DECREASE');
  const [product, setProduct] = useState<ProductSummary | null>(null);
  const [lots, setLots] = useState<LotListState>({ status: 'idle' });
  const [loadingLots, startLoadingLots] = useTransition();
  const [reasonCode, setReasonCode] = useState('');

  /**
   * This product's open lots at this branch, asked for once both are known
   * (PI-23). Before, the page fetched the first 200 lots across every branch and
   * this filtered them here — so a clinic with more than 200 open lots had lots
   * that could not be adjusted at all, with nothing on screen saying why.
   *
   * ⚠️ CALLED FROM THE TWO HANDLERS, NOT FROM AN EFFECT — see `serial-form.tsx`,
   *   which makes the same call for the same pair of inputs.
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

  useEffect(() => {
    if (state.status === 'saved') router.push('/stock/ledger');
  }, [router, state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const isAdjustment = movementType === 'ADJUSTMENT';
  const bucket = BUCKETS[movementType];

  const branchLocations = useMemo(
    () => locations.filter((l) => l.branchId === branchId && l.isActive),
    [locations, branchId]
  );

  /*
   * ⚠️ THE REASON LIST NARROWS WITH THE DIRECTION, AND `BOTH` ALWAYS SURVIVES.
   *   Filtering on equality alone would drop "stock take correction" and "other"
   *   from every list — the two most likely to be the right answer — and the API
   *   refuses a code whose direction does not match anyway. This is the same
   *   filter the server runs, applied early so the wrong choice is not offered.
   */
  const availableReasons = useMemo(
    () =>
      reasonCodes.filter(
        (r) => !isAdjustment || r.direction === 'BOTH' || r.direction === direction
      ),
    [reasonCodes, isAdjustment, direction]
  );

  const chosenReason = availableReasons.find((r) => r.code === reasonCode);

  const lotChoices = useMemo(
    () =>
      (lots.status === 'done' ? lots.lots : []).map((b) => ({
        value: b.id,
        label: `${b.lotNumber} · ${b.expiresOn ?? 'no expiry'} · ${b.quantityAvailable} ${b.baseUnitSymbol} available`,
      })),
    [lots]
  );

  if (branches.length === 0 || locations.length === 0) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record an adjustment
        </h1>
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">There is nothing to adjust yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            An adjustment corrects the count of a product on a shelf. Add a location first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-2xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Record an adjustment
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Say what happened to stock on a shelf. Every correction leaves a permanent row with your
          name on it — there is no edit and no delete.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What happened
        </h2>

        <Select
          name="movementType"
          label="What kind of change"
          required
          value={movementType}
          options={MOVEMENT_TYPES}
          errors={err('movementType')}
          onChange={(event) => setMovementType(event.target.value)}
        />

        {bucket ? <p className="text-muted text-[0.8125rem]">{bucket.explains}</p> : null}

        {isAdjustment ? (
          <Select
            name="adjustmentDirection"
            label="Which way"
            required
            value={direction}
            options={[
              { value: 'DECREASE', label: 'There is less than the system says' },
              { value: 'INCREASE', label: 'There is more than the system says' },
            ]}
            errors={err('adjustmentDirection')}
            onChange={(event) => setDirection(event.target.value as 'INCREASE' | 'DECREASE')}
            hint="The quantity below is always positive. This is what decides the direction."
          />
        ) : null}

        {/*
          ⚠️ THE STATUS FIELDS ARE ONLY SHOWN WHERE THE SERVER HAS NO DEFAULT.
             Every other movement here derives both buckets from its own name,
             and offering the choice anyway would be offering somebody the chance
             to make "damaged" mean something other than damaged.
        */}
        {movementType === 'DISPOSAL' ? (
          <Select
            name="statusFrom"
            label="Which stock is being destroyed"
            required
            options={STOCK_STATUSES}
            errors={err('statusFrom')}
            hint="Usually expired or damaged stock. There is deliberately no default here."
          />
        ) : null}
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What and where
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="branchId"
            label="Branch"
            required
            value={branchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            errors={err('branchId')}
            onChange={(event) => {
              setBranchId(event.target.value);
              // The lots belonged to the other site, so they are re-asked for.
              loadLots(product, event.target.value);
            }}
          />
          <Select
            name="locationId"
            label="Shelf"
            required
            options={branchLocations.map((l) => ({ value: l.id, label: l.name }))}
            errors={err('locationId')}
          />
        </div>

        <ProductPicker
          slug={slug}
          name="productId"
          label="Product"
          required
          errors={err('productId')}
          filters={{ isStockItem: true, status: 'ACTIVE' }}
          onChoose={(next) => {
            setProduct(next);
            loadLots(next, branchId);
          }}
          hint="Name, code, brand or barcode. Scanning the pack into this box finds it too."
        />

        {/*
          ⚠️ THE LOT PICKER APPEARS ONLY WHEN THE PRODUCT HAS LOTS AT THIS BRANCH.
             A batch-tracked product with none has no lot to adjust, and the API
             refuses the movement by name; offering an empty picker would leave
             the person hunting for a field that has nothing in it.
        */}
        {lotChoices.length > 0 ? (
          <Select
            name="batchId"
            label="Lot"
            required
            options={[{ value: '', label: 'Choose a lot' }, ...lotChoices]}
            errors={err('batchId')}
            {...(lots.status === 'done' && lots.capped
              ? { hint: 'Only the first hundred open lots are listed.' }
              : {})}
          />
        ) : loadingLots ? (
          <p className="text-muted text-[0.8125rem]">Loading this product’s lots…</p>
        ) : null}

        <Input
          name="quantity"
          label="How much"
          required
          inputMode="decimal"
          errors={err('quantity')}
          hint="Always a positive number, in the product’s base unit."
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Why</h2>

        <Select
          name="reasonCode"
          label="Reason"
          required={isAdjustment}
          value={reasonCode}
          options={[
            { value: '', label: isAdjustment ? 'Choose a reason' : 'No reason code' },
            ...availableReasons.map((r) => ({ value: r.code, label: r.label })),
          ]}
          errors={err('reasonCode')}
          onChange={(event) => setReasonCode(event.target.value)}
          hint={
            isAdjustment
              ? 'Required. This is what a shrinkage report groups by, so it has to come from the list.'
              : 'Optional — the movement already says what it is.'
          }
        />

        <Textarea
          name="reasonNote"
          label="Note"
          rows={3}
          required={chosenReason?.requiresNote ?? false}
          errors={err('reasonNote')}
          hint={
            chosenReason?.requiresNote
              ? 'Required for this reason — it explains nothing on its own. Say what actually happened.'
              : 'Optional. Anything somebody reading this next year would want to know.'
          }
        />
      </section>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record it'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push('/stock/ledger')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
