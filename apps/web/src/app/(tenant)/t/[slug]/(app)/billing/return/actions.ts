'use server';

import type { MandateStatusResponse, PaymentStatusResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * Read one payment's state.
 *
 * A plain read — it settles nothing and grants nothing. The return page calls it
 * on a timer while a payment is still with the customer's bank; the authoritative
 * move to SUCCEEDED happens on a signature-verified webhook, or on the single
 * `/reconcile` the page's server component already issued.
 *
 * Returns null rather than throwing: a poll that fails is a poll, and the caller
 * should keep waiting rather than render an error over a payment that is fine.
 */
export async function pollPaymentStatus(
  slug: string,
  intentId: string
): Promise<PaymentStatusResponse | null> {
  const result = await api<PaymentStatusResponse>(`/api/v1/billing/payments/${intentId}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  return result.ok && result.data ? result.data : null;
}

/**
 * Read one payment authorisation's state.
 *
 * A plain read. The authoritative move to ACTIVE happens either on a webhook or
 * on the single `/reconcile` the return page's server component already issued —
 * and on Cashfree's Payment Gateway configuration there is no mandate webhook at
 * all, so that reconcile is the whole mechanism.
 */
export async function pollMandateStatus(
  slug: string,
  mandateId: string
): Promise<MandateStatusResponse | null> {
  const result = await api<MandateStatusResponse>(`/api/v1/billing/mandate/${mandateId}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  return result.ok && result.data ? result.data : null;
}
