/**
 * The rules that decide what a clinic is charged.
 *
 * Pure functions, no database, no gateway — which is exactly why they are worth
 * testing here rather than through an endpoint. Every case below is one somebody
 * will eventually complain about: a clinic that signed up on the 31st, an
 * upgrade on the last day of a month, a trial that ended over a weekend.
 */
import { money } from '@rcln/payments';
import { addInterval, addMonths, daysBetween, daysRemaining, periodFrom } from '../src/periods.js';
import { classifyChange, prorate, ProrationError } from '../src/proration.js';
import { resolveEntitlements, limitOf, hasModule, wouldExceed } from '../src/entitlements.js';
import {
  GRACE_PERIOD_DAYS,
  canStartCheckout,
  canUpgrade,
  isEntitled,
  mandateCeiling,
  nextDunningAt,
} from '../src/policy.js';
import { formatInvoiceNumber } from '../src/numbering.js';
import { presentationFor, type BillingRuntime } from '../src/engine/shared.js';

const utc = (iso: string): Date => new Date(iso);

describe('period arithmetic', () => {
  it('clamps a month-end signup to the shorter month', () => {
    expect(addMonths(utc('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z'
    );
  });

  it('does not let the clamped date become the new anchor', () => {
    // The drift bug: 31 Jan -> 28 Feb -> 28 Mar forever, instead of back to 31.
    const anchor = 31;
    const feb = addMonths(utc('2026-01-31T00:00:00Z'), 1, anchor);
    expect(addMonths(feb, 1, anchor).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('handles a leap day by clamping, not by shifting a year', () => {
    expect(addInterval(utc('2028-02-29T00:00:00Z'), 'YEAR').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z'
    );
  });

  it('crosses a year boundary', () => {
    expect(addMonths(utc('2026-11-15T00:00:00Z'), 3).toISOString()).toBe(
      '2027-02-15T00:00:00.000Z'
    );
  });

  it('measures a period in whole days', () => {
    const period = periodFrom(utc('2026-03-01T00:00:00Z'), 'MONTH');
    expect(daysBetween(period.start, period.end)).toBe(31);
  });

  it('clamps days remaining to the period, in both directions', () => {
    const period = periodFrom(utc('2026-03-01T00:00:00Z'), 'MONTH');
    expect(daysRemaining(period, utc('2026-02-01T00:00:00Z'))).toBe(31);
    expect(daysRemaining(period, utc('2026-03-15T00:00:00Z'))).toBe(17);
    expect(daysRemaining(period, utc('2026-09-01T00:00:00Z'))).toBe(0);
  });
});

describe('proration', () => {
  const period = periodFrom(utc('2026-03-01T00:00:00Z'), 'MONTH');

  it('charges the difference for the unused part of the period', () => {
    const quote = prorate({
      period,
      at: utc('2026-03-15T00:00:00Z'),
      currentAmount: money(149_900, 'INR'),
      nextAmount: money(499_900, 'INR'),
    });

    expect(quote.periodDays).toBe(31);
    expect(quote.remainingDays).toBe(17);
    // 17/31 of each, and the difference is what is collected.
    // ₹1499 * 17/31 = ₹822.03, ₹4999 * 17/31 = ₹2741.39.
    expect(quote.credit.amountMinor).toBe(82_203);
    expect(quote.charge.amountMinor).toBe(274_139);
    expect(quote.amountDue.amountMinor).toBe(274_139 - 82_203);
  });

  it('adds up: the invoice total is credit plus charge', () => {
    const quote = prorate({
      period,
      at: utc('2026-03-15T00:00:00Z'),
      currentAmount: money(149_900, 'INR'),
      nextAmount: money(499_900, 'INR'),
    });
    expect(quote.charge.amountMinor - quote.credit.amountMinor).toBe(quote.amountDue.amountMinor);
  });

  it('charges the full price when the change lands on the first day', () => {
    const quote = prorate({
      period,
      at: period.start,
      currentAmount: money(0, 'INR'),
      nextAmount: money(499_900, 'INR'),
    });
    expect(quote.amountDue.amountMinor).toBe(499_900);
  });

  it('charges nothing when the period has already run out', () => {
    const quote = prorate({
      period,
      at: period.end,
      currentAmount: money(149_900, 'INR'),
      nextAmount: money(499_900, 'INR'),
    });
    expect(quote.isFree).toBe(true);
    expect(quote.amountDue.amountMinor).toBe(0);
  });

  it('floors at zero rather than producing a refund', () => {
    const quote = prorate({
      period,
      at: utc('2026-03-15T00:00:00Z'),
      currentAmount: money(499_900, 'INR'),
      nextAmount: money(149_900, 'INR'),
    });
    expect(quote.amountDue.amountMinor).toBe(0);
  });

  it('refuses to prorate across currencies', () => {
    expect(() =>
      prorate({
        period,
        at: utc('2026-03-15T00:00:00Z'),
        currentAmount: money(149_900, 'INR'),
        nextAmount: money(4999, 'USD'),
      })
    ).toThrow(ProrationError);
  });
});

describe('classifying a plan change', () => {
  const starter = { max_branches: 1, max_users: 10, pharmacy_module: false, lab_module: false };
  const growth = { max_branches: 5, max_users: 50, pharmacy_module: true, lab_module: true };
  const enterprise = { max_branches: -1, max_users: -1, pharmacy_module: true, lab_module: true };

  it('calls more of everything an upgrade', () => {
    expect(
      classifyChange(
        { features: starter, interval: 'MONTH' },
        { features: growth, interval: 'MONTH' }
      )
    ).toBe('UPGRADE');
  });

  it('treats -1 as unlimited, which beats any finite limit', () => {
    expect(
      classifyChange(
        { features: growth, interval: 'MONTH' },
        { features: enterprise, interval: 'MONTH' }
      )
    ).toBe('UPGRADE');
    expect(
      classifyChange(
        { features: enterprise, interval: 'MONTH' },
        { features: growth, interval: 'MONTH' }
      )
    ).toBe('DOWNGRADE');
  });

  it('calls less of anything a downgrade, even alongside a gain', () => {
    const mixed = { ...growth, lab_module: false, max_users: 500 };
    expect(
      classifyChange(
        { features: growth, interval: 'MONTH' },
        { features: mixed, interval: 'MONTH' }
      )
    ).toBe('DOWNGRADE');
  });

  it('treats a feature the new plan does not mention as removed', () => {
    const { lab_module: _dropped, ...withoutLab } = growth;
    expect(
      classifyChange(
        { features: growth, interval: 'MONTH' },
        { features: withoutLab, interval: 'MONTH' }
      )
    ).toBe('DOWNGRADE');
  });

  it('calls monthly-to-annual on the same plan an upgrade, and the reverse not', () => {
    expect(
      classifyChange(
        { features: growth, interval: 'MONTH' },
        { features: growth, interval: 'YEAR' }
      )
    ).toBe('UPGRADE');
    expect(
      classifyChange(
        { features: growth, interval: 'YEAR' },
        { features: growth, interval: 'MONTH' }
      )
    ).toBe('DOWNGRADE');
  });

  it('calls the identical plan lateral, so it can be refused', () => {
    expect(
      classifyChange(
        { features: growth, interval: 'MONTH' },
        { features: growth, interval: 'MONTH' }
      )
    ).toBe('LATERAL');
  });
});

describe('entitlements', () => {
  const planFeatures = [
    { featureKey: 'max_branches', valueType: 'INT' as const, intValue: 5, boolValue: null },
    { featureKey: 'lab_module', valueType: 'BOOL' as const, intValue: null, boolValue: true },
  ];

  it('falls back to a hard default for a key no plan mentions', () => {
    const resolved = resolveEntitlements(planFeatures);
    expect(resolved['custom_domain']).toBe(false);
    expect(resolved['max_patients']).toBe(500);
  });

  it('lets a subscription override beat the plan', () => {
    const resolved = resolveEntitlements(planFeatures, [
      { featureKey: 'max_branches', intValue: 11, boolValue: null },
    ]);
    expect(resolved['max_branches']).toBe(11);
  });

  it('reads -1 as unlimited', () => {
    const resolved = resolveEntitlements([
      { featureKey: 'max_users', valueType: 'INT' as const, intValue: -1, boolValue: null },
    ]);
    expect(limitOf(resolved, 'max_users')).toBe(Number.POSITIVE_INFINITY);
    expect(wouldExceed(resolved, 'max_users', 10_000)).toBe(false);
  });

  it('answers a limit question before the write, not after', () => {
    const resolved = resolveEntitlements(planFeatures);
    expect(wouldExceed(resolved, 'max_branches', 4)).toBe(false);
    expect(wouldExceed(resolved, 'max_branches', 5)).toBe(true);
  });

  it('reads a module that is off as off, not as missing', () => {
    expect(hasModule(resolveEntitlements(planFeatures), 'pharmacy_module')).toBe(false);
    expect(hasModule(resolveEntitlements(planFeatures), 'lab_module')).toBe(true);
  });
});

describe('entitlement policy', () => {
  const base = {
    currentPeriodEnd: utc('2026-04-01T00:00:00Z'),
    trialEndsAt: null,
    gracePeriodEnd: null,
  };
  const now = utc('2026-03-15T00:00:00Z');

  it('never entitles an INCOMPLETE subscription', () => {
    // The free-subscription bug: open a checkout page, close it, keep access.
    expect(isEntitled({ ...base, status: 'INCOMPLETE' }, now)).toBe(false);
  });

  it('entitles an active one', () => {
    expect(isEntitled({ ...base, status: 'ACTIVE' }, now)).toBe(true);
  });

  it('stops entitling a trial the moment it ends, without waiting for a job', () => {
    const trial = {
      ...base,
      status: 'TRIALING' as const,
      trialEndsAt: utc('2026-03-10T00:00:00Z'),
    };
    expect(isEntitled(trial, utc('2026-03-09T00:00:00Z'))).toBe(true);
    expect(isEntitled(trial, now)).toBe(false);
  });

  it('keeps a past-due clinic working through the grace period', () => {
    const pastDue = {
      ...base,
      status: 'PAST_DUE' as const,
      gracePeriodEnd: utc('2026-03-20T00:00:00Z'),
    };
    expect(isEntitled(pastDue, now)).toBe(true);
    expect(isEntitled(pastDue, utc('2026-03-21T00:00:00Z'))).toBe(false);
  });

  it('defaults the grace window when nothing set one', () => {
    const pastDue = { ...base, status: 'PAST_DUE' as const };
    const withinDefault = new Date(
      base.currentPeriodEnd.getTime() + (GRACE_PERIOD_DAYS - 1) * 86_400_000
    );
    const after = new Date(base.currentPeriodEnd.getTime() + (GRACE_PERIOD_DAYS + 1) * 86_400_000);
    expect(isEntitled(pastDue, withinDefault)).toBe(true);
    expect(isEntitled(pastDue, after)).toBe(false);
  });

  it('refuses a fresh checkout on an active subscription, which must upgrade instead', () => {
    expect(canStartCheckout('ACTIVE')).toBe(false);
    expect(canStartCheckout('TRIALING')).toBe(true);
    expect(canStartCheckout('EXPIRED')).toBe(true);
  });

  it('refuses an upgrade on a subscription that has ended', () => {
    expect(canUpgrade('CANCELED')).toBe(false);
    expect(canUpgrade('ACTIVE')).toBe(true);
  });
});

describe('dunning schedule', () => {
  const failedAt = utc('2026-03-01T00:00:00Z');

  it('front-loads the first retry and spaces out the rest', () => {
    expect(nextDunningAt(failedAt, 0)?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(nextDunningAt(failedAt, 1)?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(nextDunningAt(failedAt, 3)?.toISOString()).toBe('2026-03-13T00:00:00.000Z');
  });

  it('runs out of road before the grace period ends, so a last try is always made', () => {
    const last = nextDunningAt(failedAt, 3);
    const graceEnds = new Date(failedAt.getTime() + GRACE_PERIOD_DAYS * 86_400_000);
    expect(last).not.toBeNull();
    expect(last!.getTime()).toBeLessThan(graceEnds.getTime());
    expect(nextDunningAt(failedAt, 4)).toBeNull();
  });
});

describe('mandate ceiling', () => {
  it('carries headroom for a later upgrade or price rise', () => {
    expect(mandateCeiling(money(499_900, 'INR')).amountMinor).toBe(1_499_700);
  });
});

describe('invoice numbers', () => {
  const organizationId = '4f73c779-7ec4-4e8c-8766-5cfc14fdd2b8';

  it('is readable, sequential and scoped to the clinic', () => {
    expect(
      formatInvoiceNumber({
        organizationId,
        countThisYear: 11,
        issuedAt: utc('2026-03-01T00:00:00Z'),
      })
    ).toBe('INV-2026-4F73C7-000012');
  });

  it('restarts the sequence each year but keeps the tenant fragment', () => {
    const a = formatInvoiceNumber({
      organizationId,
      countThisYear: 0,
      issuedAt: utc('2026-12-31T23:59:59Z'),
    });
    const b = formatInvoiceNumber({
      organizationId,
      countThisYear: 0,
      issuedAt: utc('2027-01-01T00:00:01Z'),
    });
    expect(a).toBe('INV-2026-4F73C7-000001');
    expect(b).toBe('INV-2027-4F73C7-000001');
  });

  it('separates two clinics that both reach number one', () => {
    const other = '99999999-0000-0000-0000-000000000000';
    const at = utc('2026-03-01T00:00:00Z');
    expect(formatInvoiceNumber({ organizationId, countThisYear: 0, issuedAt: at })).not.toBe(
      formatInvoiceNumber({ organizationId: other, countThisYear: 0, issuedAt: at })
    );
  });
});

describe('how a customer-present checkout is presented', () => {
  /*
   * `PAYMENTS_CHECKOUT_PRESENTATION` and `PAYMENT_PROVIDER` are independent
   * variables, so every combination of the two is reachable in a real
   * deployment — including the one where a deployment asks for a widget from an
   * acquirer that has none. That is a normal state and must degrade, because the
   * alternative is a checkout screen that renders an empty container and a
   * clinic that cannot pay.
   */
  const runtimeWith = (
    embeddedCheckout: boolean,
    checkoutPresentation?: 'redirect' | 'embedded'
  ): BillingRuntime =>
    ({
      provider: { name: 'mock', capabilities: { embeddedCheckout } },
      tenantUrl: 'https://alpha.example.test',
      webhookUrl: 'https://api.example.test/api/v1/webhooks/payments/mock',
      ...(checkoutPresentation ? { checkoutPresentation } : {}),
    }) as unknown as BillingRuntime;

  it('mounts a widget when the deployment asks and the provider can', () => {
    expect(presentationFor(runtimeWith(true, 'embedded'))).toBe('embedded');
  });

  it('falls back to the hosted page when the provider has no widget', () => {
    expect(presentationFor(runtimeWith(false, 'embedded'))).toBe('redirect');
  });

  it('redirects when the deployment asks for it, widget or not', () => {
    expect(presentationFor(runtimeWith(true, 'redirect'))).toBe('redirect');
  });

  it('defaults to redirect when the deployment says nothing', () => {
    // The floor. Every provider supports it, so an unset variable can never
    // produce a checkout nobody can complete.
    expect(presentationFor(runtimeWith(true))).toBe('redirect');
  });
});
