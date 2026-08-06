/**
 * Where the clinic is in its billing period — the signature of this screen.
 *
 * WHY THIS AND NOT A DATE
 *   Every other screen in this app puts the thing that is normally hidden
 *   behind an edit button onto the row instead: the week strip on branches, the
 *   module strip on roles, the access ladder on staff. The billing equivalent
 *   is proration. "You will be charged ₹10,000.00" is a number a clinic has to
 *   take on trust; "17 of 31 days left, so you are credited for the 17 you have
 *   not used and charged for the same 17 on the new plan" is the same number
 *   with its reasoning visible — and proration IS literally a fraction of this
 *   bar, so drawing it is showing the mechanism rather than decorating it.
 *
 *   That is also why the split is rendered on the SAME bar the clinic already
 *   reads for "when does this renew". It is one object in two states, not a
 *   chart that appears when you hover a plan.
 *
 * ACCESSIBILITY
 *   The bar is `aria-hidden` and every fact it draws is stated in text
 *   underneath — colour is never the only carrier of meaning (WCAG 1.4.1), and
 *   a proportion drawn in a div is invisible to a screen reader however it is
 *   labelled. The text is the content; the bar is the illustration.
 */

import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

export interface PeriodStripProps {
  start: string;
  end: string;
  /**
   * Now, as an ISO string — REQUIRED, and it must come from the server.
   *
   * ⚠️ It used to default to `new Date()`, which is a hydration failure by
   *   construction: the server renders a percentage from its clock, the browser
   *   renders one from its own milliseconds later, the two strings differ, and
   *   React throws the whole subtree away and re-renders it. Passing one instant
   *   down from the page is what makes both renders agree.
   */
  at: string;
  /**
   * When set, the strip is showing what an upgrade would cost rather than where
   * the period is. The remaining span is the part being prorated.
   */
  proration?: {
    remainingDays: number;
    periodDays: number;
  };
  /** Dimmed and captioned when the subscription is not currently entitled. */
  muted?: boolean;
}

/**
 * How far through the period we are, as a percentage.
 *
 * Rounded to two decimals so the style attribute is a short, stable string.
 * Rounding alone would NOT have fixed the hydration mismatch — a server and a
 * browser milliseconds apart can still land either side of any rounding
 * boundary — which is why `at` is passed in rather than read from the clock.
 * This is here to keep the markup readable.
 */
function percentElapsed(start: Date, end: Date, at: Date): number {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 100;
  const elapsed = at.getTime() - start.getTime();
  const ratio = Math.min(100, Math.max(0, (elapsed / span) * 100));
  return Math.round(ratio * 100) / 100;
}

export function PeriodStrip({ start, end, at, proration, muted }: PeriodStripProps) {
  const from = new Date(start);
  const to = new Date(end);
  const now = new Date(at);

  // Driven by the day counts when they are given, so the bar and the sentence
  // below it can never disagree — the arithmetic on the invoice is in days, not
  // in milliseconds.
  const elapsed = proration
    ? ((proration.periodDays - proration.remainingDays) / proration.periodDays) * 100
    : percentElapsed(from, to, now);

  return (
    <div>
      <div
        aria-hidden="true"
        className={cn(
          'border-rule bg-drape-tint/40 relative h-2 w-full overflow-hidden rounded-full border',
          muted && 'opacity-50'
        )}
      >
        {/* The part already used. */}
        <div
          className="bg-drape/35 absolute inset-y-0 left-0"
          style={{ width: `${String(elapsed)}%` }}
        />
        {/* The part being prorated, drawn solid because it is what is priced. */}
        {proration ? (
          <div
            className="bg-drape absolute inset-y-0 right-0"
            style={{ width: `${String(100 - elapsed)}%` }}
          />
        ) : (
          <div
            className="bg-drape absolute inset-y-0 w-0.5"
            style={{ left: `${String(elapsed)}%` }}
          />
        )}
      </div>

      <p className="text-muted mt-2 font-mono text-[0.75rem]">
        {/* formatDate, not toLocaleDateString — see the header of lib/format.ts.
            A UTC date rendered in the viewer's zone lands on a different DAY. */}
        <span className="text-ink">{formatDate(from)}</span>
        {' → '}
        <span className="text-ink">{formatDate(to)}</span>
        {proration ? (
          <>
            {' · '}
            {proration.remainingDays} of {proration.periodDays} days left
          </>
        ) : null}
      </p>
    </div>
  );
}
