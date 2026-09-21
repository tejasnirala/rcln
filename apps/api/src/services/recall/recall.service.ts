/**
 * The recall workflow: the notice, its scope, and the one act that pulls stock
 * off every shelf in the organization at once (PI-10).
 *
 * ── THE SHAPE OF IT ─────────────────────────────────────────────────────────
 *
 *   DRAFT      the notice is recorded and the lots are being identified.
 *              ⚠️ NOTHING IS HELD. Deliberately: a half-assembled scope that
 *              blocked dispensing would stop a pharmacy mid-shift over a lot
 *              somebody was still checking.
 *   EXECUTED   every PENDING lot in scope moved from AVAILABLE to RECALLED, in
 *              one transaction, through `recordMovement()` and nothing else.
 *   CLOSED     a human says the work is finished. Nothing computes it — "we have
 *              contacted everyone we can" is not a fact the database holds.
 *   CANCELLED  raised in error or withdrawn. ⚠️ DOES NOT PUT STOCK BACK; a lot is
 *              released one at a time, by somebody looking at it.
 *
 * ── WHY EXECUTION IS ONE TRANSACTION ────────────────────────────────────────
 * ⚠️ THE HALVES MUST COMMIT TOGETHER OR NOT AT ALL, and there are three of them
 *   per lot: the ledger legs, `batches.status`, and this recall's own row. A
 *   batch flagged RECALLED whose quantity is still in the AVAILABLE bucket is
 *   DISPENSABLE — allocation reads the balance, not the batch — so a status
 *   update that committed without its movement produces a lot that says it is
 *   held and behaves as if it is not. That is strictly worse than neither, and
 *   it is the same argument `setBatchHold` makes for one lot.
 *
 * ── WHAT A BRANCH-SCOPED EXECUTOR ACTUALLY DOES ─────────────────────────────
 * ⚠️ THEY PULL THE LOTS AT THEIR OWN BRANCH AND NO OTHERS, because
 *   `recall_batches.branch_isolation` makes the rest invisible to the statement
 *   that reads them. That is the correct answer — they cannot reach another
 *   site's shelf physically either — and it is why executing is idempotent over
 *   PENDING rows rather than a one-shot transition: the storekeeper at the
 *   satellite pharmacy executes the same recall again and pulls theirs.
 *
 *   The consequence to hold on to: `recalls.status = EXECUTED` means "somebody
 *   executed it", not "every lot everywhere is held". The screen counts held
 *   against total, and `closeRecall` refuses while anything is still PENDING.
 *
 * ── THE LAW IS NOT ASKED, AND THAT IS A DECISION ────────────────────────────
 * ⚠️ `@rcln/regulatory` ANSWERS QUESTIONS ABOUT SUPPLYING A PRODUCT TO A PERSON.
 *   No rule type in PI-5 addresses WITHDRAWING one, `evaluateWithin` would
 *   answer `UNDETERMINED` — which refuses — for every product on the platform,
 *   and a rule engine that could refuse a recall would be a defect rather than a
 *   control. The same call PI-9 made and recorded for consumption; the call site
 *   for a future `RECALL_REPORTING_REQUIREMENT` rule type is marked below.
 *
 * NO PHI. Not one column in this file names a patient — see `trace.service.ts`
 * for the half that does, and TRACEABILITY.md for why they are separate.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  AddRecallBatchesRequest,
  CancelRecallRequest,
  CloseRecallRequest,
  CreateRecallRequest,
  ExecuteRecallRequest,
  RecallBatchDetail,
  RecallCandidatesResponse,
  RecallDetail,
  RecallListResponse,
  RecallQuery,
  RecallSummary,
  ResolveRecallBatchRequest,
  UpdateRecallRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueNumber } from '../numbering/number-sequence.service.js';
import { recordMovementIn } from '../inventory/movement.service.js';
import { toCalendarDate, toDateColumn } from '../product/values.js';
import { assertBranchInScope, auditMeta, q, recallReferenceFor } from './shared.js';
import type { RecallActionOptions } from './shared.js';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const summaryInclude = Prisma.validator<Prisma.RecallInclude>()({
  product: { select: { code: true, name: true, baseUnit: { select: { symbol: true } } } },
  raisedBy: { select: { fullName: true } },
  batches: { select: { status: true } },
});

const detailInclude = Prisma.validator<Prisma.RecallInclude>()({
  ...summaryInclude,
  executedBy: { select: { fullName: true } },
  closedBy: { select: { fullName: true } },
  batches: {
    orderBy: [{ createdAt: 'asc' }],
    include: {
      branch: { select: { name: true } },
      batch: {
        select: { expiresOn: true, balances: { select: { status: true, quantity: true } } },
      },
    },
  },
});

type SummaryRow = Prisma.RecallGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.RecallGetPayload<{ include: typeof detailInclude }>;

function personName(person: { fullName: string } | null): string | null {
  return person === null ? null : person.fullName;
}

/**
 * ⚠️ `Prisma.Decimal.add`, NEVER `Number(a) + Number(b)`. These are
 *   `Decimal(18,6)` values, and PI-8.11 found the float version of exactly this
 *   sum disagreeing with the correct one by a minor unit on one screen.
 */
function sumQuantities(
  balances: { status: string; quantity: Prisma.Decimal }[],
  onlyStatus: string
): string {
  return balances
    .filter((b) => b.status === onlyStatus)
    .reduce((total, b) => total.add(b.quantity), new Prisma.Decimal(0))
    .toString();
}

function toSummary(row: SummaryRow): RecallSummary {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    productId: row.productId,
    productName: row.product.name,
    productCode: row.product.code,
    classification: row.classification,
    source: row.source,
    status: row.status,
    noticeReference: row.noticeReference,
    noticeOn: row.noticeOn === null ? null : toCalendarDate(row.noticeOn),
    batchCount: row.batches.length,
    heldCount: row.batches.filter((b) => b.status !== 'PENDING').length,
    raisedByName: personName(row.raisedBy) ?? '',
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function toBatchDetail(row: DetailRow['batches'][number]): RecallBatchDetail {
  return {
    id: row.id,
    batchId: row.batchId,
    branchId: row.branchId,
    branchName: row.branch.name,
    lotNumber: row.lotNumber,
    expiresOn: row.batch.expiresOn === null ? null : toCalendarDate(row.batch.expiresOn),
    status: row.status,
    quantityHeldBase: row.quantityHeldBase === null ? null : q(row.quantityHeldBase),
    quantityAvailableBase: sumQuantities(row.batch.balances, 'AVAILABLE'),
    heldAt: row.heldAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    outcomeNote: row.outcomeNote,
  };
}

function toDetail(row: DetailRow): RecallDetail {
  return {
    ...toSummary(row),
    batchCount: row.batches.length,
    heldCount: row.batches.filter((b) => b.status !== 'PENDING').length,
    reason: row.reason,
    notes: row.notes,
    outcomeNote: row.outcomeNote,
    executedByName: personName(row.executedBy),
    closedByName: personName(row.closedBy),
    baseUnitSymbol: row.product.baseUnit.symbol,
    batches: row.batches.map(toBatchDetail),
  };
}

async function findRecallOrThrow(tx: TxClient, id: string): Promise<DetailRow> {
  const recall = await tx.recall.findUnique({ where: { id }, include: detailInclude });
  if (!recall) throw new NotFoundError('Recall');
  return recall;
}

export async function listRecalls(
  ctx: TenantContext,
  query: RecallQuery
): Promise<RecallListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.RecallWhereInput = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.productId !== undefined ? { productId: query.productId } : {}),
      ...(query.classification !== undefined ? { classification: query.classification } : {}),
      /*
       * ⚠️ THE LOT NUMBER IS SEARCHED THROUGH THE SNAPSHOT ON THE CHILD, not
       *   through a join to `batches`. It is the string the notice actually
       *   named, and it stays answerable even for a lot that has since been
       *   disposed of — which is exactly when somebody goes looking.
       */
      ...(query.search !== undefined && query.search !== ''
        ? {
            OR: [
              { reference: { contains: query.search, mode: 'insensitive' as const } },
              { noticeReference: { contains: query.search, mode: 'insensitive' as const } },
              { title: { contains: query.search, mode: 'insensitive' as const } },
              { batches: { some: { lotNumber: query.search } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.recall.findMany({
        where,
        include: summaryInclude,
        orderBy: [{ createdAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.recall.count({ where }),
    ]);

    return {
      items: rows.map(toSummary),
      total,
      page: query.page,
      limit: query.limit,
    };
  });
}

export async function getRecall(ctx: TenantContext, id: string): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => toDetail(await findRecallOrThrow(tx, id)));
}

/**
 * The lots of this product that are NOT yet in the scope.
 *
 * ⚠️ EVERY LOT, NOT ONLY THE ONES WITH STOCK ON THE SHELF. A lot that is already
 *   fully dispensed is the one the recall most needs to name — that is the row
 *   the affected-party trace hangs off — and filtering to "has quantity" would
 *   hide precisely the case where all of the work is contacting people.
 */
export async function listRecallCandidates(
  ctx: TenantContext,
  recallId: string
): Promise<RecallCandidatesResponse> {
  return withTenant(ctx, async (tx) => {
    const recall = await tx.recall.findUnique({
      where: { id: recallId },
      select: {
        productId: true,
        product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
        batches: { select: { batchId: true } },
      },
    });
    if (!recall) throw new NotFoundError('Recall');

    const already = new Set(recall.batches.map((b) => b.batchId));

    const batches = await tx.batch.findMany({
      where: { productId: recall.productId },
      include: {
        branch: { select: { name: true } },
        balances: { select: { status: true, quantity: true } },
        /*
         * ⚠️ ONLY THE LIVE ONES COUNT AS "ALREADY IN ANOTHER RECALL". A lot named
         *   by a CLOSED recall from two years ago is an ordinary candidate; the
         *   warning is about pulling the same lot into two open pieces of work,
         *   where two people would each execute half of it.
         */
        recallBatches: {
          where: { recall: { status: { in: ['DRAFT', 'EXECUTED'] } } },
          select: { recallId: true },
        },
      },
      orderBy: [{ expiresOn: 'asc' }, { receivedAt: 'asc' }],
      take: 500,
    });

    return {
      productId: recall.productId,
      productName: recall.product.name,
      baseUnitSymbol: recall.product.baseUnit.symbol,
      items: batches
        .filter((b) => !already.has(b.id))
        .map((b) => ({
          batchId: b.id,
          branchId: b.branchId,
          branchName: b.branch.name,
          lotNumber: b.lotNumber,
          expiresOn: b.expiresOn === null ? null : toCalendarDate(b.expiresOn),
          batchStatus: b.status,
          quantityOnHandBase: b.balances
            .reduce((t, x) => t.add(x.quantity), new Prisma.Decimal(0))
            .toString(),
          quantityAvailableBase: sumQuantities(b.balances, 'AVAILABLE'),
          inOtherRecall: b.recallBatches.length > 0,
        })),
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Attach lots to a recall, checking each one belongs to the recalled product and
 * to a branch this caller can see.
 *
 * ⚠️ THE PRODUCT IS RE-CHECKED SERVER-SIDE AND NEVER TRUSTED FROM THE REQUEST.
 *   A recall naming a lot of a different product would quarantine stock nobody
 *   asked about, and — worse — the affected-party trace would then report the
 *   wrong patients as having received the recalled item. PI-8.11's CRITICAL was
 *   this exact shape: a control that only the honest client applied.
 */
async function attachBatches(
  tx: TxClient,
  ctx: TenantContext,
  recall: { id: string; productId: string },
  batchIds: readonly string[]
): Promise<number> {
  if (batchIds.length === 0) return 0;

  const unique = [...new Set(batchIds)];
  const batches = await tx.batch.findMany({
    where: { id: { in: unique } },
    select: { id: true, branchId: true, productId: true, lotNumber: true },
  });

  if (batches.length !== unique.length) throw new NotFoundError('Batch');

  for (const batch of batches) {
    if (batch.productId !== recall.productId) {
      throw new ValidationError(
        `Lot ${batch.lotNumber} is not a lot of the product this recall names. A recall covers one product; raise a second notice for the other.`
      );
    }
    assertBranchInScope(ctx, batch.branchId);
  }

  const existing = await tx.recallBatch.findMany({
    where: { recallId: recall.id, batchId: { in: unique } },
    select: { batchId: true },
  });
  const already = new Set(existing.map((row) => row.batchId));
  const fresh = batches.filter((b) => !already.has(b.id));

  if (fresh.length === 0) return 0;

  await tx.recallBatch.createMany({
    data: fresh.map((batch) => ({
      organizationId: ctx.organizationId,
      branchId: batch.branchId,
      recallId: recall.id,
      batchId: batch.id,
      lotNumber: batch.lotNumber,
    })),
  });

  return fresh.length;
}

export async function createRecall(
  ctx: TenantContext,
  input: CreateRecallRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, name: true, isStockItem: true, deletedAt: true },
    });
    if (!product || product.deletedAt) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so there is nothing to recall. A consultation fee is a product to billing and never to inventory.`
      );
    }

    /*
     * ⚠️ ISSUED AT CREATE, WHICH IS THE OPPOSITE OF THE PROCUREMENT RULE. A
     *   requisition that is abandoned must burn no number because a supplier
     *   asks about the gap; a recall notice EXISTS from the moment it arrives,
     *   and a notice nobody can cite while they work out what it covers is the
     *   worse failure. See the enum comment in `..090500_recall_enum_members`.
     */
    const issued = await issueNumber(tx, ctx, { type: 'RECALL', prefix: 'REC-', padding: 5 });

    const created = await tx.recall.create({
      data: {
        organizationId: ctx.organizationId,
        reference: issued.formatted,
        productId: input.productId,
        title: input.title,
        classification: input.classification,
        source: input.source,
        noticeReference: input.noticeReference ?? null,
        noticeOn: toDateColumn(input.noticeOn ?? null),
        reason: input.reason,
        notes: input.notes ?? null,
        raisedById: ctx.userId,
      },
      select: { id: true, productId: true, reference: true },
    });

    const attached = await attachBatches(tx, ctx, created, input.batchIds ?? []);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'recall',
      entityId: created.id,
      after: {
        reference: created.reference,
        productId: input.productId,
        classification: input.classification,
        source: input.source,
        lotsInScope: attached,
      },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, created.id));
  });
}

/**
 * ⚠️ DRAFT ONLY. Once a recall has pulled stock, its reason is the sentence
 *   written onto every `stock_ledger` row it produced — editing it afterwards
 *   would leave the document disagreeing with the movements it caused, which is
 *   the shape of problem the ledger's append-only rule exists to prevent.
 */
export async function updateRecall(
  ctx: TenantContext,
  id: string,
  input: UpdateRecallRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findRecallOrThrow(tx, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError(
        `${existing.reference} has already been executed, so its notice can no longer be edited. The reason on it is the sentence written onto every movement it made.`
      );
    }

    await tx.recall.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.noticeReference !== undefined
          ? { noticeReference: input.noticeReference ?? null }
          : {}),
        ...(input.noticeOn !== undefined ? { noticeOn: toDateColumn(input.noticeOn) } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: id,
      before: { classification: existing.classification, source: existing.source },
      after: {
        classification: input.classification ?? existing.classification,
        source: input.source ?? existing.source,
      },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, id));
  });
}

/**
 * ⚠️ PERMITTED WHILE EXECUTED, NOT ONLY WHILE DRAFT, AND THAT IS THE REALISTIC
 *   CASE RATHER THAN A LOOSENING. A recall is executed on Monday over the lots
 *   the clinic knew about; on Wednesday the satellite pharmacy finds two more
 *   cartons of the same lot number at the back of a fridge. Refusing to add them
 *   would leave a second recall for the same notice, which is how one product
 *   ends up with two half-answers.
 *
 *   The new rows arrive PENDING and are pulled by executing again.
 */
export async function addRecallBatches(
  ctx: TenantContext,
  id: string,
  input: AddRecallBatchesRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findRecallOrThrow(tx, id);
    if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
      throw new ConflictError(
        `${existing.reference} is ${existing.status.toLowerCase()}, so nothing can be added to it. Raise a new notice citing the same reference.`
      );
    }

    const added = await attachBatches(tx, ctx, existing, input.batchIds);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: id,
      after: { lotsAdded: added },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, id));
  });
}

/**
 * ⚠️ PENDING ONLY, AND THE REFUSAL IS THE POINT. A lot that has been HELD has a
 *   ledger leg behind it; removing the row would leave quantity sitting in the
 *   RECALLED bucket with nothing in the system explaining why. Taking a held lot
 *   out of a recall is `resolveRecallBatch('RELEASE')`, which puts the stock
 *   back with a movement and a reason.
 */
export async function removeRecallBatch(
  ctx: TenantContext,
  recallId: string,
  recallBatchId: string,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const existing = await findRecallOrThrow(tx, recallId);
    const row = existing.batches.find((b) => b.id === recallBatchId);
    if (!row) throw new NotFoundError('Recall lot');

    if (row.status !== 'PENDING') {
      throw new ConflictError(
        `Lot ${row.lotNumber} has already been acted on, so it cannot simply be taken off the list. Release it instead, which puts the stock back with a reason.`
      );
    }

    await tx.recallBatch.delete({ where: { id: recallBatchId } });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: recallId,
      branchId: row.branchId,
      before: { lotRemoved: row.lotNumber },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, recallId));
  });
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

/**
 * Pull ONE lot: every location it sits at, in the caller's transaction.
 *
 * ⚠️ EVERY LOCATION, NOT THE FIRST ONE. Half a recalled lot left available at the
 *   satellite fridge is the exact failure a recall exists to prevent, and
 *   `setBatchHold` made the same call in PI-2.
 *
 * ⚠️ AND THE SERIAL IS PASSED THROUGH, WHICH `setBatchHold` DID NOT DO. For a
 *   `SERIAL` or `LOT_AND_SERIAL` product the engine REFUSES a movement that
 *   names no serial (`recordMovementIn`, the tracking-mode check), so holding a
 *   lot of implants raised a validation error and pulled nothing. That is fixed
 *   in `batch.service.ts` too — see the note there. The balance rows ARE per
 *   serial, so passing `balance.serialId` is both what the engine needs and what
 *   the data already says.
 */
async function holdBatchWithin(
  tx: TxClient,
  ctx: TenantContext,
  recall: { id: string; reference: string; noticeReference: string | null; reason: string },
  row: { id: string; batchId: string; branchId: string; lotNumber: string },
  note: string | null,
  options: RecallActionOptions
): Promise<Prisma.Decimal> {
  const batch = await tx.batch.findUnique({
    where: { id: row.batchId },
    select: {
      id: true,
      productId: true,
      branchId: true,
      balances: { select: { status: true, quantity: true, locationId: true, serialId: true } },
    },
  });
  if (!batch) throw new NotFoundError('Batch');

  /*
   * ⚠️ EVERY BUCKET HOLDING PHYSICAL STOCK, NOT JUST `AVAILABLE` (PI-11 review,
   *   CRITICAL). This filter read `b.status === 'AVAILABLE'` while the serial
   *   sweep forty lines below flipped `IN_STOCK` **and** `QUARANTINED` devices to
   *   RECALLED — an asymmetry with two consequences, and the second one reaches a
   *   patient:
   *
   *   1. A lot the storekeeper had already quarantined on hearing the notice —
   *      the obvious, responsible thing to do — moved NO quantity. `held` came
   *      back zero, so the notice recorded `NO_STOCK` and `quantity_held_base: 0`
   *      for a lot sitting on the shelf. That is a false statement to a regulator
   *      about the one question a recall exists to answer.
   *
   *   2. ⚠️ AND `RESERVED` STOCK BECAME DISPENSABLE AGAIN. The un-dispensable
   *      guarantee is the BALANCE, not the flag — "both go through one allocator
   *      and it reads the balance". Quantity left in `RESERVED` is released back
   *      to `AVAILABLE` by `releaseReservation` or by the sweep, neither of which
   *      consults the recall, and the allocator then hands it to a patient. The
   *      batch says RECALLED the whole time and nothing reads it.
   *
   *   `DISPOSED` is excluded because it has already gone, `RECALLED` because it
   *   is already there, and `IN_TRANSIT` because this programme never fills it
   *   (PI-3 decision 1). The ledger's `stock_ledger_direction` CHECK constrains a
   *   MOVE only to a non-null, differing pair, so every one of these is a legal
   *   `status_from` — and `statusFrom` is passed per balance below rather than
   *   hard-coded, which is what makes the leg say where the stock actually came
   *   from.
   */
  const RECALLABLE: readonly string[] = [
    'AVAILABLE',
    'RESERVED',
    'QUARANTINED',
    'BLOCKED',
    'DAMAGED',
    'EXPIRED',
  ];
  const movable = batch.balances.filter(
    (b) => RECALLABLE.includes(b.status) && b.quantity.greaterThan(0)
  );

  let held = new Prisma.Decimal(0);
  for (const balance of movable) {
    await recordMovementIn(
      tx,
      ctx,
      {
        branchId: batch.branchId,
        productId: batch.productId,
        batchId: batch.id,
        serialId: balance.serialId,
        movementType: 'RECALL',
        quantity: balance.quantity.toString(),
        locationId: balance.locationId,
        /* Where it actually came from — see the filter above. */
        statusFrom: balance.status,
        statusTo: 'RECALLED',
        reasonCode: 'RECALL',
        reasonNote: note ?? recall.reason,
        referenceType: 'RECALL',
        /*
         * ⚠️ THE RECALL'S ID, NOT THE BATCH'S. `(organization_id,
         *   reference_type, reference_id)` is indexed for exactly this walk:
         *   "what did this notice move" is the question asked when somebody
         *   wants to undo it, and it is not answerable from the batch side once
         *   two notices have touched one lot.
         */
        referenceId: recall.id,
      },
      auditMeta(options)
    );
    held = held.add(balance.quantity);
  }

  /*
   * The lot's own disposition, and the devices in it.
   *
   * ⚠️ `serials.status` IS MAINTAINED HERE AND NOWHERE ELSE IN THIS PATH, and
   *   without it a recalled implant reads IN_STOCK on the serial screen while its
   *   quantity sits in the RECALLED bucket — two answers to "may this be
   *   fitted", and the screen a theatre nurse looks at is the one that says yes.
   *   ISSUED serials are deliberately untouched: that device is in a patient,
   *   and it is the affected-party trace's business, not a status change.
   */
  await tx.serial.updateMany({
    where: { batchId: batch.id, status: { in: ['IN_STOCK', 'QUARANTINED'] } },
    data: { status: 'RECALLED' },
  });

  /*
   * ⚠️ AND NOTHING IS SPOKEN FOR ANY MORE (PI-11 review, CRITICAL). Pulling the
   *   `RESERVED` bucket above without closing the rows that put it there would
   *   leave a live `stock_reservations` row whose release moves quantity out of a
   *   bucket that no longer holds any — an orphan that fails, or worse, drives
   *   the balance negative.
   *
   *   `RELEASED` rather than a new terminal state: the existing vocabulary says
   *   exactly what happened — the hold is over and the stock went somewhere else
   *   — and `released_by_id` is deliberately left NULL, which is how a screen
   *   already distinguishes "a person gave it back" from "it was taken back".
   *   The `stock_reservations_terminal_dated` CHECK wants `released_at` set with
   *   any non-ACTIVE status, and it is.
   */
  await tx.stockReservation.updateMany({
    where: { batchId: batch.id, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });

  await tx.batch.update({
    where: { id: batch.id },
    data: {
      status: 'RECALLED',
      recalledAt: new Date(),
      recallReference: recallReferenceFor(recall),
    },
  });

  return held;
}

export async function executeRecall(
  ctx: TenantContext,
  id: string,
  input: ExecuteRecallRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE RECALL ROW IS LOCKED BEFORE ITS SCOPE IS READ. Two storekeepers
     *   hitting Execute at the same moment would otherwise both read the same
     *   PENDING list and both walk it; the loser's movements then fail on an
     *   empty AVAILABLE bucket with a 409 that reads as a race in the pharmacy
     *   rather than as a double-click. Three phases have now paid for a
     *   read-then-write over a running total that was not locked.
     */
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM recalls
      WHERE id = ${id}::uuid AND organization_id = ${ctx.organizationId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Recall');

    const recall = await findRecallOrThrow(tx, id);
    if (recall.status === 'CLOSED' || recall.status === 'CANCELLED') {
      throw new ConflictError(
        `${recall.reference} is ${recall.status.toLowerCase()}. A recall that has ended cannot pull more stock; raise a new notice citing the same reference.`
      );
    }

    const pending = recall.batches.filter((b) => b.status === 'PENDING');
    if (pending.length === 0) {
      throw new ConflictError(
        `${recall.reference} has no lots waiting to be pulled. Add the lots it covers first — a recall with an empty scope holds nothing.`
      );
    }

    /*
     * ⚠️ THE CALL SITE FOR A REGULATORY HOOK, MARKED AND DELIBERATELY EMPTY.
     *   A jurisdiction may REQUIRE that a recall of a controlled product is
     *   reported to a regulator within N hours, and that is a
     *   `REPORTING_REQUIREMENT` rule PI-5 does not have a type for. It would go
     *   here, and it must never be able to REFUSE: a rule engine that could
     *   block a recall would be a defect wearing a control's clothes.
     */

    const note = input.note ?? null;
    let heldLots = 0;
    let emptyLots = 0;

    for (const row of pending) {
      const held = await holdBatchWithin(tx, ctx, recall, row, note, options);
      const isEmpty = held.isZero();
      if (isEmpty) emptyLots += 1;
      else heldLots += 1;

      await tx.recallBatch.update({
        where: { id: row.id },
        data: {
          status: isEmpty ? 'NO_STOCK' : 'HELD',
          quantityHeldBase: held,
          heldAt: new Date(),
        },
      });
    }

    await tx.recall.update({
      where: { id },
      data: {
        status: 'EXECUTED',
        /*
         * ⚠️ ONLY THE FIRST EXECUTION IS ATTRIBUTED. A second pass by the
         *   storekeeper at another site pulls their own lots and does not
         *   overwrite who authorised the notice — which is the name a regulator
         *   asks for. Each lot carries its own `held_at`.
         */
        ...(recall.executedAt === null ? { executedAt: new Date(), executedById: ctx.userId } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: id,
      before: { status: recall.status },
      after: { status: 'EXECUTED', lotsHeld: heldLots, lotsWithNoStock: emptyLots },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, id));
  });
}

/**
 * Put ONE lot back, or send it away.
 *
 * ⚠️ RELEASE AND DISPOSE ARE NOT SYMMETRIC AND MUST NOT BE COLLAPSED. Releasing
 *   moves the quantity back into AVAILABLE and makes the lot sellable again;
 *   disposing takes it out of the building entirely and is the `−` PI-2's enum
 *   comment reserves for a physical departure. One of them is "the manufacturer
 *   withdrew the notice", the other is "we destroyed it".
 */
export async function resolveRecallBatch(
  ctx: TenantContext,
  recallId: string,
  recallBatchId: string,
  input: ResolveRecallBatchRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const recall = await findRecallOrThrow(tx, recallId);
    const row = recall.batches.find((b) => b.id === recallBatchId);
    if (!row) throw new NotFoundError('Recall lot');

    if (row.status !== 'HELD' && row.status !== 'NO_STOCK') {
      throw new ConflictError(
        `Lot ${row.lotNumber} is ${row.status.toLowerCase().replace('_', ' ')}, so there is nothing to resolve. Only a lot that has been pulled can be released or disposed of.`
      );
    }

    const batch = await tx.batch.findUnique({
      where: { id: row.batchId },
      select: {
        id: true,
        productId: true,
        branchId: true,
        balances: { select: { status: true, quantity: true, locationId: true, serialId: true } },
      },
    });
    if (!batch) throw new NotFoundError('Batch');

    const recalled = batch.balances.filter(
      (b) => b.status === 'RECALLED' && b.quantity.greaterThan(0)
    );

    for (const balance of recalled) {
      await recordMovementIn(
        tx,
        ctx,
        {
          branchId: batch.branchId,
          productId: batch.productId,
          batchId: batch.id,
          serialId: balance.serialId,
          movementType: input.resolution === 'RELEASE' ? 'RECALL_RELEASE' : 'DISPOSAL',
          quantity: balance.quantity.toString(),
          locationId: balance.locationId,
          statusFrom: 'RECALLED',
          ...(input.resolution === 'RELEASE' ? { statusTo: 'AVAILABLE' as const } : {}),
          reasonCode: input.resolution === 'RELEASE' ? 'RECALL_RELEASE' : 'DISPOSAL',
          reasonNote: input.note,
          referenceType: 'RECALL',
          referenceId: recall.id,
        },
        auditMeta(options)
      );
    }

    if (input.resolution === 'RELEASE') {
      /*
       * ⚠️ THE LOT ONLY GOES BACK TO ACTIVE IF NO **OTHER** LIVE RECALL STILL
       *   NAMES IT. Two notices covering one production run is ordinary — a
       *   manufacturer's, then a regulator's — and clearing the flag because
       *   THIS one was withdrawn would put a lot back on the shelf that the
       *   other notice is still holding. The quantity is already in the
       *   AVAILABLE bucket by then, so allocation would supply it.
       */
      const otherLive = await tx.recallBatch.count({
        where: {
          batchId: batch.id,
          id: { not: row.id },
          status: 'HELD',
          recall: { status: { in: ['DRAFT', 'EXECUTED'] } },
        },
      });

      if (otherLive === 0) {
        await tx.serial.updateMany({
          where: { batchId: batch.id, status: 'RECALLED' },
          data: { status: 'IN_STOCK' },
        });
        await tx.batch.update({
          where: { id: batch.id },
          data: { status: 'ACTIVE', recalledAt: null, recallReference: null },
        });
      }
    } else {
      await tx.serial.updateMany({
        where: { batchId: batch.id, status: 'RECALLED' },
        data: { status: 'DISPOSED' },
      });
      await tx.batch.update({ where: { id: batch.id }, data: { status: 'DISPOSED' } });
    }

    await tx.recallBatch.update({
      where: { id: row.id },
      data: {
        status: input.resolution === 'RELEASE' ? 'RELEASED' : 'DISPOSED',
        outcomeNote: input.note,
        ...(input.resolution === 'RELEASE' ? { releasedAt: new Date() } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: recallId,
      branchId: row.branchId,
      before: { lot: row.lotNumber, status: row.status },
      after: { status: input.resolution === 'RELEASE' ? 'RELEASED' : 'DISPOSED' },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, recallId));
  });
}

/**
 * ⚠️ REFUSED WHILE ANYTHING IS STILL PENDING, and that refusal is the only thing
 *   standing between "we executed it" and "we executed the half we could see".
 *   `recalls.status = EXECUTED` means somebody executed it; it does not mean
 *   every lot everywhere is held, because a branch-scoped executor can only pull
 *   their own. Closing is the statement that the WHOLE piece of work is done, so
 *   it is the one that has to check.
 */
export async function closeRecall(
  ctx: TenantContext,
  id: string,
  input: CloseRecallRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const recall = await findRecallOrThrow(tx, id);
    if (recall.status !== 'EXECUTED') {
      throw new ConflictError(
        `${recall.reference} is ${recall.status.toLowerCase()} and has not been executed, so there is nothing to close.`
      );
    }

    const pending = recall.batches.filter((b) => b.status === 'PENDING');
    if (pending.length > 0) {
      throw new ConflictError(
        `${recall.reference} still has ${pending.length} lot(s) waiting to be pulled. Somebody at their branch has to execute it before this can be closed — a recall closed over stock nobody looked at is a recall that did not happen.`
      );
    }

    await tx.recall.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedById: ctx.userId,
        outcomeNote: input.outcomeNote,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: id,
      before: { status: recall.status },
      after: { status: 'CLOSED', lots: recall.batches.length },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, id));
  });
}

/**
 * ⚠️ CANCELLING PUTS NO STOCK BACK, AND SAYING SO IS THE WHOLE POINT OF THE
 *   REFUSAL BELOW. If lots are still held, releasing them is a decision taken
 *   per lot by somebody looking at that lot — it writes a movement and states a
 *   reason. A cancel that silently released everything would make sellable again
 *   whatever the notice had pulled, in one click, with one sentence covering all
 *   of it.
 */
export async function cancelRecall(
  ctx: TenantContext,
  id: string,
  input: CancelRecallRequest,
  options: RecallActionOptions = {}
): Promise<RecallDetail> {
  return withTenant(ctx, async (tx) => {
    const recall = await findRecallOrThrow(tx, id);
    if (recall.status === 'CLOSED' || recall.status === 'CANCELLED') {
      throw new ConflictError(`${recall.reference} has already ended.`);
    }

    const stillHeld = recall.batches.filter((b) => b.status === 'HELD');
    if (stillHeld.length > 0) {
      throw new ConflictError(
        `${recall.reference} is still holding ${stillHeld.length} lot(s). Release or dispose of each one first: cancelling puts no stock back, and a lot left in the recalled bucket with no live notice behind it is stock nobody can explain.`
      );
    }

    await tx.recall.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        closedAt: new Date(),
        closedById: ctx.userId,
        outcomeNote: input.outcomeNote,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'recall',
      entityId: id,
      before: { status: recall.status },
      after: { status: 'CANCELLED' },
      ...auditMeta(options),
    });

    return toDetail(await findRecallOrThrow(tx, id));
  });
}
