/**
 * How a supply consults the law, and what it does with the answer (PI-7).
 *
 * The sibling of `regulatory/consult.ts`, which goods receipt and transfer use —
 * and it is a separate file rather than a parameter on that one because the two
 * differ in every way that matters:
 *
 *   stock movements            a supply
 *   ─────────────────────────  ────────────────────────────────────────────────
 *   actor is empty             the caller's effective permissions, their
 *                              licences, and whether they are the prescriber
 *   no prescription            the prescription, its age, its endorsement
 *   no patient                 an age, and whether the subject is an animal
 *   nothing is recorded        the decision is SNAPSHOTTED (PI-ADR-008) and the
 *                              row id goes on the dispense line
 *
 * ⚠️ IT IS CALLED INSIDE THE POSTING TRANSACTION, ON PURPOSE, and before any
 *   ledger row is written for the line it is about. Asking afterwards would mean
 *   a refused line had already moved stock, and the rollback would depend on the
 *   transaction rather than on the order — true today, and exactly the assumption
 *   that breaks the first time somebody splits the loop.
 *
 * ⚠️ AND THE GATE STILL APPLIES. `enforcement.ts` refuses to let a decision STOP
 *   a document unless the pack is `PRODUCTION_ENABLED`, which no pack is today,
 *   because switching enforcement on for a country is a named human's decision
 *   and not a side effect of an agent seeding rules. What that buys before the
 *   day somebody signs a pack off: the question is asked at the moment of acting,
 *   the answer is SNAPSHOTTED on the line rather than only logged, and the day
 *   the sign-off happens, refusals begin without a code change.
 *
 * NO PHI IN ANY LOG LINE FROM THIS FILE. `summarise` gives ids, an outcome and
 * rule codes; the patient this was about is deliberately not among them, because
 * "why this named person could not have this medicine" in an application log is
 * the disclosure this codebase never makes.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import type { EvaluateRegulatoryRequest, RegulatoryDecisionResponse } from '@rcln/contracts';
import { logger } from '../../utils/logger.js';
import { RegulatoryRefusalError } from '../../utils/errors.js';
import { evaluateWithin, type RegulatoryActorInput } from '../regulatory/evaluation.service.js';
import { blocks, isBlockingOutcome, summarise } from '../regulatory/enforcement.js';
import { refusingRuleCodes, toDecisionSummary, recordDecision } from './shared.js';
import type { DispenseRegulatorySummary } from '@rcln/contracts';

export interface SupplyConsultation {
  branchId: string;
  productId: string;
  locationId: string;
  quantityBase: string;
  transaction: 'DISPENSE' | 'COUNTER_SALE';
  /** When it is handed over, which is not necessarily when it is keyed in. */
  occurredAt: Date;
  prescription?: EvaluateRegulatoryRequest['prescription'];
  patient?: EvaluateRegulatoryRequest['patient'];
  substitution?: EvaluateRegulatoryRequest['substitution'];
  traceability?: EvaluateRegulatoryRequest['traceability'];
  /**
   * What the same patient has already had of this product in the rule's period.
   *
   * ⚠️ OMITTED IS NOT ZERO. A `QUANTITY_LIMIT` with a period resolves
   *   `UNDETERMINED` when this is absent — "we did not check" is not "they have
   *   had none" — and `UNDETERMINED` refuses.
   */
  priorQuantityInPeriodBase?: string;
  actor: RegulatoryActorInput;
  /** For the log line, so an operator can find the supply. Never rendered. */
  documentId: string;
}

export interface SupplyDecision {
  decisionId: string;
  summary: DispenseRegulatorySummary;
  decision: RegulatoryDecisionResponse;
}

/**
 * Ask, snapshot, and refuse where the platform is allowed to.
 *
 * Throws `RegulatoryRefusalError` (422, never 403) when the decision both fails
 * to permit AND comes from a pack a human has signed off.
 */
export async function consultForSupply(
  tx: TxClient,
  ctx: TenantContext,
  input: SupplyConsultation
): Promise<SupplyDecision> {
  const decision = await evaluateWithin(
    tx,
    ctx,
    {
      productId: input.productId,
      transaction: input.transaction,
      branchId: input.branchId,
      locationId: input.locationId,
      quantityBase: input.quantityBase,
      occurredAt: input.occurredAt.toISOString(),
      ...(input.prescription ? { prescription: input.prescription } : {}),
      ...(input.patient ? { patient: input.patient } : {}),
      ...(input.substitution ? { substitution: input.substitution } : {}),
      ...(input.traceability ? { traceability: input.traceability } : {}),
      ...(input.priorQuantityInPeriodBase !== undefined
        ? { priorQuantityInPeriodBase: input.priorQuantityInPeriodBase }
        : {}),
    } as EvaluateRegulatoryRequest,
    input.actor
  );

  /*
   * ⚠️ SNAPSHOTTED WHETHER IT PERMITTED OR NOT, AND BEFORE THE REFUSAL BELOW —
   *   which is only useful because a refusal that reaches the throw rolls the row
   *   back with everything else. What it buys is the permitted-with-conditions
   *   and the not-enforced cases: both of those PROCEED, and both need the answer
   *   on the record rather than in a log line somebody has to go looking for.
   */
  const decisionId = await recordDecision(tx, ctx, {
    branchId: input.branchId,
    productId: input.productId,
    transaction: input.transaction,
    quantityBase: input.quantityBase,
    decision,
  });

  if (isBlockingOutcome(decision.outcome)) {
    const summary = {
      ...summarise(decision, input.productId),
      documentType: input.transaction,
      documentId: input.documentId,
      branchId: input.branchId,
    };

    if (blocks(decision)) {
      logger.warn(summary, 'regulatory decision refused a supply');
      const first = decision.reasons.find((reason) => reason.outcome !== 'PERMITTED');
      throw new RegulatoryRefusalError(
        first?.message ??
          'The rules for this place do not permit this supply, and no reason was given.',
        {
          outcome: decision.outcome,
          ruleCodes: refusingRuleCodes(decision),
          messages: decision.reasons
            .filter((reason) => reason.outcome !== 'PERMITTED')
            .map((reason) => reason.message),
        }
      );
    }

    /*
     * ⚠️ `info`, NOT SWALLOWED, AND THIS IS THE HALF THAT IS LIVE TODAY. Until a
     *   pack is signed off, this line and the snapshot are the only trace that
     *   the law said no — and a refusal nobody can see is indistinguishable from
     *   a permission.
     */
    logger.info(summary, 'regulatory decision recorded, not enforced');
  }

  return { decisionId, summary: toDecisionSummary(decision), decision };
}

/**
 * The same question about a RETURN, which is a different question.
 *
 * ⚠️ IT DECIDES A DISPOSITION RATHER THAN PERMITTING AN ACT, AND IT NEVER THROWS.
 *   Refusing to accept a medicine somebody has physically brought back is not a
 *   thing a system may do — the stock is on the counter either way. What the law
 *   decides is where it GOES: many jurisdictions forbid restocking a dispensed
 *   medicine outright, because once it has left nobody can attest to how it was
 *   stored. So anything short of a clear permission quarantines it, which is also
 *   what happens when no rule speaks at all.
 */
export async function consultForReturn(
  tx: TxClient,
  ctx: TenantContext,
  input: Omit<SupplyConsultation, 'transaction'> & { requestRestock: boolean }
): Promise<{ decisionId: string; disposition: 'RESTOCKED' | 'QUARANTINED'; messages: string[] }> {
  const decision = await evaluateWithin(
    tx,
    ctx,
    {
      productId: input.productId,
      /*
       * ⚠️ `STOCK`, NOT `DISPENSE`. The transaction being asked about is stock
       *   arriving back on a shelf, and asking under `DISPENSE` would apply the
       *   prescription rules to a movement in the opposite direction — refusing
       *   to take back a Schedule H medicine for want of a prescription.
       */
      transaction: 'STOCK',
      branchId: input.branchId,
      locationId: input.locationId,
      quantityBase: input.quantityBase,
      occurredAt: input.occurredAt.toISOString(),
      ...(input.traceability ? { traceability: input.traceability } : {}),
    } as EvaluateRegulatoryRequest,
    input.actor
  );

  const decisionId = await recordDecision(tx, ctx, {
    branchId: input.branchId,
    productId: input.productId,
    /*
     * The snapshot records the SUPPLY transaction type this return is against,
     * because `RegulatoryTransactionType` has no `RETURN` member and inventing
     * one for a column would be a migration over somebody's law for a label.
     * What the row actually says is in `reasons`.
     */
    transaction: 'DISPENSE',
    quantityBase: input.quantityBase,
    decision,
  });

  /*
   * ⚠️ BOTH HAVE TO AGREE. The clinic asks, and the law does not object — either
   *   alone quarantines. An engine answer of `PERMITTED` on its own is not a
   *   licence to restock: it may have been produced by rules that never spoke to
   *   this question at all, and "no rule objected" is a long way from "a
   *   regulator says a returned medicine may be sold to somebody else".
   */
  const permitted =
    decision.outcome === 'PERMITTED' || decision.outcome === 'PERMITTED_WITH_CONDITIONS';

  return {
    decisionId,
    disposition: permitted && input.requestRestock ? 'RESTOCKED' : 'QUARANTINED',
    messages: decision.reasons
      .filter((reason) => reason.outcome !== 'PERMITTED')
      .map((reason) => reason.message),
  };
}
