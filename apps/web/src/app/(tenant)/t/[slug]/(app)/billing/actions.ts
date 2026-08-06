'use server';

import { revalidatePath } from 'next/cache';
import type {
  CancelSubscriptionResponse,
  CheckoutResponse,
  PurchaseSummary,
  MandateSetupResponse,
  ResumeSubscriptionResponse,
  UpgradeQuoteResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { formatLongDate } from '@/lib/format';

/*
 * Billing actions.
 *
 * `slug` is bound on the server before these reach the browser, so a client
 * cannot re-point one at another clinic — the same rule as every other action
 * module here.
 *
 * NOTHING IN THIS FILE SENDS AN AMOUNT. Every action names a `plan_prices` row
 * and the API computes what it costs, including the proration. A figure in a
 * request body is a figure a customer can edit.
 *
 * NOR DOES ANYTHING HERE DECIDE THAT A PAYMENT SUCCEEDED. The actions return a
 * redirect URL; the outcome arrives on a signature-verified webhook, and the
 * return page asks the API rather than reading its own query string.
 */

export type BillingFormState = {
  status: 'idle' | 'error' | 'saved' | 'redirect' | 'checkout';
  message?: string;
  /** Where to send the browser to pay. Present only on `redirect`. */
  redirectUrl?: string;
  /**
   * What the checkout component needs to mount a provider's widget on this
   * page. Present only on `checkout`, which is the embedded counterpart of
   * `redirect` — the server decides which of the two comes back, never the
   * client. See PAYMENTS_CHECKOUT_PRESENTATION.
   */
  checkout?: {
    embedded: { provider: string; publicKey: string; token: string };
    intentId: string;
    amountMinor: number;
    currency: string;
    /** What the invoice says this buys. Absent only on an older API. */
    purchase?: PurchaseSummary;
    /** Billing contact, for the widget's prefill. Never a patient. */
    customer?: { name: string; email: string; phone?: string };
  };
};

/**
 * The two ways a customer-present charge can come back, in one place.
 *
 * Exactly one of `redirectUrl` and `embedded` is set; both absent means it
 * settled off-session against a mandate and there is nothing to show.
 */
function handoffFrom(data: CheckoutResponse): BillingFormState | null {
  if (data.redirectUrl) return { status: 'redirect', redirectUrl: data.redirectUrl };

  if (data.embedded) {
    return {
      status: 'checkout',
      checkout: {
        embedded: data.embedded,
        intentId: data.intentId,
        amountMinor: data.amountMinor,
        currency: data.currency,
        ...(data.purchase ? { purchase: data.purchase } : {}),
        ...(data.customer ? { customer: data.customer } : {}),
      },
    };
  }

  return null;
}

/** Start paying for a plan — from a trial, or after the subscription lapsed. */
export async function startCheckout(
  slug: string,
  planPriceId: string,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api<CheckoutResponse>('/api/v1/billing/checkout', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { planPriceId },
  });

  if (!result.ok || !result.data) {
    return { status: 'error', message: result.message ?? 'The payment could not be started.' };
  }

  const handoff = handoffFrom(result.data);
  if (handoff) return handoff;

  // No redirect means it settled off-session against a saved mandate.
  revalidatePath(`/t/${slug}/billing`);
  return { status: 'saved', message: 'Payment taken.' };
}

/**
 * What an upgrade would cost, without committing to it.
 *
 * Called from the plan picker as the customer looks at each plan. It writes
 * nothing, and the figure it returns is recomputed server-side when the upgrade
 * is actually applied — a quote is a quote.
 */
export async function previewUpgrade(
  slug: string,
  planPriceId: string
): Promise<{ quote?: UpgradeQuoteResponse; message?: string }> {
  const result = await api<UpgradeQuoteResponse>('/api/v1/billing/subscription/upgrade/preview', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { planPriceId },
  });

  if (!result.ok || !result.data) {
    return { message: result.message ?? 'That plan change is not available.' };
  }
  return { quote: result.data };
}

export async function applyUpgrade(
  slug: string,
  planPriceId: string,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api<CheckoutResponse>('/api/v1/billing/subscription/upgrade', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { planPriceId },
  });

  if (!result.ok || !result.data) {
    return { status: 'error', message: result.message ?? 'The plan could not be changed.' };
  }

  const handoff = handoffFrom(result.data);
  if (handoff) return handoff;

  revalidatePath(`/t/${slug}/billing`);
  return { status: 'saved', message: 'Plan changed.' };
}

export async function cancelSubscription(
  slug: string,
  _previous: BillingFormState,
  formData: FormData
): Promise<BillingFormState> {
  const immediate = formData.get('immediate') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  const result = await api<CancelSubscriptionResponse>('/api/v1/billing/subscription/cancel', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
    body: { immediate, ...(reason ? { reason } : {}) },
  });

  if (!result.ok || !result.data) {
    return { status: 'error', message: result.message ?? 'The subscription could not be ended.' };
  }

  revalidatePath(`/t/${slug}/billing`);
  return {
    status: 'saved',
    message: immediate
      ? 'Subscription ended.'
      : `Subscription ends on ${formatLongDate(result.data.endsAt)}.`,
  };
}

export async function resumeSubscription(
  slug: string,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api<ResumeSubscriptionResponse>('/api/v1/billing/subscription/resume', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'The subscription could not be resumed.' };
  }

  revalidatePath(`/t/${slug}/billing`);
  return { status: 'saved', message: 'Subscription will continue.' };
}

export async function setAutoRenew(
  slug: string,
  enabled: boolean,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api('/api/v1/billing/subscription/auto-renew', {
    method: 'PUT',
    slug,
    accessToken: await getAccessToken(),
    body: { enabled },
  });

  if (!result.ok) {
    // The API refuses to arm automatic renewal with no live authorisation, and
    // its message says exactly that. Passing it through beats a vaguer one.
    return { status: 'error', message: result.message ?? 'That could not be changed.' };
  }

  revalidatePath(`/t/${slug}/billing`);
  return {
    status: 'saved',
    message: enabled ? 'Automatic renewal is on.' : 'Automatic renewal is off.',
  };
}

/** Authorise future debits. A separate act from paying, deliberately. */
export async function startMandateSetup(
  slug: string,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api<MandateSetupResponse>('/api/v1/billing/mandate', {
    method: 'POST',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return { status: 'error', message: result.message ?? 'Automatic payment could not be set up.' };
  }

  /*
   * Redirect only, deliberately — there is no embedded mandate flow.
   *
   * Authorising a standing debit is a bank-side act: UPI Autopay hands the
   * customer to their banking app and e-mandate to their bank's netbanking
   * page. Neither is something a widget on our page can hold, so `presentation`
   * has no meaning here and `createMandate` never returns an embedded handoff.
   */
  if (result.data.redirectUrl) {
    return { status: 'redirect', redirectUrl: result.data.redirectUrl };
  }

  revalidatePath(`/t/${slug}/billing`);
  return { status: 'saved', message: 'Automatic payment is set up.' };
}

export async function revokeMandate(
  slug: string,
  _previous: BillingFormState
): Promise<BillingFormState> {
  const result = await api('/api/v1/billing/mandate', {
    method: 'DELETE',
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok) {
    return { status: 'error', message: result.message ?? 'That could not be removed.' };
  }

  revalidatePath(`/t/${slug}/billing`);
  return { status: 'saved', message: 'Automatic payment removed.' };
}
