'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import type {
  BranchSummary,
  InventoryLocationDetail,
  StorageProfileSummary,
} from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createLocationAction,
  updateLocationAction,
  IDLE_FORM,
  type StockFormState,
} from '@/app/(tenant)/t/[slug]/(app)/stock/actions';

/**
 * Adding or editing a place stock is kept.
 *
 * ⚠️ THE BRANCH AND THE CODE ARE SET ONCE AND NEVER CHANGED. Moving a location
 *   to another branch would move every balance and every historical movement
 *   under it to a site they never happened at, with no row updated and nothing
 *   to detect it. The API refuses both; the form shows them as fixed on edit
 *   rather than offering a control that would be rejected.
 *
 * ⚠️ "Controlled access" RECORDS WHAT THE CLINIC HAS DECIDED. It grants nothing
 *   and bars nobody — a `kind` is metadata, never authorization (PI-ADR-012),
 *   and which products a jurisdiction actually REQUIRES a locked cabinet for is
 *   PI-5's answer. The copy says so, because a tick box called "controlled
 *   access" invites the opposite reading.
 */
const KINDS = [
  { value: 'MAIN_PHARMACY', label: 'Main pharmacy' },
  { value: 'SATELLITE_PHARMACY', label: 'Satellite pharmacy' },
  { value: 'REFRIGERATOR', label: 'Refrigerator' },
  { value: 'FREEZER', label: 'Freezer' },
  { value: 'CONTROLLED_CABINET', label: 'Controlled cabinet' },
  { value: 'DEPARTMENT_STORE', label: 'Department store' },
  { value: 'PROCEDURE_ROOM', label: 'Procedure room' },
  { value: 'LAB_STORE', label: 'Lab store' },
  { value: 'DENTAL_STORE', label: 'Dental store' },
  { value: 'VETERINARY_STORE', label: 'Veterinary store' },
  { value: 'CENTRAL_WAREHOUSE', label: 'Central warehouse' },
  { value: 'CONSIGNMENT', label: 'Consignment' },
  { value: 'DISPOSAL', label: 'Disposal' },
];

interface Props {
  slug: string;
  branches: BranchSummary[];
  storageProfiles: StorageProfileSummary[];
  /** Absent when adding. */
  location?: InventoryLocationDetail;
}

export function LocationForm({ slug, branches, storageProfiles, location }: Props) {
  const router = useRouter();
  const editing = location !== undefined;

  const [state, action, pending] = useActionState<StockFormState, FormData>(
    editing
      ? updateLocationAction.bind(null, slug, location.id)
      : createLocationAction.bind(null, slug),
    IDLE_FORM
  );

  useEffect(() => {
    if (state.status === 'saved') router.push('/stock/locations');
  }, [router, state.status]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));
  const storageOptions = [
    { value: '', label: 'No storage requirement' },
    ...storageProfiles.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <form action={action} className="max-w-2xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {editing ? location.name : 'Add a location'}
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          {editing
            ? 'Stock is counted per location, so this name is what your staff will read on every count.'
            : 'A branch has many: the main pharmacy, the vaccine fridge, the controlled cabinet, a trolley in each procedure room.'}
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {editing ? (
            <>
              {/* Fixed. See the header. */}
              <Input name="branchName" label="Branch" defaultValue={location.branchName} disabled />
              <Input
                name="codeShown"
                label="Code"
                defaultValue={location.code}
                className="font-mono"
                disabled
                hint="Set once. Every movement already recorded cites it."
              />
            </>
          ) : (
            <>
              <Select
                name="branchId"
                label="Branch"
                required
                options={branchOptions}
                errors={err('branchId')}
                hint="Cannot be changed later."
              />
              <Input
                name="code"
                label="Code"
                required
                maxLength={64}
                className="font-mono"
                errors={err('code')}
                hint="Uppercase letters, digits and underscores. Unique within the branch."
              />
            </>
          )}

          <Input
            name="name"
            label="Name"
            required
            maxLength={255}
            defaultValue={location?.name}
            errors={err('name')}
            hint="What your staff call it."
          />
          <Select
            name="kind"
            label="Kind"
            required
            options={KINDS}
            defaultValue={location?.kind}
            errors={err('kind')}
            hint="Groups it on screen and decides what it may hold. Not a permission."
          />
          <div className="sm:col-span-2">
            <Select
              name="storageProfileId"
              label="Storage requirement"
              options={storageOptions}
              defaultValue={location?.storageProfileId ?? ''}
              errors={err('storageProfileId')}
              hint="What this place can physically keep — the fridge's own range."
            />
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-muted text-[0.8125rem]">What it is used for</legend>

          <label className="flex items-start gap-3 text-[0.875rem]">
            <input
              type="checkbox"
              name="isDispensingPoint"
              defaultChecked={location?.isDispensingPoint ?? false}
              className="mt-1"
            />
            <span>
              <span className="text-ink">Stock can be dispensed from here</span>
              <span className="text-muted block text-[0.8125rem]">
                A main pharmacy can; a central warehouse usually cannot.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-[0.875rem]">
            <input
              type="checkbox"
              name="requiresControlledAccess"
              defaultChecked={location?.requiresControlledAccess ?? false}
              className="mt-1"
            />
            <span>
              <span className="text-ink">Kept under controlled access</span>
              <span className="text-muted block text-[0.8125rem]">
                Records what this clinic has decided. It does not restrict who can see or move the
                stock in it.
              </span>
            </span>
          </label>

          {editing ? (
            <label className="flex items-start gap-3 text-[0.875rem]">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={location.isActive}
                className="mt-1"
              />
              <span>
                <span className="text-ink">In use</span>
                <span className="text-muted block text-[0.8125rem]">
                  Clearing this hides it from every stock screen. It is refused while the location
                  still holds stock — move that out first, so the movements record where it went.
                </span>
              </span>
            </label>
          ) : null}
        </fieldset>
      </section>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add location'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push('/stock/locations')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
