/**
 * Of the rules we were handed, which ones actually speak to THIS transaction?
 *
 * Everything here is a filter or an ordering. No rule is interpreted — that is
 * `engine.ts` — and no row is loaded, because this package reads no database.
 *
 * ── THE THREE QUESTIONS, IN ORDER ────────────────────────────────────────────
 *   1. is the rule live?           status ACTIVE, and the day inside its window
 *   2. does it speak to this?      jurisdiction, transaction, product
 *   3. of those, which WINS?       the most specific, per rule type
 *
 * ⚠️ STEP 3 IS THE ONE THAT IS EASY TO LEAVE OUT AND IMPOSSIBLE TO NOTICE
 *   MISSING. Without it a state override does not override anything: the
 *   national rule is always present, always applies, and a refusal it produces
 *   looks exactly like a correct refusal. The state rule is configured, visible
 *   in the screen, and inert. `resolveTaxCategory` shipped with that exact bug
 *   inverted (see its comment about NULLS FIRST), which is why this file spells
 *   the ordering out instead of relying on one.
 */
import type {
  Jurisdiction,
  RegulatoryRequest,
  RegulatoryRule,
  RegulatoryRuleType,
} from './types.js';

/**
 * An instant flattened to the UTC midnight of its own calendar day, so it is
 * comparable with a `@db.Date` column.
 *
 * ⚠️ NEVER COMPARE ONE OF THESE COLUMNS TO AN INSTANT. Prisma hands a `Date`
 *   column back at UTC midnight, so `effectiveTo >= new Date()` reads false from
 *   nine in the morning on the row's own last valid day — the window closes a
 *   day early, every day, silently. The identical helper and the identical
 *   warning live in `apps/api/src/services/product/values.ts`; this is a second
 *   copy because a pure package may not import from an application, and the two
 *   must not drift.
 *
 * ⚠️ THE DAY IS TAKEN IN UTC, WHICH MAKES `occurredAt` THE CALLER'S PROBLEM.
 *   Which day a dispense happened on is a wall-clock fact in the BRANCH's zone
 *   (invariant 6), and this package has no zone. So the caller works the day out
 *   the way `resolveTaxCategory`'s callers already do and passes the instant in;
 *   this only flattens it.
 */
export function startOfCalendarDay(value: Date): Date {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** `IN-KA` where a region is known, otherwise `IN`. Matches `@rcln/tax`. */
export function formatJurisdiction(place: Jurisdiction): string {
  const country = place.countryCode.toUpperCase();
  const region = place.regionCode?.toUpperCase();
  return region ? `${country}-${region}` : country;
}

/** Is this rule live on this day? Inclusive of `effectiveTo`, as everywhere else. */
export function isInForce(rule: RegulatoryRule, on: Date): boolean {
  if (rule.status !== 'ACTIVE') return false;
  const day = startOfCalendarDay(on).getTime();
  if (startOfCalendarDay(rule.effectiveFrom).getTime() > day) return false;
  if (rule.effectiveTo === null) return true;
  return startOfCalendarDay(rule.effectiveTo).getTime() >= day;
}

/**
 * Does a rule's jurisdiction cover the place the transaction happens?
 *
 * A country-wide rule covers every region of that country. A regional rule
 * covers only its own region. Whether the regional one then SUPERSEDES the
 * national one is `mostSpecific` below — covering and winning are different
 * questions, and merging them is how a national rule stops applying in a state
 * that only meant to add to it.
 */
export function coversJurisdiction(rule: Jurisdiction, place: Jurisdiction): boolean {
  if (rule.countryCode.toUpperCase() !== place.countryCode.toUpperCase()) return false;
  if (rule.regionCode === null) return true;
  if (place.regionCode === null) return false;
  return rule.regionCode.toUpperCase() === place.regionCode.toUpperCase();
}

/** Empty means every transaction — see the schema comment. */
export function coversTransaction(rule: RegulatoryRule, request: RegulatoryRequest): boolean {
  if (rule.appliesToTransactions.length === 0) return true;
  return rule.appliesToTransactions.includes(request.transaction);
}

/**
 * Does the rule speak about this product?
 *
 * ⚠️ ALL THREE NARROWERS NULL MEANS EVERY PRODUCT, AND THAT IS A REAL RULE — a
 *   record-retention or disposal obligation usually is. It is the LEAST specific
 *   match rather than a default.
 *
 * ⚠️ A CLASSIFICATION RULE AGAINST A PRODUCT WITH NO PROFILE DOES NOT APPLY, AND
 *   THAT IS NOT A PERMISSION. It falls out of the applicable set, and if nothing
 *   else applies the decision is `UNDETERMINED`, which refuses. The failure is
 *   visible and the remedy is a profile, which is exactly the state a
 *   clinic-created product starts in.
 */
export function coversProduct(rule: RegulatoryRule, request: RegulatoryRequest): boolean {
  if (rule.appliesToProductType !== null && rule.appliesToProductType !== request.product.type) {
    return false;
  }

  if (
    rule.appliesToCategoryId !== null &&
    !request.product.categoryPath.includes(rule.appliesToCategoryId)
  ) {
    return false;
  }

  if (rule.appliesToClassification !== null) {
    const classification = request.profile?.classification ?? null;
    // Exact match, the way `tax_category` keys `tax_rules`. Never parsed, never
    // case-folded: `SCHEDULE_H` and `Schedule H` are two different assertions
    // and guessing which one a clinic meant is the whole failure mode.
    if (classification !== rule.appliesToClassification) return false;
  }

  return true;
}

/**
 * How narrowly a rule is aimed. Higher wins.
 *
 * The weights are ordered, not additive-by-coincidence: a rule naming the
 * classification is the most specific statement anybody can make about a product
 * ("Schedule H medicines"), a category is next, a bare product type is the
 * broadest narrowing, and nothing is the catch-all. A rule naming two of them is
 * more specific than one naming either alone, which is why they sum.
 */
export function specificity(rule: RegulatoryRule): number {
  return (
    (rule.appliesToClassification !== null ? 4 : 0) +
    (rule.appliesToCategoryId !== null ? 2 : 0) +
    (rule.appliesToProductType !== null ? 1 : 0)
  );
}

/**
 * Of the rules that apply, the ones that WIN — decided per rule TYPE.
 *
 * ⚠️ PER TYPE, AND THAT IS THE DESIGN. A state's quantity limit supersedes the
 *   national quantity limit; it says nothing whatever about the national
 *   labelling requirement, which continues to apply. Superseding across types
 *   would let a state rule about packaging silently switch off a national rule
 *   about prescriptions, which is not how any of these systems work.
 *
 * Two tie-breaks, in order:
 *   1. jurisdiction — a regional rule beats a country-wide one
 *   2. specificity  — a classification beats a category beats a type
 *
 * ⚠️ TIES ARE KEPT, NOT BROKEN. Two equally specific rules of one type both
 *   apply, and the engine evaluates BOTH. There is no honest way to pick, and
 *   picking one silently is how a refusal disappears. If they disagree the
 *   engine refuses, because a refusal beats a permission everywhere in this
 *   package.
 */
export function mostSpecific(rules: readonly RegulatoryRule[]): RegulatoryRule[] {
  const byType = new Map<RegulatoryRuleType, RegulatoryRule[]>();
  for (const rule of rules) {
    const group = byType.get(rule.ruleType) ?? [];
    group.push(rule);
    byType.set(rule.ruleType, group);
  }

  const winners: RegulatoryRule[] = [];
  for (const group of byType.values()) {
    const regional = group.filter((r) => r.jurisdiction.regionCode !== null);
    const level = regional.length > 0 ? regional : group;

    let best = -1;
    for (const rule of level) best = Math.max(best, specificity(rule));
    winners.push(...level.filter((r) => specificity(r) === best));
  }

  return winners;
}

/**
 * The whole selection, in the order the file header describes.
 *
 * Returned sorted by rule type and then code, so a decision's reasons come out
 * in a stable order — a caller that snapshots them (PI-ADR-008) must not record
 * a different document for the same inputs on two runs.
 */
export function selectApplicableRules(request: RegulatoryRequest): RegulatoryRule[] {
  const live = request.rules.filter(
    (rule) =>
      isInForce(rule, request.occurredAt) &&
      coversJurisdiction(rule.jurisdiction, request.jurisdiction) &&
      coversTransaction(rule, request) &&
      coversProduct(rule, request)
  );

  return mostSpecific(live).sort((a, b) =>
    a.ruleType === b.ruleType ? a.code.localeCompare(b.code) : a.ruleType.localeCompare(b.ruleType)
  );
}

/**
 * The product types whose supply is decided by a CLASSIFICATION, everywhere.
 *
 * ⚠️ THIS IS AN ARCHITECTURAL STATEMENT, NOT A JURISDICTIONAL ONE, AND THE
 *   DIFFERENCE IS WHY IT IS ALLOWED TO LIVE IN A PACKAGE THAT MAY CONTAIN NO
 *   COUNTRY'S RULES. Every jurisdiction that regulates supply at all regulates
 *   the supply of MEDICINES by putting them in classes — schedules, POM/GSL,
 *   legend drugs — and none of them classifies a bandage. The list says which
 *   products a missing classification is a GAP for; it says nothing about what
 *   any classification means or what follows from it, which stays entirely in
 *   the rule rows.
 *
 * Widening it is cheap and safe (more things demand a profile); narrowing it is
 * how a regulated product starts being supplied on the strength of an absence.
 */
const CLASSIFIED_PRODUCT_TYPES: readonly string[] = ['MEDICINE', 'VACCINE', 'VETERINARY_MEDICINE'];

/**
 * Has this jurisdiction made the classification decisive for a product nobody
 * has classified?
 *
 * ⚠️ THIS CLOSES A FAIL-OPEN THAT ONLY APPEARS ONCE A JURISDICTION IS ACTUALLY
 *   CONFIGURED, WHICH IS WHY IT SURVIVED PI-5 UNNOTICED. `coversProduct` drops a
 *   classification-keyed rule when the product has no profile, and the schema
 *   comment is right that dropping it "is not a permission" — but only while
 *   NOTHING else applies, because then the decision is `UNDETERMINED`. The
 *   moment a pack also carries rules that apply to EVERY product — a retention
 *   obligation, a "who may dispense" rule, both of which every real pack has —
 *   those rules apply, they permit, and an unclassified prescription-only
 *   medicine comes back `PERMITTED_WITH_CONDITIONS` with no prescription rule
 *   anywhere in its reasons. The gap is invisible precisely because the decision
 *   looks fully reasoned.
 *
 * So: if the jurisdiction has a live rule keyed on a classification that would
 * match this product but for the classification, and the product has none, the
 * question is unanswerable rather than answered. `UNDETERMINED`, which refuses,
 * and the remedy is the profile — which is what the reason says.
 */
export function needsClassificationButHasNone(request: RegulatoryRequest): boolean {
  if (!CLASSIFIED_PRODUCT_TYPES.includes(request.product.type)) return false;

  const classification = request.profile?.classification ?? null;
  if (classification !== null) return false;

  return request.rules.some((rule) => {
    if (rule.appliesToClassification === null) return false;
    if (!isInForce(rule, request.occurredAt)) return false;
    if (!coversJurisdiction(rule.jurisdiction, request.jurisdiction)) return false;
    if (!coversTransaction(rule, request)) return false;

    /*
     * Everything `coversProduct` checks EXCEPT the classification — that is the
     * whole question. A Schedule X storage rule aimed at a product type this
     * product is not must not make every other product undecidable.
     */
    if (rule.appliesToProductType !== null && rule.appliesToProductType !== request.product.type) {
      return false;
    }
    if (
      rule.appliesToCategoryId !== null &&
      !request.product.categoryPath.includes(rule.appliesToCategoryId)
    ) {
      return false;
    }
    return true;
  });
}

/** Is a profile the one that applies on this day? Same window rules as a rule. */
export function isProfileInForce(
  profile: { effectiveFrom: Date; effectiveTo: Date | null },
  on: Date
): boolean {
  const day = startOfCalendarDay(on).getTime();
  if (startOfCalendarDay(profile.effectiveFrom).getTime() > day) return false;
  if (profile.effectiveTo === null) return true;
  return startOfCalendarDay(profile.effectiveTo).getTime() >= day;
}
