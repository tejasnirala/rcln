/**
 * May this decision STOP a document, or may it only be reported?
 *
 * ── WHY THERE IS A GATE AT ALL ───────────────────────────────────────────────
 * ⚠️ `UNDETERMINED` REFUSES, AND ALMOST EVERY JURISDICTION ON THIS PLATFORM
 *   ANSWERS `UNDETERMINED` TODAY. Exactly one country has a rule pack. If goods
 *   receipt simply called the engine and threw on anything that was not
 *   `PERMITTED`, every clinic outside that one country would stop being able to
 *   receive stock the moment this shipped — not because anything is wrong with
 *   their stock, but because nobody has configured their law yet. That is the
 *   failure `evaluation.service.ts` has warned about since PI-5, and it is the
 *   reason PI-5 wired no call sites at all.
 *
 *   The engine's invariant is not weakened by this file. `UNDETERMINED` still
 *   means "nobody may rely on this", and that is exactly how it is reported. The
 *   gate answers a different question — whether THIS PLATFORM has been told it
 *   may act on the answer yet — and the honest answer is "only once a human has
 *   signed the pack off".
 *
 * ── THE THRESHOLD, AND WHY IT IS THE TOP OF THE LADDER ───────────────────────
 * `PRODUCTION_ENABLED` is the only maturity a code path may not set (PI-ADR-009):
 * it is a named human with `regulatory.pack.approve` deciding that the platform
 * may act on a jurisdiction's rules. Refusing a clinic's delivery IS acting on
 * them. Any lower threshold would mean an agent that seeded a pack had also,
 * silently, switched on enforcement against every clinic in that country — which
 * is the precise decision the ladder reserves for a person.
 *
 * ⚠️ SO NOTHING BLOCKS ANYWHERE TODAY, AND THAT IS THE CORRECT STATE RATHER THAN
 *   A DISABLED FEATURE. India sits at `RULES_IMPLEMENTED`; its sources are
 *   `UNVERIFIED` and no qualified person has read the pack. What the wiring buys
 *   before that day comes is that the question is ASKED at the moment of acting,
 *   the answer is recorded where an operator can see it, and the day somebody
 *   does sign a pack off, enforcement begins without a code change.
 *
 * ── WHAT A NON-ENFORCED DECISION MUST STILL DO ───────────────────────────────
 * Be visible. A refusal nobody sees is indistinguishable from a permission, so
 * `summarise` below produces the line that goes on the document's log with ids
 * and rule codes and NEVER a patient, a name or a quantity in a way that could
 * identify one.
 */
import type { RegulatoryDecisionResponse } from '@rcln/contracts';

/**
 * The only maturity at which a decision may refuse a document.
 *
 * ⚠️ EXPORTED SO A TEST CAN NAME IT RATHER THAN RE-STATE IT. A test that hard-codes
 *   `'PRODUCTION_ENABLED'` keeps passing if this is loosened to a lower rung,
 *   which is the one change to this file that would need a very deliberate
 *   review.
 */
export const ENFORCING_MATURITY = 'PRODUCTION_ENABLED' as const;

/** Outcomes that would stop a document, if the pack were enforceable. */
export type BlockingOutcome = 'REFUSED' | 'UNDETERMINED';

export function isBlockingOutcome(
  outcome: RegulatoryDecisionResponse['outcome']
): outcome is BlockingOutcome {
  return outcome === 'REFUSED' || outcome === 'UNDETERMINED';
}

/**
 * Would this decision stop the document?
 *
 * ⚠️ `lowestPackMaturity` IS THE WEAKEST PACK THAT CONTRIBUTED, NOT THE STRONGEST,
 *   AND THAT IS WHY IT IS THE ONE TO TEST. A decision assembled from a
 *   signed-off national pack and an unreviewed state one is only as trustworthy
 *   as the state one. Reading the strongest would let an unreviewed regional rule
 *   ride into enforcement on the national pack's sign-off.
 *
 * ⚠️ A NULL MATURITY IS NOT ENFORCEABLE. It means no pack contributed at all —
 *   the jurisdiction is unconfigured — which is the single most common reason a
 *   decision comes back `UNDETERMINED` and the exact case that must never block.
 */
export function isEnforceable(decision: RegulatoryDecisionResponse): boolean {
  return decision.lowestPackMaturity === ENFORCING_MATURITY;
}

export function blocks(decision: RegulatoryDecisionResponse): boolean {
  return isBlockingOutcome(decision.outcome) && isEnforceable(decision);
}

/**
 * One log-safe line about a decision that did not permit.
 *
 * ⚠️ NO PHI, AND NOT EVEN A PRODUCT NAME. Rule codes, the outcome, the
 *   jurisdiction and the product ID. A regulatory refusal on a dispense would
 *   otherwise put "why this patient could not have this medicine" into the
 *   application log, which is the one place this codebase never puts it.
 */
export function summarise(
  decision: RegulatoryDecisionResponse,
  productId: string
): {
  productId: string;
  outcome: string;
  jurisdiction: string;
  packMaturity: string | null;
  ruleCodes: string[];
  enforced: boolean;
} {
  return {
    productId,
    outcome: decision.outcome,
    jurisdiction: decision.jurisdiction,
    packMaturity: decision.lowestPackMaturity,
    ruleCodes: decision.reasons
      .filter((reason) => reason.outcome !== 'PERMITTED')
      .map((reason) => reason.ruleCode)
      .filter((code): code is string => code !== null),
    enforced: isEnforceable(decision),
  };
}
