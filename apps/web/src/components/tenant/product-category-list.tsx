'use client';

import { useActionState } from 'react';
import type { ProductCategory } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import {
  ActiveCheckbox,
  CatalogueMasterEmpty,
  CatalogueMasterRow,
  CatalogueMasterScreen,
} from '@/components/tenant/catalogue-master-screen';
import {
  createCategoryAction,
  updateCategoryAction,
  type MasterFormState,
} from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';
import { IDLE_MASTER_FORM } from '@/app/(tenant)/t/[slug]/(app)/products/form-state';

/**
 * How the catalogue is filed.
 *
 * ⚠️ THE TREE IS RENDERED AS INDENTATION AND THE LIST STAYS FLAT, WHICH IS THE
 *   SAME CALL THE CATEGORY PICKER ON THE PRODUCT FORM ALREADY MAKES. The API
 *   returns rows carrying `depth`, already in order — so a nested `<ul>` would be
 *   a second way to express something the response has already decided, and the
 *   two would disagree the first time a category moved. What is nested here is the
 *   MEANING, and one indent per level says it.
 *
 * ⚠️ DEPTH IS INDENTATION *AND* A PARENT NAMED IN THE ROW, because indentation
 *   alone is a spatial cue a screen reader does not narrate and a phone squeezes
 *   out (WCAG 1.4.1, again).
 *
 * NO PHI.
 */
interface Props {
  slug: string;
  categories: ProductCategory[];
  canManage: boolean;
}

export function ProductCategoryList({ slug, categories, canManage }: Props) {
  const [addState, add, adding] = useActionState<MasterFormState, FormData>(
    (previous, form) => createCategoryAction(slug, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => addState.fieldErrors?.[name];
  const nameById = new Map(categories.map((category) => [category.id, category.name]));

  return (
    <CatalogueMasterScreen
      title="Categories"
      blurb="How the catalogue is filed. A category groups products on every screen that lists them and is what the catalogue filter narrows by — it decides nothing about tax, stock or dispensing."
      addLabel="Add a category"
      addState={addState}
      addAction={add}
      addPending={adding}
      canManage={canManage}
      addFields={<CategoryFields errors={err} categories={categories} />}
    >
      {categories.length === 0 ? (
        <CatalogueMasterEmpty>
          Add a few broad ones first — medicines, consumables, devices — and put the detail
          underneath them. A product can sit at any level.
        </CatalogueMasterEmpty>
      ) : (
        <ul className="space-y-2">
          {categories.map((category) => (
            <CategoryRow
              key={category.id}
              slug={slug}
              category={category}
              categories={categories}
              parentName={category.parentId ? (nameById.get(category.parentId) ?? null) : null}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </CatalogueMasterScreen>
  );
}

function CategoryRow({
  slug,
  category,
  categories,
  parentName,
  canManage,
}: {
  slug: string;
  category: ProductCategory;
  categories: ProductCategory[];
  parentName: string | null;
  canManage: boolean;
}) {
  const [state, save, pending] = useActionState<MasterFormState, FormData>(
    (previous, form) => updateCategoryAction(slug, category.id, previous, form),
    IDLE_MASTER_FORM
  );

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const detail = [
    parentName ? `Under ${parentName}` : 'Top level',
    category.hasChildren ? 'Has categories under it' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    // The indent is `depth` levels, capped so a deep tree cannot push the name
    // off a phone. Six levels of product category is a filing problem, not a
    // layout one, and squeezing the name to nothing would hide it.
    <div style={{ marginInlineStart: `${String(Math.min(category.depth, 4) * 1.25)}rem` }}>
      <CatalogueMasterRow
        name={category.name}
        code={category.code}
        detail={detail}
        isOwn={category.isOwn}
        isActive={category.isActive}
        canManage={canManage}
        editState={state}
        editAction={save}
        editPending={pending}
        editFields={
          <>
            <CategoryFields errors={err} categories={categories} category={category} />
            <ActiveCheckbox defaultChecked={category.isActive} noun="category" />
          </>
        }
      />
    </div>
  );
}

function CategoryFields({
  errors,
  categories,
  category,
}: {
  errors: (name: string) => string[] | undefined;
  categories: ProductCategory[];
  category?: ProductCategory;
}) {
  /*
   * ⚠️ A CATEGORY MAY NOT BE ITS OWN PARENT, AND THE FORM DOES NOT OFFER IT.
   *   The service rejects a cycle, but the shortest cycle is the one that is one
   *   click away in an unfiltered list. Its own descendants are still offered
   *   here and refused by the server — filtering those needs the subtree, which
   *   this list has as `depth` rather than as edges.
   */
  const parentOptions = [
    { value: '', label: 'Top level' },
    ...categories
      .filter((option) => option.id !== category?.id)
      .map((option) => ({
        value: option.id,
        label: `${'— '.repeat(option.depth)}${option.name}`,
      })),
  ];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {category ? null : (
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
          defaultValue={category?.name}
          errors={errors('name')}
        />
        <Select
          name="parentId"
          label="Sits under"
          options={parentOptions}
          defaultValue={category?.parentId ?? ''}
          errors={errors('parentId')}
        />
        <Input
          name="displayOrder"
          label="Order"
          type="number"
          inputMode="numeric"
          min={0}
          defaultValue={String(category?.displayOrder ?? 0)}
          errors={errors('displayOrder')}
          hint="Lower sorts first among its siblings."
        />
      </div>
      <Textarea
        name="description"
        label="Description"
        rows={2}
        maxLength={2000}
        defaultValue={category?.description ?? ''}
        errors={errors('description')}
      />
    </>
  );
}
