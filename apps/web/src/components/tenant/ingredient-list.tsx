'use client';

import { useActionState } from 'react';
import type { ActiveIngredientSummary } from '@rcln/contracts';
import { Input, Textarea } from '@/components/ui/field';
import {
  ActiveCheckbox,
  CatalogueMasterEmpty,
  CatalogueMasterRow,
  CatalogueMasterScreen,
} from '@/components/tenant/catalogue-master-screen';
import {
  createIngredientAction,
  updateIngredientAction,
  type MasterFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';
import { IDLE_MASTER_FORM } from '@/app/(tenant)/t/[slug]/(app)/products/form-state';

/**
 * The substances a medicine is made of.
 *
 * ⚠️ THE INN IS THE FIELD THAT DOES THE WORK, AND IT IS THE ONE WITH THE MOST
 *   HINT. The International Nonproprietary Name is the one identifier that means
 *   the same substance in every country — paracetamol and acetaminophen are one
 *   molecule with two national names, and a clinic that files them as two
 *   ingredients has two compositions that will never be offered as equivalents at
 *   the counter. The name box is what this clinic calls it; the INN is what makes
 *   it the same thing as somebody else's.
 *
 * ⚠️ AN INGREDIENT ON ITS OWN CHANGES NOTHING. It is a row a composition points
 *   at, and a composition is what a product points at — so the empty state and the
 *   blurb both say where this leads rather than leaving somebody with a list of
 *   molecules and no idea why it did not affect a product.
 *
 * NO PHI.
 */
interface Props {
  slug: string;
  ingredients: ActiveIngredientSummary[];
  canManage: boolean;
}

export function IngredientList({ slug, ingredients, canManage }: Props) {
  const [addState, add, adding] = useActionState<MasterFormState, FormData>(
    (previous, form) => createIngredientAction(slug, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => addState.fieldErrors?.[name];

  return (
    <CatalogueMasterScreen
      title="Ingredients"
      blurb="The active substances a medicine is made of. On their own they do nothing — they are what a composition is built from, and a composition is what makes two brands equivalent at the counter."
      addLabel="Add an ingredient"
      addState={addState}
      addAction={add}
      addPending={adding}
      canManage={canManage}
      addFields={<IngredientFields errors={err} />}
    >
      {ingredients.length === 0 ? (
        <CatalogueMasterEmpty>
          Start with the substances you dispense most. Each one you add here becomes available on
          the composition form, which is what a product points at.
        </CatalogueMasterEmpty>
      ) : (
        <ul className="space-y-2">
          {ingredients.map((ingredient) => (
            <IngredientRow
              key={ingredient.id}
              slug={slug}
              ingredient={ingredient}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </CatalogueMasterScreen>
  );
}

function IngredientRow({
  slug,
  ingredient,
  canManage,
}: {
  slug: string;
  ingredient: ActiveIngredientSummary;
  canManage: boolean;
}) {
  const [state, save, pending] = useActionState<MasterFormState, FormData>(
    (previous, form) => updateIngredientAction(slug, ingredient.id, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const detail = [
    ingredient.innName ? `INN ${ingredient.innName}` : null,
    ingredient.synonyms.length > 0 ? `Also ${ingredient.synonyms.join(', ')}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <CatalogueMasterRow
      name={ingredient.name}
      code={ingredient.code}
      detail={detail}
      isOwn={ingredient.isOwn}
      isActive={ingredient.isActive}
      canManage={canManage}
      editState={state}
      editAction={save}
      editPending={pending}
      editFields={
        <>
          <IngredientFields errors={err} ingredient={ingredient} />
          <ActiveCheckbox defaultChecked={ingredient.isActive} noun="ingredient" />
        </>
      }
    />
  );
}

function IngredientFields({
  errors,
  ingredient,
}: {
  errors: (name: string) => string[] | undefined;
  ingredient?: ActiveIngredientSummary;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {ingredient ? null : (
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
          defaultValue={ingredient?.name}
          errors={errors('name')}
          hint="What this clinic calls the substance."
        />
        <Input
          name="innName"
          label="INN"
          maxLength={255}
          defaultValue={ingredient?.innName ?? ''}
          errors={errors('innName')}
          hint="The international name. This is what equivalence is answered on — fill it in."
        />
        <Input
          name="synonyms"
          label="Other names"
          defaultValue={ingredient?.synonyms.join(', ') ?? ''}
          errors={errors('synonyms')}
          hint="Separated by commas, e.g. acetaminophen, APAP. Searched, never dispensed on."
        />
      </div>
      <Textarea
        name="description"
        label="Description"
        rows={2}
        maxLength={2000}
        defaultValue={ingredient?.description ?? ''}
        errors={errors('description')}
      />
    </>
  );
}
