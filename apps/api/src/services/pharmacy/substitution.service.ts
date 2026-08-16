/**
 * "What else could I give them, and may I?"
 *
 * ⚠️ TWO INDEPENDENT QUESTIONS, AND CONFLATING THEM IS THE CLASSIC ERROR OF THIS
 *   DOMAIN — which is why this file answers them with two different things:
 *
 *     What is equivalent?    the composition triangle. Same `composition_id`,
 *                            in stock, not expired. A catalogue question.
 *     May I substitute it?   `@rcln/regulatory`. Per jurisdiction, per product
 *                            classification, sometimes per prescriber
 *                            instruction. A legal question.
 *
 *   A product being equivalent does not make it substitutable. India, for one,
 *   forbids it outright for Schedule H, H1 and X — rule 65(11A) is a flat
 *   prohibition and does not offer the prescriber's agreement as a way round it.
 *   The default in the absence of any rule is DO NOT (PI-ADR-007).
 *
 * ⚠️ THIS ENDPOINT WRITES NO DECISION ROW, UNLIKE THE DISPENSE PATH. A
 *   `regulatory_decisions` row is the snapshot of an answer somebody ACTED on
 *   (PI-ADR-008); one per candidate per screen refresh would fill an append-only
 *   table with hypotheticals and make the real ones impossible to find. The
 *   supply asks again, at the moment of supplying, and snapshots that.
 *
 * ⚠️ NO PHI ON THIS SURFACE. It is a question about two products and a shelf. The
 *   patient is not passed to the engine here — which means an `AGE_RESTRICTION`
 *   rule resolves `UNDETERMINED` and shows as "cannot be relied on", correctly:
 *   this screen is a shortlist, and the dispense is where the full facts are.
 */
import { Prisma, withTenant, type TenantContext } from '@rcln/db';
import type {
  EvaluateRegulatoryRequest,
  SubstitutionCandidate,
  SubstitutionQuery,
  SubstitutionResponse,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { evaluateWithin } from '../regulatory/evaluation.service.js';
import { resolveBranchId, toDecisionSummary } from './shared.js';
import type { PharmacyActionOptions } from './queue.service.js';

/** How many equivalents a screen is shown. A shortlist, not a catalogue dump. */
const MAX_CANDIDATES = 20;

export async function listSubstitutionCandidates(
  ctx: TenantContext,
  productId: string,
  query: SubstitutionQuery,
  options: PharmacyActionOptions = {}
): Promise<SubstitutionResponse> {
  const branchId = resolveBranchId(ctx, query.branchId, options.actingBranchId);

  return withTenant(ctx, async (tx) => {
    const prescribed = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, compositionId: true },
    });
    if (!prescribed) throw new NotFoundError('Product');

    if (prescribed.compositionId === null) {
      /*
       * ⚠️ NOT AN ERROR AND NOT AN EMPTY LIST WITH NO EXPLANATION. A product with
       *   no composition recorded has nothing the catalogue can call equivalent —
       *   which is a gap in the catalogue rather than a statement that no
       *   equivalent exists, and a screen that showed "no alternatives" would be
       *   asserting the second.
       */
      throw new ValidationError(
        `${prescribed.name} has no composition recorded, so nothing can be shown as equivalent to it. ` +
          'Record its ingredients in the catalogue first.'
      );
    }

    const today = new Date(new Date().toISOString().slice(0, 10));

    /*
     * Equivalents that are actually on the shelf. The candidacy filter is the
     * allocator's: AVAILABLE, above zero, an active location, an ACTIVE lot and
     * not expired. Offering an equivalent the allocator would then refuse is how
     * a screen sends a pharmacist round in a circle.
     */
    const balances = await tx.stockBalance.groupBy({
      by: ['productId'],
      where: {
        branchId,
        status: 'AVAILABLE',
        quantity: { gt: 0 },
        location: { isActive: true, deletedAt: null },
        product: { compositionId: prescribed.compositionId, deletedAt: null, status: 'ACTIVE' },
        productId: { not: prescribed.id },
        OR: [
          { batchId: null },
          { batch: { status: 'ACTIVE', OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] } },
        ],
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: MAX_CANDIDATES,
    });

    if (balances.length === 0) {
      return {
        prescribedProductId: prescribed.id,
        prescribedProductName: prescribed.name,
        compositionId: prescribed.compositionId,
        candidates: [],
      };
    }

    const products = await tx.product.findMany({
      where: { id: { in: balances.map((row) => row.productId) } },
      select: {
        id: true,
        name: true,
        baseUnit: { select: { symbol: true } },
        manufacturer: { select: { name: true } },
        medicineDetail: { select: { isNarrowTherapeuticIndex: true } },
        /*
         * ⚠️ THE FIRST INGREDIENT'S STRENGTH, AS A LABEL ONLY. A medicine is never
         *   one ingredient (see `CompositionIngredient`), so this is what a
         *   pharmacist reads to tell two presentations apart on a shortlist — it
         *   is not what makes two products equivalent. `composition_id` is.
         */
        composition: {
          select: {
            ingredients: {
              select: { strength: true, strengthUnit: { select: { symbol: true } } },
              take: 1,
            },
          },
        },
      },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    const required = query.quantityBase ? new Prisma.Decimal(query.quantityBase) : null;
    const candidates: SubstitutionCandidate[] = [];

    for (const row of balances) {
      const product = byId.get(row.productId);
      if (!product) continue;

      const available = row._sum.quantity ?? new Prisma.Decimal(0);

      const decision = await evaluateWithin(
        tx,
        ctx,
        {
          productId: product.id,
          transaction: 'DISPENSE',
          branchId,
          quantityBase: required ? required.toString() : available.toString(),
          /*
           * ⚠️ THE WHOLE POINT OF ASKING: this IS a substitution, and a
           *   `SUBSTITUTION` rule only engages when the request says so. Consent
           *   is deliberately not asserted here — a screen that pre-ticked "the
           *   prescriber agreed" would answer the question it is supposed to ask.
           */
          substitution: { isSubstitution: true },
        } as EvaluateRegulatoryRequest,
        { roleCodes: options.roleCodes ?? [] }
      );

      const strength = product.composition?.ingredients[0];

      candidates.push({
        productId: product.id,
        productName: product.name,
        manufacturerName: product.manufacturer?.name ?? null,
        strength: strength
          ? `${strength.strength.toString()} ${strength.strengthUnit.symbol}`
          : null,
        baseUnitSymbol: product.baseUnit.symbol,
        availableQuantityBase: available.toString(),
        coversRequirement: required === null ? true : available.gte(required),
        /*
         * ⚠️ SURFACED BESIDE THE LEGAL ANSWER, NOT INSTEAD OF IT. A
         *   narrow-therapeutic-index medicine is where substitution goes clinically
         *   wrong — warfarin, levothyroxine, ciclosporin — and some jurisdictions
         *   forbid substituting one. Whether THIS one may be substituted is the
         *   decision beside it; this flag is what a pharmacist weighs when it may.
         */
        isNarrowTherapeuticIndex: product.medicineDetail?.isNarrowTherapeuticIndex ?? false,
        decision: toDecisionSummary(decision),
      });
    }

    return {
      prescribedProductId: prescribed.id,
      prescribedProductName: prescribed.name,
      compositionId: prescribed.compositionId,
      candidates,
    };
  });
}
