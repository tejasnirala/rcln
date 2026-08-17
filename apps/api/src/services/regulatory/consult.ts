/**
 * The one way a document consults the law while posting itself (PI-6.7).
 *
 * ⚠️ GOODS RECEIPT AND TRANSFER BOTH CALL THIS, AND NEITHER OF THEM CONTAINS A
 *   COUNTRY, A RULE CODE OR A SCHEDULE. That is the whole architecture: a call
 *   site says WHAT IT IS ABOUT TO DO and reads a decision. If a jurisdiction
 *   needs something a call site cannot express, the fix is a field on the
 *   request or a rule type in `@rcln/regulatory` — never a condition here.
 *
 * ── WHAT THIS DOES AND DOES NOT DO ───────────────────────────────────────────
 * It asks, it logs, and it throws ONLY when `enforcement.ts` says the pack may
 * stop a document — which today is nowhere, because that needs a human sign-off.
 * Read `enforcement.ts` before changing that; the gate is the reason wiring
 * these call sites does not break every clinic outside India.
 *
 * ⚠️ IT IS CALLED INSIDE THE POSTING TRANSACTION, ON PURPOSE. The question "may
 *   this stock be received here" has to be asked against the same snapshot, and
 *   at the same moment, as the write that acts on it — which is why it takes a
 *   `tx` and why `evaluateWithin` exists at all.
 *
 * ⚠️ THE ACTOR USED TO BE EMPTY HERE, AND PI-8 FIXED IT (KNOWN_ISSUES #5, #9).
 *   Neither the receipt nor the transfer service was given the caller's
 *   permission codes, so a `PHARMACIST_AUTHORITY` or `IMPORT_RESTRICTION` rule
 *   aimed at `STOCK` saw an actor holding nothing and refused. Both now take
 *   `roleCodes` down from their routes, and `regulatoryActorWithin` adds the
 *   caller's professional registrations as at the moment of the movement.
 *
 *   ⚠️ `roleCodes` IS STILL OPTIONAL ON THE INPUT AND DEFAULTS TO EMPTY, WHICH IS
 *     THE SAFE DIRECTION AND NOT A HOLE LEFT OPEN. An actor holding nothing
 *     satisfies no rule that names anything, so a call site that forgets to pass
 *     them refuses rather than permits. The worker's sweeps have no human caller
 *     at all and are the reason the field cannot simply be required.
 *
 * NO PHI. A stock movement references no patient, and the summary logged below
 * carries ids and rule codes only.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { evaluateWithin } from './evaluation.service.js';
import { regulatoryActorWithin } from './actor.service.js';
import { blocks, isBlockingOutcome, summarise } from './enforcement.js';

export interface StockConsultation {
  branchId: string;
  productId: string;
  locationId: string | null;
  /** Base units, as a decimal string. Never a float. */
  quantityBase: string;
  /** `STOCK` for a receipt, `TRANSFER` for a movement between places. */
  transaction: 'STOCK' | 'TRANSFER';
  /**
   * ⚠️ WHEN IT HAPPENED, NOT WHEN IT WAS KEYED IN. A receipt entered on Monday
   *   for a Friday delivery is evaluated against Friday's rules — the same
   *   reason the ledger leg carries `occurredAt` rather than `now()`.
   */
  occurredAt: Date;
  /** For the log line, so an operator can find the document. Never rendered. */
  documentType: string;
  documentId: string;
  /**
   * The caller's effective permission codes for the branch being acted on.
   *
   * ⚠️ PERMISSION CODES, NEVER ROLE NAMES — see `RegulatoryActorInput`. Resolved
   *   at the route, because `TenantContext` carries no permissions by design.
   *   Absent means an actor holding nothing, which refuses any rule naming
   *   something; see the file header.
   */
  roleCodes?: readonly string[];
}

/**
 * Consult the law about one line of a document.
 *
 * Throws only if the decision both fails to permit AND comes from a pack a human
 * has signed off. Otherwise it records what the law said and lets the document
 * through — which is the state of every jurisdiction today.
 */
export async function consultForStockMovement(
  tx: TxClient,
  ctx: TenantContext,
  input: StockConsultation
): Promise<void> {
  const decision = await evaluateWithin(
    tx,
    ctx,
    {
      productId: input.productId,
      transaction: input.transaction,
      branchId: input.branchId,
      quantityBase: input.quantityBase,
      occurredAt: input.occurredAt.toISOString(),
      ...(input.locationId ? { locationId: input.locationId } : {}),
    } as never,
    /*
     * ⚠️ THE CALLER, AS THE RULES JUDGE THEM — their effective permissions and
     *   the professional registrations they held ON THE DAY OF THE MOVEMENT, not
     *   today. A receipt keyed in on Monday for a Friday delivery is judged
     *   against Friday, exactly as the rules themselves are.
     */
    await regulatoryActorWithin(tx, ctx, {
      roleCodes: input.roleCodes ?? [],
      occurredAt: input.occurredAt,
    })
  );

  if (!isBlockingOutcome(decision.outcome)) return;

  const summary = {
    ...summarise(decision, input.productId),
    documentType: input.documentType,
    documentId: input.documentId,
    branchId: input.branchId,
  };

  if (blocks(decision)) {
    /*
     * ⚠️ THE RULE'S OWN SENTENCE, VERBATIM, BECAUSE IT WAS WRITTEN TO BE READ BY
     *   THE PERSON WHO IS BLOCKED. `regulatory_rules.statement` says what to DO,
     *   not what failed — a summary composed here would lose that and would also
     *   drift from what the console shows for the same rule.
     */
    const first = decision.reasons.find((reason) => reason.outcome !== 'PERMITTED');
    logger.warn(summary, 'regulatory decision blocked a document');
    throw new ValidationError(
      first?.message ??
        'The regulatory rules for this place do not permit this movement, and no reason was given.'
    );
  }

  /*
   * ⚠️ LOGGED AT `info`, NOT SWALLOWED, AND THIS IS THE HALF OF THE FEATURE THAT
   *   IS ACTUALLY LIVE. Until a pack is signed off this line is the ONLY trace
   *   that the law said no — and a refusal nobody can see is indistinguishable
   *   from a permission. It is what tells an operator that a jurisdiction is
   *   configured, that it is objecting, and that enforcement is not on yet.
   */
  logger.info(summary, 'regulatory decision recorded, not enforced');
}
