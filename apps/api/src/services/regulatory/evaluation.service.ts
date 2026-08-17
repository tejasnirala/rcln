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
  parseQuantityLimit,
  selectApplicableRules,
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
  /**
   * Is this caller the prescriber of the prescription being dispensed? (PI-7.)
   *
   * ⚠️ DERIVED BY THE SERVICE FROM THE ENCOUNTER AND `ctx.userId`, NEVER SENT BY
   *   A CLIENT, which is why it lives on this interface and not on
   *   `EvaluateRegulatoryRequest`. It exempts nothing by itself: a rule has to
   *   opt in with `exemptWhenActorIsPrescriber`, and several jurisdictions do —
   *   India's Pharmacy Act s. 42(1) excludes a practitioner dispensing to their
   *   own patients from the section outright.
   */
  isPrescriber?: boolean;
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
  actor: RegulatoryActorInput,
  supplements: EvaluationSupplements = {}
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
      ...(actor.isPrescriber !== undefined ? { isPrescriber: actor.isPrescriber } : {}),
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
            /*
             * ⚠️ ABSENT STAYS ABSENT, for the reason `ageYears` does. A repeat
             *   endorsement nobody stated must not arrive as `false` either —
             *   the refill rule distinguishes "the prescriber said nothing"
             *   from "the prescriber said no", and only the first is the
             *   default position rule 65(11)(a) describes.
             */
            ...(input.prescription.repeatsAuthorised !== undefined
              ? { repeatsAuthorised: input.prescription.repeatsAuthorised }
              : {}),
            ...(input.prescription.repeatsAuthorisedLimit !== undefined
              ? { repeatsAuthorisedLimit: input.prescription.repeatsAuthorisedLimit }
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

  /*
   * ⚠️ THE PRIOR QUANTITY IS RESOLVED AFTER THE REQUEST IS BUILT AND BEFORE IT IS
   *   EVALUATED, BECAUSE THE WINDOW IS A PROPERTY OF THE RULES. See
   *   `resolvePriorQuantity`. A caller that supplied one explicitly is left
   *   alone.
   */
  const decision = evaluate(await withPriorQuantity(request, supplements));

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
  actor: RegulatoryActorInput,
  supplements: EvaluationSupplements = {}
): Promise<RegulatoryDecisionResponse> {
  return withTenant(ctx, async (tx) => evaluateWithin(tx, ctx, input, actor, supplements));
}

// ---------------------------------------------------------------------------
// The prior quantity (PI-8, closing KNOWN_ISSUES #10)
// ---------------------------------------------------------------------------

export interface EvaluationSupplements {
  /**
   * How much this subject has ALREADY been supplied of this product, over a
   * window the RULES decide.
   *
   * ⚠️ A CALLBACK RATHER THAN A VALUE, AND THAT IS THE WHOLE DESIGN PROBLEM
   *   THIS SOLVES. `QUANTITY_LIMIT` measures over `periodDays`, which is a
   *   parameter ON THE RULE — so a caller cannot know the window until the rules
   *   have been loaded and the applicable ones selected, and by then it is too
   *   late to go and ask a question it should have asked before. Passing a
   *   function lets the window travel the other way: the rules name it, and the
   *   caller — who is the only one who knows WHO the subject is — answers.
   *
   * ⚠️ AND IT KEEPS `@rcln/regulatory` PURE (PI-ADR-007). The engine still holds
   *   no Prisma client and reads no database; the lookup lives in `apps/api`
   *   with the caller. Putting the query in the package would have been the
   *   obvious shortcut and would have made the engine untestable without a
   *   tenant.
   *
   * Returns a decimal string in the product's BASE units. Never a float.
   */
  priorQuantityInPeriod?: (windowDays: number) => Promise<string>;
}

/**
 * Fill in `priorQuantityInPeriodBase` when the rules ask for one.
 *
 * ⚠️ IT USES THE ENGINE'S OWN `selectApplicableRules`, NOT A SECOND COPY OF
 *   "WHICH RULES APPLY". A rule that does not cover this product, transaction or
 *   jurisdiction must not get to decide the window — and re-implementing that
 *   selection here is how the window and the limit start disagreeing about which
 *   rule they came from.
 *
 * ⚠️ ONE SCALAR CANNOT SERVE TWO DIFFERENT WINDOWS, SO TWO DIFFERENT WINDOWS ARE
 *   REFUSED RATHER THAN RECONCILED. `RegulatoryRequest` carries a single
 *   `priorQuantityInPeriodBase`; if a 30-day rule and a 90-day rule both apply,
 *   no one number is right for both. Taking the longer window over-counts for
 *   the shorter rule and refuses lawful supplies; taking the shorter one
 *   UNDER-counts for the longer rule and PERMITS what the law forbids, which is
 *   the direction this domain may never fail in. So the value is left absent, the
 *   engine answers `UNDETERMINED`, and `UNDETERMINED` refuses — exactly what
 *   happened before this function existed. The single-window case, which is every
 *   real pack, is now answered properly.
 *
 * ⚠️ AN EXPLICIT VALUE FROM THE CALLER ALWAYS WINS. `POST /v1/regulatory/evaluate`
 *   is a what-if surface and a caller asking "what if they had already had 40?"
 *   must not have their number replaced by a lookup.
 */
async function withPriorQuantity(
  request: RegulatoryRequest,
  supplements: EvaluationSupplements
): Promise<RegulatoryRequest> {
  if (request.priorQuantityInPeriodBase !== undefined) return request;
  if (!supplements.priorQuantityInPeriod) return request;

  const windows = new Set<number>();
  for (const rule of selectApplicableRules(request)) {
    if (rule.ruleType !== 'QUANTITY_LIMIT') continue;
    const parsed = parseQuantityLimit(rule.parameters);
    /*
     * A rule whose parameters do not parse is the engine's problem to report,
     * not this function's to work around — it will say so in its own reason.
     */
    if (!parsed.ok) continue;
    if (parsed.value.maxPerPeriodBase === undefined) continue;
    if (parsed.value.periodDays === undefined) continue;
    windows.add(parsed.value.periodDays);
  }

  /* No period limit applies, so there is nothing to look up. */
  if (windows.size === 0) return request;
  /* Two windows, one slot. See the header — absent means UNDETERMINED. */
  if (windows.size > 1) return request;

  /*
   * Narrowed by a guard rather than by `as number`. `windows.size === 1` above
   * already proves this is present; a cast to say so is a `!` with a different
   * spelling, and the checklist bans the pattern rather than the punctuation.
   */
  const windowDays = [...windows][0];
  if (windowDays === undefined) return request;

  const prior = await supplements.priorQuantityInPeriod(windowDays);
  return { ...request, priorQuantityInPeriodBase: prior };
}
