'use client';

import { useActionState } from 'react';
import type { StorageProfileSummary } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import {
  CatalogueMasterEmpty,
  CatalogueMasterRow,
  CatalogueMasterScreen,
} from '@/components/tenant/catalogue-master-screen';
import {
  createStorageProfileAction,
  type MasterFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';
import { IDLE_MASTER_FORM } from '@/app/(tenant)/t/[slug]/(app)/products/form-state';

/**
 * How a thing has to be kept.
 *
 * ⚠️ THIS SCREEN ADDS AND DOES NOT EDIT, AND THE API IS WHY: `/v1/storage-profiles`
 *   serves GET and POST and has no PATCH. So the screen offers no edit control
 *   rather than one that 404s, and the empty-row copy says how to correct a
 *   profile — add the right one and point the products at it. Do not add an Edit
 *   button here without adding the endpoint underneath it.
 *
 * ⚠️ THE TEMPERATURE RANGE IS TWO SIGNED DECIMALS AND THE ORDER IS CHECKED
 *   TWICE — here by the contract, and again by a CHECK constraint. A range the
 *   wrong way round matches no fridge at all, and the database's error names a
 *   constraint rather than the box somebody typed into.
 *
 * ⚠️ "CONTROLLED ACCESS" IS NOT A PERMISSION. It is a property of the shelf — a
 *   cabinet with a lock — and pairs with the `CONTROLLED_CABINET` location kind
 *   that the dispensing allocator checks. Nothing about who may open it is
 *   decided here.
 *
 * NO PHI.
 */
const LIGHT = [
  { value: 'NONE', label: 'No special requirement' },
  { value: 'PROTECT_FROM_LIGHT', label: 'Protect from light' },
  { value: 'PROTECT_FROM_DIRECT_SUNLIGHT', label: 'Protect from direct sunlight' },
];

const LIGHT_LABEL: Record<string, string> = {
  PROTECT_FROM_LIGHT: 'Protect from light',
  PROTECT_FROM_DIRECT_SUNLIGHT: 'Protect from direct sunlight',
};

interface Props {
  slug: string;
  profiles: StorageProfileSummary[];
  canManage: boolean;
}

export function StorageProfileList({ slug, profiles, canManage }: Props) {
  const [addState, add, adding] = useActionState<MasterFormState, FormData>(
    (previous, form) => createStorageProfileAction(slug, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => addState.fieldErrors?.[name];

  return (
    <CatalogueMasterScreen
      title="Storage"
      blurb="The conditions a product has to be kept in. A product names one and so does a location, which is how a cold-chain medicine and a shelf that is not a fridge become a question somebody can answer."
      addLabel="Add a storage requirement"
      addState={addState}
      addAction={add}
      addPending={adding}
      canManage={canManage}
      addFields={<StorageFields errors={err} />}
    >
      {profiles.length === 0 ? (
        <CatalogueMasterEmpty>
          Add the ones your shelves actually have — room temperature, 2–8 °C, and a freezer if you
          run one. A product with no requirement can go anywhere.
        </CatalogueMasterEmpty>
      ) : (
        <ul className="space-y-2">
          {profiles.map((profile) => (
            <CatalogueMasterRow
              key={profile.id}
              name={profile.name}
              code={profile.code}
              detail={describe(profile)}
              isOwn={profile.isOwn}
              isActive={profile.isActive}
              /*
               * Never editable, on a platform row or the clinic's own: there is
               * no PATCH endpoint. `false` here is what withholds the button.
               */
              canManage={false}
            />
          ))}
        </ul>
      )}
    </CatalogueMasterScreen>
  );
}

/** The conditions as one line, in the order somebody standing at a shelf reads them. */
function describe(profile: StorageProfileSummary): string {
  const parts: string[] = [];

  if (profile.minTemperatureC !== null || profile.maxTemperatureC !== null) {
    parts.push(
      profile.minTemperatureC !== null && profile.maxTemperatureC !== null
        ? `${profile.minTemperatureC}–${profile.maxTemperatureC} °C`
        : profile.minTemperatureC !== null
          ? `at least ${profile.minTemperatureC} °C`
          : `up to ${String(profile.maxTemperatureC)} °C`
    );
  }
  if (profile.minHumidityPct !== null || profile.maxHumidityPct !== null) {
    parts.push(
      `${String(profile.minHumidityPct ?? 0)}–${String(profile.maxHumidityPct ?? 100)}% humidity`
    );
  }
  if (profile.lightSensitivity !== 'NONE') {
    parts.push(LIGHT_LABEL[profile.lightSensitivity] ?? profile.lightSensitivity);
  }
  if (profile.requiresControlledAccess) parts.push('Locked cabinet');
  if (profile.hazardClass !== null) parts.push(`Hazard ${profile.hazardClass}`);

  return parts.join(' · ');
}

function StorageFields({ errors }: { errors: (name: string) => string[] | undefined }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="code"
          label="Code"
          required
          maxLength={64}
          className="font-mono"
          errors={errors('code')}
          hint="Uppercase letters, digits and underscores. Cannot be changed later."
        />
        <Input
          name="name"
          label="Name"
          required
          maxLength={255}
          errors={errors('name')}
          hint="What the shelf is called here, e.g. Cold chain 2–8 °C."
        />
        <Input
          name="minTemperatureC"
          label="Coldest allowed (°C)"
          inputMode="decimal"
          errors={errors('minTemperatureC')}
          hint="A freezer is negative, e.g. -20."
        />
        <Input
          name="maxTemperatureC"
          label="Warmest allowed (°C)"
          inputMode="decimal"
          errors={errors('maxTemperatureC')}
        />
        <Input
          name="minHumidityPct"
          label="Lowest humidity (%)"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          errors={errors('minHumidityPct')}
        />
        <Input
          name="maxHumidityPct"
          label="Highest humidity (%)"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          errors={errors('maxHumidityPct')}
        />
        <Select
          name="lightSensitivity"
          label="Light"
          options={LIGHT}
          defaultValue="NONE"
          errors={errors('lightSensitivity')}
        />
        <Input
          name="hazardClass"
          label="Hazard class"
          maxLength={64}
          errors={errors('hazardClass')}
          hint="Only if the transport rules give it one."
        />
      </div>

      <label className="text-ink flex items-start gap-2 py-1 text-[0.875rem]">
        <input type="checkbox" name="requiresControlledAccess" className="mt-0.5 h-4 w-4" />
        <span>
          Needs a locked cabinet
          <span className="text-muted mt-0.5 block text-[0.8125rem]">
            A fact about the shelf, not about who may open it. Permissions are set under Roles.
          </span>
        </span>
      </label>

      <Textarea
        name="handlingNotes"
        label="Handling notes"
        rows={2}
        maxLength={2000}
        errors={errors('handlingNotes')}
      />
    </>
  );
}
