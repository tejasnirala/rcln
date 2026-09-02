'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BranchSummary, DispenseLineRequest, InventoryLocationSummary } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';
import { ProductPicker } from '@/components/tenant/product-picker';
import {
  dispenseAction,
  IDLE_FORM,
  type PharmacyFormState,
} from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/**
 * A sale with no prescription behind it.
 *
 * ⚠️ THERE IS NO "OVER THE COUNTER" TICKBOX ANYWHERE ON THIS FORM, AND THAT IS
 *   THE WHOLE CONCEPT. Whether a product may be supplied without a prescription
 *   is a per-jurisdiction question the regulatory engine answers — the same
 *   product is over-the-counter in one country and prescription-only in the next
 *   — so this form records what HAPPENED (somebody bought something at the
 *   counter) and the server asks whether that was allowed.
 *
 * ⚠️ NO PATIENT IS REQUIRED, AND NONE IS INVENTED. A walk-in is frequently
 *   somebody who is not a patient of this clinic and never becomes one; creating
 *   a clinical record because a person bought paracetamol would put a named human
 *   into the patient list for a transaction that is not care.
 *
 * ⚠️ THE LOTS ARE THE SERVER'S CHOICE HERE. A counter sale takes whatever FEFO
 *   picks — there is no prescription to check a lot against, and a screen that
 *   offered lot selection for a box of plasters would be ceremony. Where a
 *   pharmacist needs to choose, the prescription workspace is where that happens.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  locations: InventoryLocationSummary[];
}

interface SaleLine {
  key: string;
  productId: string;
  /**
   * ⚠️ CARRIED ON THE LINE, NOT LOOKED UP (PI-23). The unit posted with a line is
   *   the product's own base unit, and it used to be found by searching a
   *   catalogue this component held — which silently posted an empty unit for any
   *   product outside the fetched page of 100. The picker hands both over.
   */
  baseUnitId: string;
  quantity: string;
}

export function CounterSaleForm({ slug, branches, locations }: Props) {
  const router = useRouter();
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [lines, setLines] = useState<SaleLine[]>([
    { key: crypto.randomUUID(), productId: '', baseUnitId: '', quantity: '' },
  ]);

  const [state, formAction, pending] = useActionState<PharmacyFormState, FormData>(
    async (previous, form) => {
      const result = await dispenseAction(slug, previous, form);
      if (result.status === 'saved' && result.createdId) {
        router.push(`/pharmacy/dispenses/${result.createdId}`);
      }
      return result;
    },
    IDLE_FORM
  );

  const payload: DispenseLineRequest[] = lines
    .filter((line) => line.productId !== '' && Number(line.quantity) > 0)
    .map(
      (line) =>
        ({
          productId: line.productId,
          quantity: line.quantity,
          // The product's own base unit: this form counts in what the shelf counts in.
          unitId: line.baseUnitId,
        }) satisfies DispenseLineRequest
    );

  const locationsHere = locations.filter((location) => location.branchId === branchId);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Counter sale
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Something sold without a prescription. The rules for this place decide whether it may be.
        </p>
      </header>

      <PharmacyNav />

      {state.status === 'error' ? (
        <Alert tone="error">
          <p>{state.message}</p>
          {state.ruleMessages?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {state.ruleMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <form action={formAction} className="space-y-6">
        <input type="hidden" name="kind" value="COUNTER_SALE" />
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="lines" value={JSON.stringify(payload)} />

        <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
          <Select
            label="Branch"
            name="branchPicker"
            value={branchId}
            options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
            onChange={(event) => {
              setBranchId(event.target.value);
              setLocationId('');
            }}
          />
          <Select
            label="Selling from"
            name="locationPicker"
            value={locationId}
            options={locationsHere.map((location) => ({
              value: location.id,
              label: location.name,
            }))}
            onChange={(event) => setLocationId(event.target.value)}
          />
        </div>

        <ul className="space-y-2">
          {lines.map((line, index) => (
            <li
              key={line.key}
              className="border-rule bg-card flex flex-wrap gap-3 rounded-md border p-4"
            >
              <div className="min-w-64 flex-1">
                <ProductPicker
                  slug={slug}
                  label="Product"
                  filters={{ isStockItem: true, status: 'ACTIVE' }}
                  onChoose={(product) =>
                    setLines((current) =>
                      current.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              productId: product?.id ?? '',
                              baseUnitId: product?.baseUnitId ?? '',
                            }
                          : entry
                      )
                    )
                  }
                  hint="Name, code, brand or barcode. Scanning the pack into this box finds it too."
                />
              </div>
              <Input
                label="Quantity"
                name={`quantity-${String(index)}`}
                inputMode="decimal"
                fieldClassName="w-32"
                className="text-right tabular-nums"
                value={line.quantity}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, quantity: event.target.value } : entry
                    )
                  )
                }
              />
              {lines.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    setLines((current) => current.filter((_, position) => position !== index))
                  }
                  className="text-muted hover:text-ink self-end pb-2 text-[0.875rem]"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setLines((current) => [
                ...current,
                { key: crypto.randomUUID(), productId: '', baseUnitId: '', quantity: '' },
              ])
            }
          >
            Add another
          </Button>
          <Button type="submit" disabled={pending || payload.length === 0 || locationId === ''}>
            {pending ? 'Recording…' : 'Record the sale'}
          </Button>
        </div>
      </form>
    </div>
  );
}
