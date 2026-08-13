'use server';

import { revalidatePath } from 'next/cache';
import {
  createProductRequest,
  medicineDetailRequest,
  replaceProductPackagingRequest,
  replaceProductRegulatoryProfilesRequest,
  replaceProductTaxClassificationsRequest,
  type CreateProductIdentifierRequest,
  type MedicineDetail,
  type ProductDetail,
  type ProductIdentifierDetail,
  type ProductPackagingDetail,
  type ProductRegulatoryProfileDetail,
  type ProductTaxClassificationDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The product catalogue.
 *
 * ⚠️ UNLIKE `patients/actions.ts`, FILTERS HERE DO GO IN THE URL, AND THAT IS
 *   THE RIGHT CALL FOR THIS SCREEN. That file keeps a search term out of the
 *   query string because the term is somebody's surname — it would land in
 *   browser history, the next referrer header, and every proxy access log along
 *   the way. A product name is not PHI: nothing on this screen names a person or
 *   discloses anything about one. So the list gets what a catalogue should have
 *   — linkable, refreshable, shareable filter state — and paginates on the
 *   server.
 *
 *   If a screen in this domain ever joins a product to a patient (dispensing,
 *   PI-7), that screen follows the patients rule, not this one.
 *
 * `slug` is threaded through every action and becomes the Host header inside
 * `api()`. Without it the server-to-server fetch arrives as `api:5000`, resolves
 * to no tenant, and every call 404s.
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED. Do not read the sibling comment in
 *   `doctors/actions.ts` — which this file's header was copied from — as saying
 *   otherwise. It claims these are "bound to the slug on the server before they
 *   reach the browser"; they are not. `.bind(null, slug)` runs inside a CLIENT
 *   component, so it prepends the argument in the browser, and a server action
 *   is a public POST endpoint either way. Anyone who can call one of these can
 *   call it with any slug they like.
 *
 *   What actually stops that is one layer down and is not in this file: the API
 *   compares the tenant resolved from the Host header against the organization
 *   in the bearer token and returns 404 — never 403 — when they disagree
 *   (`apps/api/src/middleware/auth.middleware.ts`). Underneath that, RLS is
 *   keyed on the token's org, not the slug. So a forged slug reaches a tenant
 *   the caller has no membership in and gets nothing.
 *
 *   The consequence for this file: never let `slug` decide anything on its own.
 *   It selects a Host header and a `revalidatePath` prefix. It is not an
 *   authorization input, and no action here may branch on it.
 */

export type ProductFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set when a product was just created, so the form can offer to open it. */
  productId?: string;
};

export const IDLE_FORM: ProductFormState = { status: 'idle' };

/**
 * One place where an API refusal becomes a form state.
 *
 * Extracted because the alternative — each action shaping its own — is how one
 * of them ends up swallowing `fieldErrors` and showing a bare "Something went
 * wrong" over a form with a highlightable field.
 */
function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): ProductFormState {
  if (result.ok) return { status: 'saved' };
  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createProductAction(
  slug: string,
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  /*
   * Parsed against the SAME schema the API validates with, so the form and the
   * route cannot disagree about what is required. The server still validates —
   * this is a faster, friendlier first pass, never the control.
   */
  const raw = {
    type: formData.get('type'),
    code: formData.get('code'),
    name: formData.get('name'),
    brandName: emptyToNull(formData.get('brandName')),
    genericName: emptyToNull(formData.get('genericName')),
    description: emptyToNull(formData.get('description')),
    categoryId: emptyToNull(formData.get('categoryId')),
    manufacturerId: emptyToNull(formData.get('manufacturerId')),
    compositionId: emptyToNull(formData.get('compositionId')),
    storageProfileId: emptyToNull(formData.get('storageProfileId')),
    baseUnitId: formData.get('baseUnitId'),
    trackingMode: formData.get('trackingMode') ?? 'NONE',
    isExpiryControlled: formData.get('isExpiryControlled') === 'on',
    defaultShelfLifeDays: numberOrUndefined(formData.get('defaultShelfLifeDays')),
    reorderLevelBase: emptyToNull(formData.get('reorderLevelBase')),
    reorderQuantityBase: emptyToNull(formData.get('reorderQuantityBase')),
    isStockItem: formData.get('isStockItem') !== 'off',
  };

  const parsed = createProductRequest.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<ProductDetail>('/api/v1/products', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/products`);
  return { status: 'saved', productId: result.data?.id };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function updateProductAction(
  slug: string,
  productId: string,
  patch: Record<string, unknown>
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const result = await api<ProductDetail>(`/api/v1/products/${productId}`, {
    method: 'PATCH',
    body: patch,
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/products/${productId}`);
    revalidatePath(`/t/${slug}/products`);
  }
  return toFormState(result);
}

/**
 * Copy a platform product into this clinic's catalogue.
 *
 * The only way to customise one — a tenant cannot edit a platform row, and the
 * composite foreign key means it cannot attach its own packaging or identifiers
 * to one either. The copy arrives as a draft.
 */
export async function cloneProductAction(
  slug: string,
  productId: string,
  code?: string
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const result = await api<ProductDetail>(`/api/v1/products/${productId}/clone`, {
    method: 'POST',
    body: code ? { code } : {},
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/products`);
  return { status: 'saved', productId: result.data?.id };
}

export async function withdrawProductAction(
  slug: string,
  productId: string
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const result = await api<null>(`/api/v1/products/${productId}`, {
    method: 'DELETE',
    slug,
    accessToken,
  });

  if (result.ok) revalidatePath(`/t/${slug}/products`);
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

export async function replacePackagingAction(
  slug: string,
  productId: string,
  levels: unknown
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const parsed = replaceProductPackagingRequest.safeParse({ levels });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the pack sizes.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<{ levels: ProductPackagingDetail[] }>(
    `/api/v1/products/${productId}/packagings`,
    { method: 'PUT', body: parsed.data, slug, accessToken }
  );

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

export async function addIdentifierAction(
  slug: string,
  productId: string,
  body: CreateProductIdentifierRequest
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const result = await api<ProductIdentifierDetail>(`/api/v1/products/${productId}/identifiers`, {
    method: 'POST',
    body,
    slug,
    accessToken,
  });

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

/** Expires the identifier rather than removing it — stock received under it must
 *  keep resolving. The button says "Expire" for the same reason. */
export async function expireIdentifierAction(
  slug: string,
  productId: string,
  identifierId: string
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const result = await api<null>(`/api/v1/products/${productId}/identifiers/${identifierId}`, {
    method: 'DELETE',
    slug,
    accessToken,
  });

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

/**
 * ⚠️ BEHIND `billing.tax.manage` AT THE API, NOT A PRODUCT CODE. Setting a
 *   product's tax category decides what every future patient is charged for it.
 *   The screen hides the control when the caller lacks it; the API is what
 *   actually refuses.
 */
export async function replaceTaxClassificationsAction(
  slug: string,
  productId: string,
  classifications: unknown
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const parsed = replaceProductTaxClassificationsRequest.safeParse({ classifications });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the tax classifications.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<{ classifications: ProductTaxClassificationDetail[] }>(
    `/api/v1/products/${productId}/tax-classifications`,
    { method: 'PUT', body: parsed.data, slug, accessToken }
  );

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

/**
 * What this product IS in a jurisdiction — its registration, classification and
 * schedule.
 *
 * ⚠️ AN ASSERTION, NOT AN AUTHORISATION. Nothing dispenses on the strength of
 *   these rows: they are an INPUT to the rules engine, and a place with no rule
 *   refuses however confidently they are filled in. Gated by
 *   `product.regulatory.manage`, which is not the catalogue code — asserting
 *   that something is a controlled medicine is a claim the clinic answers for.
 */
export async function replaceRegulatoryProfilesAction(
  slug: string,
  productId: string,
  profiles: unknown
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const parsed = replaceProductRegulatoryProfilesRequest.safeParse({ profiles });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the regulatory profiles.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<{ profiles: ProductRegulatoryProfileDetail[] }>(
    `/api/v1/products/${productId}/regulatory-profiles`,
    { method: 'PUT', body: parsed.data, slug, accessToken }
  );

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

export async function saveMedicineDetailAction(
  slug: string,
  productId: string,
  body: unknown
): Promise<ProductFormState> {
  const accessToken = await getAccessToken();

  const parsed = medicineDetailRequest.safeParse(body);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the medicine details.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<MedicineDetail>(`/api/v1/products/${productId}/medicine`, {
    method: 'PUT',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (result.ok) revalidatePath(`/t/${slug}/products/${productId}`);
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An untouched `<input>` submits `''`, and `''` is not the same as "not set".
 *
 * Left as-is, an empty optional field would fail a uuid or a decimal check and
 * report "invalid" on a field the user deliberately left blank. Null is what the
 * contract means by absent.
 */

function numberOrUndefined(value: FormDataEntryValue | null): number | undefined {
  const text = emptyToNull(value);
  if (text === null) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
