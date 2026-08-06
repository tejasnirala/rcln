/**
 * The pieces every billing operation needs: how to reach a provider, how to turn
 * a `numeric` column into money, and how to write an invoice.
 *
 * WHY THE ENGINE OWNS ITS TRANSACTIONS
 *   Every operation here is really three phases: write our intent, ask the
 *   provider, record what it said. The middle one is a network call to somebody
 *   else's datacentre, and holding a Postgres transaction open across it is how
 *   a gateway's bad afternoon becomes a connection-pool outage. So each phase
 *   gets its own `withTenant` block and the engine, not the caller, decides
 *   where the boundaries are.
 *
 *   The consequence is that a crash between phases leaves a `payment_intents`
 *   row in CREATED with nothing behind it. That is the correct residue: it
 *   grants nothing, it is the idempotency key for a retry, and reconciliation
 *   can ask the provider what became of it. The alternative — no row until the
 *   provider answers — cannot be reconciled at all, because the interesting
 *   failure is the one where we never hear back.
 */

import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import { fromMajor, money, toMajorString, type Money, type PaymentProvider } from '@rcln/payments';
import { formatInvoiceNumber, yearBounds } from '../numbering.js';
import { toDateOnly } from '../periods.js';
import {
  netOf,
  resolveTax,
  type SupplierRegistration,
  type TaxIdStatus,
  type TaxQuote,
} from '../tax/engine.js';

/**
 * Everything the engine needs from the process it is running in.
 *
 * Injected rather than imported so the API and the worker can differ where they
 * genuinely do — the worker has no request, so its audit rows have no IP — and
 * so a test can run the whole engine against the mock provider and a fake clock.
 */
export interface BillingRuntime {
  provider: PaymentProvider;
  /**
   * The clinic's own web origin, e.g. `https://alpha.rcln.com`. Return URLs are
   * built from it, so a customer always comes back to their own subdomain and
   * never to the apex or to another tenant's.
   */
  tenantUrl: string;
  /** Where providers POST outcomes. Must be publicly reachable. */
  webhookUrl: string;
  /**
   * Whether a customer-present charge sends the browser to the provider, or
   * mounts the provider's widget on our own checkout page.
   *
   * ⚠️ A DEPLOYMENT DECISION, NOT A CUSTOMER'S. It comes from the environment,
   *   and no request contract carries it — see `presentation` in
   *   `@rcln/payments`. Absent means `redirect`, which every provider supports
   *   and which is the floor the embedded flow falls back to.
   *
   * It has no effect on an off-session mandate debit: there is no customer and
   * no page, so a renewal ignores this entirely.
   */
  checkoutPresentation?: 'redirect' | 'embedded' | undefined;
  /**
   * Write an audit row inside the engine's own transaction. Optional because the
   * worker has no request context to attribute; when absent the
   * `subscription_changes` row is still written, which is the billing history
   * proper.
   */
  audit?:
    ((tx: TxClient, ctx: TenantContext, entry: BillingAuditEntry) => Promise<void>) | undefined;
  /** Injectable clock. Everything reads time through this. */
  now?: (() => Date) | undefined;
}

export interface BillingAuditEntry {
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
}

export function clock(runtime: BillingRuntime): Date {
  return runtime.now?.() ?? new Date();
}

/**
 * How to present a customer-present checkout, with the fallback applied once.
 *
 * A deployment can ask for `embedded` against a provider that has no widget —
 * that is a normal state, not a misconfiguration, because `PAYMENT_PROVIDER` and
 * this setting are independent variables and an acquirer swap must not require
 * changing both in step. So the capability wins and the flow degrades to the
 * hosted page, which every provider supports.
 *
 * Resolved here rather than at each call site so the two customer-present paths
 * cannot disagree — and so that "why did it redirect?" has one answer.
 */
export function presentationFor(runtime: BillingRuntime): 'redirect' | 'embedded' {
  return runtime.checkoutPresentation === 'embedded' &&
    runtime.provider.capabilities.embeddedCheckout
    ? 'embedded'
    : 'redirect';
}

/**
 * A tenant context for work nobody requested: a webhook, a renewal, a sweep.
 *
 * `userId` is empty, so `app.current_user` is NULL and every policy that reads
 * it — the identity bootstrap, the branch scope — matches nothing. That is
 * correct: these operations act on the organization's billing rows, which are
 * scoped by organization alone, and none of them may reach a branch-scoped or
 * user-scoped table. The audit hook is omitted for the same reason; the
 * commercial record goes to `subscription_changes`, which does not claim a human
 * actor it does not have.
 */
export function systemContext(organizationId: string): TenantContext {
  return { organizationId, branchIds: [], userId: '' };
}

// ---------------------------------------------------------------------------
// numeric(14,2) <-> minor units
// ---------------------------------------------------------------------------

/**
 * The one place a `Decimal` becomes `Money`.
 *
 * Via the string form, never `.toNumber()`: `Decimal` exists precisely because
 * binary floating point cannot hold 0.1, and converting through a float to get
 * to an integer throws that away at the last possible moment.
 */
export function toMoney(value: Prisma.Decimal, currency: string): Money {
  return fromMajor(value.toString(), currency);
}

/** And back, for a column. */
export function toDecimal(value: Money): Prisma.Decimal {
  return new Prisma.Decimal(toMajorString(value));
}

export function zeroMoney(currency: string): Money {
  return money(0, currency);
}

// ---------------------------------------------------------------------------
// Loading a subscription with everything an operation needs
// ---------------------------------------------------------------------------

/**
 * What every operation reads. One query rather than five, because the
 * transaction-local session variables are paid per transaction and a billing
 * screen that issues six round-trips is six chances to interleave with a
 * webhook.
 */
export const SUBSCRIPTION_INCLUDE = {
  plan: { include: { features: true, prices: true } },
  planPrice: true,
  featureOverrides: true,
  mandate: true,
} as const;

export type LoadedSubscription = Prisma.SubscriptionGetPayload<{
  include: typeof SUBSCRIPTION_INCLUDE;
}>;

/**
 * The clinic's current subscription, or null.
 *
 * `findFirst` ordered by creation, not `findUnique`: an organization can
 * accumulate rows over time — a cancelled one, then a new one after
 * re-subscribing — and the current one is the newest. RLS narrows to the tenant;
 * the explicit `organizationId` is belt and braces, and is what makes the query
 * still correct if it is ever run outside a scoped transaction.
 */
export async function loadSubscription(
  tx: TxClient,
  ctx: TenantContext
): Promise<LoadedSubscription | null> {
  return tx.subscription.findFirst({
    where: { organizationId: ctx.organizationId },
    include: SUBSCRIPTION_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceLineInput {
  kind: 'SUBSCRIPTION' | 'PRORATION_CREDIT' | 'PRORATION_CHARGE' | 'TAX' | 'ADJUSTMENT';
  description: string;
  amount: Money;
  periodStart?: Date | undefined;
  periodEnd?: Date | undefined;
  /** Set on TAX lines only. Snapshotted — see the schema comment on the column. */
  taxRateBps?: number | undefined;
  taxName?: string | undefined;
  taxJurisdiction?: string | undefined;
}

export interface CreateInvoiceInput {
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  lines: InvoiceLineInput[];
  dueDate?: Date | undefined;
  issuedAt?: Date | undefined;
  /**
   * What tax is due on the lines above, and why.
   *
   * Absent means the caller did not compute any — which is NOT the same as "no
   * tax is due" and is why `taxFor` exists to make computing it the easy path.
   * The invoice then records `NOT_REGISTERED`, matching the column default.
   */
  tax?: TaxQuote | undefined;
}

/**
 * Issue an invoice, with its lines, in the caller's transaction.
 *
 * Status OPEN rather than DRAFT: by the time this is called the amount is
 * decided and we are about to ask for it. DRAFT is reserved for an invoice being
 * assembled over time, which nothing here does.
 *
 * SUBTOTAL IS THE SUM OF THE SUPPLY LINES; TOTAL IS THAT PLUS TAX.
 *   A credit line carries a negative amount, so a prorated upgrade subtotals to
 *   exactly what is being supplied and the customer can check the arithmetic.
 *   Tax lines are appended from the quote and are what the difference between
 *   `subtotal` and `total` consists of — the two were equal before there was a
 *   tax engine, and anything still assuming that is now wrong.
 *
 * ⚠️ `total` IS WHAT THE CUSTOMER IS CHARGED, so it is what the payment intent
 *   must be created for. `settleIntent` refuses a payment smaller than the
 *   intent's amount; an intent created for the subtotal would be settled by a
 *   payment that is short by exactly the tax, and the invoice would never be
 *   marked paid.
 */
export async function issueInvoice(
  tx: TxClient,
  ctx: TenantContext,
  input: CreateInvoiceInput
): Promise<{ id: string; invoiceNumber: string; total: Money; subtotal: Money; tax: Money }> {
  const issuedAt = input.issuedAt ?? new Date();
  const { start, end } = yearBounds(issuedAt);

  const countThisYear = await tx.subscriptionInvoice.count({
    where: { organizationId: ctx.organizationId, createdAt: { gte: start, lt: end } },
  });

  const invoiceNumber = formatInvoiceNumber({
    organizationId: ctx.organizationId,
    countThisYear,
    issuedAt,
  });

  const subtotal = money(
    input.lines.reduce((sum, line) => sum + line.amount.amountMinor, 0),
    input.currency
  );

  /*
   * Tax lines come from the quote, not from the caller — so the amounts on the
   * invoice and the amounts the engine decided cannot drift apart, and so a
   * caller cannot accidentally write a TAX line with no rate on it.
   */
  const taxLines: InvoiceLineInput[] = (input.tax?.lines ?? []).map((line) => ({
    kind: 'TAX' as const,
    description: `${line.name} at ${String(line.rateBps / 100)}%`,
    amount: line.amount,
    taxRateBps: line.rateBps,
    taxName: line.name,
    taxJurisdiction: line.jurisdiction,
  }));

  const taxAmount = input.tax?.total ?? money(0, input.currency);
  const total = money(subtotal.amountMinor + taxAmount.amountMinor, input.currency);

  const invoice = await tx.subscriptionInvoice.create({
    data: {
      organizationId: ctx.organizationId,
      subscriptionId: input.subscriptionId,
      invoiceNumber,
      periodStart: toDateOnly(input.periodStart),
      periodEnd: toDateOnly(input.periodEnd),
      currency: input.currency,
      subtotal: toDecimal(subtotal),
      taxAmount: toDecimal(taxAmount),
      total: toDecimal(total),
      status: 'OPEN',
      // Snapshotted, all four. See the schema comments — a rate or a
      // registration read again later would restate an issued document.
      ...(input.tax
        ? {
            taxTreatment: input.tax.treatment,
            placeOfSupply: input.tax.placeOfSupply,
            ...(input.tax.supplierTaxId ? { supplierTaxId: input.tax.supplierTaxId } : {}),
            ...(input.tax.customerTaxId ? { customerTaxId: input.tax.customerTaxId } : {}),
          }
        : {}),
      ...(input.dueDate ? { dueDate: toDateOnly(input.dueDate) } : {}),
      lines: {
        create: [...input.lines, ...taxLines].map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: new Prisma.Decimal(1),
          unitAmount: toDecimal(line.amount),
          lineTotal: toDecimal(line.amount),
          ...(line.periodStart ? { periodStart: toDateOnly(line.periodStart) } : {}),
          ...(line.periodEnd ? { periodEnd: toDateOnly(line.periodEnd) } : {}),
          ...(line.taxRateBps !== undefined ? { taxRateBps: line.taxRateBps } : {}),
          ...(line.taxName ? { taxName: line.taxName } : {}),
          ...(line.taxJurisdiction ? { taxJurisdiction: line.taxJurisdiction } : {}),
        })),
      },
    },
    select: { id: true, invoiceNumber: true },
  });

  // `total`, not `subtotal` — this is what the payment intent must be raised
  // for. See the warning in the header.
  return { ...invoice, total, subtotal, tax: taxAmount };
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/**
 * What tax is due on a net amount for this clinic, right now.
 *
 * The one place the engine reads the tax inputs, so every call site gets the
 * same answer from the same two tables:
 *
 *   - `organizations` for the place of supply and the customer's own number.
 *     RLS-exempt, and read here by primary key inside the tenant transaction —
 *     the same pattern `resolveTenant` uses.
 *   - `tax_registrations` for where WE may collect. Also RLS-exempt, and it has
 *     to be: a policy on it would return zero rows inside a tenant transaction,
 *     zero rows reads as NOT_REGISTERED, and every invoice would silently come
 *     out untaxed. That reasoning is recorded in enable-rls.sql.
 *
 * `effectiveFrom <= at` matters on the first invoices after registering: a
 * supply made before the registration took effect is not taxable by us even
 * though the row now exists.
 */
export async function taxFor(
  tx: TxClient,
  ctx: TenantContext,
  net: Money,
  at: Date
): Promise<TaxQuote> {
  const organization = await tx.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { countryCode: true, regionCode: true, gstNumber: true, taxIdStatus: true },
  });

  const rows = await tx.taxRegistration.findMany({
    where: {
      deletedAt: null,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
    },
  });

  const registrations: SupplierRegistration[] = rows.map((row) => ({
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme,
    registrationNumber: row.registrationNumber,
    standardRateBps: row.standardRateBps,
  }));

  const quote = resolveTax({
    net,
    customer: {
      // An organization always exists here — it is the tenant. The fallback
      // keeps this total rather than throwing inside an invoice write.
      countryCode: organization?.countryCode ?? 'IN',
      regionCode: organization?.regionCode ?? null,
      taxId: organization?.gstNumber ?? null,
      taxIdStatus: (organization?.taxIdStatus ?? 'NOT_PROVIDED') as TaxIdStatus,
    },
    registrations,
    suppliedAt: at,
  });

  return quote;
}

/**
 * Split a catalogue price into the net that is supplied and the tax on it.
 *
 * An EXCLUSIVE price IS the net and tax goes on top — every current
 * `plan_prices` row, and the schema default.
 *
 * An INCLUSIVE price is the gross, so the net has to be backed out of it. The
 * rate is learnt by quoting the gross first, which is safe because a rate does
 * not depend on the amount in any regime here, and the net is then rounded DOWN
 * so `net + tax` can never exceed the figure the customer was shown. The tax
 * takes the remainder, which keeps the invoice adding up exactly.
 */
export async function priceWithTax(
  tx: TxClient,
  ctx: TenantContext,
  price: Money,
  behavior: 'EXCLUSIVE' | 'INCLUSIVE',
  at: Date
): Promise<{ net: Money; tax: TaxQuote }> {
  if (behavior === 'EXCLUSIVE') {
    return { net: price, tax: await taxFor(tx, ctx, price, at) };
  }

  const onGross = await taxFor(tx, ctx, price, at);
  const rateBps = onGross.lines.reduce((sum, line) => sum + line.rateBps, 0);
  if (rateBps === 0) return { net: price, tax: onGross };

  const net = netOf(price, rateBps);
  const tax = await taxFor(tx, ctx, net, at);

  return { net, tax };
}

/**
 * The line-item description a customer reads on their statement.
 *
 * No patient data, no internal ids, and the plan name as they chose it. Kept in
 * one function because it also goes to the provider as the order note, and the
 * two drifting apart means the bank narration disagrees with the invoice.
 */
export function planDescription(planName: string, interval: 'MONTH' | 'YEAR'): string {
  return `${planName} — billed ${interval === 'YEAR' ? 'yearly' : 'monthly'}`;
}
