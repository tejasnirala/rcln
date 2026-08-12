'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelStockTransferRequest,
  createBatchRequest,
  createInventoryLocationRequest,
  createSerialRequest,
  createStockReservationRequest,
  createStockTransferRequest,
  receiveStockTransferRequest,
  recordMovementRequest,
  updateInventoryLocationRequest,
  type BatchDetail,
  type InventoryLocationDetail,
  type RecordMovementResponse,
  type SerialDetail,
  type StockReservationSummary,
  type StockTransferDetail,
  type StockTransferLineRequest,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of `/stock`.
 *
 * ⚠️ WHAT IS STILL DELIBERATELY ABSENT AFTER PI-3: THE RECALL WORKFLOW (PI-10)
 *   AND ASSIGNING A SERIAL TO A PATIENT (PI-9). `POST /batches/:id/hold` and
 *   `POST /serials/:id/assign` both work and both are exercised by tests; the
 *   moment a device is fitted is a clinical one and belongs beside the procedure
 *   that fitted it, not on a stock screen.
 *
 *   Adjustments, transfers and reservations landed here in PI-3 and are below.
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

// ---------------------------------------------------------------------------
// Adjustments (PI-3.1)
// ---------------------------------------------------------------------------

/**
 * Correct a count, with a reason.
 *
 * ⚠️ THE FORM SENDS A DIRECTION AND A POSITIVE QUANTITY, NEVER A SIGNED NUMBER.
 *   `adjustmentDirection` is an explicit field for exactly the reason the ledger
 *   has a direction CHECK: a form that could post `-5` is a form one keystroke
 *   away from posting it on a receipt, and the resulting row is
 *   indistinguishable from a genuine issue in every report.
 *
 * ⚠️ AND THE REASON CODE IS A `<select>` OF SERVER-SIDE CODES, NOT FREE TEXT.
 *   `BROKEN`, `BREAKAGE` and `BROKE` are three categories describing one event,
 *   and the report that aggregates them is the one a clinic uses to decide
 *   whether it has a theft problem. The API refuses a code it does not know.
 */
export async function recordAdjustmentAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const parsed = recordMovementRequest.safeParse({
    branchId: formData.get('branchId'),
    productId: formData.get('productId'),
    batchId: emptyToNull(formData.get('batchId')),
    serialId: emptyToNull(formData.get('serialId')),
    movementType: formData.get('movementType'),
    adjustmentDirection: emptyToNull(formData.get('adjustmentDirection')),
    quantity: formData.get('quantity'),
    unitId: emptyToNull(formData.get('unitId')),
    locationId: formData.get('locationId'),
    statusFrom: emptyToNull(formData.get('statusFrom')),
    statusTo: emptyToNull(formData.get('statusTo')),
    reasonCode: emptyToNull(formData.get('reasonCode')),
    reasonNote: emptyToNull(formData.get('reasonNote')),
    referenceType: 'MANUAL',
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<RecordMovementResponse>('/api/v1/stock/movements', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  /*
   * Three paths, because a movement changes what all three of them show: the
   * ledger gained a row, the overview's shelves changed, and the lot's remaining
   * quantity is the sum of the balances that just moved.
   */
  revalidatePath(`/t/${slug}/stock/ledger`);
  revalidatePath(`/t/${slug}/stock/lots`);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved', createdId: result.data?.movementId };
}

// ---------------------------------------------------------------------------
// Transfers (PI-3.2, PI-3.3)
// ---------------------------------------------------------------------------

/**
 * Read the repeated line fields off the form.
 *
 * ⚠️ INDEXED NAMES (`lines.0.productId`) RATHER THAN REPEATED ONES, because
 *   `FormData.getAll('productId')` loses which quantity belongs to which product
 *   the moment a row is removed in the middle. The index is what keeps the
 *   columns of one row together, and a gap in the sequence — row 1 deleted — is
 *   skipped rather than ending the loop.
 */
function transferLinesFrom(formData: FormData): StockTransferLineRequest[] {
  const lines: StockTransferLineRequest[] = [];

  for (const [key] of formData.entries()) {
    const match = /^lines\.(\d+)\.productId$/.exec(key);
    if (!match) continue;
    const index = match[1];

    const productId = emptyToNull(formData.get(`lines.${index}.productId`));
    if (productId === null) continue;

    lines.push({
      productId,
      batchId: emptyToNull(formData.get(`lines.${index}.batchId`)),
      serialId: emptyToNull(formData.get(`lines.${index}.serialId`)),
      quantity: String(formData.get(`lines.${index}.quantity`) ?? ''),
      unitId: null,
      packagingLevel: null,
      notes: emptyToNull(formData.get(`lines.${index}.notes`)),
    });
  }

  return lines;
}

export async function createTransferAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const parsed = createStockTransferRequest.safeParse({
    fromBranchId: formData.get('fromBranchId'),
    toBranchId: formData.get('toBranchId'),
    fromLocationId: formData.get('fromLocationId'),
    toLocationId: emptyToNull(formData.get('toLocationId')),
    notes: emptyToNull(formData.get('notes')),
    lines: transferLinesFrom(formData),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<StockTransferDetail>('/api/v1/stock-transfers', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/stock/transfers`);
  return { status: 'saved', createdId: result.data?.id };
}

/**
 * Send it.
 *
 * ⚠️ NO BODY, AND THE CONFIRMATION IS THE SCREEN'S JOB RATHER THAN A FIELD. This
 *   writes a `TRANSFER_OUT` for every line and the sending branch's shelves are
 *   lighter the moment it returns. The button says "Send" and the page says what
 *   sending does; a "confirm: yes" checkbox on the request would move the
 *   decision into a place the user has already stopped reading.
 */
export async function dispatchTransferAction(
  slug: string,
  transferId: string,
  _prev: StockFormState
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const result = await api<StockTransferDetail>(`/api/v1/stock-transfers/${transferId}/dispatch`, {
    method: 'POST',
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/stock/transfers`);
    revalidatePath(`/t/${slug}/stock/transfers/${transferId}`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}

/**
 * Sign for what arrived.
 *
 * ⚠️ A QUANTITY PER LINE, AND A BLANK LINE RECEIVES NOTHING OF IT. There is no
 *   "receive everything" button, on purpose: receiving a delivery is the moment
 *   somebody counts, and a single button for "yes, all of it" is a screen where
 *   nobody counts. A line left blank stays outstanding and the transfer stays in
 *   the receiving branch's inbox, which is exactly what should happen when a box
 *   is missing.
 */
export async function receiveTransferAction(
  slug: string,
  transferId: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const lines: { lineId: string; quantityBase: string }[] = [];
  for (const [key, value] of formData.entries()) {
    const match = /^receive\.(.+)$/.exec(key);
    if (!match || typeof value !== 'string') continue;
    // Destructured rather than indexed: `match[1] as string` silences
    // `noUncheckedIndexedAccess` with an assertion, which is the same class of
    // thing as `!` and is what this codebase refuses.
    const [, lineId] = match;
    if (!lineId) continue;

    const quantity = value.trim();
    /*
     * Blank and zero both mean "none of this line arrived". Neither is an error,
     * and neither may be sent — `positiveQuantity` refuses both.
     *
     * ⚠️ A STRING TEST, NOT `Number(quantity) <= 0`. It is only deciding whether
     *   to send the line — the untouched string goes on the wire either way — so
     *   a float would lose nothing today. It is still a float on a quantity a
     *   person counts, which is the habit this codebase does not have anywhere
     *   else, and the exact test is one regex: unsigned digits with an optional
     *   point, containing at least one digit that is not zero. `0`, `0.00` and
     *   `-5` all fall through to `continue`; the contract refuses the last one
     *   anyway if it ever reached it.
     *
     *   `compareQuantities` in `@rcln/inventory` is the canonical comparison and
     *   is deliberately NOT imported: it would pull the ledger engine and its
     *   `@rcln/db` module graph into the browser bundle to answer one question
     *   about one string.
     */
    if (!/^\d*\.?\d*$/.test(quantity) || !/[1-9]/.test(quantity)) continue;
    lines.push({ lineId, quantityBase: quantity });
  }

  if (lines.length === 0) {
    return {
      status: 'error',
      message: 'Enter how much of at least one line arrived.',
    };
  }

  const parsed = receiveStockTransferRequest.safeParse({
    toLocationId: formData.get('toLocationId'),
    lines,
    notes: emptyToNull(formData.get('notes')),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<StockTransferDetail>(`/api/v1/stock-transfers/${transferId}/receive`, {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/stock/transfers`);
    revalidatePath(`/t/${slug}/stock/transfers/${transferId}`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}

export async function cancelTransferAction(
  slug: string,
  transferId: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const parsed = cancelStockTransferRequest.safeParse({ reason: formData.get('reason') });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say why this transfer is being cancelled.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<StockTransferDetail>(`/api/v1/stock-transfers/${transferId}/cancel`, {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/stock/transfers`);
    revalidatePath(`/t/${slug}/stock/transfers/${transferId}`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Reservations (PI-3.4)
// ---------------------------------------------------------------------------

export async function reserveStockAction(
  slug: string,
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  /*
   * ⚠️ THE `datetime-local` VALUE CARRIES NO ZONE, SO IT IS CONVERTED HERE AND
   *   ONLY HERE. The browser gives `2026-08-20T14:30`, which is a wall clock in
   *   the USER's zone with nothing saying which — `new Date(...)` interprets it
   *   as local time, and `.toISOString()` is what turns it into the instant the
   *   contract requires. Sending the raw string would fail `z.iso.datetime()`,
   *   which is the good outcome; the bad one is a later reader assuming it is
   *   already UTC.
   *
   *   This is not the same rule as invariant 6, which is about DISPLAY. A
   *   reservation expires at an instant somebody picked on their own clock.
   */
  const typed = emptyToNull(formData.get('expiresAt'));
  const expiresAt = typed === null ? null : new Date(typed);

  const parsed = createStockReservationRequest.safeParse({
    branchId: formData.get('branchId'),
    productId: formData.get('productId'),
    batchId: emptyToNull(formData.get('batchId')),
    serialId: emptyToNull(formData.get('serialId')),
    locationId: formData.get('locationId'),
    quantity: formData.get('quantity'),
    unitId: null,
    packagingLevel: null,
    expiresAt:
      expiresAt === null || Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt.toISOString(),
    referenceType: 'MANUAL',
    referenceId: null,
    notes: emptyToNull(formData.get('notes')),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const result = await api<StockReservationSummary>('/api/v1/stock/reservations', {
    method: 'POST',
    body: parsed.data,
    slug,
    accessToken,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/stock/reservations`);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved', createdId: result.data?.id };
}

export async function releaseReservationAction(
  slug: string,
  reservationId: string,
  _prev: StockFormState
): Promise<StockFormState> {
  const accessToken = await getAccessToken();

  const result = await api<StockReservationSummary>(
    `/api/v1/stock/reservations/${reservationId}/release`,
    { method: 'POST', body: {}, slug, accessToken }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/stock/reservations`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}
