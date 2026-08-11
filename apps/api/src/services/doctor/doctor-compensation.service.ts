/**
 * What the clinic has agreed to pay a doctor.
 *
 * ⚠️ THIS RECORDS A FIGURE. IT PAYS NOBODY. No periods, no payslips, no
 *   reconciliation against what the practitioner billed — that is the deferred
 *   Phase 4 compensation module, and `billing.doctor_payout.manage` was named
 *   for it years before there was a table. §0.2 decision 6 opened exactly this
 *   much of that domain and no more. Do not let it grow into a payroll run
 *   without going back to the product owner.
 *
 * ⚠️ ONE ROW PER DOCTOR, ORGANIZATION-WIDE. A person has one employment
 *   contract; splitting it per branch is cost allocation, which is a different
 *   problem. The unique index says so too.
 *
 * ⚠️ THIS IS THE MOST SENSITIVE NON-CLINICAL DATA IN THE CODEBASE, and it is
 *   gated accordingly. `doctor.compensation.read` / `.manage` are their own pair
 *   rather than a corner of `doctor.update`, which every BRANCH_ADMIN holds —
 *   fusing them would mean whoever can fix a typo in a bio can read the payroll.
 *   A doctor reading their OWN figure is an ownership check here, not a code,
 *   for the same reason self-editing a profile is: the permission resolver
 *   grants across a branch scope and cannot express "this one row".
 *
 * ⚠️ NOT PHI, SO NO `data_access_logs` ROW. A salary names a member of staff,
 *   not a patient. The WRITES are audited, because "who changed this doctor's
 *   pay and to what" is the whole reason an auditor would open this table.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { DoctorCompensationDetail, SetDoctorCompensationRequest } from '@rcln/contracts';
import { money } from '@rcln/payments';

import { AuthorizationError, NotFoundError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { organizationCurrency } from '../invoicing/invoice-lifecycle.service.js';
import { toDecimal, toMoney } from '../invoicing/money.js';

/** Request metadata, carried onto the audit row. */
export interface CompensationActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * How the caller earned this read.
 *
 * `holdsCode` is `doctor.compensation.read`, resolved at the route because the
 * tenant context deliberately carries no permission list. Without it the only
 * doctor whose figure is legible is the caller's own.
 */
export interface CompensationAccess {
  holdsCode: boolean;
}

/**
 * The agreed figure, or an empty one.
 *
 * ⚠️ A DOCTOR WITH NO ROW IS NOT AN ERROR. Most doctors will have no agreement
 *   recorded, and a 404 would make the panel indistinguishable from a doctor who
 *   does not exist. The empty shape is the honest answer: nothing agreed yet.
 */
export async function getDoctorCompensation(
  ctx: TenantContext,
  doctorId: string,
  access: CompensationAccess
): Promise<DoctorCompensationDetail> {
  return withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    /*
     * 403 rather than 404, and deliberately unlike the branch checks elsewhere
     * in this codebase. The doctor's EXISTENCE is not the secret here — the
     * caller reached this endpoint holding `doctor.read` and can see the profile
     * — only the figure is. Answering 404 would tell them a colleague they can
     * plainly see does not exist, which is a worse lie than "not for you".
     */
    if (!access.holdsCode && doctor.userId !== ctx.userId) {
      throw new AuthorizationError('Access denied');
    }

    const currency = await organizationCurrency(tx, ctx);
    const row = await tx.doctorCompensation.findFirst({
      where: { doctorProfileId: doctorId },
      select: { amount: true, interval: true, updatedAt: true },
    });

    return {
      doctorProfileId: doctorId,
      currency,
      amountMinor: row?.amount == null ? null : toMoney(row.amount, currency).amountMinor,
      interval: row?.interval ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

/**
 * Write the agreement inside a caller's transaction.
 *
 * Both columns move together — an amount without an interval is a number nobody
 * can act on, and the contract refuses the pair apart. Clearing writes nulls
 * rather than deleting the row, so `updated_by` and `updated_at` survive: "who
 * removed this doctor's salary" is as much an audit question as who set it.
 *
 * Split out so `createDoctor` can record what was agreed in the SAME transaction
 * that creates the practitioner — a salary that committed against a profile
 * which then rolled back is a figure attached to nobody. The permission that
 * guards it is unchanged and still checked at the route: this function trusts
 * its caller, exactly as the fee writer does, and there is only one door.
 */
export async function writeDoctorCompensation(
  tx: TxClient,
  ctx: TenantContext,
  doctorId: string,
  input: SetDoctorCompensationRequest,
  options: CompensationActionOptions = {}
): Promise<void> {
  const currency = await organizationCurrency(tx, ctx);
  const existing = await tx.doctorCompensation.findFirst({
    where: { doctorProfileId: doctorId },
    select: { id: true, amount: true, interval: true },
  });

  const amount = input.amountMinor === null ? null : toDecimal(money(input.amountMinor, currency));

  if (existing) {
    await tx.doctorCompensation.update({
      where: { id: existing.id },
      data: {
        amount,
        interval: input.interval,
        ...(ctx.userId !== undefined ? { updatedBy: ctx.userId } : {}),
      },
    });
  } else {
    await tx.doctorCompensation.create({
      data: {
        organizationId: ctx.organizationId,
        doctorProfileId: doctorId,
        amount,
        interval: input.interval,
        ...(ctx.userId !== undefined ? { updatedBy: ctx.userId } : {}),
      },
    });
  }

  /*
   * The figures go into the trail in full. That is the point of the trail
   * here: a salary changed without a record of what it was is the exact
   * dispute this table exists to settle. Major-unit strings, as stored.
   */
  await recordAudit(tx, ctx, {
    action: existing ? 'UPDATE' : 'CREATE',
    entityType: 'doctor_compensation',
    entityId: doctorId,
    ...(existing
      ? {
          before: {
            amount: existing.amount?.toString() ?? null,
            interval: existing.interval,
          },
        }
      : {}),
    after: { amount: amount?.toString() ?? null, interval: input.interval },
    /* Organization-wide by construction — see decision 7. */
    branchId: null,
    ...options,
  });
}

/** Agree a figure, or clear one. The endpoint behind `doctor.compensation.manage`. */
export async function setDoctorCompensation(
  ctx: TenantContext,
  doctorId: string,
  input: SetDoctorCompensationRequest,
  options: CompensationActionOptions = {}
): Promise<DoctorCompensationDetail> {
  await withTenant(ctx, async (tx) => {
    const doctor = await tx.doctorProfile.findFirst({
      where: { id: doctorId, deletedAt: null },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    await writeDoctorCompensation(tx, ctx, doctorId, input, options);
  });

  return getDoctorCompensation(ctx, doctorId, { holdsCode: true });
}
