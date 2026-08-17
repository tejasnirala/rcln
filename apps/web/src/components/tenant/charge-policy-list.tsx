'use client';

import { useActionState, useState } from 'react';
import type { ChargePolicyRuleListResponse } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ChargesNav } from '@/components/tenant/charges-nav';
import {
  deleteChargePolicyAction,
  saveChargePolicyAction,
  IDLE_CHARGE_FORM,
  type ChargeFormState,
} from '@/app/(tenant)/t/[slug]/(app)/charges/actions';

/**
 * What this clinic bills for at all.
 *
 * ⚠️ THE SCREEN IS ORDERED BY HOW SPECIFIC A RULE IS, NOT BY WHEN IT WAS WRITTEN,
 *   BECAUSE THAT ORDER *IS* THE ANSWER. The resolver takes the most specific
 *   match and stops; a list sorted by date would show three rules that could all
 *   apply to one product with nothing saying which wins. Grouping them by tier —
 *   product, then category, then kind — makes the precedence readable as a shape
 *   rather than as a paragraph somebody has to remember.
 *
 * ⚠️ AND THE DEFAULT IS SHOWN AS A ROW AT THE BOTTOM, even though no rule
 *   produces it. A clinic with an empty policy table is not a clinic that bills
 *   for nothing — medicines and implants are billed and consumables are not, and
 *   a screen that rendered "no rules" would hide the answer that is actually in
 *   force everywhere.
 *
 * ⚠️ NOT PHI. A policy is a fact about a catalogue row.
 */
const POLICIES = [
  { value: 'SEPARATELY_BILLABLE', label: 'Billed as its own line' },
  { value: 'NEVER_BILL', label: 'Never billed' },
  { value: 'INCLUDED_IN_SERVICE', label: 'Included in the service fee' },
  { value: 'OPTIONAL', label: 'Someone decides at the till' },
  { value: 'CONTRACT_DEFINED', label: 'The payer contract decides' },
  { value: 'JURISDICTION_CONFIGURED', label: 'The local rules decide' },
];

const POLICY_LABEL = Object.fromEntries(POLICIES.map((p) => [p.value, p.label]));

const PRODUCT_TYPES = [
  'MEDICINE',
  'VACCINE',
  'CONSUMABLE',
  'SURGICAL_SUPPLY',
  'MEDICAL_DEVICE',
  'IMPLANT',
  'DENTAL_MATERIAL',
  'LAB_REAGENT',
  'DIAGNOSTIC_KIT',
  'VETERINARY_MEDICINE',
  'VETERINARY_CONSUMABLE',
  'GENERAL_CLINICAL_SUPPLY',
];

/** Sentence case from an enum member — `SURGICAL_SUPPLY` → `Surgical supply`. */
function humanise(value: string): string {
  const words = value.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TIERS = [
  {
    scope: 'PRODUCT' as const,
    title: 'One product',
    hint: 'Beats everything below it.',
  },
  {
    scope: 'PRODUCT_CATEGORY' as const,
    title: 'A category',
    hint: 'Applies to the products filed directly under it, not to its sub-categories.',
  },
  {
    scope: 'PRODUCT_TYPE' as const,
    title: 'A kind of thing',
    hint: 'The broadest rule a clinic can write.',
  },
];

interface Props {
  slug: string;
  rules: ChargePolicyRuleListResponse;
  canManage: boolean;
}

export function ChargePolicyList({ slug, rules, canManage }: Props) {
  const [adding, setAdding] = useState(false);
  const [state, save, saving] = useActionState<ChargeFormState, FormData>(
    saveChargePolicyAction.bind(null, slug),
    IDLE_CHARGE_FORM
  );

  /*
   * Close the form once the rule lands, so the tier it joined is what is on
   * screen. Adjusted during render rather than in an effect — see the identical
   * note in `product-panel.tsx`'s `PriceTab`.
   */
  const [lastStatus, setLastStatus] = useState(state.status);
  if (state.status !== lastStatus) {
    setLastStatus(state.status);
    if (state.status === 'saved') setAdding(false);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Charge policy
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Which things reach a patient&rsquo;s bill, and which the clinic absorbs. The most specific
          rule wins.
        </p>
      </header>

      <ChargesNav />

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {canManage ? (
        adding ? (
          <form action={save} className="border-rule bg-card space-y-4 rounded-md border p-4">
            <Select
              label="This rule is about"
              name="scope"
              defaultValue="PRODUCT_TYPE"
              options={TIERS.map((tier) => ({ value: tier.scope, label: tier.title }))}
            />
            {/*
              ⚠️ THREE FIELDS, ONE OF WHICH IS USED. The action assembles the
                discriminated union from `scope`, so the server never receives two
                scoping values at once — which is the same thing the CHECK
                constraint refuses on the row. Sending all three and letting the
                server pick would make an impossible rule merely refused rather
                than unrepresentable.
            */}
            <Select
              label="Kind of thing"
              name="productType"
              hint="Used when the rule is about a kind of thing."
              options={PRODUCT_TYPES.map((value) => ({ value, label: humanise(value) }))}
            />
            <Input
              label="Product id"
              name="productId"
              hint="Used when the rule is about one product. Copy it from the catalogue."
            />
            <Input
              label="Category id"
              name="productCategoryId"
              hint="Used when the rule is about a category."
            />
            <Select label="Then it is" name="policy" options={POLICIES} />
            <Input label="Why" name="note" hint="For whoever reads this in a year." />

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving}
                className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save rule'}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="text-muted hover:text-ink text-[0.875rem]"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium"
          >
            Add a rule
          </button>
        )
      ) : null}

      {TIERS.map((tier) => {
        const inTier = rules.items.filter((rule) => rule.scope === tier.scope);
        return (
          <section key={tier.scope} className="space-y-2">
            <h2 className="text-ink text-[1rem]">{tier.title}</h2>
            <p className="text-muted text-[0.8125rem]">{tier.hint}</p>

            {inTier.length === 0 ? (
              <p className="border-rule text-muted rounded-md border border-dashed p-4 text-[0.875rem]">
                No rules at this level.
              </p>
            ) : (
              <ul className="space-y-2">
                {inTier.map((rule) => (
                  <PolicyRow key={rule.id} slug={slug} rule={rule} canManage={canManage} />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section className="space-y-2">
        <h2 className="text-ink text-[1rem]">When no rule matches</h2>
        <p className="text-muted text-[0.8125rem]">
          In force everywhere the rules above are silent. It cannot be edited — write a rule to
          change what happens.
        </p>
        <div className="border-rule bg-card rounded-md border p-4">
          <p className="text-ink text-[0.9375rem]">
            Medicines, vaccines, devices and implants are billed as their own line.
          </p>
          <p className="text-muted mt-1 text-[0.875rem]">
            Everything else — dressings, gloves, reagents, dental materials — is consumed and not
            charged for.
          </p>
        </div>
      </section>
    </div>
  );
}

function PolicyRow({
  slug,
  rule,
  canManage,
}: {
  slug: string;
  rule: ChargePolicyRuleListResponse['items'][number];
  canManage: boolean;
}) {
  const [, remove, removing] = useActionState<ChargeFormState, FormData>(async () => {
    await deleteChargePolicyAction(slug, rule.id);
    return IDLE_CHARGE_FORM;
  }, IDLE_CHARGE_FORM);

  const subject =
    rule.productName ??
    rule.productCategoryName ??
    (rule.productType ? humanise(rule.productType) : 'Unknown');

  return (
    <li className="border-rule bg-card flex flex-wrap items-center gap-4 rounded-md border p-4">
      <span className="min-w-48 flex-1">
        <span className="text-ink block text-[0.9375rem]">{subject}</span>
        {rule.note ? <span className="text-muted block text-[0.8125rem]">{rule.note}</span> : null}
      </span>
      <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
        {POLICY_LABEL[rule.policy] ?? rule.policy}
      </span>
      {canManage ? (
        <form action={remove}>
          <button
            type="submit"
            disabled={removing}
            className="text-muted hover:text-danger text-[0.875rem] disabled:opacity-40"
          >
            {removing ? 'Removing…' : 'Remove'}
          </button>
        </form>
      ) : null}
    </li>
  );
}
