/**
 * Subscription plans, their per-currency prices and their feature limits.
 */
import { prisma } from './client.js';

export async function seedPlans(): Promise<void> {
  const plans = [
    {
      code: 'STARTER',
      name: 'Starter',
      tagline: 'A single clinic finding its feet',
      trialDays: 14,
      sortOrder: 1,
      prices: { INR: 1499, USD: 19, EUR: 19, GBP: 16, AED: 69, SGD: 25, AUD: 29 },
      features: {
        max_branches: 1,
        max_users: 10,
        max_patients: 2000,
        pharmacy_module: false,
        lab_module: false,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'GROWTH',
      name: 'Growth',
      tagline: 'Multi-branch, pharmacy and lab included',
      trialDays: 14,
      sortOrder: 2,
      prices: { INR: 4999, USD: 59, EUR: 55, GBP: 49, AED: 219, SGD: 79, AUD: 89 },
      features: {
        max_branches: 5,
        max_users: 50,
        max_patients: 25000,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: false,
      },
    },
    {
      code: 'ENTERPRISE',
      name: 'Enterprise',
      tagline: 'Hospital chains, unlimited branches',
      trialDays: 30,
      sortOrder: 3,
      prices: { INR: 14999, USD: 179, EUR: 169, GBP: 149, AED: 659, SGD: 239, AUD: 269 },
      features: {
        max_branches: -1,
        max_users: -1,
        max_patients: -1,
        pharmacy_module: true,
        lab_module: true,
        whatsapp_notifications: true,
        custom_domain: true,
      },
    },
  ];

  for (const p of plans) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, tagline: p.tagline, trialDays: p.trialDays, sortOrder: p.sortOrder },
      create: {
        code: p.code,
        name: p.name,
        tagline: p.tagline,
        trialDays: p.trialDays,
        sortOrder: p.sortOrder,
      },
    });

    /*
     * Priced per currency, and NOT converted from the rupee figure.
     *
     * A published price is a commercial decision, not an exchange-rate
     * calculation: $59 is a price somebody chose, and ₹4999 at today's rate is
     * not. Converting here would also make every plan's price move whenever the
     * rate did, which is not something a customer or a finance team can work
     * with. `@rcln/payments` deliberately contains no FX for the same reason.
     *
     * A currency a plan has no row for is simply not purchasable in that
     * currency — `listPlans` omits the plan rather than showing a price that
     * would fail at checkout.
     *
     * Annual is ten months' price in every currency: two months free, which is
     * the discount the marketing page states.
     */
    for (const [currency, monthly] of Object.entries(p.prices)) {
      for (const [interval, amount] of [
        ['MONTH', monthly],
        ['YEAR', monthly * 10],
      ] as const) {
        await prisma.planPrice.upsert({
          where: {
            planId_currency_billingInterval: {
              planId: plan.id,
              currency,
              billingInterval: interval,
            },
          },
          update: { amount },
          create: { planId: plan.id, currency, billingInterval: interval, amount },
        });
      }
    }

    for (const [featureKey, value] of Object.entries(p.features)) {
      const isBool = typeof value === 'boolean';
      const payload = {
        valueType: (isBool ? 'BOOL' : 'INT') as 'BOOL' | 'INT',
        intValue: isBool ? null : (value as number),
        boolValue: isBool ? (value as boolean) : null,
      };
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey } },
        update: payload,
        create: { planId: plan.id, featureKey, ...payload },
      });
    }
  }

  console.warn(`  plans            ${plans.length}`);
}
