'use server';

import { revalidatePath } from 'next/cache';
import {
  createBatchRequest,
  createInventoryLocationRequest,
  createSerialRequest,
  updateInventoryLocationRequest,
  type BatchDetail,
  type InventoryLocationDetail,
  type SerialDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of `/stock`.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT: RECORDING A MOVEMENT. `POST /v1/stock/movements`
 *   exists, is gated on `inventory.stock.adjust` and is exercised by tests — but
 *   the SCREEN for it is PI-3.6 ("Screens: transfers, adjustments, reservations")
 *   sitting on PI-3.1's adjustment work, and the recall workflow is PI-10. This
 *   file creates the things a movement is recorded AGAINST: a place, a lot, a
 *   serial.
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as in `products/actions.ts`. It selects
 *   a Host header and a `revalidatePath` prefix and nothing else. What stops a
 *   forged one is a layer down: the API compares the tenant resolved from the
 *   Host header against the organization in the bearer token and returns 404 —
 *   never 403 — when they disagree, and RLS is keyed on the token's org. No
 *   action here may branch on `slug`.
 *
 * ⚠️ THE BRANCH IS NOT TRUSTED FROM THE FORM EITHER, and this is the one that
 *   matters for this domain. Every service asserts the branch is in
 *   `ctx.branchIds` and throws NOT FOUND when it is not, so a posted branch id
 *   the caller has no scope for gets nothing back. The `<select>` is a
 *   convenience, never the control.
 *
 * NO PHI. Nothing here names a patient — assigning a serial to one is a
 * different action and does not exist as a screen yet.
 */

export type StockFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful create, so the form can navigate to what it made. */
  createdId?: string;
};

export const IDLE_FORM: StockFormState = { status: 'idle' };

/**
 * One place where an API refusal becomes a form state.
 *
 * Extracted for the same reason `products/actions.ts` extracts its own: each
 * action shaping its own is how one of them ends up swallowing `fieldErrors` and
 * showing a bare "Something went wrong" over a form with a highlightable field.
 */
function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): StockFormState {
  if (result.ok) return { status: 'saved' };
  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

/**
 * A money field typed in major units, stored in minor ones.
 *
 * ⚠️ `Math.round(Number(x) * 100)` AND NOT A DECIMAL LIBRARY, and that is safe
 *   HERE and nowhere near the ledger. This is one multiplication of a
 *   two-decimal string a human typed into a box — `12.50` is exactly
 *   representable as a double and `1250` is exact as an integer. Quantities go
 *   through `@rcln/inventory`'s exact rationals precisely because they compound
 *   through packaging hierarchies; a unit cost does not compound, it is stored
 *   once.
 *
 * Returns null for a BLANK field, so a lot with no recorded cost stays a lot
 * with no recorded cost rather than one costing zero.
 *
 * ⚠️ AND `NaN` FOR ANYTHING ELSE THAT IS NOT A NON-NEGATIVE NUMBER, RATHER THAN
 *   null. Returning null for a typo made the two cases identical: a lot saved
 *   successfully with no cost and no field error, because `createBatchRequest`
 *   never saw the field to complain about. `NaN` fails `z.number().int()`, so
 *   the caller is told which box is wrong — which is the entire job of a form.
 */
function majorToMinor(value: FormDataEntryValue | null): number | null {
  const text = emptyToNull(value);
  if (text === null) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
  return Math.round(amount * 100);
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function createLocationAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  /*
   * Parsed against the SAME schema the API validates with, so the form and the
   * route cannot disagree about what is required. The server still validates —
   * this is a faster, friendlier first pass, never the control.
   */
  const parsed = createInventoryLocationRequest.safeParse({
    branchId: formData.get('branchId'),
    kind: formData.get('kind'),
    code: formData.get('code'),
    name: formData.get('name'),
    isDispensingPoint: formData.get('isDispensingPoint') === 'on',
    requiresControlledAccess: formData.get('requiresControlledAccess') === 'on',
    storageProfileId: emptyToNull(formData.get('storageProfileId')),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<InventoryLocationDetail>('/api/v1/inventory-locations', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/stock/locations`);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved', createdId: result.data?.id };
}

export async function updateLocationAction(
  slug: string,
  locationId: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  /*
   * ⚠️ NEITHER `branchId` NOR `code` IS HERE, AND THE CONTRACT REFUSES BOTH.
   *   Moving a location to another branch would move every balance and every
   *   historical movement under it to a site they never happened at — the same
   *   class of silent reinterpretation as changing a product's base unit. A
   *   location at the wrong branch is taken out of use and recreated, which
   *   leaves the history where it happened.
   */
  const parsed = updateInventoryLocationRequest.safeParse({
    kind: formData.get('kind'),
    name: formData.get('name'),
    isDispensingPoint: formData.get('isDispensingPoint') === 'on',
    requiresControlledAccess: formData.get('requiresControlledAccess') === 'on',
    storageProfileId: emptyToNull(formData.get('storageProfileId')),
    isActive: formData.get('isActive') === 'on',
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<InventoryLocationDetail>(`/api/v1/inventory-locations/${locationId}`, {
    method: 'PATCH',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/stock/locations`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

/**
 * Record a lot.
 *
 * ⚠️ THIS CREATES THE LOT AND NOT THE STOCK. A batch row is the identity of a
 *   delivery — its number, its expiry, what it cost — and holds no quantity at
 *   all (PI-ADR-004). Putting stock into it is a MOVEMENT, and the screen for
 *   that is PI-3.6. Until then a lot is created here and filled by the API.
 *
 *   That separation is the reason the form does not ask "how many": a quantity
 *   field here would have to write a ledger row as a side effect of creating a
 *   row in another table, and a receipt that cannot be seen in the ledger as a
 *   receipt is exactly what PI-4's goods receipt exists to avoid.
 */
export async function createLotAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const currency = emptyToNull(formData.get('currency'));
  const unitCostBase = majorToMinor(formData.get('unitCost'));

  const parsed = createBatchRequest.safeParse({
    branchId: formData.get('branchId'),
    productId: formData.get('productId'),
    lotNumber: formData.get('lotNumber'),
    manufacturedOn: emptyToNull(formData.get('manufacturedOn')),
    expiresOn: emptyToNull(formData.get('expiresOn')),
    retestOn: emptyToNull(formData.get('retestOn')),
    manufacturerId: emptyToNull(formData.get('manufacturerId')),
    /*
     * Both or neither — `batches_cost_has_currency` refuses a number with no
     * currency, because a number with no currency is one that will eventually be
     * added to a different one.
     *
     * ⚠️ `NaN` IS PASSED THROUGH RATHER THAN PAIRED AWAY, so a mistyped cost
     *   reaches Zod and comes back as a field error. Only a genuinely BLANK cost
     *   clears the currency with it.
     */
    unitCostBase: unitCostBase === null ? null : currency === null ? Number.NaN : unitCostBase,
    currency: unitCostBase === null ? null : currency,
    notes: emptyToNull(formData.get('notes')),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<BatchDetail>('/api/v1/batches', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/stock/lots`);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved', createdId: result.data?.id };
}

// ---------------------------------------------------------------------------
// Serials
// ---------------------------------------------------------------------------

export async function createSerialAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const parsed = createSerialRequest.safeParse({
    branchId: formData.get('branchId'),
    productId: formData.get('productId'),
    batchId: emptyToNull(formData.get('batchId')),
    serialNumber: formData.get('serialNumber'),
    currentLocationId: emptyToNull(formData.get('currentLocationId')),
    expiresOn: emptyToNull(formData.get('expiresOn')),
    notes: emptyToNull(formData.get('notes')),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<SerialDetail>('/api/v1/serials', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/stock/serials`);
  return { status: 'saved', createdId: result.data?.id };
}
