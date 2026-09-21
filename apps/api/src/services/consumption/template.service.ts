/**
 * Consumption templates — what a procedure normally uses (PI-9.1).
 *
 * ⚠️ A TEMPLATE DEDUCTS NOTHING AND COMMITS TO NOTHING. Every function in this
 *   file reads and writes `consumption_templates` and its lines, and not one of
 *   them touches `stock_ledger`. A template is what the panel PRE-FILLS; only an
 *   actual recording moves quantity, which is `consumption.service.ts`.
 *
 * ── VERSIONING, AND WHO HOLDS WHICH HALF OF IT ──────────────────────────────
 * A template is versioned by effective DATE so that changing it never restates
 * what a past procedure consumed. Two halves enforce that:
 *
 *   the database   `consumption_templates_one_open_version_key` — at most one
 *                  live version per procedure with no `effective_to`.
 *   this file      `assertNoOverlap` — no two live versions whose CLOSED windows
 *                  overlap. A partial unique cannot see a range, and an
 *                  exclusion constraint over a soft-deleted versioned table is a
 *                  bigger hammer than this needs.
 *
 * ⚠️ AND THE RECORD SNAPSHOTS THE EXPECTED FIGURE ANYWAY. Even with both halves,
 *   history is answerable from `consumption_lines.expected_quantity_base` rather
 *   than by re-reading this table — because the version chain answers "what did
 *   we expect in March" and the snapshot answers "what did THIS procedure
 *   expect", and only the second is immune to somebody tidying a template.
 *
 * NO PHI. A template is a statement about a procedure, never about a patient.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ConsumptionTemplateDetail,
  ConsumptionTemplateListResponse,
  ConsumptionTemplateQuery,
  ConsumptionTemplateSummary,
  CreateConsumptionTemplateRequest,
  UpdateConsumptionTemplateRequest,
} from '@rcln/contracts';
import { convertToBase } from '@rcln/inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { loadUnitGraph } from '../product/unit.service.js';
import { auditMeta, q, type ConsumptionActionOptions } from './shared.js';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const DETAIL_INCLUDE = Prisma.validator<Prisma.ConsumptionTemplateInclude>()({
  item: { select: { name: true } },
  lines: {
    /* Ties break by id so the order is total — KNOWN_ISSUES #1's lesson. */
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    include: {
      product: { select: { name: true, baseUnitId: true, baseUnit: { select: { symbol: true } } } },
      unit: { select: { symbol: true } },
    },
  },
});

type TemplateRow = Prisma.ConsumptionTemplateGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toSummary(row: TemplateRow): ConsumptionTemplateSummary {
  return {
    id: row.id,
    itemId: row.itemId,
    itemName: row.item.name,
    name: row.name,
    version: row.version,
    status: row.status,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: row.effectiveTo?.toISOString().slice(0, 10) ?? null,
    lineCount: row.lines.length,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The detail, with each line's base-unit figure computed for the panel.
 *
 * ⚠️ THE GRAPH IS LOADED ONCE AND PASSED IN. A template with twenty lines would
 *   otherwise do twenty `toBaseUnits` round trips for a screen that is only
 *   showing a number.
 *
 * ⚠️ AND A LINE WHOSE UNIT NO LONGER CONVERTS FALLS BACK TO ITS OWN FIGURE
 *   RATHER THAN THROWING. `loadUnitGraph` filters `isActive`, so deactivating a
 *   unit a template is written in would otherwise make the template unreadable —
 *   the same trap `raiseChargeRequestsWithin` documents at length, and the same
 *   answer: a configuration gap degrades, it does not 500.
 */
function toDetail(
  row: TemplateRow,
  graph: Parameters<typeof convertToBase>[0]
): ConsumptionTemplateDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    lines: row.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.product.name,
      quantity: q(line.quantity),
      unitId: line.unitId,
      unitSymbol: line.unit.symbol,
      quantityBase: templateLineBase(graph, line),
      baseUnitSymbol: line.product.baseUnit.symbol,
      isOptional: line.isOptional,
      displayOrder: line.displayOrder,
      note: line.note,
    })),
  };
}

/** One template line in the product's base unit, or its own figure if it cannot be. */
export function templateLineBase(
  graph: Parameters<typeof convertToBase>[0],
  line: {
    quantity: Prisma.Decimal;
    unitId: string;
    product: { baseUnitId: string };
  }
): string {
  if (line.unitId === line.product.baseUnitId) return q(line.quantity);
  try {
    return convertToBase(graph, q(line.quantity), line.unitId, line.product.baseUnitId).quantity;
  } catch {
    return q(line.quantity);
  }
}

export async function listConsumptionTemplates(
  ctx: TenantContext,
  query: ConsumptionTemplateQuery
): Promise<ConsumptionTemplateListResponse> {
  return withTenant(ctx, async (tx) => {
    const where: Prisma.ConsumptionTemplateWhereInput = {
      organizationId: ctx.organizationId,
      deletedAt: null,
      ...(query.itemId ? { itemId: query.itemId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { item: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.consumptionTemplate.findMany({
        where,
        include: DETAIL_INCLUDE,
        /* Newest version of each procedure first; `id` makes the order total. */
        orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      tx.consumptionTemplate.count({ where }),
    ]);

    return {
      items: rows.map(toSummary),
      total,
      page: query.page,
      limit: query.limit,
    };
  });
}

export async function getConsumptionTemplate(
  ctx: TenantContext,
  id: string
): Promise<ConsumptionTemplateDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.consumptionTemplate.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      include: DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundError('Consumption template');
    return toDetail(row, await loadUnitGraph(tx));
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The procedure a template is for.
 *
 * ⚠️ THE `kind` IS CHECKED HERE AND NOT BY A CHECK CONSTRAINT, because the kind
 *   lives on the other table and a CHECK cannot see it. A trigger was refused:
 *   this is a data-entry mistake with an obvious message, not a security
 *   boundary — the SECURITY boundary is `item_visible`, which is a RESTRICTIVE
 *   policy and stops the row citing another clinic's private word whatever this
 *   function does.
 *
 * ⚠️ `organization_id IS NULL OR = ours` EXPLICITLY, even though the policy
 *   already scopes it. ADR-0005's defence in depth is worth nothing where one
 *   query opts out.
 */
async function assertProcedureItem(
  tx: TxClient,
  organizationId: string,
  itemId: string
): Promise<void> {
  const item = await tx.clinicalMasterItem.findFirst({
    where: {
      id: itemId,
      deletedAt: null,
      OR: [{ organizationId }, { organizationId: null }],
    },
    select: { kind: true, isActive: true, name: true },
  });
  if (!item) throw new NotFoundError('Procedure');
  if (item.kind !== 'PROCEDURE') {
    throw new ValidationError(
      `${item.name} is not a procedure, so it has nothing that consumes stock. A consumption template belongs to a procedure.`
    );
  }
  if (!item.isActive) {
    throw new ValidationError(
      `${item.name} is no longer in use. Write the template against the procedure the clinic currently performs.`
    );
  }
}

/**
 * No two live versions of one procedure's template may cover the same day.
 *
 * ⚠️ THE OPEN-ENDED CASE IS THE DATABASE'S — `consumption_templates_one_open_version_key`
 *   refuses a second version with no `effective_to`. This closes the rest, and
 *   both halves are needed: the index cannot see a range and this cannot survive
 *   a race.
 *
 * ⚠️ AND IT IS A READ-THEN-WRITE, WHICH IS THE CLASS THAT HAS COST THIS
 *   PROGRAMME THREE PHASES. It is left unlocked deliberately and the reasoning
 *   is recorded rather than assumed: the loser of a race writes an OVERLAPPING
 *   window, not a corrupt one, and `resolveTemplateInForceWithin` resolves an
 *   overlap deterministically by taking the latest `effective_from` and then the
 *   highest version. So the failure mode is "the wrong one of two templates
 *   pre-fills a panel a human is looking at", which the human corrects, and not
 *   a movement of stock. Locking would mean an advisory lock on a procedure id
 *   held across a template edit — a heavier contract than the risk earns.
 */
async function assertNoOverlap(
  tx: TxClient,
  organizationId: string,
  itemId: string,
  from: Date,
  to: Date | null,
  excludeId: string | null
): Promise<void> {
  const siblings = await tx.consumptionTemplate.findMany({
    where: {
      organizationId,
      itemId,
      deletedAt: null,
      status: { not: 'RETIRED' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, version: true, effectiveFrom: true, effectiveTo: true },
  });

  for (const sibling of siblings) {
    const overlaps =
      (to === null || sibling.effectiveFrom <= to) &&
      (sibling.effectiveTo === null || sibling.effectiveTo >= from);
    if (overlaps) {
      throw new ConflictError(
        `Version ${sibling.version} of this procedure's template already covers those dates. ` +
          'Close it first — two templates in force on one day is two answers to what a procedure expects.'
      );
    }
  }
}

/** Today, as a DATE. ⚠️ See the note in `createConsumptionTemplate`. */
function today(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

export async function createConsumptionTemplate(
  ctx: TenantContext,
  body: CreateConsumptionTemplateRequest,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionTemplateDetail> {
  const id = await withTenant(ctx, async (tx) => {
    await assertProcedureItem(tx, ctx.organizationId, body.itemId);

    /*
     * ⚠️ THE DEFAULT IS UTC's TODAY AND THAT IS A KNOWN NARROWING, NOT AN
     *   OVERSIGHT OF INVARIANT 6. A template is ORG-scoped and has no branch, so
     *   there is no `branches.timezone` to resolve it in — a three-site group
     *   spanning two zones has no single "today" for a template to start on. The
     *   window that matters is measured in DAYS against a procedure's
     *   `performed_on`, so a half-day skew at the boundary is visible only to a
     *   clinic that writes a template to take effect within hours of writing it,
     *   and the field is settable for exactly that case. Recorded here so nobody
     *   "fixes" it by reaching for a branch that does not exist.
     */
    const from = body.effectiveFrom ? new Date(body.effectiveFrom) : today();
    const to = body.effectiveTo ? new Date(body.effectiveTo) : null;

    await assertNoOverlap(tx, ctx.organizationId, body.itemId, from, to, null);

    /*
     * ⚠️ THE NEXT VERSION NUMBER IS A READ-THEN-WRITE TOO, AND THIS ONE THE
     *   DATABASE CATCHES: `@@unique([organizationId, itemId, version])` turns a
     *   race into a 409 rather than into two version 3s. Human-facing only —
     *   nothing joins on it.
     */
    const latest = await tx.consumptionTemplate.findFirst({
      where: { organizationId: ctx.organizationId, itemId: body.itemId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const created = await tx.consumptionTemplate.create({
      data: {
        organizationId: ctx.organizationId,
        itemId: body.itemId,
        name: body.name,
        version: (latest?.version ?? 0) + 1,
        status: body.status,
        effectiveFrom: from,
        effectiveTo: to,
        notes: body.notes ?? null,
        updatedBy: ctx.userId,
      },
      select: { id: true, version: true },
    });

    await writeLines(tx, ctx.organizationId, created.id, body.lines);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'consumption_template',
      entityId: created.id,
      after: {
        itemId: body.itemId,
        version: created.version,
        status: body.status,
        lineCount: body.lines.length,
      },
      ...auditMeta(options),
    });

    return created.id;
  });

  return getConsumptionTemplate(ctx, id);
}

export async function updateConsumptionTemplate(
  ctx: TenantContext,
  id: string,
  body: UpdateConsumptionTemplateRequest,
  options: ConsumptionActionOptions = {}
): Promise<ConsumptionTemplateDetail> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.consumptionTemplate.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      select: {
        id: true,
        itemId: true,
        name: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        _count: { select: { consumptions: true } },
      },
    });
    if (!before) throw new NotFoundError('Consumption template');

    /*
     * ⚠️ A VERSION SOMETHING HAS ALREADY BEEN RECORDED AGAINST MAY BE CLOSED AND
     *   RETIRED, AND NOTHING ELSE. Editing its LINES would change what a past
     *   procedure is documented as having expected — except that it would not,
     *   quite, because `consumption_lines.expected_quantity_base` is
     *   snapshotted; what it would actually do is make the template screen and
     *   the variance report tell different stories about the same day, which is
     *   worse than either being wrong on its own.
     */
    const isCited = before._count.consumptions > 0;
    if (isCited && (body.lines !== undefined || body.name !== undefined)) {
      throw new ConflictError(
        'Procedures have already been recorded against this version, so its lines are fixed. ' +
          'Close it with an end date and write the next version — that is what versioning is for.'
      );
    }

    const from = body.effectiveFrom ? new Date(body.effectiveFrom) : before.effectiveFrom;
    const to =
      body.effectiveTo === undefined
        ? before.effectiveTo
        : body.effectiveTo === null
          ? null
          : new Date(body.effectiveTo);

    if (to !== null && to < from) {
      throw new ValidationError('A template cannot stop being in force before it starts.');
    }

    const status = body.status ?? before.status;
    if (status !== 'RETIRED') {
      await assertNoOverlap(tx, ctx.organizationId, before.itemId, from, to, before.id);
    }

    await tx.consumptionTemplate.update({
      where: { id: before.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        effectiveFrom: from,
        effectiveTo: to,
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        updatedBy: ctx.userId,
      },
    });

    if (body.lines !== undefined) {
      /*
       * ⚠️ REPLACED WHOLESALE, WHICH IS SAFE ONLY BECAUSE OF THE GUARD ABOVE.
       *   `consumption_lines.template_line_id` is `Restrict`, so a line a
       *   recorded procedure cites cannot be deleted anyway — the delete would
       *   raise a foreign-key violation reaching `errorHandler` as a 500 rather
       *   than as the sentence above. The guard is what turns that into an
       *   answer.
       */
      await tx.consumptionTemplateLine.deleteMany({
        where: { organizationId: ctx.organizationId, templateId: before.id },
      });
      await writeLines(tx, ctx.organizationId, before.id, body.lines);
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'consumption_template',
      entityId: before.id,
      before: {
        name: before.name,
        status: before.status,
        effectiveFrom: before.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: before.effectiveTo?.toISOString().slice(0, 10) ?? null,
      },
      after: {
        name: body.name ?? before.name,
        status,
        effectiveFrom: from.toISOString().slice(0, 10),
        effectiveTo: to?.toISOString().slice(0, 10) ?? null,
        ...(body.lines !== undefined ? { lineCount: body.lines.length } : {}),
      },
      ...auditMeta(options),
    });
  });

  return getConsumptionTemplate(ctx, id);
}

/**
 * Retire a template.
 *
 * ⚠️ SOFT, ALWAYS, AND NEVER A HARD DELETE. `clinical_consumptions.template_id`
 *   is `Restrict` — a recorded procedure cites the version it was pre-filled
 *   from, and that citation is what makes "what did we expect at the time"
 *   answerable years later. `deleted_at` also drops it out of
 *   `consumption_templates_one_open_version_key`, which is what lets the next
 *   version take the open slot.
 */
export async function deleteConsumptionTemplate(
  ctx: TenantContext,
  id: string,
  options: ConsumptionActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const before = await tx.consumptionTemplate.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, itemId: true, version: true },
    });
    if (!before) throw new NotFoundError('Consumption template');

    await tx.consumptionTemplate.update({
      where: { id: before.id },
      data: { status: 'RETIRED', deletedAt: new Date(), updatedBy: ctx.userId },
    });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'consumption_template',
      entityId: before.id,
      before: { itemId: before.itemId, version: before.version },
      ...auditMeta(options),
    });
  });
}

async function writeLines(
  tx: TxClient,
  organizationId: string,
  templateId: string,
  lines: readonly {
    productId: string;
    quantity: string;
    unitId: string;
    isOptional: boolean;
    displayOrder: number;
    note?: string | null | undefined;
  }[]
): Promise<void> {
  if (lines.length === 0) return;

  /*
   * ⚠️ THE UNIQUE IS `(organization, template, product)`, so a duplicate product
   *   raises a 409 from the database rather than pre-filling two rows for one
   *   thing. Caught here so the message names the mistake.
   */
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.productId)) {
      throw new ValidationError(
        'One product, one line. A template that lists gloves twice pre-fills two rows for one thing and somebody deletes one at random.'
      );
    }
    seen.add(line.productId);
  }

  /*
   * ⚠️ THE PRODUCTS AND UNITS ARE ASSERTED IN ONE READ EACH, and the products
   *   read is the one that matters: `product_visible` would refuse a write
   *   naming another clinic's private product, but as a RESTRICTIVE policy it
   *   refuses with a row-security error rather than with a sentence. This turns
   *   it into "no such product", which is also the honest answer — the row is
   *   invisible to this tenant.
   */
  const products = await tx.product.findMany({
    where: {
      id: { in: [...seen] },
      deletedAt: null,
      OR: [{ organizationId }, { organizationId: null }],
    },
    select: { id: true, name: true, isStockItem: true, status: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) throw new NotFoundError('Product');
    if (!product.isStockItem) {
      throw new ValidationError(
        `${product.name} is not stocked, so a procedure cannot consume it off a shelf. A consultation fee is a product to billing and never to inventory.`
      );
    }
    if (product.status !== 'ACTIVE') {
      throw new ValidationError(
        `${product.name} is no longer active in the catalogue. Write the template against what the clinic currently uses.`
      );
    }
  }

  await tx.consumptionTemplateLine.createMany({
    data: lines.map((line) => ({
      organizationId,
      templateId,
      productId: line.productId,
      quantity: new Prisma.Decimal(line.quantity),
      unitId: line.unitId,
      isOptional: line.isOptional,
      displayOrder: line.displayOrder,
      note: line.note ?? null,
    })),
  });
}

// ---------------------------------------------------------------------------
// The one the panel calls
// ---------------------------------------------------------------------------

export type TemplateInForce = TemplateRow;

/**
 * The version in force for a procedure on a day, on the caller's transaction.
 *
 * ⚠️ `ACTIVE` ONLY. A `DRAFT` template is being written and a `RETIRED` one has
 *   been withdrawn; pre-filling from either would put a number in front of a
 *   clinician that nobody has agreed to.
 *
 * ⚠️ AND THE TIE-BREAK IS DETERMINISTIC BY DESIGN — see `assertNoOverlap` for
 *   why an overlap is possible at all and why it is not worth a lock. Latest
 *   `effective_from`, then highest `version`: the most recently written of two
 *   templates that both claim a day is the one a clinic meant.
 */
export async function resolveTemplateInForceWithin(
  tx: TxClient,
  organizationId: string,
  itemId: string,
  on: Date
): Promise<TemplateInForce | null> {
  const day = new Date(on.toISOString().slice(0, 10));
  return tx.consumptionTemplate.findFirst({
    where: {
      organizationId,
      itemId,
      deletedAt: null,
      status: 'ACTIVE',
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    include: DETAIL_INCLUDE,
  });
}
