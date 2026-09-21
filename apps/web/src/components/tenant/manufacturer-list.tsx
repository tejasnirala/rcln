'use client';

import { useActionState } from 'react';
import type { ManufacturerSummary } from '@rcln/contracts';
import { Input } from '@/components/ui/field';
import {
  ActiveCheckbox,
  CatalogueMasterEmpty,
  CatalogueMasterRow,
  CatalogueMasterScreen,
} from '@/components/tenant/catalogue-master-screen';
import {
  createManufacturerAction,
  updateManufacturerAction,
  type MasterFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';
import { IDLE_MASTER_FORM } from '@/app/(tenant)/t/[slug]/(app)/products/form-state';

/**
 * Who makes the things in the catalogue.
 *
 * ⚠️ THIS SCREEN IS THE FIRST STEP OF SETTING UP A CATALOGUE, AND IT USED TO HAVE
 *   NO UI AT ALL. A product's manufacturer was a picker fed by an endpoint
 *   nothing could write to, and the spreadsheet import resolves `manufacturerCode`
 *   against rows that must already exist — so the import failed every row until
 *   somebody had POSTed here by hand.
 *
 * ⚠️ THE GS1 PREFIX IS DIGITS AND IS NOT THE LICENCE NUMBER. It is the company
 *   prefix inside a GTIN, which is what lets a scanned barcode be attributed to a
 *   maker; a licence number is a regulator's. Two identifier boxes side by side
 *   is exactly where they get typed into each other, so each says what it is for.
 *
 * NO PHI. A manufacturer is a business.
 */
interface Props {
  slug: string;
  manufacturers: ManufacturerSummary[];
  canManage: boolean;
}

export function ManufacturerList({ slug, manufacturers, canManage }: Props) {
  const [addState, add, adding] = useActionState<MasterFormState, FormData>(
    (previous, form) => createManufacturerAction(slug, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => addState.fieldErrors?.[name];

  return (
    <CatalogueMasterScreen
      title="Manufacturers"
      blurb="Who makes what this clinic stocks. A product names one, a batch can name another when a licence holder and a maker differ, and the spreadsheet import matches on the code."
      addLabel="Add a manufacturer"
      addState={addState}
      addAction={add}
      addPending={adding}
      canManage={canManage}
      addFields={<ManufacturerFields errors={err} />}
    >
      {manufacturers.length === 0 ? (
        <CatalogueMasterEmpty>
          Add the makers you buy from before importing a catalogue — the import matches each row on
          the manufacturer code and rejects one it cannot find.
        </CatalogueMasterEmpty>
      ) : (
        <ul className="space-y-2">
          {manufacturers.map((manufacturer) => (
            <ManufacturerRow
              key={manufacturer.id}
              slug={slug}
              manufacturer={manufacturer}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </CatalogueMasterScreen>
  );
}

function ManufacturerRow({
  slug,
  manufacturer,
  canManage,
}: {
  slug: string;
  manufacturer: ManufacturerSummary;
  canManage: boolean;
}) {
  const [state, save, pending] = useActionState<MasterFormState, FormData>(
    (previous, form) => updateManufacturerAction(slug, manufacturer.id, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const detail = [
    manufacturer.countryCode,
    manufacturer.licenceNumber ? `Licence ${manufacturer.licenceNumber}` : null,
    manufacturer.gs1Prefix ? `GS1 ${manufacturer.gs1Prefix}` : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');

  return (
    <CatalogueMasterRow
      name={manufacturer.name}
      code={manufacturer.code}
      detail={detail}
      isOwn={manufacturer.isOwn}
      isActive={manufacturer.isActive}
      canManage={canManage}
      editState={state}
      editAction={save}
      editPending={pending}
      editFields={
        <>
          <ManufacturerFields errors={err} manufacturer={manufacturer} />
          <ActiveCheckbox defaultChecked={manufacturer.isActive} noun="manufacturer" />
        </>
      }
    />
  );
}

/**
 * The same fields for adding and editing, minus the code when editing.
 *
 * ⚠️ THE CODE IS NOT OFFERED ON EDIT BECAUSE THE API DOES NOT ACCEPT IT —
 *   `updateManufacturerRequest` omits it by name. It is what the spreadsheet
 *   import and every future supplier catalogue key on, so a clinic that needs a
 *   different code needs a different manufacturer.
 */
function ManufacturerFields({
  errors,
  manufacturer,
}: {
  errors: (name: string) => string[] | undefined;
  manufacturer?: ManufacturerSummary;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {manufacturer ? null : (
        <Input
          name="code"
          label="Code"
          required
          maxLength={64}
          className="font-mono"
          errors={errors('code')}
          hint="Uppercase letters, digits and underscores. Cannot be changed later."
        />
      )}
      <Input
        name="name"
        label="Name"
        required
        maxLength={255}
        defaultValue={manufacturer?.name}
        errors={errors('name')}
      />
      <Input
        name="countryCode"
        label="Country"
        maxLength={2}
        className="font-mono uppercase"
        defaultValue={manufacturer?.countryCode ?? ''}
        errors={errors('countryCode')}
        hint="Two letters, e.g. IN."
      />
      <Input
        name="licenceNumber"
        label="Licence number"
        maxLength={128}
        defaultValue={manufacturer?.licenceNumber ?? ''}
        errors={errors('licenceNumber')}
        hint="The manufacturing licence the regulator issued them."
      />
      <Input
        name="gs1Prefix"
        label="GS1 company prefix"
        inputMode="numeric"
        maxLength={16}
        className="font-mono"
        defaultValue={manufacturer?.gs1Prefix ?? ''}
        errors={errors('gs1Prefix')}
        hint="Digits only. The part of a barcode that identifies them."
      />
    </div>
  );
}
