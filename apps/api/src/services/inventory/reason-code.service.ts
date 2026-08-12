/**
 * The controlled vocabulary an adjustment must cite (PI-3.1).
 *
 * PI-2 made a reason code MANDATORY on an adjustment — a CHECK constraint on
 * `stock_ledger` refuses a row without one — and left it as free text matching
 * `^[A-Z0-9_]+$`. That is enough to force somebody to type something and not
 * enough to make a shrinkage report mean anything: `BROKEN`, `BREAKAGE` and
 * `BROKE` are three categories describing one event, and the report that
 * aggregates them is the one a clinic uses to decide whether it has a theft
 * problem.
 *
 * So this phase adds the master, and `assertReasonCode` below is what turns
 * "must cite something" into "must cite one of these".
 *
 * ── THE LEDGER STILL STORES A STRING, AND THAT IS DELIBERATE ────────────────
 * `stock_ledger.reason_code` stays `VARCHAR(64)` and does NOT become a foreign
 * key. A ledger row must outlive whatever explained it — the same reasoning
 * already written against `reference_id` — so a clinic retiring a code in 2029
 * must not thereby make its 2027 adjustments unreadable, or the code
 * undeletable. The master constrains what may be WRITTEN; the string is what is
 * READ back, for ever.
 *
 * ── THE MASTER GOVERNS THE **MANUAL** SURFACE, AND ONLY THAT ────────────────
 * ⚠️ THE SYSTEM WRITES REASON CODES THE MASTER DOES NOT CONTAIN, AND THAT IS
 *   CORRECT RATHER THAN A GAP. The expiry sweep writes `EXPIRED`; `setBatchHold`
 *   writes `QUARANTINE`, `QUARANTINE_RELEASE` and `RECALL`. None of them goes
 *   through `recordMovement`, so none is validated here — and none should be
 *   ADDED to the master either, because everything in the master appears in the
 *   picker on the adjustment form, and "expired" is not an explanation a person
 *   may choose for an adjustment. Stock that expired is expired by the sweep;
 *   claiming it by hand is what `EXPIRED_ON_SHELF` is for, which is a different
 *   sentence about a different discovery.
 *
 *   A report grouping by `reason_code` therefore sees both vocabularies. That is
 *   the honest shape: "who wrote this row" is `reference_type`, and the system's
 *   codes all carry a non-`MANUAL` one.
 *
 * ── PLATFORM-EXTENSIBLE ─────────────────────────────────────────────────────
 * The one table in the inventory domain that allows a NULL `organization_id`.
 * Thirteen platform codes ship in the migration; a clinic adds its own and
 * cannot touch the platform's. `assertMutable` is what says so with a sentence
 * before the trigger says so with an error.
 *
 * NO PHI.
 */
import { type Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateStockReasonCodeRequest,
  StockReasonCodeListResponse,
  StockReasonCodeQuery,
  StockReasonCodeSummary,
  UpdateStockReasonCodeRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from '../product/unit.service.js';

type Row = Prisma.StockReasonCodeGetPayload<object>;

function toSummary(row: Row): StockReasonCodeSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    label: row.label,
    direction: row.direction,
    requiresNote: row.requiresNote,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

/**
 * ⚠️ A PLATFORM ROW IS REFUSED HERE WITH A SENTENCE, AND BY THE
 *   `platform_rows_immutable` TRIGGER WITHOUT ONE. Both layers, exactly as on
 *   the PI-1 catalogue: this one tells the clinic what to do instead, and the
 *   trigger is what holds when a service added in a later phase forgets to call
 *   it. `assertMutable` in the product services is the same function by another
 *   name; it is repeated rather than shared because the sentence differs.
 */
function assertMutable(row: Row): void {
  if (row.organizationId === null) {
    throw new ValidationError(
      `${row.label} is one of the reason codes the platform ships, so it cannot be edited or removed here. Add your own code if you need a different one — a clinic's own codes sit beside these in the same picker.`
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every code this tenant may cite, platform and its own, in picker order.
 *
 * ⚠️ UNPAGINATED, LIKE `listLocations` AND FOR THE SAME REASON. This is a
 *   picker on a form, not a table anybody browses. Thirteen platform codes plus
 *   whatever a clinic adds; a clinic with more than a couple of hundred distinct
 *   explanations for stock going missing has a problem no pagination fixes.
 */
export async function listReasonCodes(
  ctx: TenantContext,
  query: StockReasonCodeQuery
): Promise<StockReasonCodeListResponse> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.stockReasonCode.findMany({
      where: {
        deletedAt: null,
        ...(query.includeInactive ? {} : { isActive: true }),
        /*
         * ⚠️ `BOTH` IS ALWAYS INCLUDED WHEN A DIRECTION IS ASKED FOR. A code
         *   that applies either way is a candidate for both questions, and
         *   filtering on equality alone would drop `STOCK_TAKE` and `OTHER` from
         *   every picker — the two codes most likely to be the right answer.
         */
        ...(query.direction !== undefined ? { direction: { in: [query.direction, 'BOTH'] } } : {}),
      },
      /*
       * ⚠️ `code` LAST, AS A TOTAL ORDER. `sortOrder` collides by design — the
       *   platform rows are spaced by tens so a clinic can slot its own between
       *   them — and without a tie-break the picker's order is whatever the plan
       *   returned, which changes as the table grows. A picker that reorders
       *   itself between visits is one where somebody clicks the wrong row.
       */
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }, { code: 'asc' }],
    });

    return { reasonCodes: rows.map(toSummary) };
  });
}

/**
 * Resolve a code a caller cited, or refuse it.
 *
 * ⚠️ THIS RUNS ON THE CALLER'S TRANSACTION, BECAUSE THE ADJUSTMENT IT VALIDATES
 *   IS ABOUT TO BE WRITTEN ON THAT TRANSACTION. Reading the master on a separate
 *   connection would leave a window in which a code was retired between the
 *   check and the movement — small, harmless, and exactly the kind of gap that
 *   makes a rule "usually enforced".
 *
 * ⚠️ `direction` IS NULLABLE AND NULL MEANS "DO NOT ASK", WHICH IS NOT THE SAME
 *   AS "EITHER". An ADJUSTMENT states its direction outright and is the one
 *   movement where "this reason explains stock going the other way" has an
 *   answer. A `QUARANTINE` moves quantity between buckets and is neither an
 *   increase nor a decrease in what the branch holds — passing one of the two
 *   for it would refuse every DECREASE-only code a clinic wrote for exactly that
 *   case. Existence, activity and the note requirement are asked either way.
 *
 * Returns the row so the caller can act on `requiresNote` without a second read.
 */
export async function assertReasonCode(
  tx: TxClient,
  code: string,
  direction: 'INCREASE' | 'DECREASE' | null,
  note: string | null | undefined
): Promise<Row> {
  /*
   * ⚠️ ORDERED, AND `findFirst` WITHOUT AN ORDER IS NONDETERMINISTIC WHEN TWO
   *   ROWS MATCH. `createReasonCode` refuses a tenant code that collides with a
   *   platform one, so the two cannot be created in that order — but the
   *   PLATFORM can ship a new code later that collides with one a clinic already
   *   had, and nothing stops that. From then on the code a caller cites resolves
   *   to whichever row the plan happened to return, which changes as the table
   *   grows, and the two rows can differ in direction and in `requires_note`.
   *
   *   The clinic's own row wins, because it is the one they chose. NULLs sort
   *   last under DESC, which puts a tenant row ahead of a platform row.
   */
  const row = await tx.stockReasonCode.findFirst({
    where: { code, deletedAt: null },
    orderBy: { organizationId: 'desc' },
  });

  /*
   * ⚠️ NOT FOUND AND NOT ACTIVE ARE DIFFERENT SENTENCES, AND BOTH ARE 400s. A
   *   retired code is not a typo — somebody's screen has a stale picker, or an
   *   integration is still sending last year's vocabulary — and telling them
   *   "there is no such code" sends them looking for a bug that is not there.
   */
  if (!row) {
    throw new ValidationError(
      `${code} is not a reason code this clinic uses. Pick one from the list, or add it under stock settings first.`
    );
  }
  if (!row.isActive) {
    throw new ValidationError(
      `${row.label} has been retired and cannot be used on new adjustments. Past adjustments that cite it still read normally.`
    );
  }

  if (direction !== null && row.direction !== 'BOTH' && row.direction !== direction) {
    throw new ValidationError(
      `${row.label} explains stock going ${row.direction === 'INCREASE' ? 'up' : 'down'}, and this adjustment takes it ${direction === 'INCREASE' ? 'up' : 'down'}. Pick a reason that matches what happened.`
    );
  }

  /*
   * ⚠️ CHECKED HERE AND NOT BY A CHECK CONSTRAINT, BECAUSE A CHECK CANNOT JOIN.
   *   `requires_note` lives on the master and the note lives on the ledger row,
   *   and a constraint on `stock_ledger` cannot read another table — the same
   *   reason `tracking_mode` is denormalised onto that table. This is the one
   *   rule in the adjustment path with only one layer, and it is written down
   *   rather than pretended away.
   */
  if (row.requiresNote && (note == null || note.trim().length === 0)) {
    throw new ValidationError(
      `${row.label} needs a note saying what actually happened. It is the reason codes that explain nothing on their own that carry this.`
    );
  }

  return row;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createReasonCode(
  ctx: TenantContext,
  input: CreateStockReasonCodeRequest,
  options: CatalogueActionOptions = {}
): Promise<StockReasonCodeSummary> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE CLASH IS CHECKED AGAINST PLATFORM ROWS TOO, AND THE UNIQUE INDEX
     *   WOULD NOT CATCH IT. `@@unique([organizationId, code])` lets a clinic
     *   create its own `DAMAGED` beside the platform's, which is a legal row and
     *   a broken picker: two entries reading `Damaged`, and `assertReasonCode`
     *   resolving whichever `findFirst` returned. Refused here, in the one place
     *   the two rows can be compared.
     */
    const clash = await tx.stockReasonCode.findFirst({
      where: { code: input.code, deletedAt: null },
      select: { id: true, organizationId: true, label: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.organizationId === null
          ? `${input.code} is one of the codes the platform ships ("${clash.label}"). Use it, or choose a different code for yours.`
          : `${input.code} is already a reason code here.`
      );
    }

    const created = await tx.stockReasonCode.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        label: input.label,
        direction: input.direction,
        requiresNote: input.requiresNote,
        sortOrder: input.sortOrder,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'stock_reason_code',
      entityId: created.id,
      after: { code: created.code, label: created.label, direction: created.direction },
      ...options,
    });

    return toSummary(created);
  });
}

export async function updateReasonCode(
  ctx: TenantContext,
  id: string,
  input: UpdateStockReasonCodeRequest,
  options: CatalogueActionOptions = {}
): Promise<StockReasonCodeSummary> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.stockReasonCode.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new NotFoundError('Reason code');
    assertMutable(existing);

    const updated = await tx.stockReasonCode.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.requiresNote !== undefined ? { requiresNote: input.requiresNote } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'stock_reason_code',
      entityId: id,
      before: {
        label: existing.label,
        direction: existing.direction,
        isActive: existing.isActive,
      },
      after: { label: updated.label, direction: updated.direction, isActive: updated.isActive },
      ...options,
    });

    return toSummary(updated);
  });
}

/**
 * Retire a code.
 *
 * ⚠️ A SOFT DELETE, AND `isActive` DOES MOST OF THE SAME WORK. Both are kept
 *   because they mean different things to whoever reads the list: `isActive =
 *   false` is "we do not use this any more, and it is still in the settings
 *   screen"; `deleted_at` is "this was a mistake, take it off the settings
 *   screen too". Neither touches a ledger row, which cites the STRING and is
 *   unaffected by either — see the file header.
 */
export async function deleteReasonCode(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.stockReasonCode.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new NotFoundError('Reason code');
    assertMutable(existing);

    await tx.stockReasonCode.update({ where: { id }, data: { deletedAt: new Date() } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'stock_reason_code',
      entityId: id,
      before: { code: existing.code, label: existing.label },
      ...options,
    });
  });
}
