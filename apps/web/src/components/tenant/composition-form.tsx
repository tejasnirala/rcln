'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';
import type { ActiveIngredientSummary, CompositionSummary, UnitSummary } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { asOptions } from '@/lib/enum-words';
import { nextRowKey } from '@/lib/row-key';
import { CatalogueNav } from '@/components/tenant/catalogue-nav';
import {
  createCompositionAction,
  updateCompositionAction,
  type MasterFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';
import { IDLE_MASTER_FORM } from '@/app/(tenant)/t/[slug]/(app)/products/form-state';

/**
 * Building a formula. One form for adding and for editing.
 *
 * ⚠️ A MEDICINE IS NEVER ONE INGREDIENT, AND THE FORM IS SHAPED AROUND THAT.
 *   The strength belongs to the ROW and not to the composition — co-amoxiclav is
 *   two substances at two strengths, and a single strength box on the parent can
 *   express one of them. That is why this screen is a repeater and not four
 *   fields.
 *
 * ⚠️ EDITING REPLACES THE WHOLE INGREDIENT SET, WHICH IS THE API'S CONTRACT AND
 *   IS SAID OUT LOUD ON THE SCREEN. An omitted row means "this is no longer in
 *   it", so removing a row here reformulates the medicine — for a composition
 *   products already point at, that changes what the counter believes is
 *   equivalent to what. The warning is in the form, not in a dialog, so it cannot
 *   be dismissed unread.
 *
 * ⚠️ THE STRENGTH UNIT LIST IS GROUPED AND NOTHING IS HIDDEN FROM IT. Mass and
 *   volume are what a strength is measured in ninety-nine times out of a hundred
 *   — including IU, which the seed files under MASS on purpose — so they lead. The
 *   rest stay reachable underneath rather than being filtered out, because a unit
 *   somebody needs and cannot find is a composition that does not get recorded.
 *
 * NO PHI.
 */
const DOSAGE_FORMS = [
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'SUSPENSION',
  'SOLUTION',
  'INJECTION',
  'INFUSION',
  'CREAM',
  'OINTMENT',
  'GEL',
  'LOTION',
  'DROPS',
  'SPRAY',
  'INHALER',
  'PATCH',
  'SUPPOSITORY',
  'PESSARY',
  'POWDER',
  'GRANULES',
  'LOZENGE',
  'IMPLANT',
  'OTHER',
];

interface Row {
  /** Stable across removals, so React does not re-key the rows below a deletion. */
  key: string;
  ingredientId: string;
  strength: string;
  strengthUnitId: string;
  perQuantity: string;
}

const blankRow = (): Row => ({
  key: nextRowKey(),
  ingredientId: '',
  strength: '',
  strengthUnitId: '',
  perQuantity: '',
});

interface Props {
  slug: string;
  ingredients: ActiveIngredientSummary[];
  units: UnitSummary[];
  /** Absent when adding. */
  composition?: CompositionSummary;
  canManage: boolean;
}

export function CompositionForm({ slug, ingredients, units, composition, canManage }: Props) {
  const editing = composition !== undefined;

  const [rows, setRows] = useState<Row[]>(() =>
    composition && composition.ingredients.length > 0
      ? composition.ingredients.map((ingredient) => ({
          key: nextRowKey(),
          ingredientId: ingredient.ingredientId,
          strength: ingredient.strength,
          strengthUnitId: ingredient.strengthUnitId,
          perQuantity: ingredient.perQuantity ?? '',
        }))
      : [blankRow()]
  );

  const [state, save, pending] = useActionState<MasterFormState, FormData>(
    (previous, form) =>
      composition
        ? updateCompositionAction(slug, composition.id, previous, form)
        : createCompositionAction(slug, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const ingredientOptions = useMemo(
    () => [
      { value: '', label: 'Choose an ingredient' },
      ...ingredients
        .filter((ingredient) => ingredient.isActive)
        .map((ingredient) => ({
          value: ingredient.id,
          label: ingredient.innName
            ? `${ingredient.name} (${ingredient.innName})`
            : ingredient.name,
        })),
    ],
    [ingredients]
  );

  const unitGroups = useMemo(() => {
    const strengthUnits = units.filter(
      (unit) => unit.unitClass === 'MASS' || unit.unitClass === 'VOLUME'
    );
    const rest = units.filter((unit) => unit.unitClass !== 'MASS' && unit.unitClass !== 'VOLUME');
    const asOption = (unit: UnitSummary) => ({ value: unit.id, label: unit.symbol });
    return [
      { label: 'Strength units', options: strengthUnits.map(asOption) },
      { label: 'Everything else', options: rest.map(asOption) },
    ];
  }, [units]);

  const patch = (key: string, change: Partial<Row>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };

  if (!canManage) {
    return (
      <Alert tone="error">
        You do not have permission to change compositions here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {editing ? composition.name : 'Add a composition'}
        </h1>
        <p className="text-muted mt-1 max-w-2xl text-[0.875rem]">
          {editing
            ? 'What this medicine is made of. Products that share it are treated as equivalent at the counter.'
            : 'Name the formula, then add one row per active substance with the strength printed on the pack.'}
        </p>
      </header>

      <CatalogueNav />

      {editing && !composition.isOwn ? (
        <Alert tone="info">
          This composition is part of the platform catalogue and cannot be changed here. Add your
          own if it is not right.
        </Alert>
      ) : null}

      <form action={save} className="max-w-3xl space-y-8">
        {state.status === 'error' && state.message ? (
          <Alert tone="error">{state.message}</Alert>
        ) : null}
        {state.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

        <section className="space-y-4">
          <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
            What it is
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            {editing ? null : (
              <Input
                name="code"
                label="Code"
                required
                maxLength={64}
                className="font-mono"
                errors={err('code')}
                hint="Uppercase letters, digits and underscores. Cannot be changed later."
              />
            )}
            <Input
              name="name"
              label="Name"
              required
              maxLength={500}
              defaultValue={composition?.name}
              errors={err('name')}
              hint="How the formula reads on a pack, e.g. Amoxicillin 500 mg + Clavulanic acid 125 mg."
            />
            <Select
              name="dosageForm"
              label="Dosage form"
              options={[{ value: '', label: 'Not specified' }, ...asOptions(DOSAGE_FORMS)]}
              defaultValue={composition?.dosageForm ?? ''}
              errors={err('dosageForm')}
              hint="A tablet and a syrup of the same substance are not interchangeable."
            />
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
            What is in it
          </h2>

          {editing ? (
            <p className="text-muted text-[0.8125rem]">
              Saving replaces the whole list. A row removed here is no longer part of the medicine,
              for every product that points at this composition.
            </p>
          ) : null}

          {err('ingredients') ? <Alert tone="error">{err('ingredients')?.join(' ')}</Alert> : null}

          <ul className="space-y-3">
            {rows.map((row, index) => (
              <li key={row.key} className="border-rule bg-card rounded-md border p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    name={`ingredients.${String(index)}.ingredientId`}
                    label="Ingredient"
                    required
                    options={ingredientOptions}
                    value={row.ingredientId}
                    onChange={(event) => patch(row.key, { ingredientId: event.target.value })}
                    errors={err(`ingredients.${String(index)}.ingredientId`)}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      name={`ingredients.${String(index)}.strength`}
                      label="Strength"
                      required
                      inputMode="decimal"
                      value={row.strength}
                      onChange={(event) => patch(row.key, { strength: event.target.value })}
                      errors={err(`ingredients.${String(index)}.strength`)}
                    />
                    <Select
                      name={`ingredients.${String(index)}.strengthUnitId`}
                      label="Unit"
                      required
                      placeholder="Unit"
                      options={unitGroups}
                      value={row.strengthUnitId}
                      onChange={(event) => patch(row.key, { strengthUnitId: event.target.value })}
                      errors={err(`ingredients.${String(index)}.strengthUnitId`)}
                    />
                  </div>
                  <Input
                    name={`ingredients.${String(index)}.perQuantity`}
                    label="Per"
                    inputMode="decimal"
                    value={row.perQuantity}
                    onChange={(event) => patch(row.key, { perQuantity: event.target.value })}
                    errors={err(`ingredients.${String(index)}.perQuantity`)}
                    hint="For a concentration — 125 mg per 5 mL means 5 here. Leave blank for a tablet."
                  />
                </div>

                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRows((current) =>
                        current.filter((candidate) => candidate.key !== row.key)
                      );
                    }}
                    className="text-muted hover:text-danger mt-3 px-2 py-2 text-[0.8125rem]"
                  >
                    Remove {row.ingredientId === '' ? 'this ingredient' : nameOf(ingredients, row)}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setRows((current) => [...current, blankRow()]);
            }}
          >
            Add another ingredient
          </Button>
        </section>

        {editing && composition.isOwn ? (
          <label className="text-ink flex items-start gap-2 py-1 text-[0.875rem]">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={composition.isActive}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              In use
              <span className="text-muted mt-0.5 block text-[0.8125rem]">
                Clear this to stop offering it on new products. It is refused while any product
                still references it, and the refusal says how many.
              </span>
            </span>
          </label>
        ) : null}

        <div className="border-rule flex items-center gap-3 border-t pt-6">
          <Button type="submit" disabled={pending || (editing && !composition.isOwn)}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Add composition'}
          </Button>
          <Link
            href="/products/compositions"
            className="text-muted hover:text-drape px-2 py-2 text-[0.875rem]"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

/** The chosen ingredient's name, so "Remove" names what it removes. */
function nameOf(ingredients: ActiveIngredientSummary[], row: Row): string {
  return (
    ingredients.find((ingredient) => ingredient.id === row.ingredientId)?.name ?? 'this ingredient'
  );
}
