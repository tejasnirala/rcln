'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelGoodsReceiptRequest,
  cancelPurchaseOrderRequest,
  cancelPurchaseReturnRequest,
  closePurchaseOrderRequest,
  createGoodsReceiptRequest,
  createPurchaseOrderRequest,
  createPurchaseRequisitionRequest,
  createPurchaseReturnRequest,
  createSupplierProductRequest,
  createSupplierRequest,
  createSupplierTaxIdentifierRequest,
  decideGoodsReceiptQualityRequest,
  stockStatus,
  rejectPurchaseRequisitionRequest,
  updateSupplierRequest,
  type GoodsReceiptDetail,
  type GoodsReceiptLineRequest,
  type PurchaseOrderDetail,
  type PurchaseOrderLineRequest,
  type PurchaseRequisitionDetail,
  type PurchaseRequisitionLineRequest,
  type PurchaseReturnDetail,
  type SupplierDetail,
  type SupplierProductSummary,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of `/procurement`.
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as in `stock/actions.ts`. It selects a
 *   Host header and a `revalidatePath` prefix and nothing else. What stops a
 *   forged one is a layer down: the API compares the tenant resolved from the Host
 *   header against the organization in the bearer token and returns 404 — never
 *   403 — when they disagree, and RLS is keyed on the token's org. No action here
 *   may branch on `slug`.
 *
 * ⚠️ THE BRANCH IS NOT TRUSTED FROM THE FORM. Every service asserts the branch is
 *   in `ctx.branchIds` and throws NOT FOUND when it is not, so a posted branch id
 *   the caller has no scope for gets nothing back. The `<select>` is a
 *   convenience, never the control.
 *
 * ⚠️ AND NOTHING HERE DECIDES WHETHER SOMEBODY MAY APPROVE A REQUISITION. The
 *   `canApprove` flag on the response is presentation — it hides a button that
 *   would 400 — and the decision is made three times on the server: the permission
 *   code, the service's own check against `created_by_id`, and a CHECK constraint.
 *   A form action that "checked" it would be a fourth copy that can drift.
 *
 * NO PHI. Nothing on this surface names a patient.
 */

export type ProcurementFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful create, so the form can navigate to what it made. */
  createdId?: string;
};

export const IDLE_FORM: ProcurementFormState = { status: 'idle' };

function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): ProcurementFormState {
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
 * ⚠️ THE SAME ONE-MULTIPLICATION ARGUMENT `stock/actions.ts` MAKES, AND IT STILL
 *   HOLDS HERE: this is one multiplication of a two-decimal string a human typed
 *   into a box, and `12.50` is exactly representable as a double while `1250` is
 *   exact as an integer. Quantities go through `@rcln/inventory`'s exact rationals
 *   because they compound through packaging hierarchies; a price typed into a form
 *   does not compound, and the server re-derives every per-unit figure from it
 *   with `unitCostFromPack`.
 *
 * ⚠️ `NaN` FOR A TYPO RATHER THAN `null`, so the caller is told which box is
 *   wrong. Returning null made a bad number indistinguishable from a blank one and
 *   the document saved with no price and no field error.
 */
function majorToMinor(value: FormDataEntryValue | null): number | null {
  const text = emptyToNull(value);
  if (text === null) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
  return Math.round(amount * 100);
}

/**
 * Repeated line fields out of one `FormData`.
 *
 * ⚠️ INDEXED NAMES (`lines.0.productId`) RATHER THAN `getAll`, AND THE DIFFERENCE
 *   MATTERS ON A GRN. `getAll('productId')` returns a flat list per field, so two
 *   lines whose optional fields differ — one with a lot number, one without —
 *   silently shift out of alignment and the second line inherits the first's
 *   expiry. Indexing keeps a line's fields together, which is the only way a
 *   scanner-driven form with a variable number of rows can be correct.
 */
function lineIndices(form: FormData, marker: string): number[] {
  const indices = new Set<number>();
  for (const key of form.keys()) {
    const match = /^lines\.(\d+)\./.exec(key);
    if (match?.[1] !== undefined && form.get(`lines.${match[1]}.${marker}`) !== null) {
      indices.add(Number(match[1]));
    }
  }
  return [...indices].sort((a, b) => a - b);
}

function quantityBasis(
  form: FormData,
  index: number
): { unitId?: string | null; packagingLevel?: number | null } {
  const unitId = emptyToNull(form.get(`lines.${index}.unitId`));
  const level = emptyToNull(form.get(`lines.${index}.packagingLevel`));
  // Either a unit or a packaging level, never both — the contract refines on it,
  // and sending both would be a quantity with two answers.
  if (level !== null) return { packagingLevel: Number(level) };
  return { unitId };
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * Every supplier field EXCEPT the code.
 *
 * ⚠️ THE CODE IS ADDED BY THE CREATE PATH AND NOWHERE ELSE, WHICH IS WHY IT IS NOT
 *   IN HERE. It is not editable — orders, deliveries and returns are reconciled by
 *   it — so the update path must not send one. Building it in and stripping it back
 *   out would leave the two paths one careless spread apart from each other.
 */
function supplierPayload(form: FormData): Record<string, unknown> {
  return {
    name: emptyToNull(form.get('name')) ?? '',
    legalName: emptyToNull(form.get('legalName')),
    status: emptyToNull(form.get('status')) ?? 'ACTIVE',
    contactPerson: emptyToNull(form.get('contactPerson')),
    email: emptyToNull(form.get('email')),
    phone: emptyToNull(form.get('phone')),
    website: emptyToNull(form.get('website')),
    addressLine1: emptyToNull(form.get('addressLine1')),
    addressLine2: emptyToNull(form.get('addressLine2')),
    city: emptyToNull(form.get('city')),
    regionCode: emptyToNull(form.get('regionCode')),
    postalCode: emptyToNull(form.get('postalCode')),
    countryCode: emptyToNull(form.get('countryCode')),
    defaultCurrency: emptyToNull(form.get('defaultCurrency')),
    paymentTermsDays: numberOrNull(form.get('paymentTermsDays')),
    leadTimeDays: numberOrNull(form.get('leadTimeDays')),
    notes: emptyToNull(form.get('notes')),
  };
}

/** A whole-number field. `NaN` for a typo, for the reason `majorToMinor` gives. */
function numberOrNull(value: FormDataEntryValue | null): number | null {
  const text = emptyToNull(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export async function createSupplierAction(
  slug: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const parsed = createSupplierRequest.safeParse({
    ...supplierPayload(form),
    code: (emptyToNull(form.get('code')) ?? '').toUpperCase(),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<SupplierDetail>('/api/v1/procurement/suppliers', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/procurement/suppliers`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

export async function updateSupplierAction(
  slug: string,
  supplierId: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  // No `code`: `supplierPayload` deliberately does not build one. See that function.
  const parsed = updateSupplierRequest.safeParse(supplierPayload(form));
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<SupplierDetail>(`/api/v1/procurement/suppliers/${supplierId}`, {
    method: 'PATCH',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/suppliers`);
    revalidatePath(`/t/${slug}/procurement/suppliers/${supplierId}`);
  }
  return toFormState(result);
}

export async function addTaxIdentifierAction(
  slug: string,
  supplierId: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const parsed = createSupplierTaxIdentifierRequest.safeParse({
    countryCode: emptyToNull(form.get('countryCode')) ?? '',
    regionCode: emptyToNull(form.get('regionCode')),
    scheme: emptyToNull(form.get('scheme')) ?? 'GST',
    registrationNumber: emptyToNull(form.get('registrationNumber')) ?? '',
    legalName: emptyToNull(form.get('legalName')),
    effectiveFrom: emptyToNull(form.get('effectiveFrom')) ?? '',
    effectiveTo: emptyToNull(form.get('effectiveTo')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<SupplierDetail>(
    `/api/v1/procurement/suppliers/${supplierId}/tax-identifiers`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );

  if (result.ok) revalidatePath(`/t/${slug}/procurement/suppliers/${supplierId}`);
  return toFormState(result);
}

export async function removeTaxIdentifierAction(
  slug: string,
  supplierId: string,
  identifierId: string
): Promise<ProcurementFormState> {
  const accessToken = await getAccessToken();
  const result = await api<SupplierDetail>(
    `/api/v1/procurement/suppliers/${supplierId}/tax-identifiers/${identifierId}`,
    { method: 'DELETE', slug, accessToken }
  );

  if (result.ok) revalidatePath(`/t/${slug}/procurement/suppliers/${supplierId}`);
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// The price book
// ---------------------------------------------------------------------------

export async function addSupplierProductAction(
  slug: string,
  supplierId: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const parsed = createSupplierProductRequest.safeParse({
    productId: emptyToNull(form.get('productId')) ?? '',
    supplierSku: emptyToNull(form.get('supplierSku')) ?? '',
    supplierProductName: emptyToNull(form.get('supplierProductName')),
    packUnitId: emptyToNull(form.get('packUnitId')) ?? '',
    quantityPerPack: emptyToNull(form.get('quantityPerPack')) ?? '',
    pricePerPackMinor: majorToMinor(form.get('pricePerPack')) ?? Number.NaN,
    currency: emptyToNull(form.get('currency')) ?? '',
    priceEffectiveFrom: emptyToNull(form.get('priceEffectiveFrom')) ?? '',
    priceEffectiveTo: emptyToNull(form.get('priceEffectiveTo')),
    leadTimeDays: numberOrNull(form.get('leadTimeDays')),
    minimumOrderPacks: emptyToNull(form.get('minimumOrderPacks')),
    isPreferred: form.get('isPreferred') === 'on',
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<SupplierProductSummary>(
    `/api/v1/procurement/suppliers/${supplierId}/products`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/suppliers/${supplierId}`);
    revalidatePath(`/t/${slug}/procurement/price-book`);
  }
  return toFormState(result);
}

export async function removeSupplierProductAction(
  slug: string,
  supplierProductId: string,
  supplierId: string
): Promise<ProcurementFormState> {
  const accessToken = await getAccessToken();
  const result = await api<null>(`/api/v1/procurement/supplier-products/${supplierProductId}`, {
    method: 'DELETE',
    slug,
    accessToken,
  });

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/suppliers/${supplierId}`);
    revalidatePath(`/t/${slug}/procurement/price-book`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export async function createRequisitionAction(
  slug: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const lines: PurchaseRequisitionLineRequest[] = lineIndices(form, 'productId').map((index) => ({
    productId: emptyToNull(form.get(`lines.${index}.productId`)) ?? '',
    quantity: emptyToNull(form.get(`lines.${index}.quantity`)) ?? '',
    ...quantityBasis(form, index),
    suggestedSupplierId: emptyToNull(form.get(`lines.${index}.suggestedSupplierId`)),
    notes: emptyToNull(form.get(`lines.${index}.notes`)),
  }));

  const parsed = createPurchaseRequisitionRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? '',
    requiredBy: emptyToNull(form.get('requiredBy')),
    notes: emptyToNull(form.get('notes')),
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseRequisitionDetail>('/api/v1/procurement/requisitions', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/procurement/requisitions`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * The four transitions, as one action taking the verb.
 *
 * ⚠️ ONE ACTION AND NOT FOUR, BECAUSE THE ONLY DIFFERENCE IS THE PATH SEGMENT AND
 *   FOUR COPIES IS HOW ONE OF THEM ENDS UP NOT REVALIDATING. The server decides
 *   whether the transition is allowed — approve and reject sit behind a different
 *   permission code from submit and cancel, and neither can be self-approved.
 */
export async function requisitionTransitionAction(
  slug: string,
  requisitionId: string,
  verb: 'submit' | 'approve' | 'reject' | 'cancel',
  form?: FormData
): Promise<ProcurementFormState> {
  let body: unknown;
  if (verb === 'reject') {
    const parsed = rejectPurchaseRequisitionRequest.safeParse({
      reason: emptyToNull(form?.get('reason') ?? null) ?? '',
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Say why it is being rejected.',
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      };
    }
    body = parsed.data;
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseRequisitionDetail>(
    `/api/v1/procurement/requisitions/${requisitionId}/${verb}`,
    { method: 'POST', slug, accessToken, ...(body !== undefined ? { body } : {}) }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/requisitions`);
    revalidatePath(`/t/${slug}/procurement/requisitions/${requisitionId}`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function createPurchaseOrderAction(
  slug: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const lines: PurchaseOrderLineRequest[] = lineIndices(form, 'productId').map((index) => ({
    productId: emptyToNull(form.get(`lines.${index}.productId`)) ?? '',
    supplierProductId: emptyToNull(form.get(`lines.${index}.supplierProductId`)),
    quantity: emptyToNull(form.get(`lines.${index}.quantity`)) ?? '',
    ...quantityBasis(form, index),
    pricePerPackMinor: majorToMinor(form.get(`lines.${index}.pricePerPack`)),
    packQuantityBase: emptyToNull(form.get(`lines.${index}.packQuantityBase`)),
    unitCostBase: majorToMinor(form.get(`lines.${index}.unitCost`)),
    taxRateBps: numberOrNull(form.get(`lines.${index}.taxRateBps`)),
    taxAmountMinor: majorToMinor(form.get(`lines.${index}.taxAmount`)),
    notes: emptyToNull(form.get(`lines.${index}.notes`)),
  }));

  const parsed = createPurchaseOrderRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? '',
    supplierId: emptyToNull(form.get('supplierId')) ?? '',
    requisitionId: emptyToNull(form.get('requisitionId')),
    currency: emptyToNull(form.get('currency')),
    expectedDate: emptyToNull(form.get('expectedDate')),
    deliverToLocationId: emptyToNull(form.get('deliverToLocationId')),
    terms: emptyToNull(form.get('terms')),
    notes: emptyToNull(form.get('notes')),
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseOrderDetail>('/api/v1/procurement/purchase-orders', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/procurement/purchase-orders`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

export async function purchaseOrderTransitionAction(
  slug: string,
  purchaseOrderId: string,
  verb: 'issue' | 'close' | 'cancel',
  form?: FormData
): Promise<ProcurementFormState> {
  let body: unknown;
  if (verb === 'close' || verb === 'cancel') {
    const schema = verb === 'close' ? closePurchaseOrderRequest : cancelPurchaseOrderRequest;
    const parsed = schema.safeParse({ reason: emptyToNull(form?.get('reason') ?? null) ?? '' });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          verb === 'close'
            ? 'Say why nothing more is expected on this order.'
            : 'Say why the order is being cancelled.',
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      };
    }
    body = parsed.data;
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseOrderDetail>(
    `/api/v1/procurement/purchase-orders/${purchaseOrderId}/${verb}`,
    { method: 'POST', slug, accessToken, ...(body !== undefined ? { body } : {}) }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/purchase-orders`);
    revalidatePath(`/t/${slug}/procurement/purchase-orders/${purchaseOrderId}`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export async function createGoodsReceiptAction(
  slug: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const lines: GoodsReceiptLineRequest[] = lineIndices(form, 'productId').map((index) => ({
    productId: emptyToNull(form.get(`lines.${index}.productId`)) ?? '',
    purchaseOrderLineId: emptyToNull(form.get(`lines.${index}.purchaseOrderLineId`)),
    quantity: emptyToNull(form.get(`lines.${index}.quantity`)) ?? '',
    ...quantityBasis(form, index),
    lotNumber: emptyToNull(form.get(`lines.${index}.lotNumber`)),
    manufacturedOn: emptyToNull(form.get(`lines.${index}.manufacturedOn`)),
    expiresOn: emptyToNull(form.get(`lines.${index}.expiresOn`)),
    retestOn: emptyToNull(form.get(`lines.${index}.retestOn`)),
    manufacturerId: emptyToNull(form.get(`lines.${index}.manufacturerId`)),
    serialNumber: emptyToNull(form.get(`lines.${index}.serialNumber`)),
    pricePerPackMinor: majorToMinor(form.get(`lines.${index}.pricePerPack`)),
    packQuantityBase: emptyToNull(form.get(`lines.${index}.packQuantityBase`)),
    unitCostBase: majorToMinor(form.get(`lines.${index}.unitCost`)),
    taxRateBps: numberOrNull(form.get(`lines.${index}.taxRateBps`)),
    taxAmountMinor: majorToMinor(form.get(`lines.${index}.taxAmount`)),
    notes: emptyToNull(form.get(`lines.${index}.notes`)),
  }));

  const parsed = createGoodsReceiptRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? '',
    supplierId: emptyToNull(form.get('supplierId')) ?? '',
    purchaseOrderId: emptyToNull(form.get('purchaseOrderId')),
    locationId: emptyToNull(form.get('locationId')) ?? '',
    /*
     * ⚠️ A DATE BOX BECOMES AN INSTANT AT UTC MIDNIGHT, AND THE SERVER TREATS IT AS
     *   WHEN THE GOODS ARRIVED. A receipt keyed in on Monday for a Friday delivery
     *   says Friday, and every ledger leg carries it as `occurredAt`. Left blank it
     *   defaults to now, which is the ordinary case of somebody standing at the bay.
     */
    receivedAt: dateToInstant(form.get('receivedAt')),
    currency: emptyToNull(form.get('currency')),
    supplierInvoiceNumber: emptyToNull(form.get('supplierInvoiceNumber')),
    supplierInvoiceDate: emptyToNull(form.get('supplierInvoiceDate')),
    freightMinor: majorToMinor(form.get('freight')) ?? 0,
    dutyMinor: majorToMinor(form.get('duty')) ?? 0,
    handlingMinor: majorToMinor(form.get('handling')) ?? 0,
    notes: emptyToNull(form.get('notes')),
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<GoodsReceiptDetail>('/api/v1/procurement/goods-receipts', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/procurement/goods-receipts`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * `YYYY-MM-DD` from a date input as the ISO instant the contract wants.
 *
 * ⚠️ UTC MIDNIGHT, EXPLICITLY, AND NOT `new Date(text).toISOString()` ON ITS OWN.
 *   A bare `new Date('2026-08-14')` is already UTC midnight, and the suffix is here
 *   so nobody "fixes" it into `new Date(y, m, d)` — which is LOCAL midnight and
 *   lands on the previous day for every server west of Greenwich, silently
 *   back-dating a delivery by a day.
 */
function dateToInstant(value: FormDataEntryValue | null): string | null {
  const text = emptyToNull(value);
  return text === null ? null : new Date(`${text}T00:00:00.000Z`).toISOString();
}

export async function goodsReceiptTransitionAction(
  slug: string,
  goodsReceiptId: string,
  verb: 'post' | 'cancel',
  form?: FormData
): Promise<ProcurementFormState> {
  let body: unknown;
  if (verb === 'cancel') {
    const parsed = cancelGoodsReceiptRequest.safeParse({
      reason: emptyToNull(form?.get('reason') ?? null) ?? '',
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Say why the delivery is being cancelled.',
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      };
    }
    body = parsed.data;
  }

  const accessToken = await getAccessToken();
  const result = await api<GoodsReceiptDetail>(
    `/api/v1/procurement/goods-receipts/${goodsReceiptId}/${verb}`,
    { method: 'POST', slug, accessToken, ...(body !== undefined ? { body } : {}) }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/goods-receipts`);
    revalidatePath(`/t/${slug}/procurement/goods-receipts/${goodsReceiptId}`);
    // Posting moves stock, so the stock screens are stale too.
    revalidatePath(`/t/${slug}/stock`);
    revalidatePath(`/t/${slug}/stock/lots`);
  }
  return toFormState(result);
}

/**
 * The inspection decision, line by line.
 *
 * ⚠️ ONLY THE LINES SOMEBODY ACTUALLY DECIDED ARE SENT. A form that posted every
 *   line with a default outcome would be the "pass all" button the contract
 *   deliberately refuses to offer: inspecting a delivery is the moment somebody
 *   looks at it, and a screen where the default is "fine" is a screen where nobody
 *   looks.
 */
export async function decideQualityAction(
  slug: string,
  goodsReceiptId: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  const lines = lineIndices(form, 'lineId')
    .map((index) => ({
      lineId: emptyToNull(form.get(`lines.${index}.lineId`)) ?? '',
      outcome: emptyToNull(form.get(`lines.${index}.outcome`)),
      rejectedQuantityBase: emptyToNull(form.get(`lines.${index}.rejectedQuantityBase`)),
      notes: emptyToNull(form.get(`lines.${index}.notes`)),
    }))
    .filter((line) => line.outcome !== null);

  if (lines.length === 0) {
    return {
      status: 'error',
      message: 'Mark at least one line as accepted or refused.',
    };
  }

  const parsed = decideGoodsReceiptQualityRequest.safeParse({ lines });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<GoodsReceiptDetail>(
    `/api/v1/procurement/goods-receipts/${goodsReceiptId}/quality`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/goods-receipts/${goodsReceiptId}`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}

// ---------------------------------------------------------------------------
// Purchase returns
// ---------------------------------------------------------------------------

export async function createPurchaseReturnAction(
  slug: string,
  _previous: ProcurementFormState,
  form: FormData
): Promise<ProcurementFormState> {
  /*
   * ⚠️ NOT ANNOTATED `PurchaseReturnLineRequest[]`, UNLIKE THE OTHER THREE. `statusFrom`
   *   is deliberately allowed to come out `undefined` — that is what "nobody chose"
   *   looks like — and the contract requires it, so the annotation would refuse the
   *   very case the `safeParse` below exists to report as a field error.
   */
  const lines = lineIndices(form, 'productId').map((index) => ({
    productId: emptyToNull(form.get(`lines.${index}.productId`)) ?? '',
    goodsReceiptLineId: emptyToNull(form.get(`lines.${index}.goodsReceiptLineId`)),
    batchId: emptyToNull(form.get(`lines.${index}.batchId`)),
    serialId: emptyToNull(form.get(`lines.${index}.serialId`)),
    quantity: emptyToNull(form.get(`lines.${index}.quantity`)) ?? '',
    ...quantityBasis(form, index),
    /*
     * ⚠️ NO DEFAULT, DELIBERATELY, AND THE SELECT HAS NO PRE-SELECTED OPTION EITHER.
     *   `PURCHASE_RETURN` is the second movement type with no default `statusFrom`:
     *   what is going back — sound stock, stock refused at inspection, stock damaged
     *   in the box — IS the content of the record. An empty string here fails the
     *   contract, which is the intended outcome of not choosing.
     */
    /*
     * ⚠️ CAST THROUGH THE CONTRACT'S OWN ENUM RATHER THAN ASSERTED. An empty string
     *   is not a member, which is exactly what must happen when nobody chose — the
     *   `safeParse` below turns it into a field error on this line. Parsing it here
     *   keeps the assertion out of the payload while still refusing the blank.
     */
    statusFrom: stockStatus.safeParse(emptyToNull(form.get(`lines.${index}.statusFrom`))).data,
    unitCostBase: majorToMinor(form.get(`lines.${index}.unitCost`)),
    notes: emptyToNull(form.get(`lines.${index}.notes`)),
  }));

  const parsed = createPurchaseReturnRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')) ?? '',
    supplierId: emptyToNull(form.get('supplierId')) ?? '',
    goodsReceiptId: emptyToNull(form.get('goodsReceiptId')),
    locationId: emptyToNull(form.get('locationId')) ?? '',
    currency: emptyToNull(form.get('currency')),
    reason: emptyToNull(form.get('reason')) ?? '',
    notes: emptyToNull(form.get('notes')),
    lines,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseReturnDetail>('/api/v1/procurement/returns', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });

  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/procurement/returns`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

export async function purchaseReturnTransitionAction(
  slug: string,
  purchaseReturnId: string,
  verb: 'send' | 'cancel',
  form?: FormData
): Promise<ProcurementFormState> {
  let body: unknown;
  if (verb === 'cancel') {
    const parsed = cancelPurchaseReturnRequest.safeParse({
      reason: emptyToNull(form?.get('reason') ?? null) ?? '',
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Say why the return is being cancelled.',
        fieldErrors: fieldErrorsFrom(parsed.error.issues),
      };
    }
    body = parsed.data;
  }

  const accessToken = await getAccessToken();
  const result = await api<PurchaseReturnDetail>(
    `/api/v1/procurement/returns/${purchaseReturnId}/${verb}`,
    { method: 'POST', slug, accessToken, ...(body !== undefined ? { body } : {}) }
  );

  if (result.ok) {
    revalidatePath(`/t/${slug}/procurement/returns`);
    revalidatePath(`/t/${slug}/procurement/returns/${purchaseReturnId}`);
    revalidatePath(`/t/${slug}/stock`);
  }
  return toFormState(result);
}
