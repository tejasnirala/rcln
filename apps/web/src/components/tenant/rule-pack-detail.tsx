import Link from 'next/link';
import type { RegulatoryRuleDetail, RulePackSummary } from '@rcln/contracts';
import { MaturityRail } from '@/components/tenant/maturity-rail';

/**
 * One pack, its rules, and how far it has actually got.
 *
 * ⚠️ THE RULE'S OWN SENTENCE IS WHAT IS SHOWN, VERBATIM. `statement` is the text
 *   a pharmacist is handed when this rule refuses a dispense, so showing
 *   anything else here — a summary, a prettier paraphrase — would mean the
 *   screen that explains the rules and the counter that applies them disagree
 *   about what they say.
 *
 * ⚠️ THE PARAMETERS ARE SHOWN AS THE DOCUMENT THEY ARE, not flattened into prose.
 *   Their shape varies by jurisdiction on purpose; inventing a rendering per
 *   rule type would be a second interpretation of the rule, in a place nobody
 *   tests, and the one that quietly disagreed with the engine would be the one
 *   people trust.
 *
 * A server component: nothing here is interactive, and there is nothing to save.
 */
export function RulePackDetail({
  pack,
  rules,
  timezone,
}: {
  pack: RulePackSummary;
  rules: RegulatoryRuleDetail[];
  /** The branch's zone, for the one instant on this screen. */
  timezone: string;
}) {
  const live = rules.filter((rule) => rule.isLive);
  const other = rules.filter((rule) => !rule.isLive);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link
          href="/regulatory/rule-packs"
          className="text-muted hover:text-drape text-[0.8125rem]"
        >
          ← Rule packs
        </Link>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {pack.name}
          </h1>
          <span className="text-muted font-mono text-[0.8125rem]">
            {pack.jurisdictionLabel} · v{pack.version}
          </span>
        </div>
        <p className="text-muted max-w-prose text-[0.875rem]">
          {pack.description ??
            `Published by ${pack.authorityCode}. In force from ${pack.effectiveFrom}${
              pack.effectiveTo ? ` to ${pack.effectiveTo}` : ''
            }.`}
        </p>
      </header>

      <MaturityRail
        maturity={pack.maturity}
        reviewedBy={pack.reviewedBy}
        reviewedAt={pack.reviewedAt}
        timezone={timezone}
      />

      {pack.reviewNotes ? (
        <section className="border-rule bg-card rounded-md border p-4">
          <h2 className="text-ink text-[0.9375rem] font-medium">What the reviewer said</h2>
          <p className="text-muted mt-1 max-w-prose text-[0.875rem]">{pack.reviewNotes}</p>
        </section>
      ) : null}

      <RuleTable
        heading="In force today"
        emptyLine="No rule in this pack is in force today. Every question about this place comes back undetermined, which means the answer is no."
        rules={live}
      />

      {other.length > 0 ? (
        <RuleTable
          heading="Not in force"
          emptyLine=""
          rules={other}
          note="Drafts, rules that have been replaced, and rules whose dates have passed. They are kept because a dispense decided under one has to stay explicable."
        />
      ) : null}
    </div>
  );
}

function RuleTable({
  heading,
  emptyLine,
  rules,
  note,
}: {
  heading: string;
  emptyLine: string;
  rules: RegulatoryRuleDetail[];
  note?: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-ink text-[1.0625rem] font-medium">{heading}</h2>
      {note ? <p className="text-muted max-w-prose text-[0.8125rem]">{note}</p> : null}

      {rules.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-6">
          <p className="text-muted text-[0.875rem]">{emptyLine}</p>
        </div>
      ) : (
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {rules.map((rule) => (
            <li key={rule.id} className="space-y-2 px-4 py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-ink font-mono text-[0.8125rem]">{rule.code}</span>
                <span className="text-muted text-[0.8125rem]">
                  {rule.ruleType.toLowerCase().replace(/_/g, ' ')}
                </span>
                <span className="text-muted ml-auto font-mono text-[0.75rem]">
                  from {rule.effectiveFrom}
                  {rule.effectiveTo ? ` to ${rule.effectiveTo}` : ''}
                </span>
              </div>

              <p className="text-ink max-w-prose text-[0.875rem]">{rule.statement}</p>

              <p className="text-muted text-[0.8125rem]">
                Applies to{' '}
                {rule.appliesToClassification ??
                  (rule.appliesToProductType
                    ? rule.appliesToProductType.toLowerCase().replace(/_/g, ' ')
                    : rule.appliesToCategoryId
                      ? 'one product category'
                      : 'every product')}
                {rule.appliesToTransactions.length > 0
                  ? ` · ${rule.appliesToTransactions.map((t) => t.toLowerCase().replace(/_/g, ' ')).join(', ')}`
                  : ' · every kind of transaction'}
              </p>

              <details className="text-[0.8125rem]">
                <summary className="text-muted hover:text-ink cursor-pointer">
                  Says who, and on what terms
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-muted">
                    {rule.sourceTitle}
                    {rule.sourceUrl ? (
                      <>
                        {' — '}
                        <a
                          href={rule.sourceUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                          className="text-drape underline"
                        >
                          read it
                        </a>
                      </>
                    ) : null}
                  </p>
                  <pre className="border-rule text-muted overflow-x-auto rounded-md border p-3 font-mono text-[0.75rem]">
                    {JSON.stringify(rule.parameters, null, 2)}
                  </pre>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
