/**
 * Everything the billing screen and the platform console read.
 *
 * ASSEMBLED HERE RATHER THAN IN THE API so the worker's reconciliation, the
 * tenant screen and the super-admin console all describe a subscription the same
 * way. "Past due but still inside the grace period" is one sentence in one place;
 * three copies of that logic is three chances for one of them to lock a clinic
 * out a week early.
 *
 * NOTHING HERE IS PROVIDER-SHAPED. The screen learns that automatic renewal is
 * unavailable in EUR; it never learns which acquirer said so.
 */

import type {
  InvoiceLineKind,
  MandateStatus,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  TenantContext,
  TxClient,
} from '@rcln/db';
import { currencyForCountry, type PaymentProvider } from '@rcln/payments';
import { resolveEntitlements } from '../entitlements.js';
import { isEntitled, isWithinGrace } from '../policy.js';
import { loadSubscription, toMoney, type LoadedSubscription } from './shared.js';

export interface PlanPriceView {
  id: string;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  amountMinor: number;
}

export interface PlanView {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  trialDays: number;
  sortOrder: number;
  features: Record<string, number | boolean>;
  prices: PlanPriceView[];
}

/**
 * The catalogue, priced in one currency.
 *
 * A plan with no price in `currency` is omitted, not shown at zero and not shown
 * with a price from another currency: an unpurchasable plan on a pricing screen
 * is a checkout that fails after the customer has chosen.
 */
export async function listPlans(tx: TxClient, currency: string): Promise<PlanView[]> {
  const plans = await tx.plan.findMany({
    where: { isPublic: true },
    include: { features: true, prices: { where: { currency, isActive: true } } },
    orderBy: { sortOrder: 'asc' },
  });

  return plans
    .filter((plan) => plan.prices.length > 0)
    .map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      tagline: plan.tagline,
      trialDays: plan.trialDays,
      sortOrder: plan.sortOrder,
      features: { ...resolveEntitlements(plan.features) },
      prices: plan.prices.map((price) => ({
        id: price.id,
        currency: price.currency,
        interval: price.billingInterval,
        amountMinor: toMoney(price.amount, price.currency).amountMinor,
      })),
    }));
}

/**
 * Which currency to quote this clinic.
 *
 * The subscription's own currency once it has one — it is fixed at subscribe
 * time and an existing customer must never be re-quoted in another. Otherwise
 * the country's default, narrowed to what the catalogue actually publishes.
 */
export async function billingCurrencyFor(
  tx: TxClient,
  ctx: TenantContext,
  countryCode: string | null
): Promise<string> {
  const subscription = await tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId },
    select: { currency: true, startedAt: true },
    orderBy: { createdAt: 'desc' },
  });

  if (subscription?.startedAt) return subscription.currency;

  const available = await tx.planPrice.findMany({
    where: { isActive: true, plan: { isPublic: true } },
    select: { currency: true },
    distinct: ['currency'],
  });

  return currencyForCountry(
    countryCode,
    available.map((price) => price.currency)
  );
}

export interface SubscriptionView {
  id: string;
  /**
   * The database's own enum, not a string.
   *
   * `@rcln/contracts` declares the same union by hand — it must stay
   * dependency-free — so typing it loosely here is what would let the two drift
   * until an unhandled status reached a screen as a blank badge.
   */
  status: SubscriptionStatus;
  /** The single question every gate reduces to. Computed, never stored. */
  isActive: boolean;
  plan: { id: string; code: string; name: string; tagline: string | null };
  planPriceId: string;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  amountMinor: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  /** Set only while the clinic is in the grace period after a failed renewal. */
  gracePeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  autoRenew: boolean;
  /** What the clinic gets, plan and overrides resolved. */
  entitlements: Record<string, number | boolean>;
  mandate: MandateView | null;
  /** False when this provider cannot hold a mandate in this currency. */
  autoRenewAvailable: boolean;
}

export interface MandateView {
  id: string;
  status: MandateStatus;
  method: string | null;
  instrumentLabel: string | null;
  maxAmountMinor: number;
  currency: string;
  activatedAt: string | null;
}

export function toSubscriptionView(
  subscription: LoadedSubscription,
  provider: PaymentProvider,
  at: Date = new Date()
): SubscriptionView {
  const entitled = isEntitled(
    {
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      gracePeriodEnd: subscription.gracePeriodEnd,
    },
    at
  );

  const inGrace =
    subscription.status === 'PAST_DUE' &&
    isWithinGrace(
      {
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        gracePeriodEnd: subscription.gracePeriodEnd,
      },
      at
    );

  return {
    id: subscription.id,
    status: subscription.status,
    isActive: entitled,
    plan: {
      id: subscription.plan.id,
      code: subscription.plan.code,
      name: subscription.plan.name,
      tagline: subscription.plan.tagline,
    },
    planPriceId: subscription.planPriceId,
    currency: subscription.currency,
    interval: subscription.planPrice.billingInterval,
    amountMinor: toMoney(subscription.planPrice.amount, subscription.currency).amountMinor,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    gracePeriodEnd: inGrace ? (subscription.gracePeriodEnd?.toISOString() ?? null) : null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    cancelAt: subscription.cancelAt?.toISOString() ?? null,
    autoRenew: subscription.autoRenew,
    entitlements: {
      ...resolveEntitlements(subscription.plan.features, subscription.featureOverrides),
    },
    mandate: subscription.mandate
      ? {
          id: subscription.mandate.id,
          status: subscription.mandate.status,
          method: subscription.mandate.method,
          instrumentLabel: subscription.mandate.instrumentLabel,
          maxAmountMinor: toMoney(subscription.mandate.maxAmount, subscription.mandate.currency)
            .amountMinor,
          currency: subscription.mandate.currency,
          activatedAt: subscription.mandate.activatedAt?.toISOString() ?? null,
        }
      : null,
    autoRenewAvailable:
      provider.capabilities.mandates &&
      provider.capabilities.mandateCurrencies.includes(subscription.currency),
  };
}

export interface InvoiceView {
  id: string;
  invoiceNumber: string;
  status: SubscriptionInvoiceStatus;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  dueDate: string | null;
  lines: {
    kind: InvoiceLineKind;
    description: string;
    amountMinor: number;
  }[];
}

export async function listInvoices(
  tx: TxClient,
  ctx: TenantContext,
  limit = 24
): Promise<InvoiceView[]> {
  const invoices = await tx.subscriptionInvoice.findMany({
    where: { organizationId: ctx.organizationId },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return invoices.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    currency: invoice.currency,
    totalMinor: toMoney(invoice.total, invoice.currency).amountMinor,
    amountPaidMinor: toMoney(invoice.amountPaid, invoice.currency).amountMinor,
    periodStart: invoice.periodStart.toISOString(),
    periodEnd: invoice.periodEnd.toISOString(),
    issuedAt: invoice.createdAt.toISOString(),
    paidAt: invoice.paidAt?.toISOString() ?? null,
    dueDate: invoice.dueDate?.toISOString() ?? null,
    lines: invoice.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      amountMinor: toMoney(line.lineTotal, invoice.currency).amountMinor,
    })),
  }));
}

export interface BillingOverview {
  subscription: SubscriptionView | null;
  plans: PlanView[];
  invoices: InvoiceView[];
  currency: string;
}

/**
 * One read for the whole billing screen.
 *
 * A single `withTenant` block, because the tenant session variables cost a
 * round-trip per transaction and a screen that issues four of them is four
 * chances to interleave with a webhook that is settling a payment.
 */
export async function getBillingOverview(
  tx: TxClient,
  ctx: TenantContext,
  provider: PaymentProvider,
  countryCode: string | null,
  at: Date = new Date()
): Promise<BillingOverview> {
  const subscription = await loadSubscription(tx, ctx);
  const currency = subscription?.currency ?? (await billingCurrencyFor(tx, ctx, countryCode));

  const [plans, invoices] = await Promise.all([listPlans(tx, currency), listInvoices(tx, ctx)]);

  return {
    subscription: subscription ? toSubscriptionView(subscription, provider, at) : null,
    plans,
    invoices,
    currency,
  };
}
