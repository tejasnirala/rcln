'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelOnlineOrderRequest,
  confirmOnlineOrderRequest,
  createOnlineOrderRequest,
  deliverOnlineOrderRequest,
  failOnlineOrderDeliveryRequest,
  packOnlineOrderRequest,
  shipOnlineOrderRequest,
  type OnlineOrderDetail,
  type OnlineOrderLineRequest,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import type { PharmacyFormState } from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/*
 * The write side of the delivery book (PI-12).
 *
 * ⚠️ NOTHING HERE DECIDES WHETHER A REMOTE SUPPLY IS LAWFUL, OR EVEN WHETHER THE
 *   CLINIC HAS CLEARED THE PRODUCT FOR ONE. Both are settled on the server, in
 *   the transaction that holds the stock, and a refusal comes back as a 422
 *   carrying the sentence to read to the patient. An action that pre-checked
 *   either would be a second opinion free to drift from the one that counts.
 *
 * ⚠️ AND THE ADDRESS NEVER PERSISTS ANYWHERE ON THE CLIENT. It is posted, it is
 *   rendered, and it goes nowhere else — no `localStorage`, no cookie, no query
 *   string. It is the most sensitive field on this surface: a home address
 *   beside a medicine.
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as everywhere else. It selects a Host
 *   header and a `revalidatePath` prefix and nothing else.
 */

/*
 * ⚠️ NOTHING IS RE-EXPORTED FROM HERE, AND THAT IS THE RULE THIS FILE'S OWN
 *   COMMENT STATES TWO LINES DOWN. In a `'use server'` module every export
 *   becomes a callable server ACTION; a const and a type are neither. Seven
 *   sibling `actions.ts` files DECLARE an `IDLE_FORM` this way and the app runs,
 *   so it is precedent — but this was the only RE-EXPORT of an imported binding,
 *   which is the shape most likely to break first if the transform tightens, and
 *   it bought nothing. The components import both from `../actions` directly
 *   (PI-12 review).
 */

/**
 * The same 422-lifting `pharmacy/actions.ts` does.
 *
 * ⚠️ A SECOND COPY RATHER THAN AN IMPORT, BECAUSE `toFormState` IS NOT EXPORTED
 *   FROM A `'use server'` FILE — every export of one becomes a callable server
 *   ACTION, and a helper that is not an action must not become an endpoint. The
 *   duplication is four lines and the alternative is a third file; if a third
 *   caller appears, that file is the right answer.
 */
function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): PharmacyFormState {
  if (result.ok) return { status: 'saved' };

  const ruleMessages = result.fieldErrors?.messages;
  const fieldErrors = result.fieldErrors
    ? Object.fromEntries(
        Object.entries(result.fieldErrors).filter(
          ([key]) => key !== 'messages' && key !== 'ruleCodes' && key !== 'outcome'
        )
      )
    : undefined;

  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    ...(ruleMessages && ruleMessages.length > 0 ? { ruleMessages } : {}),
  };
}

function revalidateOrder(slug: string, orderId?: string): void {
  revalidatePath(`/t/${slug}/pharmacy/orders`);
  if (orderId) revalidatePath(`/t/${slug}/pharmacy/orders/${orderId}`);
}

function linesFrom(form: FormData): OnlineOrderLineRequest[] {
  const raw = form.get('lines');
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    return JSON.parse(raw) as OnlineOrderLineRequest[];
  } catch {
    return [];
  }
}

/** The address block, read off the form in one place so the two writers agree. */
function addressFrom(form: FormData): Record<string, unknown> {
  return {
    recipientName: emptyToNull(form.get('recipientName')) ?? '',
    recipientPhone: emptyToNull(form.get('recipientPhone')) ?? '',
    addressLine1: emptyToNull(form.get('addressLine1')) ?? '',
    addressLine2: emptyToNull(form.get('addressLine2')),
    city: emptyToNull(form.get('city')),
    state: emptyToNull(form.get('state')),
    pincode: emptyToNull(form.get('pincode')),
    destinationCountryCode: emptyToNull(form.get('destinationCountryCode')) ?? '',
    destinationRegionCode: emptyToNull(form.get('destinationRegionCode')),
    patientAddressId: emptyToNull(form.get('patientAddressId')),
  };
}

// ---------------------------------------------------------------------------
// Taking the order
// ---------------------------------------------------------------------------

export async function createOnlineOrderAction(
  slug: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = createOnlineOrderRequest.safeParse({
    branchId: emptyToNull(form.get('branchId')),
    locationId: emptyToNull(form.get('locationId')),
    channel: emptyToNull(form.get('channel')) ?? 'PHONE',
    patientId: emptyToNull(form.get('patientId')),
    encounterId: emptyToNull(form.get('encounterId')),
    address: addressFrom(form),
    notes: emptyToNull(form.get('notes')),
    lines: linesFrom(form),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the order before saving it.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>('/api/v1/online-orders', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, result.data?.id);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

/**
 * Accept it, and hold the stock.
 *
 * ⚠️ THE ONE ACTION ON THIS SURFACE THAT TAKES STOCK OUT OF `AVAILABLE`. A 422
 *   here is usually the remote-supply gate: nobody has recorded whether the
 *   product may be sent out in this jurisdiction, and the message says which
 *   product and where to fix it.
 */
export async function confirmOnlineOrderAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = confirmOnlineOrderRequest.safeParse({
    holdForDays: emptyToNull(form.get('holdForDays')) ?? undefined,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check how long the stock should be held.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/confirm`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved' };
}

export async function cancelOnlineOrderAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = cancelOnlineOrderRequest.safeParse({
    reason: emptyToNull(form.get('reason')) ?? '',
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say why the order is being stood down.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/cancel`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  revalidatePath(`/t/${slug}/stock`);
  return { status: 'saved' };
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

/**
 * Make the parcel up.
 *
 * ⚠️ THIS IS THE SUPPLY. It writes the dispense, moves the ledger and raises the
 *   charge request, and it is gated on `pharmacy.dispense.create` — which is why
 *   the screen reads `canDispense` for the button rather than an online flag.
 */
export async function packOnlineOrderAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = packOnlineOrderRequest.safeParse({
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'That could not be packed.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/pack`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  revalidatePath(`/t/${slug}/pharmacy/dispenses`);
  revalidatePath(`/t/${slug}/charges`);
  return { status: 'saved' };
}

export async function shipOnlineOrderAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = shipOnlineOrderRequest.safeParse({
    carrierName: emptyToNull(form.get('carrierName')) ?? '',
    serviceLevel: emptyToNull(form.get('serviceLevel')),
    trackingReference: emptyToNull(form.get('trackingReference')),
    packageCount: emptyToNull(form.get('packageCount')) ?? undefined,
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the courier details.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/ship`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  return { status: 'saved' };
}

export async function deliverOnlineOrderAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = deliverOnlineOrderRequest.safeParse({
    receivedByName: emptyToNull(form.get('receivedByName')),
    notes: emptyToNull(form.get('notes')),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check who took the parcel.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/deliver`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  return { status: 'saved' };
}

export async function failOnlineOrderDeliveryAction(
  slug: string,
  orderId: string,
  _previous: PharmacyFormState,
  form: FormData
): Promise<PharmacyFormState> {
  const parsed = failOnlineOrderDeliveryRequest.safeParse({
    reason: emptyToNull(form.get('reason')) ?? '',
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Say what happened to the parcel.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<OnlineOrderDetail>(`/api/v1/online-orders/${orderId}/delivery-failed`, {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidateOrder(slug, orderId);
  return { status: 'saved' };
}
