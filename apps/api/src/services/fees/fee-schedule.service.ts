/**
 * What a clinic charges for an appointment — one resolver, four scopes.
 *
 * ⚠️ THIS IS THE ONLY IMPLEMENTATION OF §0.5, AND A SECOND ONE IS THE BUG THIS
 *   FILE EXISTS TO PREVENT. The booking form's quote, the freeze onto
 *   `appointments.booked_fee`, the reschedule re-resolve and the invoice engine
 *   all call `resolveFee`. A copy anywhere is how a screen quotes a patient one
 *   number at the desk and the bill states another.
 *
 * The rule, most specific first:
 *
 *   1. doctor + branch          this doctor, at this branch
 *   2. doctor + branch NULL     this doctor, anywhere
 *   3. branch, doctor NULL      the clinic's default at this branch
 *   4. both NULL                the clinic's default everywhere
 *   5. nothing                  unpriced
 *
 * ⚠️ A RESOLVED ROW HOLDING ZERO IS A RESOLVED ROW. Free is a price a clinic
 *   chose. Only the ABSENCE of a row falls through to the next scope — reading a
 *   blank as free bills every visit of that type at nothing, silently, and the
 *   clinic finds out at the end of the month.
 *
 * ⚠️ NOT THE SETTINGS RESOLVER, and the reason is one axis.
 *   `services/settings/resolver.service.ts` already does
 *   USER → DOCTOR → BRANCH → ORGANIZATION inheritance, but its `DOCTOR` scope is
 *   single-axis: it cannot say "this doctor, AT THIS BRANCH", which is scope 1
 *   above and a capability `doctor_branch_settings` had before this table
 *   existed. Folding fees into it would lose a per-branch override a clinic is
 *   already relying on.
 *
 * ⚠️ MONEY CROSSES ONE BOUNDARY, IN `../invoicing/money.ts`. The column is
 *   `numeric(14,2)`; the wire is integer minor units. Two representations need
 *   exactly one converter between them, and this file imports that one rather
 *   than growing a second.
 */
import { withTenant, type Prisma, type TenantContext, type TxClient } from '@rcln/db';
import type {
  FeeQuote,
  FeeScheduleEntry,
  FeeScheduleRow,
  FeeScopeLevel,
  FeeScheduleView,
  SetFeeScheduleRequest,
} from '@rcln/contracts';
import { KNOWN_FEE_TYPES } from '@rcln/contracts';
import { money } from '@rcln/payments';

import { recordAudit } from '../audit/audit.service.js';
import { organizationCurrency } from '../invoicing/invoice-lifecycle.service.js';
import { toDecimal, toMoney } from '../invoicing/money.js';
import { NotFoundError } from '../../utils/errors.js';

/** Request metadata, carried onto the audit row. */
export interface FeeActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

const ENTRY_SELECT = {
  id: true,
  branchId: true,
  doctorProfileId: true,
  feeType: true,
  amount: true,
  updatedAt: true,
} satisfies Prisma.FeeScheduleEntrySelect;

type EntryRow = Prisma.FeeScheduleEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

/**
 * A resolved price, and where it came from.
 *
 * The level travels with the amount because a screen that shows a number
 * without its provenance cannot tell an override from an inherited default —
 * and an admin who cannot tell will set an override on every doctor to be sure,
 * at which point the clinic's default stops meaning anything.
 */
export interface ResolvedFee {
  amount: Prisma.Decimal;
  level: FeeScopeLevel;
}

/**
 * Rank the candidate rows. Lower is more specific; `null` is "does not apply".
 *
 * ⚠️ THE BRANCH TEST IS `row.branchId === branchId`, NOT `!== null`. A row for
 *   another branch is in the candidate set only because the query fetched by
 *   organization and fee type; scoring it would price a Bengaluru visit off a
 *   Dubai override.
 */
function score(
  row: Pick<EntryRow, 'branchId' | 'doctorProfileId'>,
  doctorProfileId: string | null,
  branchId: string | null
): { rank: number; level: FeeScopeLevel } | null {
  const doctorMatches =
    row.doctorProfileId === null ||
    (doctorProfileId !== null && row.doctorProfileId === doctorProfileId);
  const branchMatches = row.branchId === null || (branchId !== null && row.branchId === branchId);
  if (!doctorMatches || !branchMatches) return null;

  const forDoctor = row.doctorProfileId !== null;
  const forBranch = row.branchId !== null;

  if (forDoctor && forBranch) return { rank: 0, level: 'DOCTOR_BRANCH' };
  if (forDoctor) return { rank: 1, level: 'DOCTOR_ORGANIZATION' };
  if (forBranch) return { rank: 2, level: 'CLINIC_BRANCH' };
  return { rank: 3, level: 'CLINIC_ORGANIZATION' };
}

/**
 * Every candidate row for a set of fee types, in one read.
 *
 * One query rather than four probes down the precedence ladder: the composite
 * index is `(organization_id, fee_type)`, the whole candidate set for a clinic
 * is a handful of rows, and four round trips inside a booking transaction is
 * four chances to be the slow statement while the number sequence lock is held.
 */
async function candidates(tx: TxClient, feeTypes: string[]): Promise<EntryRow[]> {
  return tx.feeScheduleEntry.findMany({
    where: { feeType: { in: feeTypes } },
    select: ENTRY_SELECT,
  });
}

/** Pick the winner out of a candidate set. The rule, and nothing else. */
function pick(
  rows: EntryRow[],
  feeType: string,
  doctorProfileId: string | null,
  branchId: string | null
): ResolvedFee | null {
  let best: { rank: number; level: FeeScopeLevel; amount: Prisma.Decimal } | null = null;

  for (const row of rows) {
    if (row.feeType !== feeType) continue;
    const scored = score(row, doctorProfileId, branchId);
    if (scored === null) continue;
    if (best === null || scored.rank < best.rank) {
      best = { rank: scored.rank, level: scored.level, amount: row.amount };
    }
  }

  return best === null ? null : { amount: best.amount, level: best.level };
}

/**
 * THE resolver. One fee type, one doctor, one branch.
 *
 * Takes a `tx` rather than opening its own, so the freeze at booking commits
 * with the booking that caused it — a price resolved in a transaction that
 * rolled back is a price nobody agreed to.
 */
export async function resolveFee(
  tx: TxClient,
  args: { doctorProfileId: string | null; branchId: string | null; feeType: string }
): Promise<ResolvedFee | null> {
  const rows = await candidates(tx, [args.feeType]);
  return pick(rows, args.feeType, args.doctorProfileId, args.branchId);
}

/**
 * Whether this clinic has priced ANYTHING that could reach this doctor here.
 *
 * The difference between the invoice engine's two unpriced reasons, and the
 * reason it is a separate question: `NO_RATE_CARD` means the clinic has never
 * filled the grid in, which is a "set your prices" prompt, and `NO_FEE_SET`
 * means the grid exists and this one kind of visit is blank, which is a
 * "teleconsults have no price" prompt. One message for both is how a clinic
 * that priced five of six visit types is told to go and set up billing.
 */
export async function hasAnyFee(
  tx: TxClient,
  args: { doctorProfileId: string | null; branchId: string | null }
): Promise<boolean> {
  const rows = await tx.feeScheduleEntry.findMany({
    select: { branchId: true, doctorProfileId: true },
  });
  return rows.some((row) => score(row, args.doctorProfileId, args.branchId) !== null);
}

// ---------------------------------------------------------------------------
// The grid a human edits
// ---------------------------------------------------------------------------

/**
 * Which fee types the grid shows.
 *
 * The six known keys, plus anything the clinic has actually stored — the column
 * is a `varchar` so a catalogue can arrive later (§0.2 decision 2), and a grid
 * built on the hard-coded list alone would hide a price that is being charged.
 */
function gridKeys(rows: EntryRow[]): string[] {
  const keys = new Set<string>(KNOWN_FEE_TYPES);
  for (const row of rows) keys.add(row.feeType);
  return [...keys];
}

/**
 * The sheet for one scope, with inheritance folded in.
 *
 * `doctorProfileId === null` is the clinic's own grid; a uuid is that doctor's,
 * where every row a doctor has not overridden shows the clinic's number and the
 * level it came from.
 */
export async function getFeeSchedule(
  ctx: TenantContext,
  args: { doctorProfileId?: string | undefined; branchId?: string | undefined }
): Promise<FeeScheduleView> {
  const branchId = args.branchId ?? null;
  const doctorProfileId = args.doctorProfileId ?? null;

  if (branchId !== null && !ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  return withTenant(ctx, async (tx) => {
    if (doctorProfileId !== null) {
      const doctor = await tx.doctorProfile.findFirst({
        where: { id: doctorProfileId, deletedAt: null },
        select: { id: true },
      });
      if (!doctor) throw new NotFoundError('Doctor');
    }

    const currency = await organizationCurrency(tx, ctx);
    const rows = await tx.feeScheduleEntry.findMany({ select: ENTRY_SELECT });

    const view: FeeScheduleRow[] = gridKeys(rows).map((feeType) => {
      const resolved = pick(rows, feeType, doctorProfileId, branchId);
      /*
       * What is stored AT this exact scope — the value the editor round-trips.
       * Deliberately an exact match on both columns rather than the resolver's
       * answer: an admin editing the Bengaluru sheet must see the Bengaluru row
       * as empty when the number on screen came from the org-wide default,
       * otherwise saving the form silently pins the inherited value in place.
       */
      const own = rows.find(
        (row) =>
          row.feeType === feeType &&
          row.branchId === branchId &&
          row.doctorProfileId === doctorProfileId
      );

      return {
        feeType,
        amountMinor: resolved === null ? null : toMoney(resolved.amount, currency).amountMinor,
        level: resolved?.level ?? null,
        ownAmountMinor: own === undefined ? null : toMoney(own.amount, currency).amountMinor,
      };
    });

    return { currency, branchId, doctorProfileId, rows: view };
  });
}

/** Every stored row, for the screen that lists what a clinic has configured. */
export async function listFeeScheduleEntries(ctx: TenantContext): Promise<FeeScheduleEntry[]> {
  return withTenant(ctx, async (tx) => {
    const currency = await organizationCurrency(tx, ctx);
    const rows = await tx.feeScheduleEntry.findMany({
      select: {
        ...ENTRY_SELECT,
        branch: { select: { name: true } },
        doctorProfile: { select: { user: { select: { fullName: true } } } },
      },
      orderBy: [{ doctorProfileId: 'asc' }, { branchId: 'asc' }, { feeType: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      doctorProfileId: row.doctorProfileId,
      doctorName: row.doctorProfile?.user.fullName ?? null,
      feeType: row.feeType,
      amountMinor: toMoney(row.amount, currency).amountMinor,
      updatedAt: row.updatedAt.toISOString(),
    }));
  });
}

/**
 * Save a scope's prices.
 *
 * ⚠️ A NULL AMOUNT DELETES THE ROW, AND A MISSING KEY CHANGES NOTHING. Those are
 *   different acts: deleting is how a doctor goes back to inheriting the
 *   clinic's price, and a screen that posts a filtered subset must not wipe
 *   everything it did not send.
 *
 * ⚠️ `upsert` ON THE FOUR-COLUMN UNIQUE IS NOT AVAILABLE HERE, because two of
 *   the four columns are nullable and Prisma's compound-unique input cannot
 *   express `NULLS NOT DISTINCT`. The read-then-write below runs inside the
 *   transaction, and the index — which IS `NULLS NOT DISTINCT` in the migration
 *   — is what actually refuses a duplicate if two admins race.
 */
/**
 * Write one scope's prices inside a caller's transaction.
 *
 * Split out of `setFeeSchedule` so a doctor's opening prices can be written in
 * the SAME transaction that creates the doctor — a price that committed beside a
 * profile which then rolled back belongs to nobody. `setFeeSchedule` below is
 * this function plus the scope checks and the read-back, and there is
 * deliberately no second copy of the null-deletes-the-row rule.
 */
export async function writeFeeEntries(
  tx: TxClient,
  ctx: TenantContext,
  scope: { doctorProfileId: string | null; branchId: string | null },
  fees: SetFeeScheduleRequest['fees'],
  options: FeeActionOptions = {}
): Promise<void> {
  const { doctorProfileId, branchId } = scope;
  const currency = await organizationCurrency(tx, ctx);
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};

  for (const fee of fees) {
    const existing = await tx.feeScheduleEntry.findFirst({
      where: { feeType: fee.feeType, branchId, doctorProfileId },
      select: { id: true, amount: true },
    });

    before[fee.feeType] = existing?.amount.toString() ?? null;

    if (fee.amountMinor === null) {
      if (existing) await tx.feeScheduleEntry.delete({ where: { id: existing.id } });
      after[fee.feeType] = null;
      continue;
    }

    const amount = toDecimal(money(fee.amountMinor, currency));
    after[fee.feeType] = amount.toString();

    if (existing) {
      await tx.feeScheduleEntry.update({
        where: { id: existing.id },
        data: { amount, ...(ctx.userId !== undefined ? { updatedBy: ctx.userId } : {}) },
      });
    } else {
      await tx.feeScheduleEntry.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          doctorProfileId,
          feeType: fee.feeType,
          amount,
          ...(ctx.userId !== undefined ? { updatedBy: ctx.userId } : {}),
        },
      });
    }
  }

  /*
   * One audit row for the save, not one per fee type. What an auditor asks is
   * "who changed our prices and to what", and a form submission is one answer;
   * six rows for six columns of the same grid makes the trail unreadable.
   *
   * Amounts are major-unit strings, exactly as stored. No PHI is reachable
   * here — a fee names a branch, a doctor and a price.
   */
  await recordAudit(tx, ctx, {
    action: 'UPDATE',
    entityType: 'fee_schedule_entry',
    entityId: doctorProfileId ?? ctx.organizationId,
    before,
    after,
    branchId,
    ...options,
  });
}

export async function setFeeSchedule(
  ctx: TenantContext,
  args: { doctorProfileId?: string | undefined },
  input: SetFeeScheduleRequest,
  options: FeeActionOptions = {}
): Promise<FeeScheduleView> {
  const branchId = input.branchId;
  const doctorProfileId = args.doctorProfileId ?? null;

  // Out of scope is a 404, never a 403 — whether a branch exists is itself
  // tenant information, and the two answers tell an outsider from a colleague.
  if (branchId !== null && !ctx.branchIds.includes(branchId)) throw new NotFoundError('Branch');

  await withTenant(ctx, async (tx) => {
    if (doctorProfileId !== null) {
      const doctor = await tx.doctorProfile.findFirst({
        where: { id: doctorProfileId, deletedAt: null },
        select: { id: true },
      });
      if (!doctor) throw new NotFoundError('Doctor');
    }

    await writeFeeEntries(tx, ctx, { doctorProfileId, branchId }, input.fees, options);
  });

  return getFeeSchedule(ctx, {
    ...(doctorProfileId !== null ? { doctorProfileId } : {}),
    ...(branchId !== null ? { branchId } : {}),
  });
}

/**
 * What this visit would cost, before it is booked.
 *
 * The booking form's read, and the same function the freeze calls one moment
 * later. Not a data-access disclosure: a doctor, a branch and a price name no
 * patient.
 */
export async function quoteFee(
  ctx: TenantContext,
  args: { doctorProfileId: string; branchId: string; feeType: string }
): Promise<FeeQuote> {
  if (!ctx.branchIds.includes(args.branchId)) throw new NotFoundError('Branch');

  return withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: args.doctorProfileId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    const currency = await organizationCurrency(tx, ctx);
    const resolved = await resolveFee(tx, args);

    return {
      currency,
      doctorProfileId: args.doctorProfileId,
      branchId: args.branchId,
      feeType: args.feeType,
      amountMinor: resolved === null ? null : toMoney(resolved.amount, currency).amountMinor,
      level: resolved?.level ?? null,
    };
  });
}
