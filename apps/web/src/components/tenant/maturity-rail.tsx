import type { RulePackMaturity } from '@rcln/contracts';
import { formatClinicDate } from '@/lib/format';

/**
 * How far a jurisdiction's rules have actually got — as a rail, not a badge.
 *
 * ⚠️ THIS IS THE ONE PIECE OF DESIGN IN THE SECTION THAT IS ALLOWED TO BE LOUD,
 *   AND IT IS LOUD ABOUT AN ABSENCE. A badge reading "Source verified" is
 *   flattering and says nothing about the two steps still missing; the rail
 *   shows all eight and leaves the unreached ones visibly empty, so what a pack
 *   has NOT been through is the part that reads first. Silence must never imply
 *   compliance (PI-ADR-009), and a green tick is a kind of silence.
 *
 * ⚠️ THE GAP BEFORE THE LAST TWO IS STRUCTURAL, NOT DECORATIVE. Steps one to six
 *   are things the platform does; the last two are a named person's decision and
 *   no code path can reach them. The break in the rail is where the software
 *   stops, and it is the only place in this product where a divider means "a
 *   human has to do this bit".
 *
 * No colour carries meaning on its own: every state is also a word (WCAG 1.4.1).
 */
const LADDER: { key: RulePackMaturity; label: string }[] = [
  { key: 'ARCHITECTURE_SUPPORTED', label: 'Expressible' },
  { key: 'RULES_CONFIGURED', label: 'Written' },
  { key: 'RULES_IMPLEMENTED', label: 'Acted on' },
  { key: 'AUTOMATED_TESTED', label: 'Tested' },
  { key: 'SOURCE_VERIFIED', label: 'Sources checked' },
  { key: 'REGULATORY_REVIEW_PENDING', label: 'Sent for review' },
  { key: 'REGULATORY_REVIEWED', label: 'Reviewed' },
  { key: 'PRODUCTION_ENABLED', label: 'Live' },
];

/** Where the platform's work ends and a person's begins. */
const HUMAN_STEPS = 2;

export function maturityLabel(maturity: RulePackMaturity): string {
  return LADDER.find((step) => step.key === maturity)?.label ?? maturity;
}

export function MaturityRail({
  maturity,
  reviewedBy,
  reviewedAt,
  timezone,
}: {
  maturity: RulePackMaturity;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  /**
   * The branch's zone. ⚠️ `reviewedAt` is an INSTANT, and slicing its ISO string
   *   rendered the UTC day — so a sign-off recorded at 09:00 IST showed as the
   *   previous date to the clinic that made it. Invariant 6.
   */
  timezone: string;
}) {
  const reached = LADDER.findIndex((step) => step.key === maturity);
  const platformSteps = LADDER.length - HUMAN_STEPS;

  return (
    <section className="border-rule bg-card space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-ink text-[0.9375rem] font-medium">
          {maturity === 'PRODUCTION_ENABLED'
            ? 'Signed off and live'
            : `As far as this has got: ${maturityLabel(maturity)}`}
        </h2>
        <p className="text-muted text-[0.8125rem]">
          {reviewedBy
            ? `Reviewed by ${reviewedBy}${
                reviewedAt ? ` on ${formatClinicDate(reviewedAt, timezone)}` : ''
              }`
            : 'Not yet reviewed by a qualified person'}
        </p>
      </div>

      <ol className="flex flex-wrap items-stretch gap-x-1 gap-y-3">
        {LADDER.map((step, index) => {
          const done = index <= reached;
          const isFirstHumanStep = index === platformSteps;

          return (
            <li key={step.key} className={isFirstHumanStep ? 'border-rule ml-3 border-l pl-4' : ''}>
              <div
                aria-hidden="true"
                className={
                  done
                    ? 'bg-drape h-1 w-16 rounded-full sm:w-20'
                    : 'bg-rule h-1 w-16 rounded-full opacity-50 sm:w-20'
                }
              />
              <p
                className={
                  done
                    ? 'text-ink mt-1.5 text-[0.75rem]'
                    : 'text-muted mt-1.5 text-[0.75rem] opacity-70'
                }
              >
                {step.label}
                <span className="sr-only">{done ? ' — done' : ' — not yet'}</span>
              </p>
            </li>
          );
        })}
      </ol>

      <p className="text-muted max-w-prose text-[0.8125rem]">
        {maturity === 'PRODUCTION_ENABLED'
          ? 'A named person signed these rules off and decided the platform may act on them. That is a review of the configuration, not a legal opinion about your clinic.'
          : 'These rules are configuration, not compliance. The last two steps are a named person’s decision and nothing in this software can take them.'}
      </p>
    </section>
  );
}
