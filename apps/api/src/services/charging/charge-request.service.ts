/**
 * The charge request — the structured hand-off from a supply to a bill (PI-8).
 *
 * ── WHAT THIS FILE MAY AND MAY NOT DO ───────────────────────────────────────
 * It resolves a POLICY, a PRICE and a TAX CATEGORY, and writes a row. It does
 * not compute a tax amount, split a tax line, name a tax, or insert into
 * `invoice_items` — every one of those belongs to `services/invoicing` and
 * `@rcln/tax`, which this programme does not modify (PI-ADR-005/006). The single
 * string it contributes to the tax engine is `taxCategory`, and it gets it from
 * `resolveTaxCategory` rather than by knowing anything about tax.
 *
 * ── RAISED INSIDE THE SUPPLY'S OWN TRANSACTION, AND NEVER ABLE TO STOP IT ────
 * `raiseChargeRequestsWithin` runs on the dispense's transaction. Two properties
 * are in tension and both are required:
 *
 *   · A charge request that could commit independently of its dispense WILL, on
 *     the day the dispense rolls back — and the clinic bills for medicine that
 *     never left the shelf. So: same transaction.
 *   · A pharmacist handing somebody their medicine must NEVER be stopped because
 *     an accountant has not filled in a pricing grid. So: no missing
 *     configuration throws.
 *
 * They are reconciled by making every "gap" a NULLABLE COLUMN rather than an
 * error. No price → `unit_price IS NULL`. No tax classification →
 * `tax_category IS NULL`. Both are shown on the charge-review screen as
 * something to fix, and the invoice engine refuses to ISSUE an unrated line
 * anyway — which is the right place for that refusal, because by then nobody is
 * standing at a counter waiting.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * A charge request is "this named person was given this medicine and owes for
 * it". Reads log through `recordDataAccess`; writes carry ids and counts. No log
 * line from this file names a patient or a product.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ChargeQueueSummary,
  ChargeRequestListResponse,
  ChargeRequestSummary,
  DecideChargeRequest,
  ListChargeRequestsQuery,
} from '@rcln/contracts';
import { convertFromBase } from '@rcln/inventory';
import { money } from '@rcln/payments';

import { ConflictError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { organizationCurrency } from '../invoicing/invoice-lifecycle.service.js';
import { toDecimal, toMoney } from '../invoicing/money.js';
import { assertBranchInScope } from '../pharmacy/shared.js';
import { resolveTaxCategories } from '../product/tax-classification.service.js';
import { loadUnitGraph } from '../product/unit.service.js';
import {
  auditMeta,
  defaultChargePolicy,
  isBillable,
  needsDecision,
  resolveChargePoliciesWithin,
  type ChargingActionOptions,
} from './policy.service.js';
import { resolveProductPricesWithin } from './price.service.js';

// ---------------------------------------------------------------------------
// Raising them
// ---------------------------------------------------------------------------

/** One supplied — or returned — line, as the caller already has it in hand. */
export interface ChargeableLine {
  /** Exactly one of these two, matching `charge_requests_reference_matches_kind`. */
  dispenseLineId?: string;
  dispenseReturnLineId?: string;
  productId: string;
  /** Positive, in the product's base unit. The REVERSAL's sign is its `kind`. */
  quantityBase: string;
}

export interface RaiseChargeRequestsInput {
  branchId: string;
  kind: 'SUPPLY' | 'REVERSAL';
  patientId: string | null;
  /** The instant of the supply. Becomes the invoice's `suppliedAt`. */
  occurredAt: Date;
  lines: readonly ChargeableLine[];
}

/**
 * Write the money side of a supply, on the caller's transaction.
 *
 * ⚠️ THE THREE READS ARE HOISTED OUT OF THE LOOP ON PURPOSE. The unit graph, the
 *   organization's currency and the branch's jurisdiction are the same for every
 *   line of one dispense, and reading them per line makes a twelve-line supply
 *   thirty-six extra round trips inside the transaction that is holding stock
 *   locks. `priceDraftInvoice` hoists its own reads for the same reason and says
 *   so.
 *
 * ⚠️ A `NEVER_BILL` OR `INCLUDED_IN_SERVICE` LINE STILL GETS A ROW. It is
 *   written `SUPPRESSED` with the policy's own name as the reason, and that is
 *   the whole argument for this table being a table: "we decided not to charge
 *   for this" and "we forgot to charge for this" are indistinguishable in a
 *   revenue figure and are entirely different problems. A consumed glove
 *   produces no invoice LINE; it does produce a record saying why.
 */
export async function raiseChargeRequestsWithin(
  tx: TxClient,
  ctx: TenantContext,
  input: RaiseChargeRequestsInput
): Promise<{ raised: number; suppressed: number }> {
  if (input.lines.length === 0) return { raised: 0, suppressed: 0 };

  const currency = await organizationCurrency(tx, ctx);
  const graph = await loadUnitGraph(tx);

  const branch = await tx.branch.findFirst({
    where: { id: input.branchId, organizationId: ctx.organizationId },
    select: { countryCode: true, regionCode: true },
  });
  /*
   * ⚠️ THE BRANCH'S JURISDICTION, NEVER THE PATIENT'S — the warning
   *   TAX_INTEGRATION.md gives and the one `invoices.place_of_supply` repeats. A
   *   dispensed medicine is physically supplied at the counter, and taking the
   *   jurisdiction from where the patient happens to live bills a Karnataka
   *   supply as inter-state.
   *
   *   Under RLS a missing branch is one that does not exist OR one belonging to
   *   another tenant, and both mean there is no jurisdiction to classify
   *   against. The charge request is still written, unclassified — refusing here
   *   would stop the dispense.
   */
  const jurisdiction = branch
    ? { countryCode: branch.countryCode, regionCode: branch.regionCode }
    : null;

  /*
   * ⚠️ EVERY READ IS BATCHED, AND THAT IS NOT A MICRO-OPTIMISATION. This runs
   *   inside `createDispense`'s transaction while it holds advisory bucket locks
   *   on every batch and serial it is about to move. The first version did five
   *   queries PER LINE — product, policy, price, tax category, insert — so a
   *   twelve-line supply added about sixty round trips to the most contended
   *   write in the programme, each one lengthening the window every other till at
   *   the branch queues behind. It is now a fixed five regardless of line count.
   *
   *   The three resolvers are the SAME functions the single-product path uses,
   *   with the singular delegating to the batch — a second copy of the tax
   *   precedence rule in particular is how the PI-1 `NULLS LAST` bug comes back.
   */
  const products = await tx.product.findMany({
    where: {
      id: { in: [...new Set(input.lines.map((line) => line.productId))] },
      /*
       * ⚠️ `organizationId` EXPLICITLY, even though a platform product carries
       *   NULL and RLS already scopes this. ADR-0005's defence-in-depth is worth
       *   nothing where one query opts out; `product_visible` is the policy that
       *   makes the OR safe.
       */
      OR: [{ organizationId: ctx.organizationId }, { organizationId: null }],
    },
    select: { id: true, name: true, type: true, categoryId: true, baseUnitId: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const [policies, prices, taxes] = await Promise.all([
    resolveChargePoliciesWithin(tx, ctx, products),
    resolveProductPricesWithin(
      tx,
      ctx,
      products.map((product) => product.id),
      input.branchId,
      currency
    ),
    jurisdiction
      ? resolveTaxCategories(
          tx,
          products.map((product) => product.id),
          jurisdiction,
          input.occurredAt
        )
      : Promise.resolve(new Map<string, { taxCategory: string | null; itemCode: string | null }>()),
  ]);

  let raised = 0;
  let suppressed = 0;
  const rows: Prisma.ChargeRequestCreateManyInput[] = [];

  for (const line of input.lines) {
    const product = productById.get(line.productId);
    /*
     * A dispense line's product FK is Restrict, so this cannot miss for a line
     * the caller just wrote. Guarded rather than asserted because the same
     * function will serve PI-9's consumption path, whose caller is not written
     * yet.
     */
    if (!product) continue;

    const policy = policies.get(product.id) ?? {
      policy: defaultChargePolicy(product.type),
      scope: 'DEFAULT' as const,
      ruleId: null,
    };
    const price = prices.get(product.id) ?? null;
    const tax = taxes.get(product.id) ?? { taxCategory: null, itemCode: null };

    /*
     * ⚠️ THE CONVERSION IS ALLOWED TO FAIL, AND FAILING MUST NOT STOP THE SUPPLY.
     *   This is the file's central promise and the first version broke it:
     *   `convertFromBase` throws when a unit is missing from the graph, when the
     *   two units measure different classes, or when no path joins them — and
     *   `loadUnitGraph` filters `isActive: true`. So DEACTIVATING a unit that a
     *   live `product_prices` row is denominated in made every subsequent
     *   dispense of that product throw inside `createDispense`'s transaction.
     *
     *   `upsertProductPrice` validates the unit at write time, but that is a
     *   point-in-time check against a mutable graph. So an unusable price is
     *   treated as what it is — a configuration gap — and degrades to the
     *   unpriced case the design already handles.
     */
    let pricedUnitId = price?.unitId ?? product.baseUnitId;
    let unitPrice = price ? toDecimal(price.unitPrice) : null;
    let billedQuantity: string;
    try {
      billedQuantity = toBilledQuantity(graph, line.quantityBase, product.baseUnitId, pricedUnitId);
    } catch {
      pricedUnitId = product.baseUnitId;
      unitPrice = null;
      billedQuantity = toBilledQuantity(
        graph,
        line.quantityBase,
        product.baseUnitId,
        product.baseUnitId
      );
    }

    /*
     * ⚠️ SUPPRESSED AT BIRTH WHERE THE POLICY ALREADY DECIDED, AND THE REASON IS
     *   THE POLICY'S OWN NAME. `needsDecision` policies stay PENDING for a human;
     *   `SEPARATELY_BILLABLE` stays PENDING for an invoice. Everything else has
     *   been answered, and leaving it PENDING would fill the review queue with
     *   gauze nobody will ever act on — which is how a queue stops being read.
     */
    const willBill = isBillable(policy.policy) || needsDecision(policy.policy);
    if (willBill) raised += 1;
    else suppressed += 1;

    rows.push({
      organizationId: ctx.organizationId,
      branchId: input.branchId,
      sourceType: 'PHARMACY',
      kind: input.kind,
      status: willBill ? 'PENDING' : 'SUPPRESSED',
      ...(line.dispenseLineId ? { dispenseLineId: line.dispenseLineId } : {}),
      ...(line.dispenseReturnLineId ? { dispenseReturnLineId: line.dispenseReturnLineId } : {}),
      productId: product.id,
      patientId: input.patientId,
      occurredAt: input.occurredAt,
      quantityBase: new Prisma.Decimal(line.quantityBase),
      quantity: new Prisma.Decimal(billedQuantity),
      unitId: pricedUnitId,
      policy: policy.policy,
      policyScope: policy.scope,
      policyRuleId: policy.ruleId,
      description: describe(product.name, input.kind),
      unitPrice,
      currency,
      taxCategory: tax.taxCategory,
      itemCode: tax.itemCode,
      ...(willBill
        ? {}
        : {
            suppressedReason:
              policy.policy === 'NEVER_BILL'
                ? 'Charge policy: never billed.'
                : 'Charge policy: included in the service fee.',
          }),
    });
  }

  /*
   * ⚠️ ONE INSERT. `createMany` is safe here because nothing downstream needs the
   *   generated ids — the charge request is read back by its dispense line, never
   *   by an id this function hands out.
   */
  if (rows.length > 0) await tx.chargeRequest.createMany({ data: rows });

  return { raised, suppressed };
}

/**
 * The base quantity, expressed in the unit the price is per.
 *
 * ⚠️ IT IS ROUNDED TO THREE PLACES AND THE LEDGER'S IS NOT, WHICH IS THE
 *   DELIBERATE PRECISION STEP BILLING_INTEGRATION.md DESCRIBES.
 *   `invoice_items.quantity` is `Decimal(14,3)` — a coarser, human-facing number
 *   on a frozen column of an issued document — and `stock_ledger` is
 *   `Decimal(18,6)`. `quantity_base` on the charge request keeps the exact
 *   figure, so the reconciliation against the ledger is never done against the
 *   rounded one.
 *
 * ⚠️ AN INEXACT CONVERSION IS ROUNDED HERE AND REFUSED IN THE LEDGER, AND THE
 *   ASYMMETRY IS CORRECT. Rounding a MOVEMENT means the ledger and the shelf
 *   disagree by design, which is why `toBaseUnits` calls
 *   `assertExactConversion`. Rounding a BILLED quantity means the patient is
 *   charged for 2.667 strips as 2.667 strips — the money is computed from this
 *   number by the invoice engine, so it is the number, not an approximation of
 *   one.
 */
function toBilledQuantity(
  graph: Parameters<typeof convertFromBase>[0],
  quantityBase: string,
  baseUnitId: string,
  pricedUnitId: string
): string {
  const inPricedUnit =
    pricedUnitId === baseUnitId
      ? quantityBase
      : /*
         * `assertExactConversion` is deliberately NOT called on the result.
         * `exact: false` is the ORDINARY case here — three tablets out of a
         * ten-tablet strip is 0.3 of a strip, and that reads perfectly well on a
         * bill — which is exactly why this is a separate function rather than a
         * flag on `toBaseUnits`. The ledger refuses an inexact conversion
         * because the shelf and the ledger must agree to the last unit; a bill
         * has three decimal places and always did.
         */
        convertFromBase(graph, quantityBase, baseUnitId, pricedUnitId).quantity;

  return new Prisma.Decimal(inPricedUnit)
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP)
    .toString();
}

/**
 * The line as the patient will read it.
 *
 * ⚠️ `invoice_items.description` IS varchar(255) AND A LONG PRODUCT NAME MUST NOT
 *   ABORT A DISPENSE. Truncated here rather than at the invoice boundary, so the
 *   charge-review screen shows exactly the string that will be printed. Same
 *   helper `appointment-billing.service.ts` needed and for the same reason.
 */
function describe(productName: string, kind: 'SUPPLY' | 'REVERSAL'): string {
  const text = kind === 'REVERSAL' ? `${productName} (returned)` : productName;
  return text.length <= 255 ? text : `${text.slice(0, 254)}…`;
}

/**
 * A return came back — undo the money side.
 *
 * ⚠️ IT DOES NOT EDIT THE ORIGINAL CHARGE REQUEST, EVER. Where that request has
 *   not reached a bill, this CANCELS it — nothing was owed, so nothing is
 *   credited. Where it HAS, the reversal stays `PENDING` and becomes a CREDIT
 *   NOTE, because an issued invoice may have been claimed against insurance and
 *   the lifecycle guard refuses an edit regardless. Same discipline the ledger
 *   applies to a `RETURN` movement: another record, never a rewrite.
 *
 * ⚠️ A PARTIAL RETURN CANCELS NOTHING. Returning three of ten tablets leaves the
 *   original charge standing in full and raises a reversal for three — which the
 *   credit note then prices. Cancelling the whole original and re-raising the
 *   seven would burn the idempotency guarantee and lose the fact that ten were
 *   supplied.
 */
export async function reverseChargeForReturnWithin(
  tx: TxClient,
  ctx: TenantContext,
  input: Omit<RaiseChargeRequestsInput, 'lines' | 'kind'> & {
    lines: readonly ReversedLine[];
  }
): Promise<{ raised: number; cancelled: number }> {
  if (input.lines.length === 0) return { raised: 0, cancelled: 0 };

  const { raised } = await raiseChargeRequestsWithin(tx, ctx, {
    ...input,
    kind: 'REVERSAL',
    lines: input.lines,
  });

  const supplyLineIds = [...new Set(input.lines.map((line) => line.originalDispenseLineId))];

  /*
   * ⚠️ THE DATABASE COLUMN IS THE SOURCE OF TRUTH, NOT THIS DOCUMENT'S
   *   QUANTITIES. `dispense_lines.returned_quantity_base` is the RUNNING total
   *   across every return ever taken against the line, so two partial returns
   *   that together complete it cancel the charge on the second — which a check
   *   against only this document's lines would miss.
   *
   * ⚠️ WHICH MEANS THIS DEPENDS ON `return.service.ts` HAVING ALREADY INCREMENTED
   *   IT, AND THAT ORDERING IS THE LOAD-BEARING WALL. It does: the increment
   *   happens in the line loop and this runs after `refreshDispenseStatus`. An
   *   earlier version of this function accumulated the document's own quantities
   *   into a map and never read it — the map was inert, and the comment above it
   *   pointed a future reader at arithmetic that was doing nothing while the real
   *   guarantee sat undocumented in another file. Said plainly here instead.
   */
  const supplyLines = await tx.dispenseLine.findMany({
    where: {
      organizationId: ctx.organizationId,
      id: { in: supplyLineIds },
    },
    select: { id: true, quantityBase: true, returnedQuantityBase: true },
  });

  const originals = await tx.chargeRequest.findMany({
    where: {
      organizationId: ctx.organizationId,
      dispenseLineId: { in: supplyLineIds },
      status: 'PENDING',
    },
    select: { id: true, dispenseLineId: true },
  });

  /*
   * Cancel only the originals whose supply has come back IN FULL and which never
   * reached a bill. A PENDING charge for a supply that is entirely back on the
   * shelf is a charge for nothing, and leaving it on the queue means somebody
   * eventually raises it. A PARTIAL return leaves the original standing at its
   * full quantity — the reversal is what reduces it, through a credit note —
   * because rewriting the original would lose the fact that ten were supplied.
   */
  let cancelled = 0;
  for (const original of originals) {
    const supply = supplyLines.find((row) => row.id === original.dispenseLineId);
    if (!supply) continue;

    if (supply.returnedQuantityBase.lessThan(supply.quantityBase)) continue;

    await tx.chargeRequest.update({
      where: { id: original.id },
      data: { status: 'CANCELLED', decidedById: ctx.userId, decidedAt: new Date() },
    });
    cancelled += 1;

    /*
     * ⚠️ AND THE REVERSAL RAISED FOR IT, OR IT IS ORPHANED FOR EVER. A REVERSAL
     *   cannot be invoiced — `charge-billing.service.ts` refuses `kind` REVERSAL
     *   — and it cannot be credit-noted either, because cancelling the original
     *   means there is no invoice to credit. Left PENDING it sits on the queue
     *   permanently and subtracts from the header's `estimatedValueMinor` against
     *   nothing. Nothing is owed in either direction once both are cancelled,
     *   which is the correct end state for a supply that never reached a bill.
     */
    await tx.chargeRequest.updateMany({
      where: {
        organizationId: ctx.organizationId,
        kind: 'REVERSAL',
        status: 'PENDING',
        /* `supply.id` rather than `original.dispenseLineId`: the same value, and
           already narrowed to a string by the `find` above. */
        dispenseReturnLine: { dispenseLineId: supply.id },
      },
      data: { status: 'CANCELLED', decidedById: ctx.userId, decidedAt: new Date() },
    });
  }

  return { raised, cancelled };
}

/** A return line, and the supply line it came off. */
export interface ReversedLine extends ChargeableLine {
  /** ⚠️ Required: it is what the cancellation arithmetic groups by. */
  originalDispenseLineId: string;
}

// ---------------------------------------------------------------------------
// Reading them
// ---------------------------------------------------------------------------

const SUMMARY_SELECT = {
  id: true,
  branchId: true,
  sourceType: true,
  kind: true,
  status: true,
  productId: true,
  patientId: true,
  occurredAt: true,
  quantity: true,
  quantityBase: true,
  unitId: true,
  policy: true,
  policyScope: true,
  policyRuleId: true,
  description: true,
  unitPrice: true,
  currency: true,
  taxCategory: true,
  itemCode: true,
  invoiceId: true,
  suppressedReason: true,
  decidedAt: true,
  product: { select: { name: true } },
  unit: { select: { symbol: true } },
  patient: { select: { firstName: true, lastName: true } },
  invoice: { select: { invoiceNumber: true } },
  dispenseLine: { select: { dispenseId: true, dispense: { select: { dispenseNumber: true } } } },
  dispenseReturnLine: {
    select: {
      dispenseLine: {
        select: { dispenseId: true, dispense: { select: { dispenseNumber: true } } },
      },
    },
  },
} satisfies Prisma.ChargeRequestSelect;

type SummaryRow = Prisma.ChargeRequestGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): ChargeRequestSummary {
  const unitPriceMinor =
    row.unitPrice === null ? null : toMoney(row.unitPrice, row.currency).amountMinor;

  const supply = row.dispenseLine ?? row.dispenseReturnLine?.dispenseLine ?? null;

  return {
    id: row.id,
    branchId: row.branchId,
    sourceType: row.sourceType as 'PHARMACY' | 'INVENTORY',
    kind: row.kind,
    status: row.status,
    productId: row.productId,
    productName: row.product.name,
    patientId: row.patientId,
    patientName: row.patient
      ? row.patient.lastName
        ? `${row.patient.firstName} ${row.patient.lastName}`
        : row.patient.firstName
      : null,
    occurredAt: row.occurredAt.toISOString(),
    quantity: row.quantity.toString(),
    unitId: row.unitId,
    unitSymbol: row.unit.symbol,
    quantityBase: row.quantityBase.toString(),
    policy: row.policy,
    policyScope: row.policyScope,
    policyRuleId: row.policyRuleId,
    description: row.description,
    unitPriceMinor,
    currency: row.currency,
    taxCategory: row.taxCategory,
    itemCode: row.itemCode,
    /*
     * ⚠️ INDICATIVE, AND THE FIELD NAME SAYS SO. The real figure comes out of
     *   `priceInvoice` with the discount apportioned and the tax computed per
     *   line; this is `unit_price × quantity` so the desk can see roughly what
     *   it is about to raise. A screen that presented it as the total would
     *   disagree with the invoice by the discount.
     *
     * ⚠️ INDICATIVE IS NOT AN EXEMPTION FROM DECIMAL. This was
     *   `Math.round(unitPriceMinor * Number(row.quantity.toString()))` — the
     *   `.toNumber()` route through IEEE-754 that `money.ts` says never to take —
     *   while `getChargeQueueSummary` in this same file summed the same figures in
     *   `Prisma.Decimal` with an explicit ROUND_HALF_UP. So the queue HEADER and
     *   the queue ROWS computed one quantity two ways and could disagree by a
     *   minor unit on the same screen. The rule is unconditional and the correct
     *   form was already here to copy.
     */
    estimatedTotalMinor:
      row.unitPrice === null
        ? null
        : toMoney(
            row.unitPrice.times(row.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
            row.currency
          ).amountMinor,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoice?.invoiceNumber ?? null,
    suppressedReason: row.suppressedReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    dispenseId: supply?.dispenseId ?? null,
    dispenseNumber: supply?.dispense.dispenseNumber ?? null,
  };
}

/**
 * The charge queue.
 *
 * ⚠️ IT LOGS A DISCLOSURE ROW, UNLIKE THE APPOINTMENT BILLING PREVIEW, AND THE
 *   DIFFERENCE IS WHAT IT RETURNS. That preview carries an appointment id and a
 *   fee; this carries a patient's NAME beside a medicine's name, which is the
 *   same fact `dispenses` holds and gets the same treatment.
 */
export async function listChargeRequests(
  ctx: TenantContext,
  query: ListChargeRequestsQuery,
  options: ChargingActionOptions = {}
): Promise<ChargeRequestListResponse> {
  if (query.branchId) assertBranchInScope(ctx, query.branchId);

  return withTenant(ctx, async (tx) => {
    const where = whereFor(ctx, query);

    const [rows, total] = await Promise.all([
      tx.chargeRequest.findMany({
        where,
        select: SUMMARY_SELECT,
        /* Total order: `occurredAt` ties across the lines of one dispense. */
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.chargeRequest.count({ where }),
    ]);

    /*
     * ⚠️ ON THE SAME TRANSACTION AS THE READ IT RECORDS. A disclosure row that
     *   can commit apart from the read it describes is one that will, on the day
     *   the read rolls back — and worse, a read that succeeded with a log write
     *   that failed is a disclosure with no record. Same shape every read in
     *   `queue.service.ts` uses.
     */
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'CHARGE_REQUEST',
      /* ⚠️ Ids and a count. Never a name, never a product name. */
      resultCount: rows.length,
      ...(query.patientId !== undefined ? { patientId: query.patientId } : {}),
      ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      ...(options.route !== undefined ? { route: options.route } : {}),
      ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });

    return { items: rows.map(toSummary), total, page: query.page, limit: query.limit };
  });
}

function whereFor(
  ctx: TenantContext,
  query: ListChargeRequestsQuery
): Prisma.ChargeRequestWhereInput {
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;

  return {
    organizationId: ctx.organizationId,
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(from || to
      ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    /*
     * ⚠️ "NEEDS ATTENTION" IS AND-ED WITH EVERYTHING ELSE, NOT OR-ED WITH IT.
     *   It narrows a queue the caller has already scoped; an OR here would widen
     *   a branch filter into every branch, which is the shape of bug
     *   `invoice-visibility.ts` warns about when a client-controlled filter
     *   replaces a boundary instead of intersecting it.
     */
    ...(query.needsAttention === true
      ? {
          status: 'PENDING',
          OR: [
            { unitPrice: null },
            { taxCategory: null },
            { policy: { in: ['OPTIONAL', 'CONTRACT_DEFINED', 'JURISDICTION_CONFIGURED'] } },
          ],
        }
      : {}),
  };
}

/**
 * The queue's header counts.
 *
 * ⚠️ COUNTS AND ONE SUM, WITH NO NAMES IN THE RESPONSE, because it renders on
 *   every poll of the screen. Putting a patient in a per-poll response is the
 *   firehose `invoice.service.ts` explains it is avoiding.
 */
export async function getChargeQueueSummary(
  ctx: TenantContext,
  branchId: string | undefined
): Promise<ChargeQueueSummary> {
  if (branchId) assertBranchInScope(ctx, branchId);

  return withTenant(ctx, async (tx) => {
    const scope: Prisma.ChargeRequestWhereInput = {
      organizationId: ctx.organizationId,
      ...(branchId ? { branchId } : {}),
    };

    const [byStatus, attention, pendingRows, currency] = await Promise.all([
      tx.chargeRequest.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      tx.chargeRequest.count({
        where: {
          ...scope,
          status: 'PENDING',
          OR: [
            { unitPrice: null },
            { taxCategory: null },
            { policy: { in: ['OPTIONAL', 'CONTRACT_DEFINED', 'JURISDICTION_CONFIGURED'] } },
          ],
        },
      }),
      /*
       * ⚠️ SUMMED IN NODE RATHER THAN IN SQL, AND THAT IS NOT LAZINESS. The value
       *   is `unit_price × quantity` per row and the two columns have different
       *   scales; a `SUM()` over a computed expression would round once at the
       *   end where the invoice rounds per line, so the header would disagree
       *   with the bill it is a preview of. The pending queue at one branch is
       *   tens of rows, not thousands.
       */
      tx.chargeRequest.findMany({
        where: { ...scope, status: 'PENDING', unitPrice: { not: null } },
        select: { unitPrice: true, quantity: true, currency: true, kind: true },
      }),
      organizationCurrency(tx, ctx),
    ]);

    const countOf = (status: string): number =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    const estimatedValueMinor = pendingRows.reduce((sum, row) => {
      const lineMinor = toMoney(
        row.unitPrice!.times(row.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        row.currency
      ).amountMinor;
      /* A reversal reduces what is outstanding; see `ChargeRequestKind`. */
      return sum + (row.kind === 'REVERSAL' ? -lineMinor : lineMinor);
    }, 0);

    return {
      branchId: branchId ?? null,
      pending: countOf('PENDING'),
      needsAttention: attention,
      suppressed: countOf('SUPPRESSED'),
      invoiced: countOf('INVOICED'),
      estimatedValueMinor,
      currency,
    };
  });
}

// ---------------------------------------------------------------------------
// Deciding them
// ---------------------------------------------------------------------------

/**
 * A human's answer to a charge the policy would not decide.
 *
 * ⚠️ ONLY A `PENDING` REQUEST MAY BE DECIDED, AND THE ROW IS LOCKED FIRST. Two
 *   people at two tills answering the same charge is the ordinary race, and
 *   `withTenant` is plain READ COMMITTED — the lesson PI-3 learned three times
 *   over, where every transfer state transition turned out to be a
 *   read-then-write race. An already-INVOICED request must not be suppressible:
 *   the patient is holding the bill.
 */
export async function decideChargeRequest(
  ctx: TenantContext,
  chargeRequestId: string,
  input: DecideChargeRequest,
  options: ChargingActionOptions = {}
): Promise<ChargeRequestSummary> {
  return withTenant(ctx, async (tx) => {
    await lockChargeRequest(tx, chargeRequestId);

    const before = await tx.chargeRequest.findFirst({
      where: { id: chargeRequestId, organizationId: ctx.organizationId },
      select: {
        id: true,
        status: true,
        branchId: true,
        policy: true,
        unitPrice: true,
        currency: true,
      },
    });
    if (!before) throw new NotFoundError('Charge request');

    if (before.status !== 'PENDING') {
      throw new ConflictError(
        before.status === 'INVOICED'
          ? 'This charge is already on an invoice. Raise a credit note against that invoice instead.'
          : `This charge is ${before.status.toLowerCase()} and cannot be decided again.`
      );
    }

    const row = await tx.chargeRequest.update({
      where: { id: chargeRequestId },
      data:
        input.decision === 'SUPPRESS'
          ? {
              status: 'SUPPRESSED',
              suppressedReason: input.reason,
              decidedById: ctx.userId,
              decidedAt: new Date(),
            }
          : {
              /*
               * ⚠️ IT STAYS `PENDING`. "Bill it" answers the POLICY question and
               *   raises no invoice — the document is assembled later, from a set
               *   the desk confirms. Moving it to INVOICED here would be a status
               *   claiming an invoice that does not exist, which the CHECK
               *   refuses anyway.
               */
              decidedById: ctx.userId,
              decidedAt: new Date(),
              ...(input.unitPriceMinor !== undefined
                ? { unitPrice: toDecimal(money(input.unitPriceMinor, before.currency)) }
                : {}),
            },
      select: SUMMARY_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'charge_request',
      entityId: chargeRequestId,
      branchId: before.branchId,
      before: { status: before.status, unitPrice: before.unitPrice?.toString() ?? null },
      after: { status: row.status, unitPrice: row.unitPrice?.toString() ?? null },
      ...auditMeta(options),
    });

    return toSummary(row);
  });
}

/**
 * Serialise two people deciding the same charge.
 *
 * `FOR UPDATE` on the row rather than an advisory lock, because the row is real,
 * the lock is released by COMMIT without anybody remembering to, and RLS applies
 * to it — a lock on another tenant's id locks nothing and the subsequent read
 * 404s, which is the same answer every other path gives.
 */
async function lockChargeRequest(tx: TxClient, chargeRequestId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM charge_requests WHERE id = ${chargeRequestId}::uuid FOR UPDATE
  `;
}

export { SUMMARY_SELECT as CHARGE_REQUEST_SELECT, toSummary as toChargeRequestSummary };
export type { SummaryRow as ChargeRequestRow };
