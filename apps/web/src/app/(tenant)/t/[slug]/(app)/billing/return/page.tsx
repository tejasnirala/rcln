import type { Metadata } from 'next';
import Link from 'next/link';
import type { MandateStatusResponse, PaymentStatusResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { MandateReturn, PaymentReturn } from '@/components/tenant/payment-return';

export const metadata: Metadata = {
  title: 'Payment',
};

/**
 * Where the payment provider sends the customer back to.
 *
 * ⚠️ THIS PAGE GRANTS NOTHING, AND THE QUERY STRING IS NOT EVIDENCE.
 *   A browser can be told to visit any URL with any parameters. Everything shown
 *   here comes from asking our own API about the intent id — which the API
 *   answers from a row that only a signature-verified webhook, or a direct call
 *   to the provider, can have moved to SUCCEEDED.
 *
 * WHY IT RECONCILES ONCE AND THEN POLLS
 *   The webhook is the authority and usually lands first, but "usually" is not a
 *   guarantee — a delivery can be retried, a deploy can land in between, and a
 *   fast network can beat the provider's own queue. So the first thing this page
 *   does is ask the provider directly (`/reconcile`), and then it waits, because
 *   a UPI collect request legitimately sits pending for minutes while somebody
 *   opens their banking app. Declaring failure at that moment would be wrong and
 *   would send the customer to pay a second time.
 */
export default async function PaymentReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;

  /*
   * Which flow the customer is coming back from.
   *
   * `kind` is put on the return URL by the engine (`returnUrlFor`), because a
   * charge and a mandate authorisation land on this same page carrying ids from
   * two different tables. Looking a mandate id up as a payment intent answers
   * 404, which this page used to render as "we could not check that payment"
   * while the mandate sat PENDING and automatic renewal stayed impossible.
   */
  const kind = first(query['kind']) === 'mandate' ? 'mandate' : 'charge';

  /*
   * Providers do not agree on the parameter name, and some send none at all —
   * they expect the merchant to have put its own reference in the return URL.
   * Ours is `intent`; the others are read as a fallback so a provider swap does
   * not silently break the return page.
   */
  const reference =
    first(query['intent']) ?? first(query['order_id']) ?? first(query['subscription_id']);

  if (!reference) {
    return (
      <div className="max-w-xl space-y-4">
        <Alert tone="info">
          We could not tell which payment this was. Open billing to see where your subscription
          stands.
        </Alert>
        <Link href={`/billing`} className="text-drape text-[0.875rem] underline">
          Go to billing
        </Link>
      </div>
    );
  }

  const accessToken = await getAccessToken();

  /*
   * The pull half of the webhook's push. Idempotent, so it is harmless if the
   * webhook already applied the outcome — and it is the ONLY path when the
   * provider has no webhook for this flow, which is the case for Cashfree
   * mandates unless their Subscriptions webhooks are configured separately.
   */
  if (kind === 'mandate') {
    const reconciled = await api<MandateStatusResponse>(
      `/api/v1/billing/mandate/${reference}/reconcile`,
      { method: 'POST', slug, accessToken }
    );

    if (!reconciled.ok || !reconciled.data) {
      return <ReturnError message={reconciled.message} />;
    }

    return <MandateReturn slug={slug} initial={reconciled.data} />;
  }

  const reconciled = await api<PaymentStatusResponse>(
    `/api/v1/billing/payments/${reference}/reconcile`,
    { method: 'POST', slug, accessToken }
  );

  if (!reconciled.ok || !reconciled.data) {
    return <ReturnError message={reconciled.message} />;
  }

  return <PaymentReturn slug={slug} initial={reconciled.data} />;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function ReturnError({ message }: { message?: string | undefined }) {
  return (
    <div className="max-w-xl space-y-4">
      <Alert tone="error">
        {message ?? 'We could not check that. Open billing to see where things stand.'}
      </Alert>
      <Link href="/billing" className="text-drape text-[0.875rem] underline">
        Go to billing
      </Link>
    </div>
  );
}
