/**
 * The one way to write an audit row.
 *
 * WHY THIS EXISTS
 *   A platform admin inside a tenant can read, write and delete exactly as the
 *   membership they are impersonating can — there is no elevation step and no
 *   write block (ADR-0012). The audit trail is therefore not a nice-to-have
 *   sitting alongside a permission model that already constrains the damage; it
 *   is the only control. "The clinic name was X, is now Y, changed by Z" has to
 *   be answerable for every actor and every mutation, so writing that row stops
 *   being something each call site remembers to do in its own shape.
 *
 * WHAT IT GUARANTEES
 *   - The row is written inside the caller's transaction. An audit row that can
 *     commit while its mutation rolls back is worse than none.
 *   - `impersonatedByUserId` comes off the TenantContext, so an impersonated
 *     write is attributed to both the impersonated user and the real admin
 *     without the call site knowing impersonation exists.
 *   - Only fields that actually changed are stored. A 40-column before/after
 *     pair is not readable and re-stores data nobody asked for.
 *   - Credentials are marked as changed, never recorded.
 *
 * WHAT IT DOES NOT DO
 *   Decide what is safe to log. `before`/`after` are whatever the caller passes.
 *   Pass ids, codes and configuration; never a patient name, never a full row
 *   that happens to contain one. CONVENTIONS.md: an audit row is not a place to
 *   re-store PII.
 */
import type { AuditAction, Prisma, TenantContext, TxClient } from '@rcln/db';

/**
 * Never written, even when the caller passes them.
 *
 * Replaced rather than dropped: that a password hash changed is exactly the
 * kind of thing an incident review asks about, while its value is exactly the
 * kind of thing that must not sit in a table built for wide read access.
 */
const REDACTED_KEYS = new Set([
  'passwordHash',
  'password',
  'mfaSecret',
  'codeHash',
  'token',
  'refreshTokenHash',
  'previousTokenHash',
]);

const REDACTED = '[redacted]';

/** A row shape as handed to the audit trail: flat, JSON-serialisable. */
export type AuditSnapshot = Record<string, unknown>;

export interface AuditEntry {
  action: AuditAction;
  /** lower_snake_case noun: 'branch', 'invitation', 'membership_role'. */
  entityType: string;
  entityId?: string | undefined;
  /** Omit for a create. */
  before?: AuditSnapshot | undefined;
  /** Omit for a delete. */
  after?: AuditSnapshot | undefined;
  /** The branch the change belongs to, where the entity has one. */
  branchId?: string | null | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

function redact(snapshot: AuditSnapshot): AuditSnapshot {
  const out: AuditSnapshot = {};
  for (const [key, value] of Object.entries(snapshot)) {
    out[key] = REDACTED_KEYS.has(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Compare by JSON rather than by identity.
 *
 * Prisma hands back `Date` objects and `Decimal` instances, neither of which is
 * `===` to an equal sibling. Comparing those directly reports every field as
 * changed on every update, which is the same as recording nothing.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // Decimal, BigInt and friends: their string forms are stable and comparable.
  return String(a) === String(b);
}

interface Diff {
  before: AuditSnapshot | undefined;
  after: AuditSnapshot | undefined;
}

/**
 * Reduce a before/after pair to only the keys whose value moved.
 *
 * A create has no `before` and a delete has no `after`; in both cases the whole
 * snapshot is the interesting part and there is nothing to narrow against.
 */
export function diffSnapshots(
  before: AuditSnapshot | undefined,
  after: AuditSnapshot | undefined
): Diff {
  if (!before || !after) {
    return {
      before: before ? redact(before) : undefined,
      after: after ? redact(after) : undefined,
    };
  }

  const changedBefore: AuditSnapshot = {};
  const changedAfter: AuditSnapshot = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameValue(before[key], after[key])) continue;
    changedBefore[key] = REDACTED_KEYS.has(key) ? REDACTED : before[key];
    changedAfter[key] = REDACTED_KEYS.has(key) ? REDACTED : after[key];
  }

  // An update that changed nothing still happened, and the row records that it
  // was attempted — but with empty objects rather than a misleading full copy.
  return { before: changedBefore, after: changedAfter };
}

/**
 * Write one audit row, inside the caller's transaction.
 *
 * @example
 * await withTenant(ctx, async (tx) => {
 *   const before = await tx.branch.findUniqueOrThrow({ where: { id } });
 *   const after  = await tx.branch.update({ where: { id }, data });
 *   await recordAudit(tx, ctx, {
 *     action: 'UPDATE', entityType: 'branch', entityId: id,
 *     before, after, branchId: id,
 *   });
 *   return after;
 * });
 */
export async function recordAudit(
  tx: TxClient,
  ctx: TenantContext,
  entry: AuditEntry
): Promise<void> {
  const { before, after } = diffSnapshots(entry.before, entry.after);

  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: entry.action,
      entityType: entry.entityType,
      ...(entry.entityId !== undefined ? { entityId: entry.entityId } : {}),
      ...(entry.branchId != null ? { branchId: entry.branchId } : {}),
      ...(ctx.impersonatedByUserId !== undefined
        ? { impersonatedByUserId: ctx.impersonatedByUserId }
        : {}),
      ...(before !== undefined ? { beforeData: before as Prisma.InputJsonValue } : {}),
      ...(after !== undefined ? { afterData: after as Prisma.InputJsonValue } : {}),
      ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
      // audit_logs.user_agent is varchar(512); a longer one would abort the
      // transaction, taking the mutation with it.
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent.slice(0, 512) } : {}),
    },
  });
}
