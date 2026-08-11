'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import type {
  ManufacturerSummary,
  ProductCategory,
  StorageProfileSummary,
  UnitSummary,
} from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createProductAction,
  IDLE_FORM,
  type ProductFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/actions';

/**
 * Adding a product.
 *
 * ⚠️ ONE FORM, NOT A MULTI-STEP WIZARD, AND THAT IS A DELIBERATE DOWNGRADE FROM
 *   THE PLAN. A wizard makes sense when later steps depend on earlier answers;
 *   here they do not — a product is a name, a kind, a unit and some optional
 *   references, and a storekeeper adding forty of them wants one screen and a
 *   keyboard, not four screens and a Next button. The genuinely conditional part
 *   (expiry control needing batch tracking) is one field reacting to another,
 *   which is a disclosure, not a step. Grouped into sections so it still reads
 *   as a sequence.
 *
 * ⚠️ THE BASE UNIT IS CHOSEN HERE AND CAN NEVER BE CHANGED. It is the
 *   denomination every future stock quantity for this product is counted in, so
 *   changing it later would silently reinterpret history — 100 would stop
 *   meaning 100 tablets and start meaning 100 millilitres, with no row updated
 *   and nothing to detect it. The API refuses the change; the form says so up
 *   front, because the moment to get it right is now.
 */

const TYPES = [
  { value: 'MEDICINE', label: 'Medicine' },
  { value: 'VACCINE', label: 'Vaccine' },
  { value: 'CONSUMABLE', label: 'Consumable' },
  { value: 'SURGICAL_SUPPLY', label: 'Surgical supply' },
  { value: 'MEDICAL_DEVICE', label: 'Medical device' },
  { value: 'IMPLANT', label: 'Implant' },
  { value: 'DENTAL_MATERIAL', label: 'Dental material' },
  { value: 'LAB_REAGENT', label: 'Lab reagent' },
  { value: 'DIAGNOSTIC_KIT', label: 'Diagnostic kit' },
  { value: 'VETERINARY_MEDICINE', label: 'Veterinary medicine' },
  { value: 'VETERINARY_CONSUMABLE', label: 'Veterinary consumable' },
  { value: 'GENERAL_CLINICAL_SUPPLY', label: 'General clinical supply' },
];

const TRACKING = [
  { value: 'NONE', label: 'Not tracked individually' },
  { value: 'LOT_BATCH', label: 'By lot / batch' },
  { value: 'SERIAL', label: 'By serial number' },
  { value: 'LOT_AND_SERIAL', label: 'By lot and serial number' },
];

interface Props {
  slug: string;
  units: UnitSummary[];
  categories: ProductCategory[];
  manufacturers: ManufacturerSummary[];
  storageProfiles: StorageProfileSummary[];
}

export function ProductCreateForm({
  slug,
  units,
  categories,
  manufacturers,
  storageProfiles,
}: Props) {
  const router = useRouter();

  const [state, action, pending] = useActionState<ProductFormState, FormData>(
    createProductAction.bind(null, slug),
    IDLE_FORM
  );

  /*
   * Tracking mode is mirrored into state for ONE reason: expiry control is only
   * offered when the product is batch-tracked. An expiry date lives on a batch,
   * so a product with no batches has nowhere to record one — the database
   * CHECKs it, the API refuses it, and offering the tick box anyway would let
   * someone tick it and be told no.
   */
  const [trackingMode, setTrackingMode] = useState('NONE');
  const batchTracked = trackingMode === 'LOT_BATCH' || trackingMode === 'LOT_AND_SERIAL';

  useEffect(() => {
    if (state.status === 'saved' && state.productId) {
      router.push(`/products/${state.productId}`);
    }
  }, [router, state.productId, state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const unitOptions = units.map((u) => ({
    value: u.id,
    label: `${u.name} (${u.symbol})`,
  }));

  const categoryOptions = [
    { value: '', label: 'No category' },
    ...categories.map((c) => ({ value: c.id, label: `${' '.repeat(c.depth)}${c.name}` })),
  ];

  const manufacturerOptions = [
    { value: '', label: 'Not recorded' },
    ...manufacturers.map((m) => ({ value: m.id, label: m.name })),
  ];

  const storageOptions = [
    { value: '', label: 'No special requirement' },
    ...storageProfiles.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Add a product
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          It starts as a draft. Add packaging, barcodes and tax details afterwards, then set it
          active.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          What it is
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="name"
            label="Name"
            required
            maxLength={500}
            errors={err('name')}
            hint="What it is called on the shelf and in a picker."
          />
          <Input
            name="code"
            label="Code"
            required
            maxLength={64}
            className="font-mono"
            errors={err('code')}
            hint="Uppercase letters, digits and underscores. Cannot be changed later."
          />
          <Select name="type" label="Kind" required options={TYPES} errors={err('type')} />
          <Select
            name="categoryId"
            label="Category"
            options={categoryOptions}
            errors={err('categoryId')}
          />
          <Input
            name="brandName"
            label="Brand name"
            maxLength={255}
            errors={err('brandName')}
            hint="Leave blank for a generic or a non-medicine."
          />
          <Input
            name="genericName"
            label="Generic name"
            maxLength={255}
            errors={err('genericName')}
          />
          <Select
            name="manufacturerId"
            label="Manufacturer"
            options={manufacturerOptions}
            errors={err('manufacturerId')}
          />
          <Select
            name="storageProfileId"
            label="Storage requirement"
            options={storageOptions}
            errors={err('storageProfileId')}
          />
        </div>

        <Textarea
          name="description"
          label="Description"
          rows={3}
          maxLength={4000}
          errors={err('description')}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          How it is counted
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="baseUnitId"
            label="Base unit"
            required
            options={unitOptions}
            errors={err('baseUnitId')}
            hint="Every stock figure for this product is counted in this unit. It cannot be changed once the product exists."
          />
          <Select
            name="trackingMode"
            label="Tracking"
            options={TRACKING}
            value={trackingMode}
            onChange={(event) => setTrackingMode(event.target.value)}
            errors={err('trackingMode')}
          />
        </div>

        {batchTracked ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-ink flex items-start gap-2 py-2 text-[0.875rem]">
              <input
                type="checkbox"
                name="isExpiryControlled"
                className="mt-0.5 h-4 w-4"
                aria-describedby="expiry-hint"
              />
              <span>
                Track expiry dates
                <span id="expiry-hint" className="text-muted mt-0.5 block text-[0.8125rem]">
                  Each batch will require an expiry date, and near-expiry stock will be flagged.
                </span>
              </span>
            </label>
            <Input
              name="defaultShelfLifeDays"
              label="Default shelf life (days)"
              type="number"
              inputMode="numeric"
              min={1}
              errors={err('defaultShelfLifeDays')}
              hint="Used when a supplier does not print an expiry date."
            />
          </div>
        ) : (
          <p className="text-muted text-[0.8125rem]">
            Expiry dates are recorded against a batch, so tracking by lot or batch is needed before
            this product can have them.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="reorderLevelBase"
            label="Reorder level"
            inputMode="decimal"
            errors={err('reorderLevelBase')}
            hint="In base units. Leave blank if you do not want a low-stock warning."
          />
          <Input
            name="reorderQuantityBase"
            label="Reorder quantity"
            inputMode="decimal"
            errors={err('reorderQuantityBase')}
            hint="In base units."
          />
        </div>

        <label className="text-ink flex items-start gap-2 py-2 text-[0.875rem]">
          <input
            type="checkbox"
            name="isStockItem"
            defaultChecked
            className="mt-0.5 h-4 w-4"
            aria-describedby="stock-hint"
          />
          <span>
            Keep this in stock
            <span id="stock-hint" className="text-muted mt-0.5 block text-[0.8125rem]">
              Clear this for something you bill for but never hold — it stays out of every stock
              screen.
            </span>
          </span>
        </label>
      </section>

      <div className="border-rule flex items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add product'}
        </Button>
        <Link href="/products" className="text-muted hover:text-drape px-2 py-2 text-[0.875rem]">
          Cancel
        </Link>
      </div>
    </form>
  );
}
