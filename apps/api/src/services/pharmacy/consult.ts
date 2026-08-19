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
import { Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type { EvaluateRegulatoryRequest, RegulatoryDecisionResponse } from '@rcln/contracts';
import { logger } from '../../utils/logger.js';
import { RegulatoryRefusalError } from '../../utils/errors.js';
import { evaluateWithin, type RegulatoryActorInput } from '../regulatory/evaluation.service.js';
import { regulatoryActorWithin } from '../regulatory/actor.service.js';
import { blocks, isBlockingOutcome, summarise } from '../regulatory/enforcement.js';
import { refusingRuleCodes, toDecisionSummary, recordDecision } from './shared.js';
import type { DispenseRegulatorySummary } from '@rcln/contracts';

export interface SupplyConsultation {
  branchId: string;
  productId: string;
  locationId: string;
  quantityBase: string;
  transaction: 'DISPENSE' | 'COUNTER_SALE' | 'ONLINE_DISPENSE';
  /**
   * Where the parcel is going, on a remote supply (PI-12).
   *
   * ⚠️ DERIVED BY THE ORDER SERVICE FROM THE ADDRESS THE ORDER FROZE, NEVER SENT
   *   BY A CLIENT. `POST /v1/regulatory/evaluate` accepts one as a hypothesis,
   *   for the reason it accepts a species as one; a supply must not, or the
   *   person packing the parcel picks which country's rules apply to it.
   */
  destination?: { countryCode: string; regionCode: string | null };
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
   *
   * ⚠️ SINCE PI-8, A SUPPLY DOES NOT NEED TO PASS THIS: it supplies a LOOKUP
   *   instead, and `evaluateWithin` calls it with the window the applicable
   *   rules name. This field stays for a caller that genuinely knows the number
   *   — a what-if, a migration — and an explicit value always beats the lookup.
   */
  priorQuantityInPeriodBase?: string;
  /**
   * Who the supply is FOR, so the prior quantity can be summed for them.
   *
   * ⚠️ NULL ON A COUNTER SALE, AND THAT IS NOT A GAP TO PAPER OVER. A quantity
   *   limit is a limit on a PERSON; a sale to somebody with no patient record
   *   has no history to sum and no way to acquire one, so the lookup is not
   *   offered and a period rule correctly resolves `UNDETERMINED`. Inventing a
   *   zero there would let anyone buy the whole shelf one transaction at a time.
   */
  patientId?: string | null;
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
  /* Hoisted so the closure below narrows it, rather than casting inside. */
  const patientId = input.patientId ?? null;
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
      ...(input.destination
        ? {
            destinationCountryCode: input.destination.countryCode,
            ...(input.destination.regionCode !== null
              ? { destinationRegionCode: input.destination.regionCode }
              : {}),
          }
        : {}),
      ...(input.prescription ? { prescription: input.prescription } : {}),
      ...(input.patient ? { patient: input.patient } : {}),
      ...(input.substitution ? { substitution: input.substitution } : {}),
      ...(input.traceability ? { traceability: input.traceability } : {}),
      ...(input.priorQuantityInPeriodBase !== undefined
        ? { priorQuantityInPeriodBase: input.priorQuantityInPeriodBase }
        : {}),
    } as EvaluateRegulatoryRequest,
    /*
     * ⚠️ THE CALLER'S PROFESSIONAL REGISTRATIONS ARE ADDED HERE AND NOT BY THE
     *   CALLER (PI-8, KNOWN_ISSUES #9). `licenceTypes` was empty on every consult
     *   in the programme, so a rule naming a registration — "the supply must be
     *   made by a registered pharmacist" — resolved `UNDETERMINED`, which
     *   refuses. India's was satisfied only through the s. 42 proviso, and only
     *   where the actor happened to BE the prescriber.
     *
     * ⚠️ RESOLVED AS AT THE MOMENT OF SUPPLY, NOT `now()`, and merged over
     *   whatever the caller passed so `roleCodes` and `isPrescriber` — which the
     *   service derives from the encounter and never accepts from a client — are
     *   untouched.
     */
    await regulatoryActorWithin(tx, ctx, {
      roleCodes: input.actor.roleCodes,
      occurredAt: input.occurredAt,
      branchId: input.branchId,
      ...(input.actor.isPrescriber !== undefined ? { isPrescriber: input.actor.isPrescriber } : {}),
    }),
    /*
     * ⚠️ A LOOKUP, NOT A VALUE (PI-8, closing KNOWN_ISSUES #10). The window a
     *   `QUANTITY_LIMIT` measures over lives on the RULE, so nobody can know it
     *   before the rules are loaded — `evaluateWithin` selects the applicable
     *   ones, reads the window off them and calls back here, where the patient
     *   is known. Offered only where there IS a patient; see `patientId`.
     */
    patientId
      ? {
          priorQuantityInPeriod: (windowDays: number): Promise<string> =>
            priorQuantitySupplied(tx, ctx, {
              patientId,
              productId: input.productId,
              before: input.occurredAt,
              windowDays,
            }),
        }
      : {}
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
    /* The same actor resolution the supply gets. See `consultForSupply`. */
    await regulatoryActorWithin(tx, ctx, {
      roleCodes: input.actor.roleCodes,
      occurredAt: input.occurredAt,
      branchId: input.branchId,
    })
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

/**
 * How much of one product a named person has already been supplied, in a window.
 *
 * ⚠️ IT COUNTS WHAT WAS SUPPLIED AND DOES **NOT** DEDUCT WHAT CAME BACK, WHICH IS
 *   A DELIBERATE CHOICE IN THE SAFE DIRECTION. The engine's own wording is "what
 *   has already been supplied in that window", and a return is a separate event
 *   rather than an un-supply: the medicine was in that person's hands. Deducting
 *   returns would let somebody take the limit, hand a box back, and take it
 *   again — and a quantity limit exists precisely to stop that pattern. It costs
 *   the honest patient who returned an unopened box a refusal they could argue
 *   with, which is the direction this domain is required to fail in.
 *
 * ⚠️ STRICTLY BEFORE `before`, SO THE CURRENT SUPPLY IS NOT COUNTED TWICE. The
 *   engine adds `request.quantityBase` to whatever this returns; including the
 *   line being consulted would double it. `consultForSupply` runs at step 4 and
 *   the lines are written at step 7, so they do not exist yet — the bound is
 *   belt as well as braces.
 *
 * ⚠️ AND IT COUNTS OTHER BRANCHES OF THE SAME ORGANIZATION. A limit on a person
 *   is not a limit per counter, and a patient collecting from two sites of one
 *   clinic is the obvious way round a per-branch sum. RLS still applies — the
 *   branch policy on `dispenses` is RESTRICTIVE — so what this actually returns
 *   is every branch IN THE CALLER'S SCOPE. A pharmacist scoped to one site
 *   therefore under-counts, which is a real limitation and is recorded in
 *   KNOWN_ISSUES rather than fixed by widening a tenant context.
 *
 * Returns a decimal string in the product's base units. Never a float.
 */
async function priorQuantitySupplied(
  tx: TxClient,
  ctx: TenantContext,
  input: { patientId: string; productId: string; before: Date; windowDays: number }
): Promise<string> {
  const from = new Date(input.before.getTime() - input.windowDays * 86_400_000);

  const rows = await tx.$queryRaw<{ total: Prisma.Decimal | null }[]>`
    SELECT SUM(dl.quantity_base) AS total
      FROM dispense_lines dl
      JOIN dispenses d ON d.id = dl.dispense_id
     WHERE dl.organization_id = ${ctx.organizationId}::uuid
       AND dl.product_id      = ${input.productId}::uuid
       AND d.patient_id       = ${input.patientId}::uuid
       AND d.dispensed_at     >= ${from}
       AND d.dispensed_at      < ${input.before}
       -- A fully returned supply is excluded: at that point the medicine is
       -- demonstrably back on the shelf rather than in somebody's hands, and
       -- refusing on it produces a refusal nobody can explain to the patient in
       -- front of them. A PARTIAL return still counts in full -- see the header
       -- on why returns are not deducted.
       AND d.status <> 'RETURNED'
  `;

  /*
   * `SUM()` over no rows is NULL, and NULL here genuinely means none — the
   * person has a record and nothing was supplied to them in the window. That is
   * the one place a zero is honest, and it is different from the absent value
   * the engine treats as `UNDETERMINED`.
   */
  return (rows[0]?.total ?? new Prisma.Decimal(0)).toString();
}
