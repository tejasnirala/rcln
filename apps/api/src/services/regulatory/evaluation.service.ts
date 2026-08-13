/**
 * The seam: load the rows, hand them to the pure engine, return the decision.
 *
 * ⚠️ EVERY REGULATORY QUESTION IN THE PROGRAMME COMES THROUGH HERE, AND NO
 *   CALLER READS A RULE ROW ITSELF. PI-7's dispensing, PI-9's consumption,
 *   PI-12's online orders and the counter-sale path all call `evaluateFor` and
 *   read the decision; none of them contains a country code, and none of them
 *   may re-interpret a parameter. A second reader of `regulatory_rules` is a
 *   second opinion about the law, and they diverge in the direction nobody
 *   notices — the permissive one.
 *
 * ── WHO CONSULTS THIS, AND WHAT HAPPENS TO THE ANSWER (PI-6.7) ───────────────
 * Goods receipt and transfer now ask, through `regulatory/consult.ts`, inside
 * their own posting transaction — which is why `evaluateWithin` exists.
 *
 * ⚠️ THEY ASK, AND TODAY NOTHING STOPS THEM, AND THAT IS DELIBERATE RATHER THAN
 *   UNFINISHED. One country has a rule pack, so nearly every evaluation on the
 *   platform answers `UNDETERMINED` — which REFUSES — and a call site that threw
 *   on a non-permission would stop every clinic elsewhere from receiving stock.
 *   `regulatory/enforcement.ts` is the gate: a decision may only stop a document
 *   once a named human has moved its pack to `PRODUCTION_ENABLED`, which no code
 *   path may do. Until then the answer is logged where an operator can see it.
 *   Read that file before changing any of this.
 *
 * ── THE THREE THINGS THE CALLER MUST GET RIGHT ───────────────────────────────
 *   the jurisdiction   the BRANCH's, not the patient's — a supply happens where
 *                      the counter is
 *   the day            worked out in the branch's zone before it arrives here
 *                      (invariant 6), then flattened to a calendar day
 *   the category path  the whole chain, root to leaf, so a rule written against
 *                      a parent category still matches
 *
 * NO PHI. The request carries an age and a subject type and never a patient id.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { EvaluateRegulatoryRequest, RegulatoryDecisionResponse } from '@rcln/contracts';
import {
  evaluate,
  formatJurisdiction,
  isProfileInForce,
  type Jurisdiction,
  type ProductRegulatoryProfile,
  type RegulatoryRequest,
  type RegulatoryRule,
} from '@rcln/regulatory';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { startOfCalendarDay } from '../product/values.js';

interface CategoryAncestorRow {
  id: string;
}

/**
 * The category chain from the product's own category up to the root.
 *
 * ⚠️ THE WHOLE CHAIN, AND A LEAF-ONLY VERSION OF THIS FUNCTION IS THE MOST
 *   LIKELY WAY THIS DOMAIN SILENTLY STOPS WORKING. A rule is written against
 *   "Controlled substances"; a product is filed under "Opioid analgesics", a
 *   child of it. Passing only the leaf makes that rule match nothing, at every
 *   clinic, while the screens show it configured and in force.
 */
async function categoryPath(tx: TxClient, categoryId: string | null): Promise<string[]> {
  if (categoryId === null) return [];

  const rows = await tx.$queryRaw<CategoryAncestorRow[]>`
    WITH RECURSIVE up AS (
      SELECT c.id, c.parent_id
      FROM product_categories c
      WHERE c.id = ${categoryId}::uuid AND c.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id
      FROM product_categories p
      JOIN up ON up.parent_id = p.id
      WHERE p.deleted_at IS NULL
    )
    SELECT id FROM up
  `;

  return rows.map((row) => row.id);
}

/**
 * Every rule that could possibly speak to this place, loaded whole.
 *
 * ⚠️ THE SELECTION IS THE ENGINE'S JOB, NOT SQL'S, AND THAT SPLIT IS THE POINT
 *   OF PI-ADR-007. This query narrows on the two things a database indexes well
 *   — the jurisdiction and the pack's date window — and hands everything else
 *   over. Pushing specificity, transaction matching or product targeting into
 *   the `where` would put half the decision in a query nobody can unit-test and
 *   half in a package everybody can, which is how the two start disagreeing.
 *
 * Country-wide AND regional packs are both loaded; which one wins is
 * `mostSpecific`, per rule type.
 */
async function loadRules(tx: TxClient, place: Jurisdiction, on: Date): Promise<RegulatoryRule[]> {
  const rows = await tx.regulatoryRule.findMany({
    where: {
      status: 'ACTIVE',
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
      pack: {
        effectiveFrom: { lte: on },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
        jurisdiction: {
          countryCode: place.countryCode,
          /*
           * ⚠️ TWO GROUPS, SO THEY GO IN `AND` — a second `OR:` key on this
           *   object would REPLACE the pack's date group above it, silently,
           *   with no type error. That exact mistake shipped in
           *   `resolveTaxCategory` and made every regional override inert; see
           *   its comment.
           */
          ...(place.regionCode
            ? { OR: [{ regionCode: place.regionCode }, { regionCode: null }] }
            : { regionCode: null }),
        },
      },
    },
    include: {
      pack: {
        select: {
          id: true,
          version: true,
          maturity: true,
          jurisdiction: { select: { countryCode: true, regionCode: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    packId: row.pack.id,
    packVersion: row.pack.version,
    packMaturity: row.pack.maturity,
    jurisdiction: {
      countryCode: row.pack.jurisdiction.countryCode,
      regionCode: row.pack.jurisdiction.regionCode,
    },
    ruleType: row.ruleType,
    code: row.code,
    statement: row.statement,
    status: row.status,
    appliesToProductType: row.appliesToProductType,
    appliesToCategoryId: row.appliesToCategoryId,
    appliesToClassification: row.appliesToClassification,
    appliesToTransactions: row.appliesToTransactions,
    parameters: row.parameters,
    sourceId: row.sourceId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  }));
}

/**
 * The product's profile for this place on this day, most specific first.
 *
 * ⚠️ REGION BEATS COUNTRY, AND `nulls: 'last'` IS REQUIRED TO GET THAT ON
 *   `desc`. Postgres sorts NULLs FIRST on DESC — the opposite of what reading it
 *   suggests — so without it the country-wide profile always sorts first, always
 *   wins with `take: 1`, and every regional profile is configured, visible and
 *   unreachable. That is not a hypothetical: it shipped in `resolveTaxCategory`.
 */
async function loadProfile(
  tx: TxClient,
  productId: string,
  place: Jurisdiction,
  on: Date
): Promise<ProductRegulatoryProfile | null> {
  const rows = await tx.productRegulatoryProfile.findMany({
    where: {
      productId,
      effectiveFrom: { lte: on },
      AND: [
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
        {
          jurisdiction: {
            countryCode: place.countryCode,
            ...(place.regionCode
              ? { OR: [{ regionCode: place.regionCode }, { regionCode: null }] }
              : { regionCode: null }),
          },
        },
      ],
    },
    include: { jurisdiction: { select: { countryCode: true, regionCode: true } } },
    orderBy: [
      { jurisdiction: { regionCode: { sort: 'desc', nulls: 'last' } } },
      { effectiveFrom: 'desc' },
    ],
    take: 1,
  });

  const row = rows[0];
  if (!row) return null;

  const profile: ProductRegulatoryProfile = {
    id: row.id,
    jurisdiction: {
      countryCode: row.jurisdiction.countryCode,
      regionCode: row.jurisdiction.regionCode,
    },
    classification: row.classification,
    controlledSchedule: row.controlledSchedule,
    prescriptionRequirement: row.prescriptionRequirement,
    registrationNumber: row.registrationNumber,
    registrationStatus: row.registrationStatus,
    onlineSalePosition: row.onlineSalePosition,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };

  /*
   * The query already narrowed the window, so this is a second layer rather than
   * the first — kept because the engine's own notion of "in force" is the one
   * that must decide, and a query and a package that disagree about a boundary
   * day is precisely the class of defect this domain cannot afford.
   */
  return isProfileInForce(profile, on) ? profile : null;
}

/**
 * Who is asking, as the rules see them.
 *
 * ⚠️ THE CALLER SUPPLIES THIS AND THE SERVICE NEVER DERIVES IT FROM THE TENANT
 *   CONTEXT, because `TenantContext` deliberately carries no permissions — it is
 *   an isolation boundary, not an authorization one. The route resolves the
 *   effective codes for the branch this request is acting on (`authorize()` has
 *   already warmed that cache) and passes them, which keeps "what may this
 *   person do" answered in exactly one place.
 */
export interface RegulatoryActorInput {
  /**
   * The caller's effective PERMISSION codes, not their role names.
   *
   * ⚠️ PERMISSION CODES BECAUSE ROLE NAMES ARE A CLINIC'S TO CHANGE. A clinic
   *   may clone `PHARMACIST` into "Dispensary Lead", and a rule naming the role
   *   would then match nobody — which reads as the rule being wrong rather than
   *   as the role having been renamed. A rule that wants a professional
   *   REGISTRATION names a licence type instead; PI-7 supplies those from the
   *   actor's staff profile, and until then the list is empty and any rule
   *   demanding one resolves `UNDETERMINED`, which refuses.
   */
  roleCodes: readonly string[];
  licenceTypes?: readonly string[];
}

/**
 * The evaluation itself, inside a transaction the CALLER already opened.
 *
 * ⚠️ THIS EXISTS SO A DOCUMENT CAN CONSULT THE LAW AS PART OF POSTING ITSELF,
 *   AND `evaluateFor` BELOW IS NOW ONLY A WRAPPER. Goods receipt and transfer
 *   ask this question in the middle of their own `withTenant` — they have
 *   already locked rows and are about to write the ledger — and calling
 *   `evaluateFor` there would open a SECOND transaction. That second
 *   transaction cannot see the uncommitted work of the first, would take its own
 *   snapshot, and on a pooled connection can deadlock against the locks the
 *   outer one is holding. A regulatory answer read outside the transaction that
 *   acts on it is also an answer about a different moment than the write.
 *
 * ⚠️ IT STILL TAKES `ctx`, BECAUSE THE TENANT CONTEXT IS NOT THE TRANSACTION.
 *   `ctx.branchIds` is the caller's branch scope and is what stops a named
 *   branch outside it being evaluated; `tx` only carries the session variables.
 */
export async function evaluateWithin(
  tx: TxClient,
  ctx: TenantContext,
  input: EvaluateRegulatoryRequest,
  actor: RegulatoryActorInput
): Promise<RegulatoryDecisionResponse> {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { id: true, type: true, categoryId: true, compositionId: true, deletedAt: true },
  });
  if (!product || product.deletedAt) throw new NotFoundError('Product');

  /*
   * ⚠️ THE BRANCH'S JURISDICTION, NOT THE PATIENT'S. A supply happens where the
   *   counter is; taking it from a patient's address would let a clinic in one
   *   state dispense under another state's rules because of where somebody
   *   lives. The caller may override it — an online order asks about its
   *   DESTINATION — which is why `destinationCountryCode` is a separate field
   *   and not this one.
   */
  /*
   * ⚠️ THE BRANCH THE REQUEST NAMES, NOT THE FIRST ONE IN SCOPE. This used to
   *   be `ctx.branchIds[0]`, so a caller with membership at branches in two
   *   states was evaluated against whichever id happened to sort first —
   *   arbitrary, silent, and wrong half the time. A named branch must also be
   *   one this caller may act in; `branchIds` is the scope RLS already
   *   enforces, so an id outside it is NOT FOUND rather than FORBIDDEN, for
   *   the reason every branch-scoped service in this codebase gives.
   */
  if (input.branchId && !ctx.branchIds.includes(input.branchId)) {
    throw new NotFoundError('Branch');
  }
  const branchId = input.branchId ?? (ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined);
  const branch = branchId
    ? await tx.branch.findUnique({
        where: { id: branchId },
        select: { countryCode: true, regionCode: true },
      })
    : null;

  const countryCode = input.countryCode ?? branch?.countryCode;
  if (!countryCode) {
    /*
     * ⚠️ REFUSED RATHER THAN GUESSED, INCLUDING THE MULTI-BRANCH CASE. A
     *   caller who works at several branches and names neither a branch nor a
     *   country has asked a question with more than one answer, and picking
     *   one is exactly the silent-arbitrary behaviour this domain cannot have.
     */
    throw new ValidationError(
      ctx.branchIds.length > 1
        ? 'This request could be about more than one branch. Name the branch, or the country, so the rules of one place are the ones applied.'
        : 'No jurisdiction to evaluate against: this request names no country and the branch has none.'
    );
  }
  const place: Jurisdiction = {
    countryCode,
    regionCode: input.regionCode ?? (input.countryCode ? null : (branch?.regionCode ?? null)),
  };

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const day = startOfCalendarDay(occurredAt);

  const location = input.locationId
    ? await tx.inventoryLocation.findUnique({
        where: { id: input.locationId },
        /*
         * ⚠️ BOTH FLAGS, BECAUSE A LOCATION CARRIES ITS OWN AND A PROFILE
         *   CARRIES ONE TOO. Reading only the profile's — which is what this
         *   did — makes `inventory_locations.requires_controlled_access` dead
         *   for every regulatory decision: a cabinet a clinic has explicitly
         *   marked controlled, but hung no storage profile on, reads as an
         *   open shelf, and a `controlledAccessRequired` rule refuses a
         *   receipt into the very place the clinic set up for it. Refusing is
         *   the safe direction, which is exactly why nobody would have noticed
         *   — it presents as the rule being too strict rather than as a field
         *   being ignored.
         */
        select: {
          kind: true,
          requiresControlledAccess: true,
          storageProfile: { select: { requiresControlledAccess: true } },
        },
      })
    : null;

  const [rules, profile, path] = await Promise.all([
    loadRules(tx, place, day),
    loadProfile(tx, input.productId, place, day),
    categoryPath(tx, product.categoryId),
  ]);

  const request: RegulatoryRequest = {
    jurisdiction: place,
    transaction: input.transaction,
    product: {
      id: product.id,
      type: product.type,
      categoryPath: path,
      compositionId: product.compositionId,
    },
    profile,
    rules,
    actor: {
      roleCodes: actor.roleCodes,
      ...(actor.licenceTypes ? { licenceTypes: actor.licenceTypes } : {}),
    },
    quantityBase: input.quantityBase,
    occurredAt,
    ...(input.priorQuantityInPeriodBase !== undefined
      ? { priorQuantityInPeriodBase: input.priorQuantityInPeriodBase }
      : {}),
    ...(input.prescription
      ? {
          prescription: {
            presented: input.prescription.presented,
            signedByQualifiedPrescriber: input.prescription.signedByQualifiedPrescriber,
            issuedOn: startOfCalendarDay(new Date(input.prescription.issuedOn)),
            refillsUsed: input.prescription.refillsUsed,
            ...(input.prescription.prescriberClasses
              ? { prescriberClasses: input.prescription.prescriberClasses }
              : {}),
          },
        }
      : {}),
    ...(input.patient
      ? {
          patient: {
            subjectType: input.patient.subjectType,
            /*
             * ⚠️ ABSENT STAYS ABSENT. An age the caller did not supply must not
             *   arrive as a key holding `undefined`: `AGE_RESTRICTION` reads
             *   "we do not know" as `UNDETERMINED`, which refuses, and that is
             *   the answer a missing date of birth deserves.
             */
            ...(input.patient.ageYears !== undefined ? { ageYears: input.patient.ageYears } : {}),
          },
        }
      : {}),
    ...(input.substitution
      ? {
          substitution: {
            isSubstitution: input.substitution.isSubstitution,
            ...(input.substitution.prescriberConsented !== undefined
              ? { prescriberConsented: input.substitution.prescriberConsented }
              : {}),
            ...(input.substitution.patientConsented !== undefined
              ? { patientConsented: input.substitution.patientConsented }
              : {}),
          },
        }
      : {}),
    ...(location
      ? {
          location: {
            kind: location.kind,
            // Either establishes it. A clinic saying "this cabinet is locked"
            // on the location itself is the same assertion as a storage
            // profile saying it, and requiring both would mean a location is
            // only ever controlled if it also happens to carry a profile.
            hasControlledAccess:
              location.requiresControlledAccess ||
              (location.storageProfile?.requiresControlledAccess ?? false),
          },
        }
      : {}),
    ...(input.destinationCountryCode
      ? { destination: { countryCode: input.destinationCountryCode, regionCode: null } }
      : {}),
    ...(input.traceability
      ? {
          traceability: {
            gtin: input.traceability.gtin ?? null,
            lotNumber: input.traceability.lotNumber ?? null,
            expiresOn: input.traceability.expiresOn
              ? startOfCalendarDay(new Date(input.traceability.expiresOn))
              : null,
            serial: input.traceability.serial ?? null,
          },
        }
      : {}),
  };

  const decision = evaluate(request);

  return {
    outcome: decision.outcome,
    conditions: decision.conditions,
    reasons: decision.reasons,
    packVersionIds: [...decision.packVersionIds],
    lowestPackMaturity: decision.lowestPackMaturity,
    jurisdiction: formatJurisdiction(place),
    hasProfile: profile !== null,
    evaluatedAt: occurredAt.toISOString(),
  };
}

/** The same question, for a caller that is not already in a transaction. */
export async function evaluateFor(
  ctx: TenantContext,
  input: EvaluateRegulatoryRequest,
  actor: RegulatoryActorInput
): Promise<RegulatoryDecisionResponse> {
  return withTenant(ctx, async (tx) => evaluateWithin(tx, ctx, input, actor));
}
