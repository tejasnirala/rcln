'use server';

import { revalidatePath } from 'next/cache';
import {
  createActiveIngredientRequest,
  createCompositionRequest,
  createManufacturerRequest,
  createProductCategoryRequest,
  createStorageProfileRequest,
  updateActiveIngredientRequest,
  updateCompositionRequest,
  updateManufacturerRequest,
  updateProductCategoryRequest,
  type ActiveIngredientSummary,
  type CompositionSummary,
  type ManufacturerSummary,
  type ProductCategory,
  type StorageProfileSummary,
} from '@rcln/contracts';
import type { ZodType } from 'zod';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The five master lists a product points at: manufacturers, active ingredients,
 * compositions, categories and storage requirement profiles.
 *
 * ⚠️ A SECOND ACTIONS MODULE IN ONE ROUTE GROUP, AND THE SPLIT IS BY SUBJECT
 *   RATHER THAN BY ROUTE. `actions.ts` is about ONE product — creating it,
 *   editing its tabs, importing a spreadsheet of them. This file is about the
 *   things every product points at, which have their own screens, their own
 *   endpoints and a rule none of the product actions have (below). Ten more
 *   actions in that file would have doubled it and buried the product in its
 *   own prerequisites.
 *
 * ⚠️ EVERY ONE OF THESE FIVE HAS A PLATFORM HALF THIS CLINIC CANNOT EDIT.
 *   `isOwn: false` is a row rcln ships to every tenant; `assertMutable` in
 *   `catalogue.service.ts` refuses to change one, and underneath that RLS
 *   refuses the UPDATE outright because the row's `organization_id` is NULL. The
 *   screens do not offer the edit — but nothing here relies on that, because a
 *   server action is a public POST endpoint and the client decides what it
 *   sends. The refusal that matters is the API's.
 *
 * ⚠️ NOTHING HERE DELETES. The API exposes no DELETE for any of the five and
 *   should not: a manufacturer is named by products, a composition is what
 *   substitution is answered on, and a row removed under either is a foreign key
 *   pointing at nothing. Retiring one is `isActive: false`, which the services
 *   refuse while anything still names it — and say how many.
 *
 * `slug` selects a Host header and a `revalidatePath` prefix. It is not an
 * authorization input and no action here branches on it; see the long note in
 * `actions.ts` for what actually stops a forged one.
 *
 * NO PHI. Every row on these screens is a fact about a substance or a business.
 */

export type MasterFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

/**
 * Parse against the contract, send, revalidate — the shape all ten actions share.
 *
 * ⚠️ THE SAME SCHEMA THE API VALIDATES WITH, so the form and the route cannot
 *   disagree about what is required. The server still validates; this is a
 *   faster, friendlier first pass and never the control.
 */
async function submit<T>(options: {
  schema: ZodType;
  raw: unknown;
  path: string;
  method: 'POST' | 'PATCH';
  slug: string;
  /** Paths to revalidate on success, relative to the tenant root. */
  revalidate: string[];
}): Promise<MasterFormState> {
  const parsed = options.schema.safeParse(options.raw);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<T>(options.path, {
    method: options.method,
    body: parsed.data,
    slug: options.slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.message ?? 'That could not be saved. Check the fields and try again.',
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
    };
  }

  for (const path of options.revalidate) revalidatePath(`/t/${options.slug}${path}`);
  return { status: 'saved' };
}

/** A checkbox that is absent from `FormData` when cleared. */
const checked = (form: FormData, name: string): boolean => form.get(name) === 'on';

function numberOrNull(value: FormDataEntryValue | null): number | null {
  const text = emptyToNull(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Manufacturers
// ---------------------------------------------------------------------------

export async function createManufacturerAction(
  slug: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ManufacturerSummary>({
    schema: createManufacturerRequest,
    raw: {
      code: form.get('code'),
      name: form.get('name'),
      countryCode: emptyToNull(form.get('countryCode')),
      licenceNumber: emptyToNull(form.get('licenceNumber')),
      gs1Prefix: emptyToNull(form.get('gs1Prefix')),
    },
    path: '/api/v1/manufacturers',
    method: 'POST',
    slug,
    revalidate: ['/products/manufacturers', '/products'],
  });
}

export async function updateManufacturerAction(
  slug: string,
  manufacturerId: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ManufacturerSummary>({
    schema: updateManufacturerRequest,
    raw: {
      name: form.get('name'),
      countryCode: emptyToNull(form.get('countryCode')),
      licenceNumber: emptyToNull(form.get('licenceNumber')),
      gs1Prefix: emptyToNull(form.get('gs1Prefix')),
      isActive: checked(form, 'isActive'),
    },
    path: `/api/v1/manufacturers/${manufacturerId}`,
    method: 'PATCH',
    slug,
    revalidate: ['/products/manufacturers', '/products'],
  });
}

// ---------------------------------------------------------------------------
// Active ingredients
// ---------------------------------------------------------------------------

/**
 * Synonyms arrive as one comma-separated box and leave as an array.
 *
 * ⚠️ ONE BOX RATHER THAN A REPEATER, BECAUSE OF WHAT THEY ARE FOR. A synonym is
 *   a spelling — "paracetamol, acetaminophen, APAP" — typed in one breath while
 *   somebody is looking at a pack. A row-per-value repeater would put a button
 *   press between each of three words. Anything that needs its own id is another
 *   ingredient and belongs in the table, not in this box (ADR-0006).
 */
function synonymsFrom(value: FormDataEntryValue | null): string[] {
  const text = emptyToNull(value);
  if (text === null) return [];
  return [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
    ),
  ];
}

export async function createIngredientAction(
  slug: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ActiveIngredientSummary>({
    schema: createActiveIngredientRequest,
    raw: {
      code: form.get('code'),
      name: form.get('name'),
      innName: emptyToNull(form.get('innName')),
      synonyms: synonymsFrom(form.get('synonyms')),
      description: emptyToNull(form.get('description')),
    },
    path: '/api/v1/active-ingredients',
    method: 'POST',
    slug,
    revalidate: ['/products/ingredients', '/products/compositions'],
  });
}

export async function updateIngredientAction(
  slug: string,
  ingredientId: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ActiveIngredientSummary>({
    schema: updateActiveIngredientRequest,
    raw: {
      name: form.get('name'),
      innName: emptyToNull(form.get('innName')),
      synonyms: synonymsFrom(form.get('synonyms')),
      description: emptyToNull(form.get('description')),
      isActive: checked(form, 'isActive'),
    },
    path: `/api/v1/active-ingredients/${ingredientId}`,
    method: 'PATCH',
    slug,
    revalidate: ['/products/ingredients', '/products/compositions'],
  });
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

/**
 * The ingredient rows out of one `FormData`.
 *
 * ⚠️ INDEXED NAMES (`ingredients.0.ingredientId`) RATHER THAN `getAll`, the same
 *   call `procurement/actions.ts` makes and for the same reason: `perQuantity` is
 *   optional, so a syrup row that has one and a tablet row that does not would
 *   shift out of alignment under `getAll` and the second row would inherit the
 *   first's denominator. Co-amoxiclav 500/125 typed as 500/500 is a dispensing
 *   error that reads as a typo.
 */
function ingredientRows(form: FormData): unknown[] {
  const indices = new Set<number>();
  for (const key of form.keys()) {
    const match = /^ingredients\.(\d+)\./.exec(key);
    if (match?.[1] !== undefined && form.get(`ingredients.${match[1]}.ingredientId`) !== null) {
      indices.add(Number(match[1]));
    }
  }

  return [...indices]
    .sort((a, b) => a - b)
    .map((index, position) => ({
      ingredientId: emptyToNull(form.get(`ingredients.${index}.ingredientId`)) ?? '',
      strength: emptyToNull(form.get(`ingredients.${index}.strength`)) ?? '',
      strengthUnitId: emptyToNull(form.get(`ingredients.${index}.strengthUnitId`)) ?? '',
      perQuantity: emptyToNull(form.get(`ingredients.${index}.perQuantity`)),
      /*
       * The order they are on screen, renumbered — never the raw index. Removing
       * the second of three rows leaves 0 and 2 in the DOM, and sending those
       * would store a gap that the next edit renders in the same order but
       * cannot explain.
       */
      displayOrder: position,
    }));
}

export async function createCompositionAction(
  slug: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<CompositionSummary>({
    schema: createCompositionRequest,
    raw: {
      code: form.get('code'),
      name: form.get('name'),
      dosageForm: emptyToNull(form.get('dosageForm')),
      ingredients: ingredientRows(form),
    },
    path: '/api/v1/compositions',
    method: 'POST',
    slug,
    revalidate: ['/products/compositions'],
  });
}

export async function updateCompositionAction(
  slug: string,
  compositionId: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<CompositionSummary>({
    schema: updateCompositionRequest,
    raw: {
      name: form.get('name'),
      dosageForm: emptyToNull(form.get('dosageForm')),
      isActive: checked(form, 'isActive'),
      /*
       * The whole set, every time — PUT semantics on the children, which is what
       * the contract documents. An omitted ingredient means "this is no longer in
       * it", so a partial send would be a silent reformulation.
       */
      ingredients: ingredientRows(form),
    },
    path: `/api/v1/compositions/${compositionId}`,
    method: 'PATCH',
    slug,
    revalidate: ['/products/compositions', `/products/compositions/${compositionId}`],
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createCategoryAction(
  slug: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ProductCategory>({
    schema: createProductCategoryRequest,
    raw: {
      code: form.get('code'),
      name: form.get('name'),
      parentId: emptyToNull(form.get('parentId')),
      description: emptyToNull(form.get('description')),
      displayOrder: numberOrNull(form.get('displayOrder')) ?? 0,
    },
    path: '/api/v1/product-categories',
    method: 'POST',
    slug,
    revalidate: ['/products/categories', '/products'],
  });
}

export async function updateCategoryAction(
  slug: string,
  categoryId: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<ProductCategory>({
    schema: updateProductCategoryRequest,
    raw: {
      name: form.get('name'),
      parentId: emptyToNull(form.get('parentId')),
      description: emptyToNull(form.get('description')),
      displayOrder: numberOrNull(form.get('displayOrder')) ?? 0,
      isActive: checked(form, 'isActive'),
    },
    path: `/api/v1/product-categories/${categoryId}`,
    method: 'PATCH',
    slug,
    revalidate: ['/products/categories', '/products'],
  });
}

// ---------------------------------------------------------------------------
// Storage requirement profiles
// ---------------------------------------------------------------------------

export async function createStorageProfileAction(
  slug: string,
  _prev: MasterFormState,
  form: FormData
): Promise<MasterFormState> {
  return submit<StorageProfileSummary>({
    schema: createStorageProfileRequest,
    raw: {
      code: form.get('code'),
      name: form.get('name'),
      minTemperatureC: emptyToNull(form.get('minTemperatureC')),
      maxTemperatureC: emptyToNull(form.get('maxTemperatureC')),
      minHumidityPct: numberOrNull(form.get('minHumidityPct')),
      maxHumidityPct: numberOrNull(form.get('maxHumidityPct')),
      lightSensitivity: form.get('lightSensitivity') ?? 'NONE',
      requiresControlledAccess: checked(form, 'requiresControlledAccess'),
      hazardClass: emptyToNull(form.get('hazardClass')),
      handlingNotes: emptyToNull(form.get('handlingNotes')),
    },
    path: '/api/v1/storage-profiles',
    method: 'POST',
    slug,
    revalidate: ['/products/storage', '/products'],
  });
}

/*
 * ⚠️ THERE IS NO `updateStorageProfileAction`, AND THAT IS THE API'S SHAPE RATHER
 *   THAN AN OVERSIGHT. `/v1/storage-profiles` serves GET and POST and nothing
 *   else — there is no PATCH route and no `updateStorageProfileRequest` in the
 *   contracts. A profile is therefore corrected by adding the right one and
 *   pointing the products at it, which the screen says. Adding the endpoint is a
 *   contract, a service, a route, an OpenAPI registry entry and a test, and it is
 *   not what "let a pharmacist set the fridge up from a screen" needed.
 */
