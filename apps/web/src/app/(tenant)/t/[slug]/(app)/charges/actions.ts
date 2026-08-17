'use server';

import { revalidatePath } from 'next/cache';
import {
  createChargePolicyRuleRequest,
  createInvoiceFromChargesRequest,
  decideChargeRequest,
  upsertProductPriceRequest,
  type ChargePolicyRuleDetail,
  type ChargeRequestSummary,
  type InvoiceDetail,
  type ProductPriceDetail,
} from '@rcln/contracts';
import { api, emptyToNull, fieldErrorsFrom } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/*
 * The write side of charging (PI-8).
 *
 * ⚠️ `slug` IS CLIENT-CONTROLLED, exactly as everywhere else. It selects a Host
 *   header and a `revalidatePath` prefix and nothing else; the API compares the
 *   tenant resolved from that Host against the organization in the bearer token
 *   and returns 404 — never 403 — when they disagree. No action here may branch
 *   on it.
 *
 * ⚠️ NOTHING HERE DECIDES A POLICY OR A PRICE. Both are resolved on the server,
 *   inside the transaction that wrote the charge, and frozen on the row. An
 *   action that recomputed either would be a second opinion free to drift from
 *   the one the bill was actually made from — the same argument
 *   `charge-billing.service.ts` makes about not re-resolving at invoice time.
 *
 * ⚠️ AND NO PHI PERSISTS ANYWHERE. These actions post ids and integers; the
 *   patient's name never leaves the rendered page, and nothing here writes to
 *   `localStorage`, a cookie or a URL.
 */

export type ChargeFormState = {
  status: 'idle' | 'error' | 'saved';
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Set on a successful bill, so the screen can navigate to the invoice. */
  createdId?: string;
};

export const IDLE_CHARGE_FORM: ChargeFormState = { status: 'idle' };

function toFormState(result: {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}): ChargeFormState {
  if (result.ok) return { status: 'saved' };
  return {
    status: 'error',
    message: result.message ?? 'That could not be saved. Check the fields and try again.',
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * Answer one charge the policy would not decide.
 *
 * ⚠️ "BILL IT" RAISES NO INVOICE. It records that a human said yes and leaves the
 *   charge waiting for a document somebody assembles and confirms — see
 *   `decideChargeRequest` on the server. The button therefore says "Approve",
 *   not "Bill", because an action keeps the same name through the whole flow and
 *   nothing gets billed here.
 */
export async function decideChargeAction(
  slug: string,
  chargeRequestId: string,
  _previous: ChargeFormState,
  form: FormData
): Promise<ChargeFormState> {
  const decision = form.get('decision') === 'SUPPRESS' ? 'SUPPRESS' : 'BILL';
  const priceInput = emptyToNull(form.get('unitPriceMinor'));

  const parsed = decideChargeRequest.safeParse(
    decision === 'SUPPRESS'
      ? { decision, reason: emptyToNull(form.get('reason')) ?? '' }
      : {
          decision,
          ...(priceInput !== null ? { unitPriceMinor: Number(priceInput) } : {}),
        }
  );
  if (!parsed.success) {
    return {
      status: 'error',
      message:
        decision === 'SUPPRESS'
          ? 'Say why this is not being charged for.'
          : 'Check the amount and try again.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ChargeRequestSummary>(
    `/api/v1/charging/requests/${chargeRequestId}/decide`,
    { method: 'POST', slug, accessToken, body: parsed.data }
  );
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/charges`);
  return { status: 'saved' };
}

/**
 * Raise one invoice from the charges somebody has ticked.
 *
 * ⚠️ THE SET IS EXPLICIT AND COMES FROM THE SCREEN. "Bill everything for this
 *   patient" is a query the LIST runs and a set the human then confirms; sending
 *   a patient id and letting the server decide would mean a charge raised one
 *   second before the click silently joining a bill nobody reviewed.
 */
export async function billChargesAction(
  slug: string,
  _previous: ChargeFormState,
  form: FormData
): Promise<ChargeFormState> {
  const parsed = createInvoiceFromChargesRequest.safeParse({
    chargeRequestIds: form.getAll('chargeRequestId').map(String),
    notes: emptyToNull(form.get('notes')) ?? undefined,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Choose at least one charge to bill.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<InvoiceDetail>('/api/v1/invoices/from-charges', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/charges`);
  revalidatePath(`/t/${slug}/invoices`);
  return { status: 'saved', ...(result.data ? { createdId: result.data.id } : {}) };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export async function saveProductPriceAction(
  slug: string,
  _previous: ChargeFormState,
  form: FormData
): Promise<ChargeFormState> {
  const branchId = emptyToNull(form.get('branchId'));
  const parsed = upsertProductPriceRequest.safeParse({
    productId: emptyToNull(form.get('productId')) ?? '',
    unitId: emptyToNull(form.get('unitId')) ?? '',
    /* Null is the organization-wide default every branch inherits. */
    branchId,
    amountMinor: Number(emptyToNull(form.get('amountMinor')) ?? Number.NaN),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ProductPriceDetail>('/api/v1/charging/prices', {
    method: 'PUT',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  /*
   * ⚠️ BOTH SCREENS, BECAUSE ONE ACTION SERVES BOTH. A price is SET on the
   *   product — that is where somebody has the item, its base unit and its
   *   packaging in front of them, and where "per strip" is a choice they can
   *   make sensibly — and LISTED under /charges, which is the ledger of what has
   *   been set. Two copies of this action, one per screen, is how the two
   *   screens start disagreeing about what a price is.
   */
  revalidatePath(`/t/${slug}/charges/prices`);
  revalidatePath(`/t/${slug}/products/${parsed.data.productId}`);
  return { status: 'saved' };
}

export async function deleteProductPriceAction(
  slug: string,
  priceId: string,
  /** Supplied from the product screen, so its own tab refreshes too. */
  productId?: string
): Promise<void> {
  const accessToken = await getAccessToken();
  await api(`/api/v1/charging/prices/${priceId}`, { method: 'DELETE', slug, accessToken });
  revalidatePath(`/t/${slug}/charges/prices`);
  if (productId) revalidatePath(`/t/${slug}/products/${productId}`);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE TARGET IS A DISCRIMINATED UNION AND IS ASSEMBLED HERE FROM A `scope`
 *   SELECT PLUS ONE FIELD. A form posts flat strings; the contract refuses two
 *   scoping fields at once, which is the same thing the CHECK constraint refuses
 *   on the row. Building the union here rather than posting all three and
 *   letting the server sort it out is what makes "a rule sits at exactly one
 *   tier" unrepresentable rather than merely refused.
 */
export async function saveChargePolicyAction(
  slug: string,
  _previous: ChargeFormState,
  form: FormData
): Promise<ChargeFormState> {
  const scope = String(form.get('scope') ?? '');
  const target =
    scope === 'PRODUCT'
      ? { scope, productId: emptyToNull(form.get('productId')) ?? '' }
      : scope === 'PRODUCT_CATEGORY'
        ? { scope, productCategoryId: emptyToNull(form.get('productCategoryId')) ?? '' }
        : { scope: 'PRODUCT_TYPE', productType: emptyToNull(form.get('productType')) ?? '' };

  const parsed = createChargePolicyRuleRequest.safeParse({
    target,
    policy: emptyToNull(form.get('policy')) ?? '',
    note: emptyToNull(form.get('note')) ?? undefined,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Check the fields below.',
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const accessToken = await getAccessToken();
  const result = await api<ChargePolicyRuleDetail>('/api/v1/charging/policies', {
    method: 'POST',
    slug,
    accessToken,
    body: parsed.data,
  });
  if (!result.ok) return toFormState(result);

  revalidatePath(`/t/${slug}/charges/policy`);
  return { status: 'saved' };
}

export async function deleteChargePolicyAction(slug: string, ruleId: string): Promise<void> {
  const accessToken = await getAccessToken();
  await api(`/api/v1/charging/policies/${ruleId}`, { method: 'DELETE', slug, accessToken });
  revalidatePath(`/t/${slug}/charges/policy`);
}
